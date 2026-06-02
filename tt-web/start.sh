#!/usr/bin/env bash
# tt-web start — thin wrapper over the tt-web dispatcher (manual PID-file daemon).
exec "$(cd "$(dirname "$0")" && pwd)/tt-web" start "$@"
