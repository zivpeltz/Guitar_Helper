"""Adapter for Songsterr's (unofficial, undocumented) JSON endpoints.

Everything Songsterr-specific lives here so that a change on their side only
requires touching this file. Personal, non-commercial use only.

Endpoints used (verified 2026-10):
  /api/songs?pattern=&size=             search
  /api/meta/{songId}                    latest revision meta (tracks, image id)
  CDN/{songId}/{revisionId}/{image}/{partIndex}.json   per-track notation JSON
  /api/video-points/{songId}/{revisionId}/list         YouTube videos + per-measure timestamps
"""

from __future__ import annotations

import gzip
import json
from typing import Any

import httpx

from ..config import HTTP_HEADERS

BASE = "https://www.songsterr.com"
CDN = "https://dqsljvtekg760.cloudfront.net"

_client = httpx.Client(headers=HTTP_HEADERS, timeout=20.0, follow_redirects=True)


def _json(resp: httpx.Response) -> Any:
    resp.raise_for_status()
    content = resp.content
    if content[:2] == b"\x1f\x8b":  # gzip body without Content-Encoding header
        content = gzip.decompress(content)
    return json.loads(content)


def _is_vocal(track: dict) -> bool:
    return bool(track.get("isVocalTrack")) or str(track.get("hash", "")).startswith("vocals")


def _is_drums(track: dict) -> bool:
    return str(track.get("hash", "")).startswith("drums") or track.get("instrumentId") == 1024


def string_count(track: dict) -> int:
    tuning = track.get("tuning") or []
    return int(track.get("strings") or len(tuning) or 6)


def classify_track(track: dict) -> str:
    """The app only supports 6-string guitar (acoustic or electric): 7/8-string or
    12-string-as-other tracks are classified as "other" so they are never offered."""
    h = str(track.get("hash", ""))
    if _is_vocal(track):
        return "vocals"
    if _is_drums(track):
        return "drums"
    if h.startswith("guitar"):
        return "guitar" if string_count(track) == 6 else "other"
    if h.startswith("bass"):
        return "bass"
    return "other"


def search(query: str, size: int = 20) -> list[dict]:
    data = _json(_client.get(f"{BASE}/api/songs", params={"pattern": query, "size": size}))
    results = []
    for s in data:
        tracks = s.get("tracks") or []
        if not any(classify_track(t) == "guitar" for t in tracks):
            continue  # nothing playable on a 6-string guitar
        results.append(
            {
                "songId": s["songId"],
                "artist": s.get("artist", ""),
                "title": s.get("title", ""),
                "hasPlayer": s.get("hasPlayer", False),
                "guitarTracks": sum(1 for t in tracks if classify_track(t) == "guitar"),
                "trackCount": len(tracks),
            }
        )
    return results


def meta(song_id: int) -> dict:
    return _json(_client.get(f"{BASE}/api/meta/{song_id}"))


def track(song_id: int, revision_id: int, image: str, part_index: int) -> dict:
    return _json(_client.get(f"{CDN}/{song_id}/{revision_id}/{image}/{part_index}.json"))


def video_points(song_id: int, revision_id: int) -> list[dict]:
    try:
        return _json(_client.get(f"{BASE}/api/video-points/{song_id}/{revision_id}/list"))
    except httpx.HTTPError:
        return []


