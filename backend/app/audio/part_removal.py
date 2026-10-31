"""EXPERIMENTAL: remove (or isolate) a single tabbed guitar part.

Demucs gives us one stem containing *all* guitars. It cannot tell lead from rhythm, but
the tab can: we know which notes every guitar part plays, and the sync points tell us
when. That is enough for score-informed NMF (Ewert & Müller, 2012):

* The guitar stem's magnitude spectrogram V is factorised as V ≈ W·H.
* Every (part, pitch) pair gets one component. Its spectrum W starts as a harmonic comb
  for that pitch, and its activation H is non-zero only where the tab says that part
  plays that pitch (with some slack for sync error and ringing). A few unconstrained
  "residual" components soak up whatever the tab doesn't explain (strums that aren't
  tabbed, pick noise, bleed).
* Multiplicative KL updates keep zeros at zero, so the score's structure survives while
  timbres and loudness are learned from the actual recording.
* A Wiener-style mask built from the target part's components splits the stem into
  "this part" and "everything else", which is mixed back with the non-guitar stems.

Works best when parts differ in register or rhythm (solo over chords). Where two guitars
play the same notes at the same time, the split is a guess and you'll hear artifacts.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from typing import Callable, Iterable

import numpy as np

SR = 44100
N_FFT = 4096  # ~10.8 Hz bins: low E (82 Hz) and F (87 Hz) are separable
HOP = 1024  # ~23 ms frames
MAX_BIN = 1024  # model up to ~11 kHz; above that the mask is extended from the top bands
RESIDUAL_COMPONENTS = 6
ITERATIONS = 60
PRE_ROLL = 0.10  # s of slack before a note (sync error)
RING = 0.35  # s of slack after a note ends (strings keep ringing)
MAX_NOTE = 6.0  # s, cap for very long tied notes
EPS = 1e-9


@dataclass(frozen=True)
class Note:
    pitch: int
    start: float  # seconds in the recording
    end: float


# ---------------------------------------------------------------- tab → timed notes


def midi_notes(midi_bytes: bytes, channels: Iterable[int]) -> list[tuple[int, int, int]]:
    """(tick_on, tick_off, pitch) for every note on the given MIDI channels."""
    import mido

    wanted = set(channels)
    mid = mido.MidiFile(file=io.BytesIO(midi_bytes))
    out: list[tuple[int, int, int]] = []
    for track in mid.tracks:
        tick = 0
        open_notes: dict[tuple[int, int], list[int]] = {}
        for msg in track:
            tick += msg.time
            if msg.type not in ("note_on", "note_off") or msg.channel not in wanted:
                continue
            k = (msg.channel, msg.note)
            if msg.type == "note_on" and msg.velocity > 0:
                open_notes.setdefault(k, []).append(tick)
            elif open_notes.get(k):
                out.append((open_notes[k].pop(0), tick, msg.note))
    out.sort()
    return out


def tick_mapper(bars: list[dict], sync_points: list[dict], offset: float = 0.0) -> Callable[[np.ndarray], np.ndarray]:
    """Piecewise-linear MIDI tick → recording seconds, through the bar sync points."""
    by_key = {(int(p["barIndex"]), int(p.get("occurrence", 0))): float(p["seconds"]) for p in sync_points}
    pairs: list[tuple[float, float]] = []
    for b in bars:
        sec = by_key.get((int(b["barIndex"]), int(b.get("occurrence", 0))))
        if sec is None:
            continue
        t = float(b["tick"])
        if pairs and (t <= pairs[-1][0] or sec < pairs[-1][1]):
            continue  # keep it monotonic
        pairs.append((t, sec + offset))
    if len(pairs) < 2:
        raise ValueError("not enough sync points to place the tab's notes in the recording")
    ticks = np.array([p[0] for p in pairs])
    secs = np.array([p[1] for p in pairs])
    slope_lo = (secs[1] - secs[0]) / (ticks[1] - ticks[0])
    slope_hi = (secs[-1] - secs[-2]) / (ticks[-1] - ticks[-2])

    def f(x: np.ndarray) -> np.ndarray:
        x = np.asarray(x, dtype=float)
        y = np.interp(x, ticks, secs)
        y = np.where(x < ticks[0], secs[0] + (x - ticks[0]) * slope_lo, y)
        return np.where(x > ticks[-1], secs[-1] + (x - ticks[-1]) * slope_hi, y)

    return f


def timed_notes(raw: list[tuple[int, int, int]], to_sec: Callable[[np.ndarray], np.ndarray]) -> list[Note]:
    if not raw:
        return []
    arr = np.array(raw, dtype=float)
    starts, ends = to_sec(arr[:, 0]), to_sec(arr[:, 1])
    return [Note(int(p), float(s), float(e)) for (_, _, p), s, e in zip(raw, starts, ends) if e > 0]


# ---------------------------------------------------------------- separation


def _comb(freqs: np.ndarray, pitch: int, tuning: float) -> np.ndarray:
    """Harmonic comb for a MIDI pitch: gaussian peaks at (slightly stretched) partials."""
    f0 = 440.0 * 2 ** ((pitch - 69 + tuning) / 12)
    bin_w = freqs[1] - freqs[0]
    col = np.zeros_like(freqs)
    for h in range(1, 60):
        f = f0 * h * np.sqrt(1 + 1e-4 * h * h)  # string inharmonicity
        if f > freqs[-1]:
            break
        sigma = max(0.8 * bin_w, f * (2 ** (45 / 1200) - 1))  # ±45 cents: vibrato, bends, detune
        near = np.abs(freqs - f) < 3 * sigma
        col[near] += np.exp(-0.5 * ((freqs[near] - f) / sigma) ** 2) / h**0.7
    return col


def _activation(notes: list[Note], pitch: int, n_frames: int) -> np.ndarray:
    row = np.zeros(n_frames, dtype=np.float32)
    fps = SR / HOP
    for n in notes:
        if n.pitch != pitch:
            continue
        a = int(max(0, (n.start - PRE_ROLL) * fps))
        b = int(min(n_frames, (min(n.end, n.start + MAX_NOTE) + RING) * fps) + 1)
        row[a:b] = 1.0
    return row


def split_part(
    guitar: np.ndarray,
    target: list[Note],
    others: list[Note],
    progress: Callable[[float, str], None] | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """guitar: (channels, samples) at SR. Returns (guitar without the target part, target part)."""
    import librosa

    report = progress or (lambda p, m: None)
    if not target:
        raise ValueError("the selected part has no notes")
    n = guitar.shape[1]
    report(0.02, "Analysing the guitar stem…")
    specs = [librosa.stft(ch, n_fft=N_FFT, hop_length=HOP) for ch in guitar]
    V = np.mean([np.abs(s[:MAX_BIN]) for s in specs], axis=0).astype(np.float32)
    n_frames = V.shape[1]
    freqs = librosa.fft_frequencies(sr=SR, n_fft=N_FFT)[:MAX_BIN]
    tuning = float(librosa.estimate_tuning(y=guitar.mean(axis=0), sr=SR, n_fft=N_FFT))

    cols, rows, is_target = [], [], []
    for notes, tgt in ((target, True), (others, False)):
        for pitch in sorted({x.pitch for x in notes}):
            act = _activation(notes, pitch, n_frames)
            if not act.any():
                continue
            cols.append(_comb(freqs, pitch, tuning))
            rows.append(act)
            is_target.append(tgt)
    rng = np.random.default_rng(0)
    for _ in range(RESIDUAL_COMPONENTS):
        cols.append(rng.random(len(freqs)) + 0.1)
        rows.append(np.ones(n_frames, dtype=np.float32))
        is_target.append(False)

    W = np.stack(cols, axis=1).astype(np.float32)
    W /= W.sum(axis=0, keepdims=True) + EPS
    H = np.stack(rows).astype(np.float32) * (V.sum(axis=0, keepdims=True) / len(rows) + EPS)
    tmask = np.array(is_target)

    # KL-divergence NMF with multiplicative updates (zeros stay zero → score constraints hold)
    for it in range(ITERATIONS):
        WH = W @ H + EPS
        H *= (W.T @ (V / WH)) / (W.sum(axis=0)[:, None] + EPS)
        WH = W @ H + EPS
        W *= ((V / WH) @ H.T) / (H.sum(axis=1)[None, :] + EPS)
        scale = W.sum(axis=0, keepdims=True) + EPS
        W /= scale
        H *= scale.T
        if it % 5 == 0:
            report(0.05 + 0.8 * it / ITERATIONS, "Splitting the guitar parts (experimental)…")

    report(0.88, "Building the mix…")
    Vt = W[:, tmask] @ H[tmask]
    Vo = W[:, ~tmask] @ H[~tmask]
    M = Vt**2 / (Vt**2 + Vo**2 + EPS)  # Wiener-like soft mask for the target part
    top = M[-64:].mean(axis=0, keepdims=True)
    M_full = np.concatenate([M, np.repeat(top, specs[0].shape[0] - MAX_BIN, axis=0)])

    keep = np.stack([librosa.istft(s * (1 - M_full), hop_length=HOP, length=n) for s in specs])
    only = np.stack([librosa.istft(s * M_full, hop_length=HOP, length=n) for s in specs])
    return keep.astype(np.float32), only.astype(np.float32)
