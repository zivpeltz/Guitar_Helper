"""HTTP API."""

from __future__ import annotations

import base64
import hashlib
import re
import shutil
import threading

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
import numpy as np
from pydantic import BaseModel

from . import jobs, library
from .audio import youtube
from .tabs import songsterr

router = APIRouter(prefix="/api")

SEPARATED_SOURCES = [
    {"id": "ai-no-guitar", "kind": "separated", "label": "No guitar (AI separated)", "provider": "demucs", "syncFrom": "original"},
    {"id": "ai-guitar-only", "kind": "separated-guitar", "label": "Guitar only (AI separated)", "provider": "demucs", "syncFrom": "original"},
]
PART_ID_RE = re.compile(r"^p[0-9]{1,3}$")
_sep_locks: dict[str, threading.Lock] = {}
_sep_locks_guard = threading.Lock()


def _sep_lock(key: str) -> threading.Lock:
    with _sep_locks_guard:
        return _sep_locks.setdefault(key, threading.Lock())


def _part_source_ids(part_id: str) -> tuple[str, str]:
    return f"ai-nopart-{part_id}", f"ai-onlypart-{part_id}"


def _delete_part_outputs(key: str) -> None:
    """Part splits derive from the AI guitar stem; drop them whenever that stem changes."""
    for f in library.song_dir(key).joinpath("audio").glob("ai-*part-*.*"):
        f.unlink(missing_ok=True)


GP_EXTENSIONS = {".gp", ".gp3", ".gp4", ".gp5", ".gpx", ".musicxml", ".xml", ".mxl", ".cap", ".tex"}


def _meta_or_404(key: str) -> dict:
    try:
        if not library.exists(key):
            raise HTTPException(404, "song not found")
        return library.load(key)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


def _source_or_404(meta: dict, source_id: str) -> dict:
    s = library.get_source(meta, source_id)
    if not s:
        raise HTTPException(404, f"unknown audio source {source_id}")
    return s


def _ensure_separated_sources(meta: dict) -> None:
    ids = {s["id"] for s in meta.setdefault("sources", [])}
    for s in SEPARATED_SOURCES:
        if s["id"] not in ids:
            meta["sources"].append(dict(s))


# ---------------------------------------------------------------- search / library


@router.get("/health")
def health():
    return {"ok": True}


@router.get("/search")
def search(q: str):
    if not q.strip():
        return []
    try:
        return songsterr.search(q.strip())
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Songsterr search failed: {e}") from e


@router.get("/library")
def library_list():
    return library.list_songs()


@router.delete("/songs/{key}")
def delete_song(key: str):
    _meta_or_404(key)
    shutil.rmtree(library.song_dir(key))
    return {"ok": True}


# ---------------------------------------------------------------- opening songs


@router.post("/songs/songsterr/{song_id}")
def open_songsterr(song_id: int, refresh: bool = False):
    key = f"ss-{song_id}"
    if library.exists(key) and not refresh:
        meta = library.update(key, lambda m: None)  # bump openedAt
        return library.with_availability(meta)
    try:
        song, track_jsons = songsterr.build_song(song_id)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Could not fetch tab from Songsterr: {e}") from e
    if library.exists(key):  # refresh: keep user tweaks to sources we already had
        old = {s["id"]: s for s in library.load(key).get("sources", [])}
        for s in song["sources"]:
            if s["id"] in old and "offset" in old[s["id"]]:
                s["offset"] = old[s["id"]]["offset"]
        song["sources"] += [s for sid, s in old.items() if s.get("provider") in ("youtube",) and sid not in {x["id"] for x in song["sources"]}]
    _ensure_separated_sources(song)
    library.save_tracks(key, track_jsons)
    return library.with_availability(library.save(song))


@router.post("/songs/local")
async def upload_local(file: UploadFile = File(...), title: str = Form(""), artist: str = Form("")):
    name = file.filename or "tab.gp"
    ext = "." + name.rsplit(".", 1)[-1].lower() if "." in name else ".gp"
    if ext not in GP_EXTENSIONS:
        raise HTTPException(400, f"unsupported file type {ext}")
    data = await file.read()
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(413, "file too large")
    key = "local-" + hashlib.sha1(data).hexdigest()[:12]
    d = library.song_dir(key)
    for old in d.glob("tab.*"):
        old.unlink()
    (d / f"tab{ext}").write_bytes(data)
    if library.exists(key):
        meta = library.load(key)
        meta["title"] = title or meta.get("title", "")
        meta["artist"] = artist or meta.get("artist", "")
    else:
        meta = {
            "key": key,
            "origin": "local",
            "title": title or name.rsplit(".", 1)[0],
            "artist": artist,
            "fileName": name,
            "sources": [],
        }
    _ensure_separated_sources(meta)
    return library.with_availability(library.save(meta))


