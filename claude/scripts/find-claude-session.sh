#!/bin/bash
# Find Claude Code session UUIDs in current project matching given keywords.
#
# Usage:
#   find-claude-session.sh KEYWORD [KEYWORD ...]
#
# 3-stage convergence on ~/.claude/projects/<cwd-encoded>/*.jsonl:
#   1. files containing ANY keyword (case-insensitive, fixed string)
#   2. files containing ALL keywords (AND filter)
#   3. user-prompt messages (type=user) containing any keyword — preview lines
#
# stdout: structured "=== SESSION i/N ===" blocks, empty if no matches.
# stderr: NO_HISTORY / NO_MATCH / PARTIAL_MATCH sentinels for caller to branch on.
# exit:   0 always; caller inspects stdout/stderr.

set -uo pipefail
shopt -s nullglob

if [ $# -eq 0 ]; then
  echo "ERROR: at least one keyword required" >&2
  echo "Usage: $(basename "$0") KEYWORD [KEYWORD ...]" >&2
  exit 1
fi

KEYWORDS=("$@")

# mtime helpers. GNU coreutils reads `-f` as *filesystem* info while BSD reads it
# as *format*, so `stat -f '%m'` on Linux treats %m as a filename and prints
# statfs output — whose extra lines then get split into phantom session records
# downstream. Try the GNU form first, fall back to BSD.
file_mtime_epoch() {
  stat -c '%Y' "$1" 2>/dev/null || stat -f '%m' "$1" 2>/dev/null
}
file_mtime_str() {
  stat -c '%y' "$1" 2>/dev/null | cut -c1-16 \
    || stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$1" 2>/dev/null
}

# Claude Code encodes a project's absolute path by replacing every '/' with '-'.
# /Users/lindong/research/ai-assistant -> -Users-lindong-research-ai-assistant
PROJ_DIR="$HOME/.claude/projects/$(pwd | sed 's|/|-|g')"

if [ ! -d "$PROJ_DIR" ]; then
  echo "NO_HISTORY: $PROJ_DIR does not exist (no prior Claude sessions in $(pwd))" >&2
  exit 0
fi

JSONLS=("$PROJ_DIR"/*.jsonl)
if [ ${#JSONLS[@]} -eq 0 ]; then
  echo "NO_HISTORY: no .jsonl session files under $PROJ_DIR" >&2
  exit 0
fi

# Stage 1: ANY keyword (fixed-string OR via repeated -e)
GREP_OR_ARGS=()
for kw in "${KEYWORDS[@]}"; do GREP_OR_ARGS+=(-e "$kw"); done

STAGE1=()
while IFS= read -r f; do
  STAGE1+=("$f")
done < <(grep -l -i -F "${GREP_OR_ARGS[@]}" "${JSONLS[@]}" 2>/dev/null)

if [ ${#STAGE1[@]} -eq 0 ]; then
  echo "NO_MATCH: no session files contain any of the keywords (${KEYWORDS[*]})" >&2
  exit 0
fi

# Stage 2: ALL keywords (AND)
STAGE2=()
for f in "${STAGE1[@]}"; do
  hit_all=1
  for kw in "${KEYWORDS[@]}"; do
    if ! grep -q -i -F -- "$kw" "$f"; then
      hit_all=0; break
    fi
  done
  [ $hit_all -eq 1 ] && STAGE2+=("$f")
done

# The live session's own JSONL records the invocation that is searching it, so
# every query self-matches. Never let that masquerade as a real hit: flag it in
# the output and, when it is the ONLY hit, tell the caller it means no match.
SELF_UUID="${CLAUDE_CODE_SESSION_ID:-}"
if [ -n "$SELF_UUID" ] && [ ${#STAGE2[@]} -eq 1 ] \
   && [ "$(basename "${STAGE2[0]}" .jsonl)" = "$SELF_UUID" ]; then
  echo "SELF_MATCH_ONLY: the only match is the live session ($SELF_UUID), which records this search itself — treat as NO_MATCH" >&2
fi

if [ ${#STAGE2[@]} -eq 0 ]; then
  echo "PARTIAL_MATCH: ${#STAGE1[@]} session(s) match some keywords but none match ALL" >&2
  echo "Partial-match UUIDs (try with fewer or different keywords):" >&2
  for f in "${STAGE1[@]}"; do echo "  $(basename "$f" .jsonl)" >&2; done
  exit 0
fi

# Stage 3: extract user-prompt previews; sort newest mtime first
TMPSORT=$(mktemp)
for f in "${STAGE2[@]}"; do
  printf '%s\t%s\n' "$(file_mtime_epoch "$f")" "$f"
done | sort -rn > "$TMPSORT"

TOTAL=${#STAGE2[@]}
i=0
while IFS=$'\t' read -r _mt f; do
  # Defensive: never emit a record for a path that is not a readable file, so a
  # malformed sort line can't produce a phantom "SESSION i/N" block.
  [ -n "$f" ] && [ -f "$f" ] || continue
  i=$((i+1))
  uuid=$(basename "$f" .jsonl)
  mtime=$(file_mtime_str "$f")
  echo "=== SESSION $i/$TOTAL ==="
  echo "UUID:   $uuid"
  echo "MTIME:  $mtime"
  [ -n "$SELF_UUID" ] && [ "$uuid" = "$SELF_UUID" ] \
    && echo "NOTE:   CURRENT live session — it logs this very search, so its match may be self-contamination"
  echo "RESUME: claude --resume $uuid"
  echo ""
  echo "MATCHING USER MESSAGES:"
  python3 - "$f" "${KEYWORDS[@]}" <<'PYEOF'
import json, sys
path = sys.argv[1]
keywords = [k.lower() for k in sys.argv[2:]]
shown = 0
with open(path, encoding="utf-8", errors="replace") as fp:
    for line in fp:
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d.get("type") != "user":
            continue
        content = d.get("message", {}).get("content", "")
        # User content is either a plain string or a list of blocks. Skipping the
        # list form makes a real prompt match print the "no user prompt match"
        # line instead — a false negative in the tool's own conclusion.
        if isinstance(content, str):
            msg = content
        elif isinstance(content, list):
            msg = " ".join(
                b.get("text", "")
                for b in content
                if isinstance(b, dict) and b.get("type") == "text"
            )
        else:
            continue
        if not msg:
            continue
        ml = msg.lower()
        if not any(k in ml for k in keywords):
            continue
        ts = d.get("timestamp", "")[:19]
        preview = msg[:250].replace("\n", " / ")
        print(f"  [{ts}] {preview}")
        shown += 1
        if shown >= 5:
            print(f"  ... (truncated; more matches in this session)")
            break
if shown == 0:
    print("  (keywords matched in tool output / assistant text only — no user prompt match)")
PYEOF
  echo ""
done < "$TMPSORT"
rm -f "$TMPSORT"
