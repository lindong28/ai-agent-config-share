#!/bin/bash
# tt-statusline.sh — Token Tracker style statusline with transcript observability
# Line 1: project | 5h bar | 7d bar | context bar
# Line 2: tokens | cached | cost
# Line 3: duration | model
# Line 4: env metadata (CLAUDE.md / rules / MCPs / hooks)
# Line 5: transcript (tools / agents / skills / todos)
# Also persists data to ~/.claude/tt-status.json for `tt` CLI dashboard

input=$(cat)

# ── Persist to tt-status.json (atomic write, add _received_at) ──
STATUS_FILE="$HOME/.claude/tt-status.json"
if [ -n "$input" ]; then
  tmp=$(mktemp "${STATUS_FILE}.XXXXXX" 2>/dev/null)
  if [ -n "$tmp" ]; then
    echo "$input" | jq --arg ts "$(date -u +%Y-%m-%dT%H:%M:%S+00:00)" \
      '. + {_received_at: $ts}' > "$tmp" 2>/dev/null && mv "$tmp" "$STATUS_FILE" 2>/dev/null
  fi
fi

# ── Parse core fields ──
PROJECT_DIR=$(echo "$input" | jq -r '.workspace.project_dir // .workspace.current_dir // .cwd // ""')
PROJECT_NAME=$(basename "$PROJECT_DIR" 2>/dev/null)
MODEL=$(echo "$input" | jq -r '.model.display_name // "?"')
EFFORT=$(echo "$input" | jq -r '.effort.level // empty')
COST=$(echo "$input" | jq -r '.cost.total_cost_usd // 0')

# Context window
CTX_PCT=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)
CTX_SIZE=$(echo "$input" | jq -r '.context_window.context_window_size // 0')

# Rate limits
USAGE_5H=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
RESET_5H=$(echo "$input" | jq -r '.rate_limits.five_hour.resets_at // empty')
USAGE_7D=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')
RESET_7D=$(echo "$input" | jq -r '.rate_limits.seven_day.resets_at // empty')

# Tokens (cumulative session)
TOTAL_IN=$(echo "$input" | jq -r '.context_window.total_input_tokens // 0')
TOTAL_OUT=$(echo "$input" | jq -r '.context_window.total_output_tokens // 0')
CACHE_READ=$(echo "$input" | jq -r '.context_window.current_usage.cache_read_input_tokens // 0')
CACHE_CREATE=$(echo "$input" | jq -r '.context_window.current_usage.cache_creation_input_tokens // 0')

# Tokens (current round)
CUR_IN=$(echo "$input" | jq -r '.context_window.current_usage.input_tokens // 0')
CUR_OUT_FIELD=$(echo "$input" | jq -r '.context_window.current_usage.output_tokens // 0')

# Duration / transcript
DURATION_MS=$(echo "$input" | jq -r '.cost.total_duration_ms // 0')
TRANSCRIPT=$(echo "$input" | jq -r '.transcript_path // empty')

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

# ── Transcript parse (shared by Line 3 duration + Line 5 observability) ──
TDATA=""
if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  TDATA=$(python3 "$HOME/.claude/statusline-transcript.py" "$TRANSCRIPT" 2>/dev/null)
fi

# ── Output speed tracking (tok/s) ──
SPEED=""
SPEED_CACHE="$HOME/.claude/statusline-cache/.speed.json"
CUR_OUT="$CUR_OUT_FIELD"
NOW_MS=$(python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null || echo 0)
if [ "$NOW_MS" -gt 0 ] && [ -f "$SPEED_CACHE" ]; then
  PREV_OUT=$(jq -r '.out // 0' "$SPEED_CACHE" 2>/dev/null || echo 0)
  PREV_MS=$(jq -r '.ts // 0' "$SPEED_CACHE" 2>/dev/null || echo 0)
  DT=$((NOW_MS - PREV_MS))
  DOT=$((CUR_OUT - PREV_OUT))
  if [ "$DT" -gt 0 ] && [ "$DT" -le 2000 ] && [ "$DOT" -gt 0 ]; then
    SPEED=$(awk -v dt="$DT" -v dtok="$DOT" 'BEGIN { printf "%.1f", dtok/(dt/1000) }')
  fi
fi
if [ "$NOW_MS" -gt 0 ]; then
  mkdir -p "$(dirname "$SPEED_CACHE")" 2>/dev/null
  printf '{"out":%d,"ts":%d}\n' "$CUR_OUT" "$NOW_MS" > "$SPEED_CACHE" 2>/dev/null
fi

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
if [ -n "$TDATA" ] && [ "$TDATA" != "{}" ]; then
  STI=$(echo "$TDATA" | jq -r '.session_tokens.in // 0' 2>/dev/null)
  STO=$(echo "$TDATA" | jq -r '.session_tokens.out // 0' 2>/dev/null)
  STCC=$(echo "$TDATA" | jq -r '.session_tokens.cache_creation // 0' 2>/dev/null)
  STCR=$(echo "$TDATA" | jq -r '.session_tokens.cache_read // 0' 2>/dev/null)
  STCACHE=$((STCC + STCR))
  STTOTAL=$((STI + STO + STCACHE))
  if [ "$STTOTAL" -gt 0 ] 2>/dev/null; then
    session_seg="${C_CYAN}Session: $(fmt_tok "$STTOTAL")${C_RESET} ${C_DIM}(in: $(fmt_tok "$STI"), out: $(fmt_tok "$STO"), cache: $(fmt_tok "$STCACHE"))${C_RESET}"
  fi
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
SST=$(echo "$TDATA" | jq -r '.session_start_ts // empty' 2>/dev/null)
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

