#!/usr/bin/env bash
# Idempotent installer for ask-user-mcp: installs runtime deps only.
set -euo pipefail
cd "$(dirname "$0")"
npm install --omit=dev --no-audit --no-fund --loglevel=error
echo "ask-user-mcp: deps ready"