def build_song(song_id: int) -> tuple[dict, list[dict]]:
    """Fetch everything needed for a song.

    Returns (song_meta, track_jsons). song_meta contains the normalized track list
    and the audio sources derived from Songsterr's synced videos.
    """
    m = meta(song_id)
    revision_id, image = m["revisionId"], m["image"]
    tracks_meta = m.get("tracks") or []

    track_jsons: list[dict] = []
    tracks: list[dict] = []
    for i, t in enumerate(tracks_meta):
        kind = classify_track(t)
        try:
            data = track(song_id, revision_id, image, i)
        except httpx.HTTPError:
            data = None
        track_jsons.append(data or {})
        tracks.append(
            {
                "index": i,
                "name": t.get("name") or t.get("instrument") or f"Track {i + 1}",
                "instrument": t.get("instrument", ""),
                "hash": t.get("hash", ""),
                "kind": kind,
                "strings": string_count(t),
                "difficulty": t.get("difficulty"),
                "views": t.get("views", 0),
                "isEmpty": bool(t.get("isEmpty")) or data is None,
            }
        )

    measure_count = max((len(d.get("measures", [])) for d in track_jsons if d), default=0)
    sources = audio_sources_from_videos(video_points(song_id, revision_id), tracks)

    default_track = m.get("popularTrackGuitar")
    if default_track is None or default_track >= len(tracks):
        default_track = next((t["index"] for t in tracks if t["kind"] == "guitar"), m.get("defaultTrack", 0))

    song = {
        "key": f"ss-{song_id}",
        "origin": "songsterr",
        "title": m.get("title", ""),
        "artist": m.get("artist", ""),
        "songsterr": {"songId": song_id, "revisionId": revision_id, "image": image},
        "tracks": tracks,
        "defaultTrack": default_track,
        "measureCount": measure_count,
        "sources": sources,
    }
    return song, track_jsons


def audio_sources_from_videos(videos: list[dict], tracks: list[dict]) -> list[dict]:
    """Turn Songsterr's synced videos into audio sources.

    feature None        -> the main (official) recording
    feature "backing"   -> recording with `trackHashes` removed (exactly what we need for "no guitar")
    feature "solo"      -> only `trackHashes` audible
    feature "alternative" -> other uploads of the original (fallbacks)

    Songsterr's `points[i]` is the start time (seconds) of measure i in the video.
    """
    by_hash = {t["hash"]: t for t in tracks}
    sources: list[dict] = []
    alternatives: list[dict] = []
    for v in videos:
        if v.get("status") != "done" or not v.get("points") or not v.get("videoId"):
            continue
        feature = v.get("feature")
        hashes = v.get("trackHashes") or []
        names = [by_hash[h]["name"] for h in hashes if h in by_hash]
        base = {
            "videoId": v["videoId"],
            # Songsterr expands repeats, so measure i is played exactly once (occurrence 0)
            "syncPoints": [
                {"barIndex": i, "occurrence": 0, "seconds": float(p)} for i, p in enumerate(v["points"])
            ],
            "trackHashes": hashes,
            "provider": "songsterr",
        }
        if feature is None:
            sources.append({**base, "id": "original", "kind": "original", "label": "Original recording"})
        elif feature == "backing":
            removed_kinds = {by_hash[h]["kind"] for h in hashes if h in by_hash}
            label = "No " + ", ".join(_short(n) for n in names) if names else "Backing track"
            sources.append(
                {
                    **base,
                    "id": f"backing-{v['videoId']}",
                    "kind": "backing",
                    "label": label,
                    "guitarOnlyRemoved": removed_kinds == {"guitar"},
                }
            )
        elif feature == "solo":
            label = "Only " + ", ".join(_short(n) for n in names) if names else "Isolated track"
            sources.append({**base, "id": f"solo-{v['videoId']}", "kind": "solo", "label": label})
        elif feature == "alternative":
            alternatives.append({**base, "id": f"alt-{v['videoId']}", "kind": "original", "label": "Original (alt. upload)"})

    if not any(s["id"] == "original" for s in sources) and alternatives:
        first = dict(alternatives[0])
        first["id"], first["label"] = "original", "Original recording"
        sources.insert(0, first)
    # keep a couple of alternatives as fallbacks if the main video is unavailable
    sources.extend(alternatives[:3])

    def order(s: dict) -> tuple:
        if s["id"] == "original":
            return (0, 0)
        if s["kind"] == "backing":
            return (1, 0 if s.get("guitarOnlyRemoved") else 1)
        return ({"solo": 3, "original": 4}.get(s["kind"], 5), 0)

    sources.sort(key=order)
    return sources


def _short(name: str) -> str:
    """Songsterr track names look like 'Noel Gallagher | Takamine | Rhythm Guitar'; keep the role."""
    parts = [p.strip() for p in name.split("|") if p.strip()]
    return parts[-1] if parts else name
