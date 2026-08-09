#!/bin/bash
# tt-statusline.sh — Token Tracker style statusline with transcript observability
# Line 1: project | 5h bar | 7d bar | per-model bars (Fable, …)
# Line 2: tokens | cached | cost
# Line 3: duration | model
# Line 4: env metadata (CLAUDE.md / rules / MCPs / hooks)
# Line 5: transcript (tools / agents / skills / todos)
# Also persists data to ~/.claude/tt-status.json for `tt` CLI dashboard

input=$(cat)

# ── Parse everything in one pass ──
# statusline-fields.py owns all JSON handling: this repo does not require jq, and
# on a host without it the old one-jq-per-field approach silently emptied every
# field. It also persists tt-status.json and refreshes the speed cache, since the
# same parse already has that data. The defaults below stand if it fails, so a
# parse error degrades the statusline rather than breaking the session.
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
STATUS_FILE="$HOME/.claude/tt-status.json"
SPEED_CACHE="$HOME/.claude/statusline-cache/.speed.json"
# Per-model quotas are absent from the harness payload, so statusline-usage.py
# polls them in the background and leaves them here for the render to pick up.
USAGE_CACHE="$HOME/.claude/statusline-cache/.usage.json"
# The helper ships beside this script, so resolve it from here rather than from
# $HOME/.claude — that path only happens to work because of the install symlink,
# and it makes the script unusable when run straight from a checkout.
SELF_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PROJECT_DIR=""; MODEL="?"; EFFORT=""; COST=0; DURATION_MS=0; TRANSCRIPT=""; SESSION_ID=""
CTX_PCT=0; CTX_SIZE=0; TOTAL_IN=0; TOTAL_OUT=0
CUR_IN=0; CUR_OUT_FIELD=0; CACHE_READ=0; CACHE_CREATE=0
USAGE_5H=""; RESET_5H=""; USAGE_7D=""; RESET_7D=""; MODEL_LIMIT_LINES=""
SPEED=""; HAS_TDATA=0
ST_IN=0; ST_OUT=0; ST_CACHE=0; ST_TOTAL=0; SST=""
TOOLS_RUNNING_LINES=""; TOOLS_DONE_LINES=""; AGENT_LINES=""; SKILL_LINES=""
TODO_CONTENT=""; TODO_COMPLETED=""; TODO_TOTAL=""
MCP_COUNT=0; HOOKS_COUNT=0

eval "$(printf '%s' "$input" \
  | STATUS_FILE="$STATUS_FILE" SPEED_CACHE="$SPEED_CACHE" CLAUDE_DIR="$CLAUDE_DIR" \
    USAGE_CACHE="$USAGE_CACHE" \
    python3 "$SELF_DIR/statusline-fields.py" 2>/dev/null)"

PROJECT_NAME=$(basename "$PROJECT_DIR" 2>/dev/null)

# Git branch
BRANCH=""
if [ -n "$PROJECT_DIR" ] && [ -d "$PROJECT_DIR/.git" ] 2>/dev/null; then
  BRANCH=$(git -C "$PROJECT_DIR" branch --show-current 2>/dev/null)
fi

# ── Colors (tt-statusline.py palette) ──
C_CYAN=$'\033[36m'
C_GREEN=$'\033[32m'
C_YELLOW=$'\033[33m'
C_RED=$'\033[31m'
C_BLUE=$'\033[94m'
C_MAGENTA=$'\033[35m'
C_PEACH=$'\033[38;5;216m'
C_DIM=$'\033[2m'
C_RESET=$'\033[0m'

