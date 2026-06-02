#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$HOME/.local/bin"
VENDOR_DIR="$ROOT_DIR/web/vendor"
CHART_FILE="$VENDOR_DIR/chart.umd.min.js"
CHART_URL="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"

mkdir -p "$ROOT_DIR/state" "$VENDOR_DIR" "$BIN_DIR"
chmod +x "$ROOT_DIR/tt-web"

if [ ! -f "$CHART_FILE" ]; then
  curl --fail --location --silent --show-error "$CHART_URL" --output "$CHART_FILE"
fi

ln -sfn "$ROOT_DIR/tt-web" "$BIN_DIR/tt-web"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "WARN: ~/.local/bin not in PATH; please add it before using tt-web directly" ;;
esac

echo "tt-web installed"

# --- ip-check sub-feature ---
IPCHECK_BIN="$ROOT_DIR/ip-check"
chmod +x "$IPCHECK_BIN"
ln -sfn "$IPCHECK_BIN" "$BIN_DIR/ip-check"

# requests dependency (used by ip-check) is provided by the repo-root shared
# venv created in the top-level install.sh. We only verify here — never install,
# so venv creation stays single-sourced and doesn't drift between scripts.
REPO_DIR="${REPO_DIR:-$(git -C "$ROOT_DIR" rev-parse --show-toplevel)}"
VENV_PY="$REPO_DIR/.venv/bin/python"
if [ ! -x "$VENV_PY" ] || ! "$VENV_PY" -c "import requests" >/dev/null 2>&1; then
  echo "WARN: ip-check needs the shared venv ($VENV_PY) with 'requests'."
  echo "      Run the repo-root install.sh first (it creates the shared venv)."
fi
echo "ip-check installed"
