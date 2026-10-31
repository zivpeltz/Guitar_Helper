"""On-disk cache of opened songs.

data/songs/{key}/
    meta.json          normalized song meta incl. audio sources and their sync points
    tracks/{i}.json    Songsterr track JSON (songsterr songs)
    tab.<ext>          original Guitar Pro file (local songs)
    audio/{source}.ogg downloaded / generated audio
    stems/             intermediate separation output
"""

from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path

from .config import SONGS_DIR

_lock = threading.RLock()
_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
_SOURCE_RE = re.compile(r"^[A-Za-z0-9_.-]{1,120}$")


def check_key(key: str) -> str:
    if not _KEY_RE.match(key):
        raise ValueError(f"invalid song key: {key!r}")
    return key


def check_source_id(source_id: str) -> str:
    if not _SOURCE_RE.match(source_id):
        raise ValueError(f"invalid source id: {source_id!r}")
    return source_id


def song_dir(key: str) -> Path:
    d = SONGS_DIR / check_key(key)
    d.mkdir(parents=True, exist_ok=True)
    return d


def exists(key: str) -> bool:
    return (SONGS_DIR / check_key(key) / "meta.json").exists()


def load(key: str) -> dict:
    with _lock:
        return json.loads((SONGS_DIR / check_key(key) / "meta.json").read_text())


def save(meta: dict) -> dict:
    with _lock:
        meta.setdefault("createdAt", time.time())
        meta["openedAt"] = time.time()
        path = song_dir(meta["key"]) / "meta.json"
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(meta, indent=1))
        tmp.replace(path)
        return meta


def update(key: str, fn) -> dict:
    """Atomically load → mutate → save."""
    with _lock:
        meta = load(key)
        fn(meta)
        return save(meta)


def get_source(meta: dict, source_id: str) -> dict | None:
    return next((s for s in meta.get("sources", []) if s["id"] == source_id), None)


def upsert_source(key: str, source: dict) -> dict:
    def fn(meta):
        sources = meta.setdefault("sources", [])
        for i, s in enumerate(sources):
            if s["id"] == source["id"]:
                sources[i] = {**s, **source}
                return
        sources.append(source)

    return update(key, fn)


def audio_path(key: str, source_id: str) -> Path:
    d = song_dir(key) / "audio"
    d.mkdir(exist_ok=True)
    return d / f"{check_source_id(source_id)}.ogg"


def save_tracks(key: str, track_jsons: list[dict]) -> None:
    d = song_dir(key) / "tracks"
    d.mkdir(exist_ok=True)
    for i, t in enumerate(track_jsons):
        (d / f"{i}.json").write_text(json.dumps(t))


def track_path(key: str, index: int) -> Path:
    return song_dir(key) / "tracks" / f"{int(index)}.json"


def tab_file(key: str) -> Path | None:
    d = song_dir(key)
    for p in d.glob("tab.*"):
        return p
    return None


def list_songs() -> list[dict]:
    out = []
    for meta_path in SONGS_DIR.glob("*/meta.json"):
        try:
            m = json.loads(meta_path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        out.append(
            {
                "key": m["key"],
                "title": m.get("title", ""),
                "artist": m.get("artist", ""),
                "origin": m.get("origin", ""),
                "openedAt": m.get("openedAt", 0),
            }
        )
    out.sort(key=lambda s: s["openedAt"], reverse=True)
    return out


def with_availability(meta: dict) -> dict:
    """Annotate each source with whether its audio file is already on disk."""
    meta = json.loads(json.dumps(meta))
    for s in meta.get("sources", []):
        s["ready"] = audio_path(meta["key"], s["id"]).exists()
    return meta