# ── Detect terminal width ──
COLS=${COLUMNS:-0}
if [ "$COLS" -le 0 ] 2>/dev/null; then
  COLS=$(python3 -c "
import subprocess,os,fcntl,termios,struct
pid=os.getpid()
for _ in range(15):
    tty=subprocess.check_output(['ps','-o','tty=','-p',str(pid)],text=True).strip()
    if tty and tty!='??' and os.path.exists('/dev/'+tty):
        fd=os.open('/dev/'+tty,os.O_RDONLY|os.O_NONBLOCK)
        r=fcntl.ioctl(fd,termios.TIOCGWINSZ,b'\x00'*8)
        os.close(fd)
        print(struct.unpack('hh',r[:4])[1]);break
    pid=int(subprocess.check_output(['ps','-o','ppid=','-p',str(pid)],text=True).strip())
" 2>/dev/null)
  COLS=${COLS:-100}
fi

# ── Adaptive bar width ──
if [ "$COLS" -ge 150 ] 2>/dev/null; then BAR_W=10
elif [ "$COLS" -ge 100 ] 2>/dev/null; then BAR_W=8
elif [ "$COLS" -ge 60 ] 2>/dev/null; then BAR_W=6
else BAR_W=4
fi

# ── Helpers ──
fmt_tok() {
  awk -v n="$1" 'BEGIN { if (n>=1000000) printf "%.1fM", n/1000000; else if (n>=1000) printf "%dk", n/1000; else printf "%d", n }'
}

fmt_cost() {
  awk -v n="$1" 'BEGIN { if (n>=100) printf "$%.0f", n; else if (n>=1) printf "$%.2f", n; else if (n>0) printf "$%.3f", n; else printf "$0" }'
}

pct_color() {
  local pct=${1:-0}
  if [ "$pct" -ge 80 ]; then echo "$C_RED"
  elif [ "$pct" -ge 50 ]; then echo "$C_YELLOW"
  else echo "$C_GREEN"
  fi
}

build_bar() {
  local pct=${1:-0} bw=${2:-$BAR_W}
  local color=$(pct_color "$pct")
  local filled=$((pct * bw / 100))
  [ "$filled" -gt "$bw" ] && filled=$bw
  local empty=$((bw - filled)) f="" e=""
  [ "$filled" -gt 0 ] && printf -v f "%${filled}s" && f="${f// /█}"
  [ "$empty" -gt 0 ] && printf -v e "%${empty}s" && e="${e// /░}"
  echo "${color}${f}${C_DIM}${e}${C_RESET} ${color}${pct}%${C_RESET}"
}

fmt_reset() {
  local resets_at="$1"
  if [ -z "$resets_at" ]; then return 1; fi
  local now diff_s
  now=$(date +%s)
  diff_s=$((resets_at - now))
  [ "$diff_s" -le 0 ] && return 1
  local mins=$((diff_s / 60))
  if [ "$mins" -lt 60 ]; then
    echo "${mins}m"
  elif [ "$mins" -lt 1440 ]; then
    local h=$((mins / 60)) m=$((mins % 60))
    [ "$m" -gt 0 ] && echo "${h}h${m}m" || echo "${h}h"
  else
    local d=$((mins / 1440)) rh=$(((mins % 1440) / 60))
    [ "$rh" -gt 0 ] && echo "${d}d${rh}h" || echo "${d}d"
  fi
}

join_seg() {
  # Usage: join_seg existing new_content
  if [ -n "$1" ]; then echo "$1 ${C_DIM}|${C_RESET} $2"
  else echo "$2"; fi
}

# Transcript observability and tok/s already came back from statusline-fields.py.
CUR_OUT="$CUR_OUT_FIELD"

# ══════════════════════════════════════════════════════════════
# LINE 1: project | 5h bar | 7d bar | context bar
# ══════════════════════════════════════════════════════════════
line1=""

if [ -n "$PROJECT_NAME" ]; then
  if [ -n "$BRANCH" ]; then
    line1="${C_GREEN}${PROJECT_NAME}${C_DIM}(${BRANCH})${C_RESET}"
  else
    line1="${C_GREEN}${PROJECT_NAME}${C_RESET}"
  fi
fi

# 5h bar
if [ -n "$USAGE_5H" ]; then
  U5=${USAGE_5H%.*}
  bar5h=$(build_bar "$U5")
  reset5h=$(fmt_reset "$RESET_5H")
  seg5h="${C_BLUE}5h${C_RESET}:${bar5h}"
  [ -n "$reset5h" ] && seg5h="${seg5h} ${C_DIM}(${reset5h})${C_RESET}"
  line1=$(join_seg "$line1" "$seg5h")
fi

# 7d bar
if [ -n "$USAGE_7D" ]; then
  U7=${USAGE_7D%.*}
  bar7d=$(build_bar "$U7")
  reset7d=$(fmt_reset "$RESET_7D")
  seg7d="${C_BLUE}7d${C_RESET}:${bar7d}"
  [ -n "$reset7d" ] && seg7d="${seg7d} ${C_DIM}(${reset7d})${C_RESET}"
  line1=$(join_seg "$line1" "$seg7d")
fi

# Per-model bars, one per model-scoped window the account has (today: Fable).
# Labelled from the API's own display_name rather than a hard-coded list, so a
# quota scoped to another model later appears here without a change.
while IFS= read -r limit_entry; do
  [ -z "$limit_entry" ] && continue
  limit_name="${limit_entry%%|*}"
  limit_rest="${limit_entry#*|}"
  limit_pct="${limit_rest%%|*}"
  limit_reset="${limit_rest##*|}"
  seg_model="${C_BLUE}${limit_name}${C_RESET}:$(build_bar "$limit_pct")"
  # `|| true`: fmt_reset signals "nothing to show" with a non-zero status, which
  # under an inherited `errexit` would abort the whole render before line 1 ever
  # prints — taking the project name and every other bar down with it.
  reset_model=$(fmt_reset "$limit_reset") || true
  [ -n "$reset_model" ] && seg_model="${seg_model} ${C_DIM}(${reset_model})${C_RESET}"
  line1=$(join_seg "$line1" "$seg_model")
done <<< "$MODEL_LIMIT_LINES"

[ -n "$line1" ] && printf '%b\n' "$line1"

# ══════════════════════════════════════════════════════════════
# LINE 2: Tokens: in/out (本轮: in/out) | Cached: X | Cost: $X
# ══════════════════════════════════════════════════════════════
line2=""

if [ "$TOTAL_IN" -gt 0 ] 2>/dev/null || [ "$TOTAL_OUT" -gt 0 ] 2>/dev/null \
   || [ "$CACHE_READ" -gt 0 ] 2>/dev/null || [ "$CACHE_CREATE" -gt 0 ] 2>/dev/null; then
  line2="${C_PEACH}本轮 input:${C_RESET} ${C_PEACH}$(fmt_tok "$TOTAL_IN")${C_RESET} ${C_DIM}(fresh $(fmt_tok "$CUR_IN") + cache_w $(fmt_tok "$CACHE_CREATE") + cache_r $(fmt_tok "$CACHE_READ"))${C_RESET}${C_PEACH}, out $(fmt_tok "$CUR_OUT")${C_RESET}"
fi

if [ "$COST" != "0" ] && [ -n "$COST" ]; then
  seg_cost="${C_MAGENTA}Cost: ${C_PEACH}$(fmt_cost "$COST")${C_RESET}"
  line2=$(join_seg "$line2" "$seg_cost")
fi

[ -n "$line2" ] && printf '%b\n' "$line2"

# ══════════════════════════════════════════════════════════════
# Context bar + Session-cumulative tokens (combined on one line)
# ══════════════════════════════════════════════════════════════
ctx_seg=""
if [ -n "$CTX_PCT" ] && [ "$CTX_PCT" != "0" ]; then
  ctx_bar=$(build_bar "$CTX_PCT")
  ctx_seg="Context:${ctx_bar}"
fi

session_seg=""
if [ "$ST_TOTAL" -gt 0 ] 2>/dev/null; then
  session_seg="${C_CYAN}Session: $(fmt_tok "$ST_TOTAL")${C_RESET} ${C_DIM}(in: $(fmt_tok "$ST_IN"), out: $(fmt_tok "$ST_OUT"), cache: $(fmt_tok "$ST_CACHE"))${C_RESET}"
fi

ctx_session_line=""
[ -n "$ctx_seg" ] && ctx_session_line="$ctx_seg"
[ -n "$session_seg" ] && ctx_session_line=$(join_seg "$ctx_session_line" "$session_seg")
[ -n "$ctx_session_line" ] && printf '%b\n' "$ctx_session_line"

# ══════════════════════════════════════════════════════════════
# LINE 3: duration | model
# ══════════════════════════════════════════════════════════════
line3=""

# Duration: prefer wall-clock from transcript
if [ -n "$SST" ] && [ "$SST" != "null" ]; then
  NOW_SEC=$(date +%s)
  WC_TOTAL=$(awk -v a="$NOW_SEC" -v b="$SST" 'BEGIN { print int(a - b) }')
  [ "$WC_TOTAL" -lt 0 ] 2>/dev/null && WC_TOTAL=0
  MINS=$((WC_TOTAL / 60)); SECS=$((WC_TOTAL % 60))
else
  MINS=$((DURATION_MS / 60000)); SECS=$(((DURATION_MS % 60000) / 1000))
fi

line3="${C_DIM}${C_MAGENTA}会话时长: ${MINS}m ${SECS}s${C_RESET}"
if [ -n "$SPEED" ]; then
  line3="${line3} ${C_DIM}· ${SPEED} tok/s${C_RESET}"
fi

# Model: "Opus 4.7 (1M)/xhigh/nofast"
# Upstream display_name may include "(... context)" — strip " context" suffix; absent → append size.
ctx_label=$(fmt_tok "$CTX_SIZE")
case "$MODEL" in
  *"context)") MODEL_NAME="${MODEL/ context)/)}" ;;
  *) MODEL_NAME="$MODEL (${ctx_label})" ;;
