# Guitar Helper

A local practice app. Search a song, read the tab (standard notation + tablature), and
play along with the **real recording** or a **backing track without the guitar**, while a
cursor follows the music note by note.

Runs on **Windows, macOS and Linux**, on your own computer, in your browser.

## Start it

1. Install **Python 3.11+** from [python.org](https://www.python.org/downloads/). On Windows, tick *"Add python.exe to PATH"*.
2. Double-click the launcher for your system:
   - Windows: `start.bat`
   - macOS: `start.command` (the first time: right-click → *Open*)
   - Linux: `start.sh` (or run `./start.sh` in a terminal)
3. The first start installs everything into `backend/.venv` (a few GB, mostly PyTorch for the AI separation). After
   that it starts in seconds and opens the app in your browser. Keep the launcher window open while you use it.

ffmpeg and the JavaScript runtime yt-dlp needs come as Python packages, so nothing else has to be installed.
**Node.js 20+** is needed only to build the UI from source, once (and again after UI changes). The launcher does
that automatically when Node is available.

```
python start.py              # same as the double-click launchers
python start.py --gpu        # install PyTorch with NVIDIA CUDA: AI separation in seconds instead of minutes
python start.py --cpu        # switch back to the CPU-only build
python start.py setup        # reinstall dependencies
python start.py dev          # hot reload: backend :8765 + Vite at http://localhost:5173
python start.py --port 9000 --no-browser
```

Personal, non-commercial use only. Tabs and audio are fetched from Songsterr / YouTube and cached under `data/`.
See **Credits & legal** in the app (link at the bottom of the home page).

## How it works

| Step | How |
|---|---|
| **Search & tabs** | Songsterr's (unofficial) JSON API → per-track notation JSON → converted in the browser into an [alphaTab](https://alphatab.net) score (`frontend/src/lib/songsterrToScore.ts`). You can also open your own Guitar Pro / MusicXML files. |
| **Rendering + cursor** | alphaTab draws notation + tab. It runs in *external media* mode: a plain `<audio>` element plays, and alphaTab follows it through **sync points** (bar → time in the recording). |
| **Original audio** | Songsterr lists YouTube recordings for each tab, with a timestamp for every bar, so sync is exact. For local files (or songs without one) the backend searches YouTube with `yt-dlp` and ranks results by title and duration. |
| **No-guitar audio** | Priority: 1) Songsterr "backing" videos with specific tracks removed (also synced per bar), 2) a YouTube "guitar backing track", 3) **AI separation** with Demucs `htdemucs_6s`. It mixes every stem except `guitar` and also gives you a "guitar only" track. Separated audio shares the original's timeline, so it reuses the original's sync points. |
| **One part removed** *(experimental)* | Demucs puts all guitars in one stem. `backend/app/audio/part_removal.py` splits that stem between the tabbed guitar parts with score-informed NMF: each (part, pitch) gets a harmonic-comb component that can only be active where the tab and sync points say that part plays it, and a Wiener mask then removes (or isolates) the selected part. Clean when parts differ in register or rhythm; leaky where guitars double each other. |
| **Auto-sync** | When no ready-made sync exists, alphaTab renders the tab to MIDI. The backend aligns the MIDI's chroma features with the recording's using slope-constrained subsequence DTW, maps each bar start into the audio, and repairs outliers with a local Theil–Sen tempo fit (`backend/app/sync/align.py`). Measured against Songsterr's hand-made sync, the median error is about 0.1 s. |

## Using it

- **Original / No guitar** toggle (top right). "No guitar" picks the best backing for the *part you're viewing*.
- **Audio** dropdown lists every source: original, backing tracks with guitar removed, isolated guitar tracks, AI-separated tracks, and a MIDI synth. ⤓ means it isn't downloaded yet (first use downloads or separates it).
- **Experimental: this part only** (Audio dropdown): "No ‹part›" removes just the guitar part you're viewing and keeps the other guitars, so you can play that part along with the rest of the band. "Only ‹part›" lets you hear it on its own. Needs the AI separation first, then about 10 s per part. **Re-split part** redoes it, for example after fixing the sync offset.
- **Volume**: playback volume for whichever source is playing (remembered between sessions).
- **Part**: which guitar part to show. Only 6-string guitar (acoustic or electric) is supported: bass, 7/8-string guitars and other instruments are hidden, and searches leave out songs with no 6-string guitar part.
- **Speed** 40–125% (pitch preserved). **Loop**: drag across bars in the tab to select them, then turn the loop on.
- **Sync offset** ±50 ms if the cursor runs early or late (saved per song). For YouTube audio you can **Re-sync** or pick a different video ("Wrong video?").
- **Metronome**: clicks on every beat with an accented downbeat (compound meters like 6/8 click on the dotted
  quarter). With a recording, the beats are placed through the bar sync points, so the clicks follow the band's real
  tempo, including speed-ups and slow-downs, at any playback speed. With the tab synth it uses alphaTab's metronome.
  The lights show where you are in the bar.
- **Space** = play/pause, **M** = metronome on/off. Click a note to jump there.

AI separation takes about 2–5 minutes per song the first time on a CPU (seconds with `--gpu`). It's cached afterwards. While a source is being prepared, the current audio keeps playing and a status bar shows progress. Playback switches over when it's ready.

## Layout

```
backend/app/
  api.py              REST routes (FastAPI)
  tabs/songsterr.py   Songsterr adapter (all endpoint knowledge lives here)
  audio/youtube.py    yt-dlp search / rank / download → Ogg Opus
  audio/separate.py   Demucs guitar removal
  audio/part_removal.py  experimental tab-guided split of one guitar part
  tools.py            ffmpeg / JS runtime discovery (bundled or system)
  sync/align.py       MIDI ↔ audio DTW alignment
  jobs.py             background jobs with progress
  library.py          on-disk cache in data/songs/<key>/
frontend/src/
  components/Player.tsx      alphaTab + audio wiring, transport, sources
  components/Home.tsx        search, library, file upload
  components/Credits.tsx     credits, licenses and legal notice
  lib/metronome.ts           beat grid + recording-synced click scheduler
  lib/songsterrToScore.ts    Songsterr JSON → alphaTab model
  lib/alphatabSync.ts        sync-point / source helpers
start.py                     cross-platform launcher (start.bat / start.command / start.sh wrap it)
```

Tests: `cd backend && .venv/bin/python -m pytest` (on Windows: `.venv\Scripts\python -m pytest`)

Configuration (env vars): `GH_DATA_DIR`, `GH_SEPARATION_MODEL` (default `htdemucs_6s`),
`GH_JS_RUNTIME` (JS runtime for yt-dlp, default: the bundled deno), `PORT`.

## Known limitations

- Songsterr's endpoints are undocumented and may change. If they break, only `tabs/songsterr.py` needs updating, and local files keep working.
- Demucs' guitar stem is good but not perfect: expect some guitar bleed, especially with distorted rhythm guitars doubled by keys.
- Auto-sync can slip by about half a second inside long stretches of identical bars. Use the offset nudge or Re-sync.
- YouTube changes often. If downloads fail, update yt-dlp: `backend/.venv/bin/pip install -U "yt-dlp[default]"` (Windows: `backend\.venv\Scripts\pip ...`).
- AI separation uses an NVIDIA GPU when PyTorch was installed with `--gpu`; otherwise the CPU (a few minutes per song). Apple GPUs aren't used.
