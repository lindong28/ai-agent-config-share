#!/usr/bin/env bash
# Terminal tab-title indicator for Claude Code processing state.
#
# Sets the tab title to "⏳ <cwd>" (busy) / "<cwd>" (idle/alert). Wiring is
# deployment-specific — in this repo's full install, hooks in
# ~/.claude/settings.json invoke it (UserPromptSubmit/PreToolUse/PostToolUse →
# busy; SessionStart/Stop → idle; Notification → alert); subset deployments may
# wire it only on the Codex side (codex/hooks.json) or not at all. Also called
# directly by ask-recommend-gate.js (alert) when a question is about to be shown.
#
# Three states are readable off one tab, which is the whole point:
#   ⏳ <cwd>   working
#   🔔 <cwd>   stopped and you have not looked yet — 🔔 is Ghostty's, added on
#              BEL and cleared by focus or a keypress, so "looked at it" is
#              exactly what clears it (see the alert paragraph below)
#      <cwd>   stopped, and seen
#
# This hook must be the ONLY thing writing the title, which is why settings.json
# sets CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1. The CLI otherwise writes its own
# "✳ <task summary>" over the same OSC, and with two writers the title belongs to
# whoever wrote last — so "⏳ is missing" and "it really did stop" render
# identically, collapsing exactly the distinction this hook exists to draw. The
# summary is the more informative string of the two; it loses because it cannot
# carry state, and state is what the tab strip is being scanned for.
#
# Stop clears the ⏳ but deliberately does NOT ring: hooks matching one event run
# in parallel, so a Stop-fired bell precedes stop-gate.js's verdict and rings for
# turns that are then forced to continue. The bell rides Notification instead —
# same reasoning, and the same split, as desktop-notify.js's header explains.
#
# The "alert" state is identical to "idle" but also emits a BEL (\a) so Ghostty's
# `bell-features = title` prepends 🔔 to the tab title of an *unfocused* surface —
# a per-tab "message waiting for you" indicator that clears the moment you focus
# the tab. With no `system`/`audio` in bell-features the BEL is silent: it only
# lights 🔔 (plus one dock bounce via the `attention` feature).
#
# Works local, over SSH, and inside tmux:
#   - Hooks have no controlling TTY (/dev/tty is ENXIO), so we locate the PTY
#     by walking up the process tree (ps -o tty=) — same approach as
#     desktop-notify.js.
#   - Inside tmux the two signals take DIFFERENT channels, on purpose. The title
#     is a PLAIN OSC 0 written to the pane PTY: tmux consumes it, stores it as
#     that pane's `pane_title`, and (with `set-titles on`, see tmux.conf in
#     system-config) re-renders the outer terminal's title from
#     `set-titles-string` — for the pane each client is actually displaying, and
#     again whenever you switch pane/window. The BEL bypasses tmux entirely (see
#     emit_bel): gating a "look at the pane you are NOT watching" indicator on
#     that pane being watched defeats it.
#   - Over plain SSH we write to the login shell's controlling terminal, whose
#     output flows back to the local terminal. That device is the same one
#     SSH_TTY names (measured: a real non-tmux ssh session had SSH_TTY, the
#     shell's ctty and pick_tty's result all = /dev/ttys001) — but the variable
#     itself is no longer consulted, for the reasons in pick_tty's header.
#     TERM_PROGRAM is NOT forwarded over SSH / inside tmux, so we must NOT gate
#     on TERM_PROGRAM=ghostty there — OSC 0 is a universal title sequence any
#     terminal honors. SSH_TTY/SSH_CONNECTION still gate that emission decision
#     at the bottom of this file; being unfit to name a target does not make an
#     env var unfit to say "there is a remote terminal somewhere".
#
# Why pane_title and not the tmux passthrough DCS, which this hook used before:
# passthrough does not exist below tmux 3.3, and Ubuntu 22.04 (every DGX node)
# ships 3.2a, so the wrapped title was swallowed whole — Claude ran in tmux there
# and the tab never updated. pane_title needs no passthrough, works identically
# on 3.2a and 3.3+, and hands tmux the multi-pane bookkeeping (per-client
# visibility, redraw on switch) that the passthrough version could only
# approximate: with it, a title set while the pane was hidden simply stayed
# stale until the next hook fired.
#
# The tmux-side prerequisite is `set-titles on` — off by default, and off is
# indistinguishable from "hook not firing", since the failure is a title that
# never changes rather than an error. It lives in system-config's tmux.conf.
#
# OSC 0 (not 2): updates both window title and icon/tab name; OSC 2 leaves the
# tab label stale on some Ghostty configs.
#
# Stdin is drained and re-emitted so chained hooks downstream still receive the
# transcript payload.

