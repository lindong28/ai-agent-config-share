#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$HOME/.local/bin"
VENDOR_DIR="$ROOT_DIR/web/vendor"
CHART_FILE="$VENDOR_DIR/chart.umd.min.js"
CHART_URL="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"
SERVICE="${1:-web}"
ROLLUP_LABEL="com.ttweb.rollup"
ROLLUP_PLIST="$HOME/Library/LaunchAgents/$ROLLUP_LABEL.plist"
ROLLUP_LOG="$ROOT_DIR/state/rollup-daemon.log"
ROLLUP_INTERVAL_SECONDS="${TT_WEB_ROLLUP_INTERVAL_SECONDS:-3600}"

usage() {
  echo "usage: ./install.sh [web|rollup-daemon]" >&2
}

install_rollup_daemon() {
  mkdir -p "$ROOT_DIR/state" "$HOME/Library/LaunchAgents"
  chmod +x "$ROOT_DIR/tt-web"
  ROLLUP_LABEL="$ROLLUP_LABEL" \
  ROLLUP_PLIST="$ROLLUP_PLIST" \
  ROLLUP_LOG="$ROLLUP_LOG" \
  ROLLUP_INTERVAL_SECONDS="$ROLLUP_INTERVAL_SECONDS" \
  ROOT_DIR="$ROOT_DIR" \
  python3 - <<'PY'
import os
import plistlib
from pathlib import Path

root = Path(os.environ["ROOT_DIR"])
plist = {
    "Label": os.environ["ROLLUP_LABEL"],
    "ProgramArguments": [str(root / "tt-web"), "rollup"],
    "RunAtLoad": True,
    "StartInterval": int(os.environ["ROLLUP_INTERVAL_SECONDS"]),
    "WorkingDirectory": str(root),
    "StandardOutPath": os.environ["ROLLUP_LOG"],
    "StandardErrorPath": os.environ["ROLLUP_LOG"],
    "EnvironmentVariables": {"PYTHONPATH": str(root)},
}
Path(os.environ["ROLLUP_PLIST"]).write_bytes(plistlib.dumps(plist, sort_keys=False))
PY
  launchctl bootout "gui/$(id -u)/$ROLLUP_LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$ROLLUP_PLIST"
  echo "tt-web rollup-daemon installed: $ROLLUP_LABEL"
  echo "  interval: ${ROLLUP_INTERVAL_SECONDS}s"
  echo "  plist: $ROLLUP_PLIST"
  echo "  log: $ROLLUP_LOG"
  echo "  verify: ./tt-web/status.sh rollup-daemon"
}

if [ "$#" -gt 1 ]; then
  usage
  exit 2
fi

case "$SERVICE" in
  web) ;;
  rollup-daemon)
    install_rollup_daemon
    exit 0
    ;;
  *)
    usage
    exit 2
    ;;
esac

mkdir -p "$ROOT_DIR/state" "$VENDOR_DIR" "$BIN_DIR"
chmod +x "$ROOT_DIR/tt-web"

if [ ! -f "$CHART_FILE" ]; then
  curl --fail --location --silent --show-error "$CHART_URL" --output "$CHART_FILE"
fi

ln -sfn "$ROOT_DIR/tt-web" "$BIN_DIR/tt-web"