@router.get("/songs/{key}")
def get_song(key: str):
    return library.with_availability(_meta_or_404(key))


@router.get("/songs/{key}/tracks/{index}")
def get_track(key: str, index: int):
    _meta_or_404(key)
    p = library.track_path(key, index)
    if not p.exists():
        raise HTTPException(404, "track not cached")
    return FileResponse(p, media_type="application/json")


@router.get("/songs/{key}/tab")
def get_tab(key: str):
    _meta_or_404(key)
    p = library.tab_file(key)
    if not p:
        raise HTTPException(404, "no tab file")
    return FileResponse(p, media_type="application/octet-stream", filename=p.name)


# ---------------------------------------------------------------- audio sources


@router.post("/songs/{key}/discover")
def discover_youtube(key: str, backing: bool = True):
    """Search YouTube for the original recording (and a backing track) when Songsterr has none."""
    meta = _meta_or_404(key)

    def run(job: jobs.Job):
        artist, title = meta.get("artist", ""), meta.get("title", "")
        found = {}
        current = library.load(key)
        if not library.get_source(current, "original"):
            job.report(0.1, "Searching YouTube for the original recording…")
            ranked = youtube.find_best(artist, title, "original")
            if ranked:
                best = ranked[0]
                library.upsert_source(key, {
                    "id": "original", "kind": "original", "label": "Original recording", "provider": "youtube",
                    "videoId": best["videoId"], "videoTitle": best["title"], "duration": best.get("duration"),
                    "syncPoints": None, "candidates": ranked[:8],
                })
                found["original"] = best["videoId"]
        if backing and not library.get_source(current, "yt-backing"):
            job.report(0.5, "Searching YouTube for a backing track…")
            ref = (library.get_source(library.load(key), "original") or {}).get("duration")
            ranked = [c for c in youtube.find_best(artist, title, "backing", ref) if c["score"] > 2.0]
            if ranked:
                best = ranked[0]
                library.upsert_source(key, {
                    "id": "yt-backing", "kind": "backing", "label": "Backing track (YouTube)", "provider": "youtube",
                    "videoId": best["videoId"], "videoTitle": best["title"], "duration": best.get("duration"),
                    "syncPoints": None, "candidates": ranked[:8],
                })
                found["backing"] = best["videoId"]
        job.report(1.0, "Found " + (", ".join(found) or "nothing"))
        return found

    job = jobs.submit(f"Searching audio for {meta.get('title')}", run, dedupe=f"discover:{key}")
    return job.to_dict()


class ChooseVideo(BaseModel):
    videoId: str


@router.post("/songs/{key}/sources/{source_id}/video")
def choose_video(key: str, source_id: str, body: ChooseVideo):
    meta = _meta_or_404(key)
    src = _source_or_404(meta, source_id)
    if src.get("provider") != "youtube":
        raise HTTPException(400, "only YouTube-searched sources can switch video")
    cand = next((c for c in src.get("candidates", []) if c["videoId"] == body.videoId), None)
    path = library.audio_path(key, source_id)
    path.unlink(missing_ok=True)
    if source_id == "original":  # separated stems derive from the original
        for s in SEPARATED_SOURCES:
            library.audio_path(key, s["id"]).unlink(missing_ok=True)
        _delete_part_outputs(key)
    library.upsert_source(key, {
        "id": source_id, "videoId": body.videoId, "syncPoints": None, "offset": 0,
        "videoTitle": (cand or {}).get("title", body.videoId), "duration": (cand or {}).get("duration"),
    })
    return library.with_availability(library.load(key))


def _download_source(key: str, source: dict, job: jobs.Job, base: float = 0.0, span: float = 1.0):
    dest = library.audio_path(key, source["id"])
    if dest.exists():
        return dest
    if not source.get("videoId"):
        raise RuntimeError(f"source {source['id']} has no video to download")
    youtube.download_audio(source["videoId"], dest, lambda p, m: job.report(base + span * p, m))
    dur = youtube.probe_duration(dest)
    if dur:
        library.upsert_source(key, {"id": source["id"], "audioDuration": dur})
    return dest