esac
if [ -n "$EFFORT" ]; then
  MODEL_DISPLAY="${C_DIM}${C_MAGENTA}${MODEL_NAME}/${EFFORT}${C_RESET}"
else
  MODEL_DISPLAY="${C_DIM}${C_MAGENTA}${MODEL_NAME}${C_RESET}"
fi
line3=$(join_seg "$line3" "$MODEL_DISPLAY")

# Session id, first group only. Its job is to tell one window from another —
# notably to match the peer named in a writer-registry conflict message, whose
# id starts with these same characters. The full 36-char id would cost this line
# half its width for characters the eye never compares.
# Guard the shortened value, not the raw one: an id that starts with `-` passes
# a check on the full string but shortens to nothing, leaving a bare label.
SHORT_SID="${SESSION_ID%%-*}"
if [ -n "$SHORT_SID" ]; then
  line3=$(join_seg "$line3" "${C_DIM}session-id ${SHORT_SID}${C_RESET}")
fi

# PID of the Claude Code process behind this window, so the session that
# session-id above only names can also be reached — found in `ps`, signalled,
# told apart from the other sessions on this machine.
# The statusline was measured to run as a direct child of that process; the walk
# exists so that an interposed wrapper shell reports the session rather than the
# wrapper, and at the observed depth it costs a single `ps`. Per-hop rather than
# one full-table snapshot: the table costs the same fork plus enumerating every
# process on the host, on every render of every session.
# Each `ps` is guarded by `|| break` rather than left bare, because an inherited
# `errexit` would otherwise abort the render before line 3 ever prints — the
# same hazard the `fmt_reset` call above guards against.
CLAUDE_PID=""
walk_pid="$PPID"
for _ in 1 2 3 4 5 6 7 8; do
  [ "$walk_pid" -gt 1 ] 2>/dev/null || break
  walk_row=$(ps -o ppid=,comm= -p "$walk_pid" 2>/dev/null) || break
  [ -n "$walk_row" ] || break
  walk_row="${walk_row#"${walk_row%%[![:space:]]*}"}"
  # Compare the basename, so that neither an install path containing spaces nor
  # a process that rewrote its own title (`claude bg-pty-host`) is mis-split.
  walk_comm="${walk_row#* }"
  case "${walk_comm##*/}" in
    claude|claude\ *) CLAUDE_PID="$walk_pid"; break ;;
  esac
  walk_pid="${walk_row%% *}"
