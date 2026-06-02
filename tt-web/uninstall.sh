#!/usr/bin/env bash
# tt-web uninstall — stop the server and remove the ~/.local/bin symlinks.
# Keeps source, state/, and vendored assets. Idempotent.
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
"$ROOT/tt-web" stop 2>/dev/null || true

for link in "$HOME/.local/bin/tt-web" "$HOME/.local/bin/ip-check"; do
  if [ -L "$link" ]; then
    rm -f "$link"
    echo "→ removed $link"
  else
    echo "✓ $link absent"
  fi
done
echo "  (source + state/ kept)"