printf '%b\n' "$line3"

# ══════════════════════════════════════════════════════════════
# LINE 4: environment metadata
# ══════════════════════════════════════════════════════════════
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
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

MCP_COUNT=0
[ -f "$CLAUDE_DIR/settings.json" ] && MCP_COUNT=$(jq '.mcpServers // {} | length' "$CLAUDE_DIR/settings.json" 2>/dev/null || echo 0)
if [ -n "$CWD" ] && [ -f "$CWD/.mcp.json" ]; then
  PROJECT_MCP=$(jq '.mcpServers // {} | length' "$CWD/.mcp.json" 2>/dev/null || echo 0)
  MCP_COUNT=$((MCP_COUNT + PROJECT_MCP))
fi
[ "$MCP_COUNT" -gt 0 ] && env_parts="${env_parts:+${env_parts} ${C_DIM}|${C_RESET} }${MCP_COUNT} MCPs"

HOOKS_COUNT=0
[ -f "$CLAUDE_DIR/settings.json" ] && HOOKS_COUNT=$(jq '.hooks // {} | length' "$CLAUDE_DIR/settings.json" 2>/dev/null || echo 0)
[ "$HOOKS_COUNT" -gt 0 ] && env_parts="${env_parts:+${env_parts} ${C_DIM}|${C_RESET} }${HOOKS_COUNT} hooks"

[ -n "$env_parts" ] && printf '%b\n' "${env_parts}"

# ══════════════════════════════════════════════════════════════
# LINE 5+: transcript-based (tools / agents / skills / todos)
# ══════════════════════════════════════════════════════════════
if [ -n "$TDATA" ] && [ "$TDATA" != "{}" ]; then
  # Tools: running ◐ + completed ✓ (top-4)
  tool_parts=""
  while IFS= read -r t; do
    [ -z "$t" ] && continue
    tool_parts="${tool_parts:+${tool_parts} ${C_DIM}|${C_RESET} }${C_YELLOW}◐${C_RESET} ${C_CYAN}${t}${C_RESET}"
  done < <(echo "$TDATA" | jq -r '.tools_running[]? | "\(.name)\(if .target then ": \(.target)" else "" end)"' 2>/dev/null)
  while IFS= read -r t; do
    [ -z "$t" ] && continue
    tool_parts="${tool_parts:+${tool_parts} ${C_DIM}|${C_RESET} }${C_GREEN}✓${C_RESET} ${C_DIM}${t}${C_RESET}"
  done < <(echo "$TDATA" | jq -r '.tools_completed | to_entries | sort_by(-.value)[:4][] | "\(.key) ×\(.value)"' 2>/dev/null)
  [ -n "$tool_parts" ] && printf '%b\n' "$tool_parts"

  # Agents: ◐ running | ✓ done
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    icon="${line:0:1}"; rest="${line:2}"
    if [ "$icon" = "R" ]; then IC="${C_YELLOW}◐${C_RESET}"; else IC="${C_GREEN}✓${C_RESET}"; fi
    printf '%b\n' "${IC} ${C_MAGENTA}${rest}${C_RESET}"
  done < <(echo "$TDATA" | jq -r '
    [(.agents[]? | select(.status == "running"))] + [(.agents[]? | select(.status != "running"))]
    | .[-3:][]
    | (if .status == "running" then "R" else "D" end) + " "
      + .type
      + (if .model then " [2m[\(.model)][0m" else "" end)
      + (if .desc != "" then "[2m: \(.desc)[0m" else "" end)
      + " [2m(" + (if .elapsed_s < 0 then "0s" elif .elapsed_s < 60 then "\(.elapsed_s)s" else "\(.elapsed_s / 60 | floor)m \(.elapsed_s % 60)s" end) + ")[0m"
  ' 2>/dev/null)

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
  done < <(echo "$TDATA" | jq -r '.skills[]? | (if .status == "running" then "R" else "D" end) + "|" + .name + "|" + ((.count // 1) | tostring)' 2>/dev/null)
  [ -n "$skill_parts" ] && printf '%b\n' "${C_DIM}skill:${C_RESET} ${skill_parts}"

  # Todos: ▸ in-progress | ✓ all complete
  TODO_CONTENT=$(echo "$TDATA" | jq -r '.todos.content // empty' 2>/dev/null)
  TODO_COMPLETED=$(echo "$TDATA" | jq -r '.todos.completed // empty' 2>/dev/null)
  TODO_TOTAL=$(echo "$TDATA" | jq -r '.todos.total // empty' 2>/dev/null)
  if [ -n "$TODO_TOTAL" ]; then
    if [ -z "$TODO_CONTENT" ] || [ "$TODO_CONTENT" = "null" ]; then
      printf '%b\n' "${C_GREEN}✓${C_RESET} All complete ${C_DIM}(${TODO_COMPLETED}/${TODO_TOTAL})${C_RESET}"
    else
      printf '%b\n' "${C_YELLOW}▸${C_RESET} ${TODO_CONTENT} ${C_DIM}(${TODO_COMPLETED}/${TODO_TOTAL})${C_RESET}"
    fi
  fi
fi

exit 0