def _ensure_separated(key: str, job: jobs.Job, base: float, span: float) -> None:
    """Demucs no-guitar + guitar-only stems on disk (one separation per song at a time)."""
    no_guitar, guitar_only = library.audio_path(key, "ai-no-guitar"), library.audio_path(key, "ai-guitar-only")
    with _sep_lock(key):
        if no_guitar.exists() and guitar_only.exists():
            return
        from .audio.separate import remove_guitar

        original = library.get_source(library.load(key), "original")
        if not original:
            raise RuntimeError("No original recording known yet — search YouTube for it first")
        orig_path = _download_source(key, original, job, base, span * 0.15)
        remove_guitar(orig_path, no_guitar, guitar_only, lambda p, m: job.report(base + span * (0.15 + 0.85 * p), m))


@router.post("/songs/{key}/sources/{source_id}/prepare")
def prepare_source(key: str, source_id: str, force: bool = False):
    """Make the audio for a source available on disk (download or AI-separate)."""
    meta = _meta_or_404(key)
    src = _source_or_404(meta, source_id)
    dest = library.audio_path(key, source_id)
    if dest.exists() and not force:
        return {"id": None, "state": "done", "progress": 1.0, "message": "ready", "error": None, "result": {}}

    if src.get("partId"):
        raise HTTPException(409, "part splits need the tab: select the part's source in the player")

    if src.get("kind") in ("separated", "separated-guitar"):
        def run_sep(job: jobs.Job):
            _ensure_separated(key, job, 0.0, 1.0)
            return {"ready": ["ai-no-guitar", "ai-guitar-only"]}

        if force:
            for s in SEPARATED_SOURCES:
                library.audio_path(key, s["id"]).unlink(missing_ok=True)
            _delete_part_outputs(key)
        job = jobs.submit(f"Removing guitar from {meta.get('title')}", run_sep, dedupe=f"sep:{key}")
        return job.to_dict()

    def run_dl(job: jobs.Job):
        if force:
            dest.unlink(missing_ok=True)
        _download_source(key, src, job)
        return {"ready": [source_id]}

    job = jobs.submit(f"Downloading {src.get('label')}", run_dl, dedupe=f"dl:{key}:{source_id}")
    return job.to_dict()


_aac_lock = threading.Lock()


