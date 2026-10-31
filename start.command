#!/bin/bash
# Guitar Helper launcher for macOS: double-click this file in Finder.
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3.11+ is required. Install it from https://www.python.org/downloads/"
  read -r -p "Press Enter to close…"
  exit 1
fi
python3 start.py "$@" || read -r -p "Press Enter to close…"