# web/vendor/ is gitignored, so the stylesheet's typefaces are fetched here like
# Chart.js is. They are not decoration: without them the page falls back to the
# system stack, which renders fine and therefore hides the regression.
FONT_DIR="$VENDOR_DIR/fonts"
FONT_FILES=(
  "ibm-plex-sans:ibm-plex-sans-latin-400-normal.woff2"
  "ibm-plex-sans:ibm-plex-sans-latin-500-normal.woff2"
  "ibm-plex-sans:ibm-plex-sans-latin-600-normal.woff2"
  "ibm-plex-sans:ibm-plex-sans-latin-400-italic.woff2"
  "ibm-plex-mono:ibm-plex-mono-latin-400-normal.woff2"
)
FONT_LICENSE_URL="https://raw.githubusercontent.com/IBM/plex/master/LICENSE.txt"
mkdir -p "$FONT_DIR"
# A truncated or non-WOFF2 file is worse than a missing one: the browser falls back
# silently and `-f` on the next run treats the wreckage as installed. The magic bytes
# alone do not catch truncation — a file cut after its first four bytes still starts
# with wOF2 — so the header's declared total length is compared with the real size.
is_woff2() {
  [ -s "$1" ] || return 1
  [ "$(head -c 4 "$1" 2>/dev/null)" = "wOF2" ] || return 1
  local hex declared actual
  # WOFF2 header: signature(4) flavor(4) length(4) — `length` is the whole file, stored
  # big-endian. Read it byte-wise; `od --endian` is GNU-only and this also runs on macOS.
  hex="$(od -An -j8 -N4 -tx1 "$1" 2>/dev/null | tr -d ' \n')"
  [ "${#hex}" -eq 8 ] || return 1
  declared=$((16#$hex))
  actual="$(wc -c <"$1" | tr -d ' ')"
  [ "$declared" -eq "$actual" ]
}
font_total="${#FONT_FILES[@]}"
font_fetched=0
font_replaced=0
font_failed=0
font_failed_names=""
for entry in "${FONT_FILES[@]}"; do
  pkg="${entry%%:*}"
  name="${entry##*:}"
  is_woff2 "$FONT_DIR/$name" && continue
  # Distinguished so the report can say a corrupt copy was replaced. Without it the
  # reader is never told a bad file was on their disk.
  [ -e "$FONT_DIR/$name" ] && font_replaced=$((font_replaced + 1))
  rm -f "$FONT_DIR/$name"
  font_fetched=$((font_fetched + 1))
  # Fetch to a scratch path and promote only a verified file, so an interrupted
  # download cannot leave a plausible-looking one behind. The path carries this
  # process's pid: a fixed name lets two concurrent installs move or delete each
  # other's in-flight file.
  tmp="$FONT_DIR/.$name.$$.part"
  if curl --fail --location --silent --show-error \
    "https://cdn.jsdelivr.net/npm/@fontsource/$pkg/files/$name" --output "$tmp" \
    && is_woff2 "$tmp"; then
    mv -f "$tmp" "$FONT_DIR/$name"
  else
    rm -f "$tmp"
    font_failed=$((font_failed + 1))
    font_failed_names="${font_failed_names:+$font_failed_names, }$name"
  fi
done
[ -s "$FONT_DIR/LICENSE.txt" ] || curl --fail --location --silent --show-error \
  "$FONT_LICENSE_URL" --output "$FONT_DIR/LICENSE.txt" || rm -f "$FONT_DIR/LICENSE.txt"
font_have=$((font_total - font_failed))
if [ "$font_failed" -gt 0 ]; then
  font_state=degraded
  echo "WARN: tt-web fonts: $font_failed of $font_total IBM Plex files could not be downloaded ($font_failed_names)" >&2
  echo "      tt-web renders in the system font stack until then — re-run ./tt-web/install.sh once the network allows it" >&2
elif [ "$font_fetched" -gt 0 ]; then
  font_state=installed
else
  font_state=present
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "WARN: ~/.local/bin not in PATH; please add it before using tt-web directly" ;;
esac

# The qualification rides in the line that says "installed", not above it: this is the
# last thing said about tt-web, it is what a scrolled terminal or a pasted tail shows,
# and the degradation it reports is otherwise invisible — the pages still render.
case "$font_state" in
  degraded) echo "tt-web installed, with the UI degraded — $font_have of $font_total fonts present, see the warning above" ;;
  installed)
    font_note="$font_fetched downloaded"
    [ "$font_replaced" -eq 0 ] \
      || font_note="$font_note, $font_replaced of them replacing an incomplete copy already on disk"
    echo "tt-web installed — fonts $font_total/$font_total ($font_note)"
    ;;
  *) echo "tt-web installed — fonts $font_total/$font_total already present" ;;
esac

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

# --- post-install network health hint ---
# Run ip-check once and surface a remediation pointer ONLY when it finds a real
# risk (verdict "high": IPv6 leak / CN DNS / timezone mismatch). Stays silent when
# the environment is clean (low / proxy-in-use). Never aborts the install — a
# network probe must not block setup, so every failure path returns 0. Note: this
# makes one set of outbound calls (ip-api etc.), adding a few seconds to install.
network_health_hint() {
  [ -x "$BIN_DIR/ip-check" ] || return 0
  local py="$VENV_PY"; [ -x "$py" ] || py="python3"
  "$py" -c "import requests" >/dev/null 2>&1 || return 0   # deps missing → ip-check can't run; the WARN above already covers it
  local json
  json="$("$BIN_DIR/ip-check" --json 2>/dev/null)" || return 0
  # Script via stdin (`-`); JSON + runbook path via argv so stdin isn't contended.
  "$py" - "$json" "$ROOT_DIR/NETWORK-REMEDIATION.md" <<'PY' || true
import sys, json
raw, runbook = sys.argv[1], sys.argv[2]
try:
    data = json.loads(raw)
except Exception:
    sys.exit(0)
if data.get("verdict") != "high":
    sys.exit(0)
findings = [c["text"] for c in data.get("conclusions", []) if c.get("level") == "bad"]
print("")
print("⚠ ip-check found network risks (verdict: high):")
for text in findings:
    print("    ✗ " + text)
print("  How to fix: " + runbook)
print("  Re-check after fixing: ip-check")
PY
}
network_health_hint || true
