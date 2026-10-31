#!/usr/bin/env python3
"""Guitar Helper launcher for Windows, macOS and Linux.

Double-click start.bat (Windows), start.command (macOS) or start.sh (Linux), or run:

    python start.py              set up on first run, start the app and open it in the browser
    python start.py --gpu        first install with NVIDIA GPU support (much faster AI separation)
    python start.py setup        reinstall the dependencies
    python start.py dev          developer mode: auto-reload backend + Vite dev server

Only Python 3.11+ is required. ffmpeg and the JavaScript runtime yt-dlp needs come as Python
packages. Node.js is needed only to (re)build the UI from source; a built UI in
frontend/dist is used as-is.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import platform
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
VENV = BACKEND / ".venv"
STAMP = VENV / ".guitar-helper-installed"
IS_WIN = os.name == "nt"
IS_MAC = sys.platform == "darwin"
CPU_TORCH = "https://download.pytorch.org/whl/cpu"
GPU_TORCH = "https://download.pytorch.org/whl/cu126"  # works with any reasonably recent NVIDIA driver


def say(msg: str) -> None:
    print(f"[guitar-helper] {msg}", flush=True)


def fail(msg: str) -> None:
    say(f"ERROR: {msg}")
    sys.exit(1)


def venv_python() -> Path:
    return VENV / ("Scripts/python.exe" if IS_WIN else "bin/python")


def run(args: list, **kw) -> None:
    subprocess.run([str(a) for a in args], check=True, **kw)


# ---------------------------------------------------------------- setup


def wanted_stamp(gpu: bool) -> str:
    h = hashlib.sha256((BACKEND / "pyproject.toml").read_bytes()).hexdigest()[:16]
    return f"{h}:{'gpu' if gpu else 'cpu'}"


def installed_mode() -> str | None:
    try:
        return STAMP.read_text().strip()
    except OSError:
        return None


def setup(gpu: bool) -> None:
    if not venv_python().exists():
        say("Creating a Python environment in backend/.venv …")
        try:
            run([sys.executable, "-m", "venv", VENV])
        except subprocess.CalledProcessError:
            fail("could not create a virtual environment (on Debian/Ubuntu: sudo apt install python3-venv)")
    py = venv_python()
    pip = [py, "-m", "pip", "install", "--disable-pip-version-check"]
    run([*pip, "-q", "--upgrade", "pip"])
    say(f"Installing PyTorch ({'NVIDIA GPU' if gpu else 'CPU'} build). This is a large download the first time…")
    if IS_MAC:
        run([*pip, "torch"])  # macOS wheels on PyPI already are the right build
    else:
        run([*pip, "torch", "--index-url", GPU_TORCH if gpu else CPU_TORCH])
    say("Installing Guitar Helper's dependencies…")
    run([*pip, "-q", "-e", f"{BACKEND}[separation,dev]"])
    STAMP.write_text(wanted_stamp(gpu))
    say("Setup complete.")


def has_nvidia_gpu() -> bool:
    if IS_MAC or not shutil.which("nvidia-smi"):
        return False
    try:
        return subprocess.run(["nvidia-smi", "-L"], capture_output=True, timeout=10).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


# ---------------------------------------------------------------- UI build


def ui_is_stale() -> bool:
    index = FRONTEND / "dist" / "index.html"
    if not index.exists():
        return True
    built = index.stat().st_mtime
    sources = [FRONTEND / "index.html", FRONTEND / "package.json", *(FRONTEND / "src").rglob("*"), *(FRONTEND / "public").rglob("*")]
    return any(p.is_file() and p.stat().st_mtime > built for p in sources)


def build_ui() -> None:
    if not ui_is_stale():
        return
    npm = shutil.which("npm")
    have_dist = (FRONTEND / "dist" / "index.html").exists()
    if not npm:
        if have_dist:
            say("Node.js not found; using the UI that is already built in frontend/dist.")
            return
        fail("the UI hasn't been built yet and Node.js isn't installed. Install Node.js 20+ from nodejs.org "
             "(needed once, to build it), or copy a built frontend/dist folder from another computer.")
    if not (FRONTEND / "node_modules").exists():
        say("Installing UI packages (npm install)…")
        run([npm, "install", "--no-audit", "--no-fund"], cwd=FRONTEND)
    say("Building the UI…")
    run([npm, "run", "build"], cwd=FRONTEND)


# ---------------------------------------------------------------- serve


def free_port(preferred: int) -> int:
    for port in [preferred, *range(preferred + 1, preferred + 50)]:
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_healthy(url: str, proc: subprocess.Popen, timeout: float = 90) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            return False
        try:
            with urllib.request.urlopen(f"{url}/api/health", timeout=2) as r:
                if r.status == 200:
                    return True
        except OSError:
            time.sleep(0.4)
    return False


def stop(proc: subprocess.Popen) -> None:
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()


def serve(port: int, open_browser: bool) -> None:
    port = free_port(port)
    url = f"http://127.0.0.1:{port}"
    say("Starting…")

    def interrupt(*_):  # closing the terminal window (SIGHUP/SIGTERM) also stops the server
        raise KeyboardInterrupt

    for name in ("SIGTERM", "SIGHUP", "SIGBREAK"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), interrupt)
    proc = subprocess.Popen(
        [str(venv_python()), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=BACKEND,
    )
    try:
        if not wait_healthy(url, proc):
            stop(proc)
            fail("the server didn't start; see the messages above. `python start.py setup` reinstalls everything.")
        say(f"Guitar Helper is running at {url}")
        say("Keep this window open while you use it. Close it or press Ctrl+C to quit.")
        if open_browser:
            webbrowser.open(url)
        proc.wait()
    except KeyboardInterrupt:
        pass
    finally:
        stop(proc)
        say("Stopped.")


def dev(port: int) -> None:
    npm = shutil.which("npm") or fail("dev mode needs Node.js (npm)")
    if not (FRONTEND / "node_modules").exists():
        run([npm, "install", "--no-audit", "--no-fund"], cwd=FRONTEND)
    back = subprocess.Popen(
        [str(venv_python()), "-m", "uvicorn", "app.main:app", "--reload", "--port", str(port)], cwd=BACKEND
    )
    try:
        subprocess.run([npm, "exec", "vite"], cwd=FRONTEND)
    except KeyboardInterrupt:
        pass
    finally:
        stop(back)


# ---------------------------------------------------------------- main


def main() -> None:
    if sys.version_info < (3, 11):
        fail(f"Python 3.11 or newer is required (this is {platform.python_version()}). Get it from python.org.")
    ap = argparse.ArgumentParser(description="Guitar Helper launcher")
    ap.add_argument("command", nargs="?", default="start", choices=["start", "setup", "dev"])
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8765)))
    ap.add_argument("--gpu", action="store_true", help="install PyTorch with NVIDIA CUDA support")
    ap.add_argument("--cpu", action="store_true", help="install the CPU-only PyTorch build")
    ap.add_argument("--no-browser", action="store_true", help="don't open the browser")
    args = ap.parse_args()

    current = installed_mode()
    gpu = args.gpu or (not args.cpu and current is not None and current.endswith(":gpu"))
    if args.command == "setup" or current != wanted_stamp(gpu) or not venv_python().exists():
        if current is None and not args.gpu and not args.cpu and has_nvidia_gpu():
            say("An NVIDIA GPU was found. Run `python start.py --gpu` instead to make AI separation much faster "
                "(bigger download). Continuing with the CPU build.")
        setup(gpu)
        if args.command == "setup":
            return
    if args.command == "dev":
        dev(args.port)
        return
    build_ui()
    serve(args.port, not args.no_browser)


if __name__ == "__main__":
    main()
