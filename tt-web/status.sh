#!/usr/bin/env bash
# tt-web status — thin wrapper over the tt-web dispatcher. Read-only.
exec "$(cd "$(dirname "$0")" && pwd)/tt-web" status "$@"