set -u

raw="$(cat 2>/dev/null || true)"
state="${1:-idle}"

# A JSON string field, without a JSON parser (this hook must stay dependency-free
# and cheap — it runs on every tool call).
payload_field() {
  printf '%s' "$raw" \
    | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
    | head -1 \
    | sed 's/.*"\([^"]*\)"$/\1/'
}

# PreToolUse fires for AskUserQuestion as well, but that tool is Claude WAITING
# on you — painting ⏳ there would hide the one state this indicator exists to
# show. Leave the title alone and let ask-recommend-gate.js's allow path light
# the bell instead: that gate can deny the call outright, and a question you are
# never shown must not ring. (Same reasoning, same emission point, as the
# "等你选择" desktop notification — see desktop-notify.js.)
if [ "$state" = "busy" ] \
   && [ "$(payload_field hook_event_name)" = "PreToolUse" ] \
   && [ "$(payload_field tool_name)" = "AskUserQuestion" ]; then
  printf '%s' "$raw"
  exit 0
fi

# The Notification event is not "the user is needed" — it also carries
# auth_success and elicitation_*, which want nothing from anyone. Ringing for
# those inflates 🔔 from "this tab is waiting on me" into "something happened
# here", and an indicator that cries wolf is worse than none: the whole value of
# the third state is that a bell always means action. Worse, a notification
# arriving mid-work would also clear ⏳ and paint the tab as stopped.
#
# Allowlist rather than a deny-list of the two known-noisy types, so a
# notification_type added upstream later is silent until someone decides it
# deserves attention. Mirrors buildBody() in desktop-notify.js, which returns
# null for exactly the same set — the two must agree, since a desktop
# notification and this bell are the same claim on two channels.
if [ "$state" = "alert" ] \
   && [ "$(payload_field tool_name)" != "AskUserQuestion" ]; then
  case "$(payload_field notification_type)" in
    permission_prompt | idle_prompt) ;;
    *) printf '%s' "$raw"; exit 0 ;;
  esac
fi

if [ "$PWD" = "$HOME" ]; then
  cwd_path="~"
elif [[ "$PWD" == "$HOME/"* ]]; then
  cwd_path="~${PWD#$HOME}"
else
  cwd_path="$PWD"
fi

# Walk up the process tree to the nearest ancestor that owns a real PTY.
# Hook → sh -c(no tty) → claude(pty). Echoes "/dev/<pty>" or nothing.
# An ancestor counts only when /dev/<pty> is a real character device: `ps -o tty=`
# spells "no tty" as "??" on macOS but "?" on Linux, so a guard written against
# "??" alone yielded the bogus path "/dev/?" and killed this on Linux.
find_ancestor_pty() {
  local pid=$PPID pty="" hops=0
  while [ "$pid" -gt 1 ] && [ "$hops" -lt 12 ]; do
    pty=$(ps -o tty= -p "$pid" 2>/dev/null | tr -d ' ')
    if [ -n "$pty" ] && [ -c "/dev/$pty" ]; then
      echo "/dev/$pty"
      return
    fi
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    [ -n "$pid" ] || return
    hops=$((hops + 1))
  done
}