done

# Nothing in the ancestry called itself `claude` — a `node …/cli.js` invocation,
# say. The parent is still where this script was observed to be spawned from, so
# it is the best available answer, but it is a guess: mark it, or the user reads
# an unconfirmed pid as a confirmed one and signals whatever now holds it.
if [ -n "$CLAUDE_PID" ]; then
  line3=$(join_seg "$line3" "${C_DIM}pid ${CLAUDE_PID}${C_RESET}")
else
  line3=$(join_seg "$line3" "${C_DIM}pid ${PPID}?${C_RESET}")
fi

printf '%b\n' "$line3"

# ══════════════════════════════════════════════════════════════
# LINE 4: environment metadata
# ══════════════════════════════════════════════════════════════
CWD="$PROJECT_DIR"
env_parts=""

CMD_COUNT=0
[ -f "$CLAUDE_DIR/CLAUDE.md" ] && CMD_COUNT=$((CMD_COUNT + 1))
[ -n "$CWD" ] && [ -f "$CWD/CLAUDE.md" ] && CMD_COUNT=$((CMD_COUNT + 1))
[ -n "$CWD" ] && [ -f "$CWD/CLAUDE.local.md" ] && CMD_COUNT=$((CMD_COUNT + 1))
[ -n "$CWD" ] && [ -f "$CWD/.claude/CLAUDE.md" ] && CMD_COUNT=$((CMD_COUNT + 1))
[ "$CMD_COUNT" -gt 0 ] && env_parts="${CMD_COUNT} CLAUDE.md"

RULES_COUNT=0
[ -d "$CLAUDE_DIR/rules" ] && RULES_COUNT=$(find "$CLAUDE_DIR/rules" -name '*.md' -type f 2>/dev/null | wc -l | tr -d ' ')
if [ -n "$CWD" ] && [ -d "$CWD/.claude/rules" ]; then
  PROJECT_RULES=$(find "$CWD/.claude/rules" -name '*.md' -type f 2>/dev/null | wc -l | tr -d ' ')
  RULES_COUNT=$((RULES_COUNT + PROJECT_RULES))
