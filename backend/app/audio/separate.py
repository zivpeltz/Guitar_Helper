"""Guitar removal using Demucs (htdemucs_6s has a dedicated `guitar` stem).

Pipeline: decode with ffmpeg → separate → sum every stem except guitar → Ogg/Opus.
The guitar stem itself is saved as well ("guitar only"), handy for listening to the part.
Because the output has the exact timeline of the input, it reuses the input's sync points.
"""

from __future__ import annotations

import tempfile
import threading
from pathlib import Path
from typing import Callable

import numpy as np

from ..config import SEPARATION_MODEL
from .. import tools
from .youtube import to_ogg

_model_lock = threading.Lock()
_separator = None


def _get_separator(callback):
    global _separator
    from demucs.api import Separator  # heavy import, keep lazy

    with _model_lock:
        if _separator is None:
            import torch

            device = "cuda" if torch.cuda.is_available() else "cpu"
            _separator = Separator(model=SEPARATION_MODEL, device=device, progress=False, jobs=0)
    _separator.update_parameter(callback=callback)
    return _separator


def _decode(path: Path, sr: int, channels: int = 2) -> np.ndarray:
    return tools.decode(path, sr, channels)


def remove_guitar(
    src: Path,
    dest_no_guitar: Path,
    dest_guitar_only: Path | None = None,
    progress: Callable[[float, str], None] | None = None,
) -> None:
    import soundfile as sf
    import torch

    torch.set_num_threads(max(1, (torch.get_num_threads() or 2)))

    def cb(info: dict):
        if not progress:
            return
        length = info.get("audio_length") or 0
        offset = info.get("segment_offset") or 0
        if length and info.get("state") == "end":
            progress(0.05 + 0.85 * min(1.0, offset / length), "Separating guitar (this takes a few minutes on CPU)…")

    if progress:
        progress(0.01, "Loading separation model…")
    sep = _get_separator(cb)
    if progress:
        progress(0.04, "Decoding audio…")
    wav = torch.from_numpy(_decode(src, sep.samplerate, sep.audio_channels))
    _, stems = sep.separate_tensor(wav, sep.samplerate)
    if "guitar" not in stems:
        raise RuntimeError(f"model {SEPARATION_MODEL} has no guitar stem (stems: {list(stems)})")

    if progress:
        progress(0.92, "Mixing backing track…")
    backing = sum(t for name, t in stems.items() if name != "guitar")
    outputs = [(backing, dest_no_guitar)]
    if dest_guitar_only is not None:
        outputs.append((stems["guitar"], dest_guitar_only))

    with tempfile.TemporaryDirectory(prefix="gh-sep-") as tmp:
        for tensor, dest in outputs:
            data = tensor.clamp(-1, 1).numpy().T  # (samples, channels)
            wav_path = Path(tmp) / (dest.stem + ".wav")
            sf.write(wav_path, data, sep.samplerate, subtype="PCM_16")
            to_ogg(wav_path, dest)