# Pick the tty whose output reaches the user's terminal.
#
# Every source here has to be one this process can show it OWNS. SSH_TTY cannot,
# so it is gone from this function entirely — it used to be the first choice
# outside tmux.
#
# What it actually is: `ssh(1)` defines it as the tty ssh allocated for the
# current shell, and nothing updates it afterwards. Under mosh it therefore
# names the bootstrap pty rather than the one you are typing into. Two separate
# readings, kept separate on purpose: mosh's man page supplies only the first
# half — ssh starts `mosh-server`, then the ssh connection is closed — while
# "the shell ends up on a different pty" comes from a live process reading here,
# not from the manual. That reading: SSH_TTY=/dev/ttys003, absent from /dev,
# while the same session's chain was mosh-server → zsh → claude on /dev/ttys006,
# and every title write of that session was landing in tab-title.jsonl as a
# failure.
#
# An existence check does not rescue it, and that is the whole reason it is
# removed rather than guarded: `-c` proves "is a char device right now", never
# "belongs to this session". macOS recycles pty numbers, so a dead SSH_TTY can
# come back as a live device owned by another tab, and a `-c`-guarded write
# would retitle that stranger. Worse, the case where a fallback would be reached
# at all is the case where it is least trustworthy: the walk below returns empty
# exactly when ownership could NOT be established from the process tree — no
# ancestor held a controlling terminal, `ps` failed, the chain outran the hop
# limit, or the device was revoked mid-walk. Whichever of those it was, nothing
# about it makes a simultaneously-live SSH_TTY more likely to be ours; it is the
# moment we know least about who owns what, which is the worst possible moment
# to write somewhere on the strength of a stale name.
#
# What the walk gives instead: `ps -o tty=` reports the CONTROLLING terminal, so
# it can only ever name a pty this process descends from. That is an ownership
# guarantee, not a visibility one — the two come apart when something between
# the ancestor and the user re-terminals the stream (screen, a session recorder,
# any pty broker), where the ctty is the INNER pty and OSC 0 lands in the broker
# rather than the outer tab. This host runs claude directly under mosh/ssh with
# at most tmux in between, and tmux is handled by its own branch below, so no
# such layer is in the path here; introduce one and this function needs revising.
# Under plain ssh with no broker the ancestor pty and SSH_TTY are the same
# device, which is why dropping SSH_TTY costs that path nothing.
#
# The tmux branch keeps its own exclusive return, and always did. Falling
# through would be a regression rather than a rescue: inside a long-lived pane
# SSH_TTY names whichever ssh session created the pane, which may be attached
# elsewhere entirely (desktop-notify.js's pickTargets() documents an observed
# case).
#
# That twin still tries SSH_TTY before its own walk outside tmux, with only the
# `-c` guard, so the recycling hole above remains open on its side. Twins, not
# clones — it should follow, but its delivery path (OSC 9, plus a mosh relay
# with no analogue here) makes that its own change rather than a copy of this.
#
# Returning nothing is a deliberate outcome, not a gap: emit_osc logs the miss
# and emit_bel returns quietly. A tab that fails to update is recoverable by the
# next hook; a title written into someone else's tab is not.
pick_tty() {
  local pty
  if [ -n "${TMUX:-}" ]; then
    # tmux: the pane PTY; server unwraps passthrough and forwards to the client.
    find_ancestor_pty
    return
  fi
  pty="$(find_ancestor_pty)"
  if [ -n "$pty" ]; then
    echo "$pty"
  elif { exec 9>/dev/tty; } 2>/dev/null; then
    # This process's own controlling terminal — ownership is definitional. In
    # practice unreachable (hooks get ENXIO here, see the header), kept because
    # it is the one remaining source that cannot name a stranger's device.
    exec 9>&-
    echo "/dev/tty"
  fi
}

