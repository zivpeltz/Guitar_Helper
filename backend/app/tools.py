"""External binaries, resolved so the app runs on Windows, macOS and Linux with only Python installed.

* ffmpeg: a system install if present, else the static build shipped by the `imageio-ffmpeg` package.
* JavaScript runtime for yt-dlp (YouTube's signature challenges): GH_JS_RUNTIME, else the `deno`
  binary shipped by the `deno` package, else deno/node/bun found on PATH.
"""

from __future__ import annotations

import functools
import os
import re
import shutil
import subprocess
from pathlib import Path

import numpy as np


@functools.cache
def ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as e:  # noqa: BLE001
        raise RuntimeError("ffmpeg not found: run the launcher again to reinstall dependencies") from e


@functools.cache
def js_runtimes() -> dict:
    """yt-dlp `js_runtimes` option."""
    env = os.environ.get("GH_JS_RUNTIME")
    if env:
        return {env: {}}
    try:
        import deno

        return {"deno": {"path": deno.find_deno_bin()}}
    except Exception:  # noqa: BLE001
        pass
    for name in ("deno", "node", "bun"):
        path = shutil.which(name)
        if path:
            return {name: {"path": path}}
    return {}


def _run(args: list[str], **kw) -> subprocess.CompletedProcess:
    # no console window popping up for every ffmpeg call on Windows
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return subprocess.run(args, creationflags=flags, **kw)


def transcode(src: Path, dest: Path, codec_args: list[str]) -> None:
    tmp = dest.with_name(dest.stem + ".part" + dest.suffix)
    _run([ffmpeg(), "-y", "-loglevel", "error", "-i", str(src), "-vn", *codec_args, str(tmp)], check=True, capture_output=True)
    tmp.replace(dest)


def decode(path: Path, sr: int, channels: int = 2) -> np.ndarray:
    """Decode any audio file to float32 (channels, samples)."""
    raw = _run(
        [ffmpeg(), "-loglevel", "error", "-i", str(path), "-f", "f32le", "-ac", str(channels), "-ar", str(sr), "-"],
        capture_output=True,
        check=True,
    ).stdout
    audio = np.frombuffer(raw, dtype=np.float32).reshape(-1, channels).T
    return np.ascontiguousarray(audio)


def duration(path: Path) -> float | None:
    out = _run([ffmpeg(), "-hide_banner", "-i", str(path)], capture_output=True, text=True).stderr
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", out)
    return int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3]) if m else None
