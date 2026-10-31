"""Tiny in-process background job runner with progress reporting.

Downloads and separation are slow, blocking work; they run in a thread pool and the
frontend polls /api/jobs/{id}. Jobs are de-duplicated by a `dedupe` key so clicking
twice doesn't start two downloads of the same audio.
"""

from __future__ import annotations

import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from typing import Callable

# Separation is CPU-heavy: keep concurrency low.
_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="job")
_jobs: dict[str, "Job"] = {}
_active_by_key: dict[str, str] = {}
_lock = threading.Lock()


@dataclass
class Job:
    id: str
    title: str
    state: str = "queued"  # queued | running | done | error
    progress: float = 0.0  # 0..1
    message: str = ""
    error: str | None = None
    result: dict | None = None
    dedupe: str | None = field(default=None, repr=False)

    def report(self, progress: float | None = None, message: str | None = None) -> None:
        if progress is not None:
            self.progress = max(0.0, min(1.0, progress))
        if message is not None:
            self.message = message

    def to_dict(self) -> dict:
        d = asdict(self)
        d.pop("dedupe", None)
        return d


def submit(title: str, fn: Callable[[Job], dict | None], dedupe: str | None = None) -> Job:
    with _lock:
        if dedupe and dedupe in _active_by_key:
            existing = _jobs.get(_active_by_key[dedupe])
            if existing and existing.state in ("queued", "running"):
                return existing
        job = Job(id=uuid.uuid4().hex[:12], title=title, dedupe=dedupe)
        _jobs[job.id] = job
        if dedupe:
            _active_by_key[dedupe] = job.id

    def run():
        job.state = "running"
        try:
            job.result = fn(job) or {}
            job.progress = 1.0
            job.state = "done"
            job.message = "Done"
        except Exception as e:  # noqa: BLE001 - report any failure to the UI
            traceback.print_exc()
            job.state = "error"
            job.error = str(e) or e.__class__.__name__
        finally:
            with _lock:
                if dedupe and _active_by_key.get(dedupe) == job.id:
                    del _active_by_key[dedupe]

    _pool.submit(run)
    return job


def get(job_id: str) -> Job | None:
    return _jobs.get(job_id)