# Failures only. Every write used to be `2>/dev/null || true` with nothing
# recorded, so a write that never reached the pty and one that landed were
# externally identical — and a tab stuck on ⏳ could not be attributed. Recording
# successes too would not fix that attribution: the two writes that could race
# here land well inside one second, which is the finest timestamp available to a
# shell builtin, and the stamp is taken after the write anyway. So this answers
# the one question it can answer — was a write dropped — and stays silent on
# ordering rather than inviting a false reading of it. Failures being rare also
# keeps the file bounded without the rotation a per-tool-call log would need.
log_write_failure() {
  local state="$1" tty="$2" pid="$3" log="$HOME/.claude/logs/tab-title.jsonl" size
  mkdir -p "${log%/*}" 2>/dev/null || return
  # Failures are rare only while the indicator is healthy. A tty that stays
  # unresolvable turns every tool call into an append, so the file is capped
  # rather than merely expected to stay small; one generation is kept because
  # the interesting record is the onset, which the rotated copy preserves.
  size=$(stat -f%z "$log" 2>/dev/null || stat -c%s "$log" 2>/dev/null || echo 0)
  [ "${size:-0}" -gt 262144 ] && mv -f "$log" "$log.1" 2>/dev/null
  # printf's %(fmt)T is bash 4.2+, and every current call site runs this hook
  # as `bash <path>`, so PATH picks the interpreter -- on a stock macOS that is
  # /bin/bash 3.2. There
  # it is not a degraded timestamp but an "invalid format character" that
  # truncates the line at that point, appending a bare `{"ts":"` with no newline
  # and no fields; the surrounding 2>/dev/null || true swallows the complaint,
  # so the log fills with unparseable fragments and the 256KiB cap then evicts
  # the one rotated generation holding real records.
  #
  # `date` is a fork, and the paragraph above about a persistently unresolvable
  # tty means this can become per-tool-call rather than rare. It is still the
  # right trade: one fork buys a parseable record, and this function already
  # forks `stat` on every call a few lines up. What must not be paid on the
  # hot path is a fork for a value already in hand -- that is the distinction
  # the ${BASHPID:-$$} guard below preserves, not "never fork here".
  local ts
  ts="$(date +%Y-%m-%dT%H:%M:%S%z 2>/dev/null)" || ts=""
  # umask rather than create-then-chmod: two hooks racing an existence check
  # would let the second truncate what the first just wrote, and chmod after
  # creation leaves a window at the ambient umask.
  #
  # ts_json carries its own quoting so a failed `date` yields JSON null rather
  # than "": an empty string cannot be told apart from a real-but-empty stamp,
  # while null says "not recorded" on its own. Built with an if rather than
  # ${ts:+...}${ts:-...} -- that pairing looks like an either/or but both halves
  # expand when ts is set, producing "<ts>"<ts> and invalid JSON on the common
  # path.
  local ts_json
  if [ -n "$ts" ]; then ts_json="\"$ts\""; else ts_json="null"; fi
  ( umask 077
    printf '{"ts":%s,"state":"%s","tty":"%s","pid":%d}\n' \
      "$ts_json" "$state" "$tty" "$pid" >> "$log"
  ) 2>/dev/null || true
}

# Resolved once and kept, so the delayed re-assert below does not have to find
# the pty again: by the time it runs this process has exited, and the ancestor
# walk it would repeat starts from a pid that is already gone.
RESOLVED_TTY=""

# Who intends to own this tab's title, so the delayed re-assert below can tell
# whether anyone claimed it in the meantime. Per tty, because one machine runs
# many sessions and each owns a different tab. Overwritten in place.
#
# Claimed BEFORE the write, not recorded after it, and that ordering is the
# whole design. Recording afterwards fails twice: a busy landing between another
# writer's tty write and its bookkeeping would be overwritten anyway, and a
# primary write that FAILED would record nothing — leaving the re-assert to see
# a stale claim and stand down in exactly the dropped-write case it exists for.
# Claiming first makes the token depend only on who started last, which is the
# question being asked.
INTENT_TOKEN=""

state_file() {
  [ -n "$RESOLVED_TTY" ] || return 1
  printf '%s/.tab-title-intent-%s' "$HOME/.claude/logs" "${RESOLVED_TTY##*/}"
}

