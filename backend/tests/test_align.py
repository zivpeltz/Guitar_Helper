"""Alignment must recover a known offset + tempo change between tab MIDI and a 'recording'."""

import io

import numpy as np
import pretty_midi
import soundfile as sf

from app.sync.align import SR, compute_sync_points

CHORDS = [[52, 55, 59], [48, 52, 55], [50, 54, 57], [45, 48, 52], [43, 47, 50], [47, 50, 54]]
BAR = 2.0  # seconds per bar at the tab tempo (120 bpm, 4/4)


def make_midi(stretch: float = 1.0, offset: float = 0.0) -> pretty_midi.PrettyMIDI:
    pm = pretty_midi.PrettyMIDI(initial_tempo=120, resolution=960)
    inst = pretty_midi.Instrument(program=25)
    rng = np.random.default_rng(0)
    for bar in range(24):
        chord = CHORDS[rng.integers(len(CHORDS))]
        for beat in range(4):
            start = offset + (bar * BAR + beat * 0.5) * stretch
            for p in chord:
                inst.notes.append(pretty_midi.Note(90, p, start, start + 0.45 * stretch))
    pm.instruments.append(inst)
    return pm


def test_recovers_offset_and_tempo(tmp_path):
    tab = make_midi()
    buf = io.BytesIO()
    tab.write(buf)
    bars = [{"barIndex": i, "occurrence": 0, "tick": int(tab.time_to_tick(i * BAR))} for i in range(24)]

    stretch, offset = 1.08, 3.0  # recording is 8% slower and starts after 3 s of intro silence
    rec = make_midi(stretch, offset).synthesize(fs=SR)
    audio = tmp_path / "rec.wav"
    sf.write(audio, rec.astype(np.float32), SR)

    pts = compute_sync_points(buf.getvalue(), bars, audio)
    expected = np.array([offset + i * BAR * stretch for i in range(24)])
    got = np.array([p["seconds"] for p in pts])
    err = np.abs(got - expected)
    assert np.median(err) < 0.15, err
    assert err.max() < 0.5, err
