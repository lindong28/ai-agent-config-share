#!/usr/bin/env bash
# verify.sh — check whether ai-agent-config-share is fully installed.
#
# Prints a structured report with one line per check:
#   [PASS] <subsystem>: <detail>
#   [WARN] <subsystem>: <detail>          (degraded but not fatal)
#   [FAIL] <subsystem>: <detail>          (something is broken / missing)
#   [INFO] <subsystem>: <detail>          (needs human judgment, not a verdict)
#
# Exit code = number of FAILs (clamped to 255). 0 = clean install.
#
# Run after ./install.sh. Idempotent — purely read-only.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_ROOT="$SCRIPT_DIR/claude"

pass=0
warn=0
fail=0

# ANSI color setup. Disabled when stdout is not a TTY or NO_COLOR is set
# (see https://no-color.org/), so redirecting to a file or pipe keeps the
# output clean.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    C_RESET=$'\033[0m'
    C_PASS=$'\033[32m'  # green
    C_FAIL=$'\033[31m'  # red
    C_WARN=$'\033[33m'  # yellow
    C_INFO=$'\033[36m'  # cyan
else
    C_RESET=""; C_PASS=""; C_FAIL=""; C_WARN=""; C_INFO=""
fi

emit() {
    # $1 = level (PASS|WARN|FAIL|INFO), $2 = subsystem, $3 = message
    local color=""
    case "$1" in
        PASS) color="$C_PASS"; pass=$((pass + 1)) ;;
        WARN) color="$C_WARN"; warn=$((warn + 1)) ;;
        FAIL) color="$C_FAIL"; fail=$((fail + 1)) ;;
        INFO) color="$C_INFO" ;;
    esac
    printf '%s[%s]%s %s: %s\n' "$color" "$1" "$C_RESET" "$2" "$3"
}

# files_equal: returns 0 if two paths have byte-identical content
# (cmp for files, recursive diff for directories). Type mismatch = no match.
files_equal() {
    local a="$1" b="$2"
    if [ -d "$a" ] && [ -d "$b" ]; then
        diff -rq "$a" "$b" >/dev/null 2>&1
    elif [ -f "$a" ] && [ -f "$b" ]; then
        cmp -s "$a" "$b"
    else
        return 1
    fi
}

# ---------- Symlink checks ----------
# Verify each file the installer should have symlinked points at this repo.

check_symlink() {
    # $1 = subsystem label, $2 = expected target (in repo), $3 = link path
    local label="$1" expected="$2" link="$3"

    if [ ! -e "$expected" ]; then
        emit WARN "$label" "source missing in repo: $expected (skip)"
        return
    fi
    if [ ! -L "$link" ]; then
        if [ -e "$link" ]; then
            if files_equal "$expected" "$link"; then
                emit PASS "$label" "$link (regular copy, content matches repo)"
            else
                emit FAIL "$label" "$link exists but content differs from repo"
            fi
        else
            emit FAIL "$label" "$link not installed"
        fi
        return
    fi
    local actual
    actual="$(readlink "$link")"
    if [ "$actual" = "$expected" ]; then
        emit PASS "$label" "$link -> repo"
    else
        emit FAIL "$label" "$link -> $actual (expected -> $expected)"
    fi
}

check_symlink_tree() {
    # $1 = subsystem label, $2 = src dir in repo, $3 = dst dir, $4 = file glob
    local label="$1" src_dir="$2" dst_dir="$3" pattern="$4"

    if [ ! -d "$src_dir" ]; then
        emit WARN "$label" "source dir missing in repo: $src_dir"
        return
    fi
    local count=0 broken=0 missing=0 matched_copies=0
    while IFS= read -r -d '' src_file; do
        count=$((count + 1))
        local rel="${src_file#"$src_dir"/}"
        local link="$dst_dir/$rel"
        if [ -L "$link" ]; then
            local actual
            actual="$(readlink "$link")"
            if [ "$actual" != "$src_file" ]; then
                broken=$((broken + 1))
                emit FAIL "$label" "$link -> $actual (expected -> $src_file)"
            fi
        elif [ -e "$link" ]; then
            if files_equal "$src_file" "$link"; then
                matched_copies=$((matched_copies + 1))
            else
                missing=$((missing + 1))
                emit FAIL "$label" "$link exists but content differs from repo"
            fi
        else
            missing=$((missing + 1))
            emit FAIL "$label" "$link not installed"
        fi
    done < <(find "$src_dir" -type f -name "$pattern" -print0)

    local good=$((count - broken - missing))
    if [ "$count" -gt 0 ] && [ "$missing" -eq 0 ] && [ "$broken" -eq 0 ]; then
        if [ "$matched_copies" -gt 0 ]; then
            local symlinked=$((good - matched_copies))
            emit PASS "$label" "$good/$count installed ($symlinked symlinked + $matched_copies content-matching copies)"
        else
            emit PASS "$label" "$good/$count files symlinked to repo"
        fi
    elif [ "$count" -eq 0 ]; then
        emit WARN "$label" "no files found under $src_dir"
    fi
}