# BASHPID (bash 4.0+) and EPOCHREALTIME (bash 5.0+) are dynamic variables, not
# builtins. Every current call site invokes this hook as `bash <path>` --
# settings.json's hook entries and ask-recommend-gate.js's spawnSync alike --
# so in practice PATH selects the interpreter, and on a stock macOS that is
# /bin/bash 3.2, where neither variable exists. The file is executable, so a
# direct `<path>` invocation would honour the shebang; the guards below hold
# either way, which is the point of guarding rather than pinning a version.
# Under `set -u` an unguarded $BASHPID is not a degraded token: it aborts the
# hook, so every invocation died with "BASHPID: unbound variable" before writing
# anything. Guard both rather than reach for `date`, which is a fork -- not
# because this path is fork-free (it is not: state_file, pick_tty and
# payload_field all fork above), but because a value already in hand needs no
# process.
#
# $$ is the correct stand-in here: claim_intent and emit_osc both run in the
# hook's main process, where $$ and BASHPID are equal by definition. They
# diverge only inside subshells -- which is why reassert_idle's background block
# writes a plain $$ instead of this guard: it wants the hook's identity, and
# ${BASHPID:-$$} would hand it the subshell's own pid on bash 4/5 while giving
# the hook's on 3.2, i.e. two different meanings for the same log field.
#
# On 3.2 the timestamp half collapses to a constant 0, leaving pid as the sole
# distinguishing component. That still holds: each hook invocation is its own
# process, so consecutive claims carry different pids. Losing a component can
# only make two unequal tokens compare equal, never the reverse -- so the
# degradation cannot suppress a re-assert that should happen, only permit one
# that should not. Such a collision needs the same state prefix AND a reused pid
# within 0.7s; the resulting write is the same state, though not necessarily the
# same bytes: it repaints the cwd captured by *that* invocation, so a collision
# across a directory change could momentarily show a stale path.
claim_intent() {
  local f
  f="$(state_file)" || return
  mkdir -p "${f%/*}" 2>/dev/null || return
  INTENT_TOKEN="$1:${BASHPID:-$$}:${EPOCHREALTIME:-0}"
  { printf '%s' "$INTENT_TOKEN" > "$f"; } 2>/dev/null || true
}

emit_osc() {
  local body="$1" state="${2:-?}"
  [ -n "$RESOLVED_TTY" ] || RESOLVED_TTY="$(pick_tty)"
  claim_intent "$state"
  # Braces so 2>/dev/null covers the redirection itself — same reason as
  # emit_bel below: a failing `> "$tty"` is reported by the shell before an
  # inline 2>/dev/null applies, and would leak to the hook's stderr.
  if [ -z "$RESOLVED_TTY" ] || ! { printf '\033]0;%s\007' "$body" > "$RESOLVED_TTY"; } 2>/dev/null; then
    log_write_failure "$state" "$RESOLVED_TTY" "${BASHPID:-$$}"
  fi
}

# Hooks for one event are separate processes with no ordering guarantee between
# them, and the harness kills any that outruns its timeout. Both failure modes
# strand the tab on ⏳ — a busy write from the turn's last PostToolUse landing
# after Stop's idle, or that idle write being dropped outright — and neither
# reports itself. Re-asserting idle once, shortly after, closes both without
# needing to know which occurred: the state is idempotent, so a redundant write
# costs one OSC sequence. Kept under the hook's 2s timeout, detached from stdio
# so the hook still exits immediately.
#
# `disown` drops the job from bash's table but does NOT leave the process group,
# so a group-directed kill at the timeout takes this child with it. That is
# accepted rather than worked around: 0.7s sits well inside the 2s budget, and
# `setsid` is not available as a bash builtin here. It costs the re-assert in
# exactly the runs where the hook was already too slow to be trusted.
#
# It must also not undo a legitimate busy: a prompt submitted within the delay
# paints ⏳ for a turn that really is running, and a re-assert that fired blindly
# would repaint "stopped" over it — the same false-idle defect this indicator
# already suffers from elsewhere, made worse. So it re-reads the recorded state
# first and writes only while idle is still the newest. The read-to-write gap is
# microseconds against a 0.7s exposure, which is the whole of the improvement.
reassert_idle() {
  local body="$1" tty="$RESOLVED_TTY" sf token="$INTENT_TOKEN"
  [ -n "$tty" ] && [ -n "$token" ] || return
  sf="$(state_file)" || return
  (
    sleep 0.7
    [ "$(cat "$sf" 2>/dev/null)" = "$token" ] || exit 0
    { printf '\033]0;%s\007' "$body" > "$tty"; } 2>/dev/null \
      || log_write_failure "idle-reassert" "$tty" "$$"
  ) >/dev/null 2>&1 &
  disown 2>/dev/null || true
}

