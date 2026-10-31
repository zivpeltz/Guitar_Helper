#!/usr/bin/env bash
# Guitar Helper launcher for Linux: ./start.sh  (same options as start.py, e.g. ./start.sh --gpu)
cd "$(dirname "$0")" || exit 1
exec python3 start.py "$@"
