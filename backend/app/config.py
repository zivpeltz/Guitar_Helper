"""Central configuration (paths, model choice). Override via environment variables."""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.environ.get("GH_DATA_DIR", ROOT / "data"))
SONGS_DIR = DATA_DIR / "songs"
FRONTEND_DIST = ROOT / "frontend" / "dist"

# Demucs model used to strip guitars when no backing track exists online.
# htdemucs_6s is the only standard Demucs model with a dedicated guitar stem.
SEPARATION_MODEL = os.environ.get("GH_SEPARATION_MODEL", "htdemucs_6s")

HTTP_HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) GuitarHelper/0.1 (personal practice tool)",
}

SONGS_DIR.mkdir(parents=True, exist_ok=True)