@router.get("/songs/{key}/audio/{source_id}")
def get_audio(key: str, source_id: str, format: str = "ogg"):
    """Ogg/Opus by default; `format=aac` serves an M4A copy (iPhone/iPad browsers), made on first request."""
    _meta_or_404(key)
    try:
        p = library.audio_path(key, source_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if not p.exists():
        raise HTTPException(404, "audio not prepared yet")
    if format != "aac":
        return FileResponse(p, media_type="audio/ogg")
    m4a = p.with_suffix(".m4a")
    with _aac_lock:
        if not m4a.exists() or m4a.stat().st_mtime < p.stat().st_mtime:
            youtube.to_aac(p, m4a)
    return FileResponse(m4a, media_type="audio/mp4")


# ---------------------------------------------------------------- sync


class SyncUpdate(BaseModel):
    offset: float | None = None
    syncPoints: list[dict] | None = None


@router.put("/songs/{key}/sources/{source_id}/sync")
def update_sync(key: str, source_id: str, body: SyncUpdate):
    meta = _meta_or_404(key)
    _source_or_404(meta, source_id)
    patch: dict = {"id": source_id}
    if body.offset is not None:
        patch["offset"] = float(body.offset)
    if body.syncPoints is not None:
        patch["syncPoints"] = body.syncPoints
    library.upsert_source(key, patch)
    return library.with_availability(library.load(key))


class AlignRequest(BaseModel):
    midi: str  # base64 MIDI produced by alphaTab
    bars: list[dict]  # [{barIndex, occurrence, tick}]


@router.post("/songs/{key}/sources/{source_id}/align")
def align_source(key: str, source_id: str, body: AlignRequest):
    meta = _meta_or_404(key)
    src = _source_or_404(meta, source_id)
    target_id = src.get("syncFrom") or source_id  # separated audio shares the original's timeline
    audio = library.audio_path(key, target_id)
    if not audio.exists():
        raise HTTPException(409, "audio must be prepared before aligning")
    midi = base64.b64decode(body.midi)
    bars = body.bars

    def run(job: jobs.Job):
        from .sync.align import compute_sync_points

        job.report(0.1, "Analyzing recording and aligning it to the tab…")
        points = compute_sync_points(midi, bars, audio)
        library.upsert_source(key, {"id": target_id, "syncPoints": points, "syncMethod": "auto", "offset": 0})
        return {"count": len(points)}

    job = jobs.submit(f"Syncing {src.get('label')}", run, dedupe=f"align:{key}:{target_id}")
    return job.to_dict()


class PartSplitRequest(BaseModel):
    label: str  # human name of the part, e.g. "Lead Guitar"
    hash: str | None = None  # Songsterr track hash of the part, if any
    midi: str  # base64 MIDI of the score (alphaTab render)
    bars: list[dict]  # [{barIndex, occurrence, tick}]
    targetChannels: list[int]  # MIDI channels of the part to remove/isolate
    otherChannels: list[int]  # MIDI channels of the other guitar parts


@router.post("/songs/{key}/parts/{part_id}/split")
def split_part(key: str, part_id: str, body: PartSplitRequest, force: bool = False):
    """EXPERIMENTAL: remove / isolate one tabbed guitar part from the AI guitar stem."""
    meta = _meta_or_404(key)
    if not PART_ID_RE.match(part_id):
        raise HTTPException(400, "invalid part id")
    if not body.targetChannels:
        raise HTTPException(400, "no MIDI channels for the part")
    no_id, only_id = _part_source_ids(part_id)
    name = body.label.strip()[:60] or "this part"
    common = {"provider": "demucs", "syncFrom": "original", "experimental": True, "partId": part_id, "partHash": body.hash}
    library.upsert_source(key, {**common, "id": no_id, "kind": "separated", "label": f"No {name} (AI tab-guided, experimental)"})
    library.upsert_source(key, {**common, "id": only_id, "kind": "separated-guitar", "label": f"Only {name} (AI tab-guided, experimental)"})
    if force:
        for sid in (no_id, only_id):
            library.audio_path(key, sid).unlink(missing_ok=True)
    if library.audio_path(key, no_id).exists() and library.audio_path(key, only_id).exists():
        return {"id": None, "state": "done", "progress": 1.0, "message": "ready", "error": None, "result": {}}
    midi = base64.b64decode(body.midi)

    def run(job: jobs.Job):
        import tempfile
        from pathlib import Path

        import soundfile as sf

        from .audio.part_removal import SR, midi_notes, split_part as split, tick_mapper, timed_notes
        from .audio.separate import _decode
        from .audio.youtube import to_ogg

        _ensure_separated(key, job, 0.0, 0.6)

        original = library.get_source(library.load(key), "original") or {}
        if not original.get("syncPoints"):  # YouTube-found recording that was never synced
            from .sync.align import compute_sync_points

            job.report(0.6, "Syncing the tab to the recording…")
            pts = compute_sync_points(midi, body.bars, library.audio_path(key, "original"))
            meta_now = library.upsert_source(key, {"id": "original", "syncPoints": pts, "syncMethod": "auto", "offset": 0})
            original = library.get_source(meta_now, "original")
        to_sec = tick_mapper(body.bars, original["syncPoints"], float(original.get("offset") or 0))
        target = timed_notes(midi_notes(midi, body.targetChannels), to_sec)
        others = timed_notes(midi_notes(midi, set(body.otherChannels) - set(body.targetChannels)), to_sec)

        job.report(0.62, "Loading the AI guitar stem…")
        guitar = _decode(library.audio_path(key, "ai-guitar-only"), SR)
        backing = _decode(library.audio_path(key, "ai-no-guitar"), SR)
        keep, only = split(guitar, target, others, lambda p, m: job.report(0.62 + 0.33 * p, m))
        n = min(backing.shape[1], keep.shape[1])
        mix = backing[:, :n] + keep[:, :n]

        job.report(0.96, "Encoding…")
        with tempfile.TemporaryDirectory(prefix="gh-part-") as tmp:
            for audio, sid in ((mix, no_id), (only, only_id)):
                wav = Path(tmp) / f"{sid}.wav"
                sf.write(wav, np.clip(audio, -1, 1).T, SR, subtype="PCM_16")
                to_ogg(wav, library.audio_path(key, sid))
        return {"ready": [no_id, only_id]}

    job = jobs.submit(f"Splitting {name} out of {meta.get('title')}", run, dedupe=f"part:{key}:{part_id}")
    return job.to_dict()


@router.get("/jobs/{job_id}")
def get_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "unknown job")
    return job.to_dict()

