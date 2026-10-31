import numpy as np

from app.audio.part_removal import SR, Note, split_part, tick_mapper


def pluck(pitch: int, dur: float) -> np.ndarray:
    t = np.arange(int(dur * SR)) / SR
    f0 = 440 * 2 ** ((pitch - 69) / 12)
    tone = sum(np.sin(2 * np.pi * f0 * h * t) / h for h in range(1, 12))
    return (tone * np.exp(-3 * t)).astype(np.float32)


def render(notes: list[Note], length: float) -> np.ndarray:
    y = np.zeros(int(length * SR), dtype=np.float32)
    for n in notes:
        s = pluck(n.pitch, n.end - n.start + 0.3)
        a = int(n.start * SR)
        y[a : a + len(s)] += s[: len(y) - a]
    return y


def energy(x):
    return float(np.sum(np.asarray(x, dtype=np.float64) ** 2))


def test_split_removes_lead_keeps_rhythm():
    rng = np.random.default_rng(1)
    lead = [Note(int(rng.integers(72, 84)), i * 0.25, i * 0.25 + 0.25) for i in range(32)]
    rhythm = [Note(p, i * 1.0, i * 1.0 + 1.0) for i in range(8) for p in (40, 47, 52)]
    a, b = render(lead, 9), render(rhythm, 9)
    mix = np.stack([a + b, a + b])

    keep, only = split_part(mix, lead, rhythm)

    lead_left = energy(keep[0] - b) / energy(a)  # leftover lead in "no lead"
    rhythm_kept = 1 - energy(keep[0] - b) / energy(b)
    assert lead_left < 0.15, lead_left
    assert rhythm_kept > 0.85, rhythm_kept
    assert energy(only[0] - a) / energy(a) < 0.15


def test_tick_mapper_interpolates_and_extrapolates():
    bars = [{"barIndex": i, "occurrence": 0, "tick": i * 3840} for i in range(3)]
    pts = [{"barIndex": i, "occurrence": 0, "seconds": 1.0 + 2.0 * i} for i in range(3)]
    f = tick_mapper(bars, pts, offset=0.5)
    assert np.allclose(f(np.array([0, 1920, 7680, 11520])), [1.5, 2.5, 5.5, 7.5])