# The ttys of every tmux client attached to THIS pane's session. Each is the
# outer terminal's own stream, so a byte written there bypasses tmux entirely.
# Scoped by session id on purpose: `list-clients -t ''` neither fails nor returns
# empty — it resolves to tmux's current session and would ring ANOTHER session's
# terminal, so the empty-id guard below is load-bearing.
#
# Twin of tmuxClientTTYs() in desktop-notify.js: same algorithm, same guard, both
# on the Notification path. Change one, change the other. They already differ in
# that the JS side puts a timeout on every tmux call and opens with
# O_WRONLY|O_NOCTTY.
tmux_client_ttys() {
  local session
  [ -n "${TMUX_PANE:-}" ] || return
  session="$(tmux display -p -t "$TMUX_PANE" '#{session_id}' 2>/dev/null)"
  [ -n "$session" ] || return
  tmux list-clients -t "$session" -F '#{client_tty}' 2>/dev/null
}

# Emit a lone BEL to trigger Ghostty's `title` bell-feature (🔔 on an unfocused
# tab). Unlike the title above, this must NOT go through tmux passthrough: tmux
# forwards a pane's output only to clients currently displaying it, so the bell
# would fall silent in exactly the case it exists for — a pane you are not
# watching. Write it straight to each attached client tty instead. (The title
# keeps passthrough deliberately: a title describes the pane you ARE looking at,
# so tmux's visibility scoping is correct there.)
#
# Two costs of that split, both accepted:
#   - The tab can read "🔔 ⏳ <cwd>": the title froze at ⏳ when the pane went
#     hidden, while the bell still lands. Focusing the tab clears 🔔 but not the
#     stale ⏳, which only refreshes on the next hook fired while the pane is
#     visible. Before this split both were dropped together, so they were always
#     consistent — the inconsistency is the price of a bell that actually rings.
#   - tmux never sees the BEL, so `monitor-bell` / `window_bell_flag` stay unset
#     and the status line cannot say WHICH window rang. With two Claude panes in
#     one session the 🔔 is ambiguous. Recovering that would mean also writing a
#     bare BEL to the pane pty, which depends on the reader's tmux bell config
#     (`bell-action none` / `visual-bell on` change or swallow it) — hence not
#     the primary path.
emit_bel() {
  local tty rang=""
  if [ -n "${TMUX:-}" ]; then
    # Process substitution, not a pipe: a piped `while` runs in a subshell and
    # `rang` would never escape it, silently disabling the fallback below.
    while IFS= read -r tty; do
      [ -c "$tty" ] || continue
      # Braces so 2>/dev/null covers the redirection itself — the shell reports
      # a failing `> "$tty"` before an inline 2>/dev/null applies, which would
      # leak to the hook's stderr on every Stop. And `rang` must track a bell
      # that LANDED, not one attempted: a client can detach between
      # list-clients and this write, and a fallback keyed on "attempted" would
      # never run.
      { printf '\007' > "$tty"; } 2>/dev/null && rang=1
    done < <(tmux_client_ttys)
    [ -n "$rang" ] && return
    # Reached only when the client query failed mechanically (tmux not on PATH,
    # TMUX_PANE unset). A detached session has no terminal to ring, on any
    # tmux version, so this cannot rescue that case — it just costs nothing.
    tty="$(pick_tty)"
    [ -n "$tty" ] || return
    printf '\033Ptmux;\007\033\\' > "$tty" 2>/dev/null || true
    return
  fi
  tty="$(pick_tty)"
  [ -n "$tty" ] || return
  printf '\007' > "$tty" 2>/dev/null || true
}

# Emit when we can plausibly reach the user's terminal:
#   - tmux / SSH: TERM_PROGRAM is unreliable; the PTY path is the real signal.
#   - local: only when Ghostty, to avoid hijacking other terminals' titles.
if [ -n "${TMUX:-}" ] || [ -n "${SSH_TTY:-}" ] || [ -n "${SSH_CONNECTION:-}" ] \
   || [ "${TERM_PROGRAM:-}" = "ghostty" ] || [ -n "${GHOSTTY_RESOURCES_DIR:-}" ]; then
  case "$state" in
    busy)  emit_osc "⏳ $cwd_path" busy ;;
    idle)  emit_osc "$cwd_path" idle; reassert_idle "$cwd_path" ;;
    alert) emit_osc "$cwd_path" alert; emit_bel ;;
  esac
fi

printf '%s' "$raw"
exit 0