echo "=== Symlinks ==="
check_symlink_tree "commands"       "$SRC_ROOT/commands/custom"      "$HOME/.claude/commands/custom"  "*.md"
check_symlink_tree "routines"       "$SRC_ROOT/commands/routine"     "$HOME/.claude/commands/routine" "*.md"
check_symlink_tree "references"     "$SRC_ROOT/references"           "$HOME/.claude/references"       "*.md"
check_symlink_tree "claude-agents"  "$SRC_ROOT/agents"               "$HOME/.claude/agents"          "*.md"
check_symlink_tree "codex-agents"   "$SCRIPT_DIR/codex/agents"       "$HOME/.codex/agents"           "*.toml"
# Derived from the source dir rather than listed, so a newly added skill cannot end up
# installed-but-unverified — which is how deep-discuss previously slipped through.
for skill_src in "$SRC_ROOT/skills"/*/; do
    [ -f "$skill_src/SKILL.md" ] || continue
    skill_name="$(basename "$skill_src")"
    check_symlink  "skills/$skill_name (claude)" "${skill_src%/}" "$HOME/.claude/skills/$skill_name"
    check_symlink  "skills/$skill_name (codex)"  "${skill_src%/}" "$HOME/.codex/skills/$skill_name"
done
check_symlink      "ask-user-mcp"         "$SCRIPT_DIR/ask-user-mcp"       "$HOME/.codex/ask-user-mcp"
# install.sh picks the platform artifact and links it AS codeagent-wrapper, so the
# expected source is the per-platform build, not the in-repo run-time dispatcher.
# Kept in sync with detect_platform() in install.sh — if you change one, change
# both. The Rosetta correction matters here too: without it an Apple Silicon host
# running verify from an x86_64 shell would report "no build for this platform"
# about a wrapper that installed and works fine.
verify_arch="$(uname -m)"
if [ "$(uname -s)" = "Darwin" ] && [ "$verify_arch" = "x86_64" ]; then
    verify_sysctl=""
    if command -v sysctl >/dev/null 2>&1; then verify_sysctl="$(command -v sysctl)"
    elif [ -x /usr/sbin/sysctl ]; then verify_sysctl=/usr/sbin/sysctl
    fi
    if [ -n "$verify_sysctl" ] \
        && [ "$("$verify_sysctl" -in sysctl.proc_translated 2>/dev/null || true)" = "1" ]; then
        verify_arch=arm64
    fi
fi
case "$(uname -s)/$verify_arch" in
    Darwin/arm64)             wrapper_artifact="codeagent-wrapper-darwin-arm64" ;;
    Linux/x86_64|Linux/amd64) wrapper_artifact="codeagent-wrapper-linux-amd64" ;;
    *)                        wrapper_artifact="" ;;
esac
if [ -n "$wrapper_artifact" ]; then
    check_symlink  "codeagent-wrapper"    "$SRC_ROOT/bin/$wrapper_artifact" "$HOME/.claude/bin/codeagent-wrapper"
else
    emit WARN "codeagent-wrapper" "no prebuilt binary for $(uname -s)/$(uname -m); /custom:execute-plan delegation unavailable"
fi
check_symlink      "statusline.sh"        "$SRC_ROOT/statusline.sh"         "$HOME/.claude/statusline.sh"
check_symlink      "statusline-fields.py" "$SRC_ROOT/statusline-fields.py"  "$HOME/.claude/statusline-fields.py"
check_symlink      "statusline-transcript.py" "$SRC_ROOT/statusline-transcript.py" "$HOME/.claude/statusline-transcript.py"
check_symlink      "statusline-usage.py"  "$SRC_ROOT/statusline-usage.py"    "$HOME/.claude/statusline-usage.py"
# Hook scripts are linked per-file by install.sh; without these checks a hook could be
# wired in settings.json while its script was never linked (a silent no-op hook).
for hook_rel in ask-recommend-gate.js desktop-notify.js desktop-notify.test.js \
                codeagent-stdin-guard.js codeagent-stdin-guard.test.js \
                run-with-flags.js \
                writer-registry-gate.js block-broad-kill.js commit-message-language.js \
                continuation-claim-gate.js prose-choice-gate.js \
                capability-claim-gate.js reverse-assertion-gate.js \
                bg-shell-reclaim-check.js \
                lib/llm-judge.js lib/utils.js lib/hook-flags.js \
                lib/judge-log.js lib/transcript.js; do
    check_symlink  "hooks/$hook_rel"      "$SRC_ROOT/hooks/$hook_rel"       "$HOME/.claude/hooks/$hook_rel"
done
# Previously uncovered despite install.sh linking it.
check_symlink      "poll-progress.sh"     "$SRC_ROOT/bin/poll-progress.sh"  "$HOME/.claude/bin/poll-progress.sh"
check_symlink      "active-plan"          "$SRC_ROOT/bin/active-plan"       "$HOME/.claude/bin/active-plan"

# ---------- Dependency / PATH checks ----------

echo
echo "=== Dependencies ==="

if command -v jq >/dev/null 2>&1; then
    emit PASS "jq" "$(command -v jq)"
else
    # Not a FAIL any more: statusline.sh does its JSON work in statusline-fields.py.
    # jq is still used to READ/WRITE settings.json — by install.sh to merge the statusLine
    # field, and by this script's own settings.json check below, which degrades to a WARN
    # without it. So its absence costs install-time wiring and one verify check, not the
    # statusline itself.
    emit WARN "jq" "not on PATH (install.sh can't auto-wire settings.json statusLine, and the settings.json check below degrades; statusline itself is fine)"
fi

if command -v python3 >/dev/null 2>&1; then
    emit PASS "python3" "$(command -v python3)"
else
    emit FAIL "python3" "not on PATH (statusline.sh parses its payload via statusline-fields.py)"
fi

if command -v codex >/dev/null 2>&1; then
    emit PASS "codex-cli" "$(command -v codex)"
else
    emit WARN "codex-cli" "not on PATH (/custom:execute-plan won't work; install + login at https://github.com/openai/codex)"
fi

case ":$PATH:" in
    *":$HOME/.local/bin:"*) emit PASS "local-bin-path" "~/.local/bin in PATH" ;;
    *) emit WARN "local-bin-path" "~/.local/bin not in current PATH (needed for tt-web entry; may already be appended to rc file — reload shell)" ;;
esac

NPM_GLOBAL_LIST="$(npm list -g --depth=0 2>/dev/null || true)"
check_npm() {
    local pkg="$1"
    if [ -z "$NPM_GLOBAL_LIST" ]; then
        emit WARN "npm/$pkg" "npm not available — can't verify"
        return
    fi
    if echo "$NPM_GLOBAL_LIST" | grep -q " $pkg@"; then
        emit PASS "npm/$pkg" "globally installed"
    else
        emit FAIL "npm/$pkg" "not globally installed (re-run ./install.sh)"
    fi
}
check_npm "@modelcontextprotocol/server-github"
check_npm "@upstash/context7-mcp"
check_npm "agent-browser"

if command -v agent-browser >/dev/null 2>&1; then
    emit PASS "agent-browser-cli" "$(command -v agent-browser)"
else
    emit WARN "agent-browser-cli" "not on PATH (npm global bin dir may not be in PATH)"
fi

if [ -n "${GITHUB_PERSONAL_ACCESS_TOKEN:-}" ]; then
    emit PASS "github-pat" "GITHUB_PERSONAL_ACCESS_TOKEN set"
else
    emit WARN "github-pat" "GITHUB_PERSONAL_ACCESS_TOKEN not set (GitHub MCP server will fail)"
fi

# ---------- settings.json statusLine wiring ----------

echo
echo "=== Claude Code settings.json ==="

SETTINGS="$HOME/.claude/settings.json"
TARGET_CMD='~/.claude/statusline.sh'

if [ ! -f "$SETTINGS" ]; then
    emit FAIL "settings.json" "$SETTINGS missing (statusLine not wired; re-run ./install.sh)"
elif ! command -v jq >/dev/null 2>&1; then
    emit WARN "settings.json" "can't parse without jq"
else
    existing="$(jq -r '.statusLine.command // empty' "$SETTINGS" 2>/dev/null)"
    if [ "$existing" = "$TARGET_CMD" ]; then
        emit PASS "settings.json/statusLine" "wired to $TARGET_CMD"
    elif [ -z "$existing" ]; then
        emit FAIL "settings.json/statusLine" "missing statusLine.command (re-run ./install.sh)"
    else
        emit WARN "settings.json/statusLine" "points to $existing, not $TARGET_CMD (manual override; remove if unintentional)"
    fi

    # Hook WIRING, not just linkage. install.sh links the scripts but cannot merge
    # settings.json for you (the README prompt does that), so a hook can be linked
    # and still be completely inert — and a symlink check reports green either way.
    # id + event + matcher together. Matching the id alone accepts a stanza that was
    # merged under the wrong event (e.g. the Bash guard landing in Stop) — it would
    # report "wired" while the hook never fires, which is the exact failure this
    # check exists to catch.
    # Also assert the handler command names the expected script. Checking only that
    # *some* command handler exists accepts a stanza whose command is stale or wrong
    # (`"command": "true"` would pass), which fires nothing while reporting green.
    # Delimiter is ^ , not | : the writer-registry matcher is itself an alternation
    # ("Edit|Write|MultiEdit|NotebookEdit"), so a pipe-split would shred that row into
    # the wrong fields and silently check a hook that does not exist.
    # Field 4 is the EXACT expected handler command, compared with `==`, not a
    # substring. Substring matching passes commands that provably never run — a
    # path with a `.disabled` suffix still contains the expected fragment, and so
    # does `true # <fragment>`. Since the whole point of this check is catching a
    # hook that is wired but inert, a matcher that green-lights an inert command
    # defeats it. Exact match costs us nothing: the installer does not generate
    # these strings, the README tells the reader to copy them verbatim from
    # claude/settings.json, so any deviation is exactly what we want to surface.
    # Field 5 marks whether the row is required. The four LLM judge gates are opt-in
    # at the settings.json merge step (each costs a judge call per turn reaching Stop),
    # so "not wired" is a legitimate configuration for them, not a defect to warn about.
    # Delimiter is ^ , not | : the writer-registry matcher is itself an alternation.
    # This check reports one thing only: does the wired command match, verbatim,
    # the canonical command in the repo's claude/settings.json?
    #
    # It deliberately does NOT try to answer "will this hook actually fire".
    # Three review rounds established that we cannot answer that from the command
    # string: `node --check <script>` parses without executing, `node
    # block-broad-kill.js` runs a module with no entry point and exits 0 doing
    # nothing, and a dispatcher path with a `.disabled` suffix still ends in the
    # right script argument. Each attempt to model those cases in shell missed a
    # new one, and a wrong "it should still fire" is worse than no claim at all —
    # it is exactly the unverified reverse assertion this repo's own rules forbid.
    # The authority for whether a hook runs is lib/hook-flags.js plus the harness,
    # not this script. So: mismatch is reported as drift, both strings printed,
    # and the reader decides.
    while IFS='^' read -r hook_event hook_matcher hook_id hook_script hook_required; do
        [ -n "$hook_event" ] || continue
        actual_cmd="$(jq -r --arg ev "$hook_event" --arg m "$hook_matcher" --arg id "$hook_id" \
            '[.hooks[$ev]? // [] | .[]? | select(.id == $id and .matcher == $m)
              | .hooks[]? | select(.type == "command") | .command] | join(" ;; ") // empty' \
            "$SETTINGS" 2>/dev/null || true)"
        if [ -n "$actual_cmd" ] && [ "$actual_cmd" = "$hook_script" ]; then
            emit PASS "settings.json/hook" "$hook_id wired under $hook_event/$hook_matcher, command matches the repo version"
        elif [ -n "$actual_cmd" ]; then
            emit WARN "settings.json/hook" "$hook_id is wired under $hook_event/$hook_matcher but its command differs from the repo version — whether it still fires depends on the difference, so compare them yourself:
      repo:  $hook_script
      yours: $actual_cmd"
        elif jq -e --arg id "$hook_id" \
            '[.hooks // {} | .[]? | .[]? | select(.id == $id)] | length > 0' \
            "$SETTINGS" >/dev/null 2>&1; then
            emit FAIL "settings.json/hook" "$hook_id exists in settings.json but not under $hook_event/$hook_matcher — a hook under the wrong event or matcher is never reached for the calls it was meant to gate"
        elif [ "$hook_required" = "optional" ]; then
            emit PASS "settings.json/hook" "$hook_id not wired (opt-in LLM judge gate — expected unless you chose it)"
        else
            emit WARN "settings.json/hook" "$hook_id NOT wired — its script is linked but nothing references it (see README 安装 prompt step 3)"
        fi
    done <<'HOOK_WIRING'
PreToolUse^AskUserQuestion^pre:ask-user-question:recommend-gate^node "$HOME/.claude/hooks/ask-recommend-gate.js"^required
PreToolUse^Bash^pre:bash:codeagent-stdin-guard^node "$HOME/.claude/hooks/codeagent-stdin-guard.js"^required
Stop^*^stop:desktop-notify-local^node "$HOME/.claude/hooks/desktop-notify.js"^required
PreToolUse^Edit|Write|MultiEdit|NotebookEdit^pre:edit:writer-registry-gate^node "$HOME/.claude/hooks/run-with-flags.js" writer-registry-gate writer-registry-gate.js^required
PreToolUse^Bash^pre:bash:block-broad-kill^node "$HOME/.claude/hooks/run-with-flags.js" block-broad-kill block-broad-kill.js^required
PreToolUse^Bash^pre:bash:commit-message-language^node "$HOME/.claude/hooks/run-with-flags.js" commit-message-language commit-message-language.js^required
Stop^*^stop:bg-shell-reclaim-check^node "$HOME/.claude/hooks/bg-shell-reclaim-check.js"^required
Stop^*^stop:continuation-claim-gate^node "$HOME/.claude/hooks/continuation-claim-gate.js"^optional
Stop^*^stop:prose-choice-gate^node "$HOME/.claude/hooks/prose-choice-gate.js"^optional
Stop^*^stop:capability-claim-gate^node "$HOME/.claude/hooks/capability-claim-gate.js"^optional
Stop^*^stop:reverse-assertion-gate^node "$HOME/.claude/hooks/reverse-assertion-gate.js"^optional
HOOK_WIRING

    # desktop-notify-local only takes over if the ECC plugin's own stop hook is off;
    # otherwise both fire and the user gets duplicate notifications.
    # Exact token compare, not a substring: `stop:desktop-notify-old` contains
    # `stop:desktop-notify` but disables a different hook, so a substring test would
    # report green while both notifiers still fire.
    ecc_disabled="$(jq -r '.env.ECC_DISABLED_HOOKS // empty' "$SETTINGS" 2>/dev/null)"
    if [ -z "$ecc_disabled" ]; then
        emit WARN "settings.json/env" "ECC_DISABLED_HOOKS unset — the ECC plugin's stop:desktop-notify may double up with this repo's"
    elif printf '%s' "$ecc_disabled" | tr ',: ' '\n\n\n' >/dev/null 2>&1 &&
         printf '%s' "$ecc_disabled" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' \
           | grep -qxF 'stop:desktop-notify'; then
        emit PASS "settings.json/env" "ECC_DISABLED_HOOKS disables the plugin's stop:desktop-notify"
    else
        emit WARN "settings.json/env" "ECC_DISABLED_HOOKS='$ecc_disabled' has no exact stop:desktop-notify token (possible duplicate notifications)"
    fi
fi

# Hook profile. Three of the required hooks (writer-registry-gate, block-broad-kill,
# commit-message-language) run through run-with-flags.js, which consults
# HOOK_PROFILE / ECC_HOOK_PROFILE and only runs the hook under the `standard` or
# `strict` profile. Under `minimal` the dispatcher exits 0 without calling the hook
# at all — the wiring is present and correct, the script is linked, and the gate
# still never fires. Every check above passes in that state, which is precisely the
# silent-failure shape this suite exists to catch, so it gets its own check.
# Both the settings.json env block and the ambient shell are consulted, because
# either one reaches the dispatcher.
# Hook profile. Three required hooks (writer-registry-gate, block-broad-kill,
# commit-message-language) run through run-with-flags.js, which only runs them
# under the `standard` or `strict` profile. Under `minimal` the dispatcher exits 0
# without calling the hook — wiring present, script linked, gate never fires, and
# every other check here still green. That is the exact silent-failure shape this
# suite exists to catch, so it gets its own check.
#
# Two things the naive version of this check got wrong, both verified against
# lib/hook-flags.js: the runtime does trim().toLowerCase() on the value (so
# `Minimal` and ` minimal ` disable the hooks just as `minimal` does), and it
# resolves HOOK_PROFILE before ECC_HOOK_PROFILE by NAME, out of one merged
# process env — settings.json's env block and the ambient shell both land there.
# So we normalize, and we treat a `minimal` from EITHER source as disabling.
# lib/hook-flags.js resolves `HOOK_PROFILE || ECC_HOOK_PROFILE` out of ONE merged
# process env, then trim()s and lowercase()s it. settings.json's env block and the
# ambient shell both feed that env, so precedence is by NAME, not by source: any
# HOOK_PROFILE at all wins over any ECC_HOOK_PROFILE. An earlier version of this
# check treated "minimal from any source" as disabling, which reported FAIL on the
# perfectly working combination HOOK_PROFILE=standard + ECC_HOOK_PROFILE=minimal.
read_env_var() {  # settings.json env first, then the ambient shell
    local v; v="$(jq -r --arg k "$1" '.env[$k] // empty' "$SETTINGS" 2>/dev/null || true)"
    [ -n "$v" ] || eval "v=\${$1:-}"
    printf '%s' "$v" | tr '[:upper:]' '[:lower:]' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}
profile_raw="$(read_env_var HOOK_PROFILE)"
[ -n "$profile_raw" ] || profile_raw="$(read_env_var ECC_HOOK_PROFILE)"
case "${profile_raw:-standard}" in
    standard|strict)
        emit PASS "hook profile" "${profile_raw:-standard (default)} — dispatcher-routed gates run"
        ;;
    minimal)
        emit FAIL "hook profile" "the effective hook profile is 'minimal' — run-with-flags.js then exits 0 without calling the three dispatcher-routed required gates (writer-registry-gate / block-broad-kill / commit-message-language). They stay wired and linked, and never run. Set HOOK_PROFILE=standard, or unwire those three so the gap is deliberate"
        ;;
    *)
        emit WARN "hook profile" "hook profile '$profile_raw' is not one of minimal/standard/strict; hook-flags.js falls back to standard (gates run), but the value looks like a typo"
        ;;
esac

# DISABLED_HOOKS can switch off a required gate by id with the same silent result.
# Same precedence rule, same reason: DISABLED_HOOKS wins over ECC_DISABLED_HOOKS by
# name. Reading ECC_DISABLED_HOOKS first would let this repo's own
# ECC_DISABLED_HOOKS=stop:desktop-notify mask an ambient DISABLED_HOOKS that
# switches a required gate off.
disabled_ids="$(read_env_var DISABLED_HOOKS)"
[ -n "$disabled_ids" ] || disabled_ids="$(read_env_var ECC_DISABLED_HOOKS)"
for req in writer-registry-gate block-broad-kill commit-message-language bg-shell-reclaim-check; do
    if printf '%s' "$disabled_ids" | tr ',' '\n' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
        | grep -qxF "$req"; then
        emit FAIL "hook profile" "the effective DISABLED_HOOKS lists '$req' — that required gate is wired but hook-flags.js will not run it"
    fi
done

# lsof: bg-shell-reclaim-check is a required Stop hook whose whole job is spotting
# background shells nobody has accounted for, and its probe shells out to lsof.
# Without lsof it marks the probe unusable and lets the stop through — it fails
# open, silently, forever. macOS ships lsof; many minimal Linux images do not.
if command -v lsof >/dev/null 2>&1; then
    emit PASS "lsof" "present (stop:bg-shell-reclaim-check can probe)"
else
    emit FAIL "lsof" "not on PATH — stop:bg-shell-reclaim-check (required) and stop:continuation-claim-gate (if wired) probe with lsof; without it they mark the probe unusable and let every stop through. They are wired, linked, and permanently inert. Install lsof (Debian/Ubuntu: apt install lsof), or unwire those gates so the gap is deliberate rather than silent"
fi

# ---------- Top-level config files (manually merged) ----------
# These aren't symlinked, so we just check existence and grep for known
# BINDING-section anchors. Subtle drift (older versions of a section)
# still needs human review — the prompt in README handles that.

echo
echo "=== Top-level merged configs ==="

check_anchor() {
    # $1 = label, $2 = file, $3 = anchor description, $4 = grep pattern
    local label="$1" file="$2" desc="$3" pattern="$4"
    if [ ! -f "$file" ]; then
        emit FAIL "$label" "$file missing (manual merge step not done — see README)"
        return 1
    fi
    if grep -qF "$pattern" "$file"; then
        emit PASS "$label" "$desc present"
    else
        emit WARN "$label" "$desc NOT found in $file (likely needs merge from repo's version)"
    fi
}

# CLAUDE.md anchors
check_anchor "CLAUDE.md"          "$HOME/.claude/CLAUDE.md" "Long-Task Protocol section"      "Long-Task Protocol" || true
check_anchor "CLAUDE.md"          "$HOME/.claude/CLAUDE.md" "Plan Execution Principles section" "Plan Execution Principles" || true
check_anchor "CLAUDE.md"          "$HOME/.claude/CLAUDE.md" "plan-execution-principles.md reference" "plan-execution-principles.md" || true

# AGENTS.md anchors. In-repo codex/AGENTS.md is a symlink to claude/CLAUDE.md, so the
# anchors mirror the CLAUDE.md ones — a divergence here means the Codex-side merge
# target drifted from the shared policy source, which is exactly what we want flagged.
check_anchor "AGENTS.md"          "$HOME/.codex/AGENTS.md"  "Long-Task Protocol section"      "Long-Task Protocol" || true
check_anchor "AGENTS.md"          "$HOME/.codex/AGENTS.md"  "Plan Execution Principles section" "Plan Execution Principles" || true
check_anchor "AGENTS.md"          "$HOME/.codex/AGENTS.md"  "plan-execution-principles.md reference" "plan-execution-principles.md" || true

# config.toml anchors — verify each MCP server entry is present.
TOML="$HOME/.codex/config.toml"
if [ ! -f "$TOML" ]; then
    emit FAIL "config.toml" "$TOML missing (manual merge step not done — see README)"
else
    for srv in openaiDeveloperDocs exa context7 github ask-user; do
        if grep -qF "[mcp_servers.$srv]" "$TOML"; then
            emit PASS "config.toml/mcp" "$srv entry present"
        else
            emit WARN "config.toml/mcp" "$srv entry missing (repo provides it — merge if you want this server)"
        fi
    done
fi

emit INFO "merged-configs" "content drift beyond anchors needs human review — see README prompt"

# ---------- tt-web ----------

echo
echo "=== tt-web ==="

if command -v tt-web >/dev/null 2>&1; then
    emit PASS "tt-web-cli" "$(command -v tt-web)"
elif [ -x "$HOME/.local/bin/tt-web" ]; then
    emit WARN "tt-web-cli" "exists at ~/.local/bin/tt-web but not on current PATH (reload shell)"
else
    emit FAIL "tt-web-cli" "not installed (tt-web/install.sh may have failed; re-run ./install.sh)"
fi

if [ -f "$HOME/.claude/tt-status.json" ]; then
    emit PASS "tt-status.json" "exists (statusline has run at least once)"
else
    emit INFO "tt-status.json" "absent — will be created on next Claude Code launch if statusLine is wired"
fi

# ---------- Summary ----------

echo
echo "=== Summary ==="
printf '%sPASS=%d%s  %sWARN=%d%s  %sFAIL=%d%s\n' \
    "$C_PASS" "$pass" "$C_RESET" \
    "$C_WARN" "$warn" "$C_RESET" \
    "$C_FAIL" "$fail" "$C_RESET"

if [ "$fail" -eq 0 ] && [ "$warn" -eq 0 ]; then
    printf '%sClean install.%s\n' "$C_PASS" "$C_RESET"
elif [ "$fail" -eq 0 ]; then
    printf '%sFunctional, but %d warning(s) — see [WARN] lines above.%s\n' "$C_WARN" "$warn" "$C_RESET"
else
    printf '%s%d failure(s) — see [FAIL] lines above. Re-run ./install.sh or fix manually.%s\n' "$C_FAIL" "$fail" "$C_RESET"
fi

# Clamp exit code to 255 for shell compatibility.
if [ "$fail" -gt 255 ]; then exit 255; fi
exit "$fail"