fi
[ "$RULES_COUNT" -gt 0 ] && env_parts="${env_parts:+${env_parts} ${C_DIM}|${C_RESET} }${RULES_COUNT} rules"

# MCP_COUNT / HOOKS_COUNT were counted during the single parse pass above.
[ "$MCP_COUNT" -gt 0 ] && env_parts="${env_parts:+${env_parts} ${C_DIM}|${C_RESET} }${MCP_COUNT} MCPs"
[ "$HOOKS_COUNT" -gt 0 ] && env_parts="${env_parts:+${env_parts} ${C_DIM}|${C_RESET} }${HOOKS_COUNT} hooks"

[ -n "$env_parts" ] && printf '%b\n' "${env_parts}"

# ══════════════════════════════════════════════════════════════
# LINE 5+: transcript-based (tools / agents / skills / todos)
# ══════════════════════════════════════════════════════════════
if [ "$HAS_TDATA" = "1" ]; then
  # Tools: running ◐ + completed ✓ (top-4)
  tool_parts=""
  while IFS= read -r t; do
    [ -z "$t" ] && continue
    tool_parts="${tool_parts:+${tool_parts} ${C_DIM}|${C_RESET} }${C_YELLOW}◐${C_RESET} ${C_CYAN}${t}${C_RESET}"
  done <<< "$TOOLS_RUNNING_LINES"
  while IFS= read -r t; do
    [ -z "$t" ] && continue
    tool_parts="${tool_parts:+${tool_parts} ${C_DIM}|${C_RESET} }${C_GREEN}✓${C_RESET} ${C_DIM}${t}${C_RESET}"
  done <<< "$TOOLS_DONE_LINES"
  [ -n "$tool_parts" ] && printf '%b\n' "$tool_parts"

  # Agents: ◐ running | ✓ done
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    icon="${line:0:1}"; rest="${line:2}"
    if [ "$icon" = "R" ]; then IC="${C_YELLOW}◐${C_RESET}"; else IC="${C_GREEN}✓${C_RESET}"; fi
    printf '%b\n' "${IC} ${C_MAGENTA}${rest}${C_RESET}"
  done <<< "$AGENT_LINES"

  # Skills: running ◐, completed with ×count, churn alert (≥3 yellow, ≥5 red)
  skill_parts=""
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    icon="${line%%|*}"; name="${line#*|}"; count="${name#*|}"; name="${name%%|*}"
    if [ "$icon" = "R" ]; then
      skill_parts="${skill_parts:+${skill_parts} ${C_DIM}|${C_RESET} }${C_YELLOW}◐${C_RESET} ${C_CYAN}${name}${C_RESET}"
    elif [ "$count" -ge 5 ] 2>/dev/null; then
      skill_parts="${skill_parts:+${skill_parts} ${C_DIM}|${C_RESET} }${C_RED}⚠${C_RESET} ${C_RED}${name}${C_RESET} ${C_RED}×${count}${C_RESET}"
    elif [ "$count" -ge 3 ] 2>/dev/null; then
      skill_parts="${skill_parts:+${skill_parts} ${C_DIM}|${C_RESET} }${C_YELLOW}!${C_RESET} ${C_YELLOW}${name}${C_RESET} ${C_YELLOW}×${count}${C_RESET}"
    else
      suffix=""; [ "$count" -gt 1 ] 2>/dev/null && suffix=" ${C_DIM}×${count}${C_RESET}"
      skill_parts="${skill_parts:+${skill_parts} ${C_DIM}|${C_RESET} }${C_GREEN}✓${C_RESET} ${C_DIM}${name}${C_RESET}${suffix}"
    fi
  done <<< "$SKILL_LINES"
  [ -n "$skill_parts" ] && printf '%b\n' "${C_DIM}skill:${C_RESET} ${skill_parts}"

  # Todos: ▸ in-progress | ✓ all complete
  if [ -n "$TODO_TOTAL" ]; then
    if [ -z "$TODO_CONTENT" ] || [ "$TODO_CONTENT" = "null" ]; then
      printf '%b\n' "${C_GREEN}✓${C_RESET} All complete ${C_DIM}(${TODO_COMPLETED}/${TODO_TOTAL})${C_RESET}"
    else
      printf '%b\n' "${C_YELLOW}▸${C_RESET} ${TODO_CONTENT} ${C_DIM}(${TODO_COMPLETED}/${TODO_TOTAL})${C_RESET}"
    fi
  fi
fi

exit 0
