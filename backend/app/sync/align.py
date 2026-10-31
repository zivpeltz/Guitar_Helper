"""Automatic tab ↔ recording alignment (used when no ready-made sync points exist).

The frontend renders the tab to MIDI with alphaTab and tells us at which MIDI tick each
bar (occurrence) starts. We compute chroma features for both the MIDI and the recording,
align them with DTW, and map every bar start to a time in the recording. The result is a
list of sync points alphaTab can consume directly.
"""

from __future__ import annotations

import io
from pathlib import Path

import numpy as np

SR = 22050
HOP = 2048  # ~93 ms frames: precise enough for bar starts, cheap enough for DTW on full songs
FPS = SR / HOP


def _normalize(chroma: np.ndarray) -> np.ndarray:
    chroma = np.asarray(chroma, dtype=np.float64) + 1e-6  # avoid zero vectors (cosine undefined)
    return chroma / np.linalg.norm(chroma, axis=0, keepdims=True)


def midi_chroma(midi_bytes: bytes):
    import pretty_midi

    pm = pretty_midi.PrettyMIDI(io.BytesIO(midi_bytes))
    pm.instruments = [i for i in pm.instruments if not i.is_drum]
    if not pm.instruments:
        raise ValueError("MIDI contains no pitched instruments")
    return pm, _normalize(pm.get_chroma(fs=FPS))


def audio_chroma(path: Path | str | None = None, y: np.ndarray | None = None) -> np.ndarray:
    import librosa

    if y is None:
        from .. import tools

        y = tools.decode(Path(path), SR, channels=1)[0]
    return _normalize(librosa.feature.chroma_cqt(y=y, sr=SR, hop_length=HOP))


def warp_path(midi_c: np.ndarray, audio_c: np.ndarray) -> np.ndarray:
    """Returns a monotonic array mapping every MIDI frame to an audio frame."""
    import librosa

    # Subsequence DTW lets the tab match only part of the recording (intros, fade-outs, silence).
    # Steps (1,1),(1,2),(2,1) bound the local tempo ratio to [0.5, 2]; without this the path
    # degenerates (whole sections collapse onto a single audio frame).
    subseq = midi_c.shape[1] <= audio_c.shape[1]
    try:
        _, wp = librosa.sequence.dtw(
            X=midi_c,
            Y=audio_c,
            metric="cosine",
            subseq=subseq,
            step_sizes_sigma=np.array([[1, 1], [1, 2], [2, 1]]),
            weights_add=np.zeros(3),
            weights_mul=np.ones(3),
        )
    except librosa.util.exceptions.ParameterError:
        # lengths too different for the slope constraint; fall back to unconstrained steps
        _, wp = librosa.sequence.dtw(X=midi_c, Y=audio_c, metric="cosine", subseq=subseq)
    wp = wp[::-1]
    idx = np.arange(midi_c.shape[1])
    mapping = np.interp(idx, wp[:, 0], wp[:, 1])
    return np.maximum.accumulate(mapping)


def compute_sync_points(midi_bytes: bytes, bars: list[dict], audio_path: Path) -> list[dict]:
    """bars: [{barIndex, occurrence, tick}] in playback order → [{barIndex, occurrence, seconds}]."""
    pm, mc = midi_chroma(midi_bytes)
    ac = audio_chroma(audio_path)
    mapping = warp_path(mc, ac)
    return _smooth(_map_bars(pm, bars, mapping), [pm.tick_to_time(int(b["tick"])) for b in bars])


def _smooth(points: list[dict], midi_times: list[float], window: int = 4, tolerance: float = 0.2) -> list[dict]:
    """Repair isolated outliers.

    Chroma can't pin down a bar line inside repeated material (same chord twice), so DTW
    sometimes slides a single bar start. Each bar is compared with a robust local tempo
    fit (Theil–Sen over ±`window` neighbouring bars); points that disagree by more than
    `tolerance` seconds are replaced by the fit.
    """
    n = len(points)
    if n < 5:
        return points
    x = np.asarray(midi_times, dtype=float)
    y = np.array([p["seconds"] for p in points], dtype=float)
    fixed = y.copy()
    for i in range(n):
        lo, hi = max(0, i - window), min(n, i + window + 1)
        idx = [j for j in range(lo, hi) if j != i]
        xs, ys = x[idx], y[idx]
        slopes = [(ys[b] - ys[a]) / (xs[b] - xs[a]) for a in range(len(idx)) for b in range(a + 1, len(idx)) if xs[b] - xs[a] > 1e-6]
        if not slopes:
            continue
        slope = float(np.median(slopes))
        intercept = float(np.median(ys - slope * xs))
        pred = slope * x[i] + intercept
        if abs(pred - y[i]) > tolerance:
            fixed[i] = pred
    fixed = np.maximum.accumulate(np.maximum(fixed, 0.0))
    return [{**p, "seconds": round(float(t), 3)} for p, t in zip(points, fixed)]


def _map_bars(pm, bars: list[dict], mapping: np.ndarray) -> list[dict]:
    out = []
    last = -1.0
    for b in bars:
        t_midi = pm.tick_to_time(int(b["tick"]))
        f = max(0.0, t_midi * FPS - 0.5)  # pretty_midi frames cover [k, k+1); librosa frames are centred
        f0 = int(np.clip(np.floor(f), 0, len(mapping) - 1))
        f1 = min(f0 + 1, len(mapping) - 1)
        frac = f - np.floor(f)
        audio_frame = mapping[f0] * (1 - frac) + mapping[f1] * frac
        seconds = max(float(audio_frame / FPS), last)
        last = seconds
        out.append({"barIndex": int(b["barIndex"]), "occurrence": int(b.get("occurrence", 0)), "seconds": round(seconds, 3)})
    return out
