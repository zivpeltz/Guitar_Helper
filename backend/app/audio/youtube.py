"""YouTube search + audio download via yt-dlp.

Downloaded audio is cached locally for personal practice only.
"""

from __future__ import annotations

import re
import tempfile
from pathlib import Path
from typing import Callable

import yt_dlp

from .. import tools

BACKING_WORDS = ("backing track", "no guitar", "without guitar", "guitar backing", "minus guitar", "guitarless")
BAD_WORDS_FOR_ORIGINAL = ("cover", "lesson", "tutorial", "karaoke", "backing", "live", "reaction", "remix", "how to play")


def _base_opts() -> dict:
    opts: dict = {"quiet": True, "no_warnings": True, "noprogress": True}
    runtimes = tools.js_runtimes()
    if runtimes:
        opts["js_runtimes"] = runtimes
    opts["ffmpeg_location"] = tools.ffmpeg()
    return opts


def search(query: str, limit: int = 8) -> list[dict]:
    opts = {**_base_opts(), "extract_flat": "in_playlist", "skip_download": True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"ytsearch{limit}:{query}", download=False)
    out = []
    for e in (info or {}).get("entries") or []:
        if not e or not e.get("id"):
            continue
        out.append(
            {
                "videoId": e["id"],
                "title": e.get("title") or "",
                "channel": e.get("channel") or e.get("uploader") or "",
                "duration": e.get("duration"),
            }
        )
    return out


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", " ", s.lower())


def _words(s: str) -> set[str]:
    return {w for w in _norm(s).split() if len(w) > 1}


def score_candidate(c: dict, artist: str, title: str, want: str, ref_duration: float | None = None) -> float:
    """Heuristic relevance score. want = 'original' | 'backing'."""
    t = _norm(c.get("title", "")) + " " + _norm(c.get("channel", ""))
    title_words = _words(title)
    artist_words = _words(artist)
    score = 0.0
    if title_words:
        score += 4.0 * len(title_words & set(t.split())) / len(title_words)
    if artist_words:
        score += 2.0 * len(artist_words & set(t.split())) / len(artist_words)
    is_backing = any(w in t for w in BACKING_WORDS)
    if want == "backing":
        score += 4.0 if is_backing else -6.0
        if "guitar" not in t:
            score -= 2.0
    else:
        score -= 3.0 * sum(1 for w in BAD_WORDS_FOR_ORIGINAL if w in t)
        if "official audio" in t or "topic" in t:
            score += 1.5
        elif "official" in t:
            score += 0.8
    dur = c.get("duration")
    if dur:
        if dur > 15 * 60 or dur < 60:
            score -= 5.0
        if ref_duration:
            rel = abs(dur - ref_duration) / ref_duration
            score -= 4.0 * min(rel, 1.0)
            if want == "backing" and rel > 0.15:
                score -= 3.0
    return score


def find_best(artist: str, title: str, want: str, ref_duration: float | None = None) -> list[dict]:
    if want == "backing":
        queries = [f"{artist} {title} guitar backing track", f"{artist} {title} no guitar"]
    else:
        queries = [f"{artist} {title} official audio"]
    seen: dict[str, dict] = {}
    for q in queries:
        for c in search(q):
            seen.setdefault(c["videoId"], c)
    ranked = sorted(
        ({**c, "score": score_candidate(c, artist, title, want, ref_duration)} for c in seen.values()),
        key=lambda c: c["score"],
        reverse=True,
    )
    return ranked


def download_audio(video_id: str, dest: Path, progress: Callable[[float, str], None] | None = None) -> Path:
    """Download best audio for a YouTube video and store it as Ogg/Opus at `dest`."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{6,20}", video_id):
        raise ValueError(f"invalid video id {video_id!r}")
    dest.parent.mkdir(parents=True, exist_ok=True)

    def hook(d):
        if progress and d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            if total:
                progress(0.9 * d.get("downloaded_bytes", 0) / total, "Downloading audio…")

    with tempfile.TemporaryDirectory(prefix="gh-dl-") as tmp:
        opts = {
            **_base_opts(),
            "format": "bestaudio/best",
            "outtmpl": str(Path(tmp) / "%(id)s.%(ext)s"),
            "progress_hooks": [hook],
            "noplaylist": True,
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([f"https://www.youtube.com/watch?v={video_id}"])
        files = list(Path(tmp).glob(f"{video_id}.*"))
        if not files:
            raise RuntimeError("yt-dlp produced no file")
        if progress:
            progress(0.92, "Converting…")
        to_ogg(files[0], dest)
    return dest


def to_ogg(src: Path, dest: Path) -> None:
    """Transcode anything ffmpeg understands to Ogg/Opus (plays natively in browsers)."""
    tools.transcode(src, dest, ["-c:a", "libopus", "-b:a", "160k"])


def to_aac(src: Path, dest: Path) -> None:
    """AAC in MP4, for Safari (moov atom up front so playback can start while loading)."""
    tools.transcode(src, dest, ["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"])


def probe_duration(path: Path) -> float | None:
    return tools.duration(path)
