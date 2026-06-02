#!/usr/bin/env bash
# tt-web stop — thin wrapper over the tt-web dispatcher.
exec "$(cd "$(dirname "$0")" && pwd)/tt-web" stop "$@"
