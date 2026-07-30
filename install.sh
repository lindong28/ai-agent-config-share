#!/usr/bin/env bash
# install.sh — install shared AI agent configs into user-scope dirs.
#
# Auto-installed (safe to share verbatim):
#   Symlinks:
#     <repo>/claude/commands/custom/*.md  → ~/.claude/commands/custom/*.md
#     <repo>/claude/commands/routine/*.md → ~/.claude/commands/routine/*.md
#     <repo>/claude/references/*.md       → ~/.claude/references/*.md
#     <repo>/claude/agents/*.md           → ~/.claude/agents/*.md
#     <repo>/claude/bin/codeagent-wrapper → ~/.claude/bin/codeagent-wrapper
#     <repo>/claude/bin/poll-progress.sh  → ~/.claude/bin/poll-progress.sh
#     <repo>/claude/statusline.sh        → ~/.claude/statusline.sh
#     <repo>/claude/statusline-fields.py → ~/.claude/statusline-fields.py
#     <repo>/claude/statusline-transcript.py → ~/.claude/statusline-transcript.py
#     <repo>/codex/agents/*.toml         → ~/.codex/agents/*.toml
#     <repo>/claude/skills/agent-browser → ~/.claude/skills/agent-browser
#                                      → ~/.codex/skills/agent-browser
#     <repo>/claude/skills/create-commit → ~/.claude/skills/create-commit
#     <repo>/claude/skills/deep-discuss  → ~/.claude/skills/deep-discuss
#     <repo>/claude/skills/review-gate   → ~/.claude/skills/review-gate
#     <repo>/claude/skills/tdd-workflow  → ~/.claude/skills/tdd-workflow
#     <repo>/claude/skills/game-release-loop → ~/.claude/skills/game-release-loop
#     <repo>/ask-user-mcp                → ~/.codex/ask-user-mcp
#   Sub-installers:
#     <repo>/tt-web/install.sh           # localhost token-usage dashboard
#     <repo>/ask-user-mcp/install.sh     # AskUserQuestion MCP server for Codex (node deps)
#   npm global packages:
#     MCP server CLI tools referenced by codex/config.toml
#     agent-browser
#   Dependency checks + auto-fix (macOS assumed; interactive y/N prompts):
#     python3 (brew install if missing) — required by statusline.sh, which delegates
#                                    all JSON parsing to statusline-fields.py
#     jq (brew install if missing) — used by this installer to merge settings.json,
#                                    and by verify.sh for its settings.json checks
#     ~/.local/bin in PATH (append export to ~/.zshrc / ~/.bashrc / fish config)
#     codex CLI presence (warn only — OAuth-gated, can't auto-install)
#     ~/.claude/settings.json statusLine field (add if missing; warn on conflict)
#
# Platform note: codeagent-wrapper is an arm64 macOS binary required by
# /custom:execute-plan. On Intel Mac it links but won't run.
#
# Manual merge required (preserves existing customizations):
#   <repo>/claude/CLAUDE.md  → merge into ~/.claude/CLAUDE.md
#   <repo>/codex/AGENTS.md   → merge into ~/.codex/AGENTS.md
#     (in-repo, codex/AGENTS.md is a symlink to ../claude/CLAUDE.md — one policy
#      source for both harnesses, so the two can't drift. Both merge targets
#      therefore carry the same content.)
#   <repo>/codex/config.toml → merge into ~/.codex/config.toml
#
# Symlink policy: if a target path already exists (file, dir, or symlink
# pointing elsewhere), prompt the user whether to overwrite it. The prompt
# accepts y / N / a (yes-to-all-remaining) / s (skip-all-remaining); once
# 'a' or 's' is chosen, the rest of this run is automatic. In a
# non-interactive shell the prompt defaults to skip (preserve existing).
#
# Package-update policy: already-installed npm globals and the Chrome for
# Testing payload are NOT upgraded by default. The installer asks once
# upfront: "Update existing installations? [y/N]" — y/N is run-wide
# (all-or-nothing), no per-package question. Override with the env var:
#   UPDATE_EXISTING=1 ./install.sh    # upgrade all existing
#   UPDATE_EXISTING=0 ./install.sh    # leave all existing alone
# Non-interactive shells default to 0. New installs always proceed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_ROOT="$SCRIPT_DIR/claude"
DST_ROOT="$HOME/.claude"

if [ ! -d "$SRC_ROOT" ]; then
    echo "ERROR: source dir not found: $SRC_ROOT" >&2
    exit 1
fi

installed=0
overwritten=0
skipped=0
already_linked=0

# Run-level decision shortcut for overwrite prompts.
#   ""     = ask each time (default)
#   "all"  = auto-overwrite every remaining conflict in this run
#   "skip" = auto-skip every remaining conflict in this run
overwrite_mode=""

prompt_overwrite() {
    # Ask the user whether to replace an existing target with our symlink.
    # Returns 0 (yes) or 1 (no / no tty). Silent — caller prints messaging.
    #
    # Reads from /dev/tty directly because the caller runs inside a
    # `while read; done < <(find ...)` loop, where stdin is the find pipe,
    # not the terminal. /dev/tty bypasses that.

    case "$overwrite_mode" in
        all)  return 0 ;;
        skip) return 1 ;;
    esac

    if [ ! -e /dev/tty ] || [ ! -r /dev/tty ]; then
        return 1
    fi

    local dst="$1"
    local detail="$2"
    {
        echo "  [CONFLICT] $dst already exists ($detail)"
        printf "  Replace with symlink to share version? [y/N/a=yes-to-all/s=skip-all] "
    } >/dev/tty
    local answer=""
    read -r answer </dev/tty
    case "$answer" in
        a|A)         overwrite_mode="all";  echo "  (auto-overwriting remaining conflicts)" >/dev/tty; return 0 ;;
        s|S)         overwrite_mode="skip"; echo "  (auto-skipping remaining conflicts)"    >/dev/tty; return 1 ;;
        y|Y|yes|YES) return 0 ;;
        *)           return 1 ;;
    esac
}

link_one() {
    local src="$1"
    local dst="$2"

    if [ ! -e "$src" ]; then
        echo "  [SKIP — source missing] $src"
        skipped=$((skipped + 1))
        return
    fi

    mkdir -p "$(dirname "$dst")"

    if [ -L "$dst" ]; then
        local current
        current="$(readlink "$dst")"
        if [ "$current" = "$src" ]; then
            echo "  [already linked] $dst"
            already_linked=$((already_linked + 1))
            return
        fi
        if prompt_overwrite "$dst" "symlink -> $current"; then
            rm "$dst"
            ln -s "$src" "$dst"
            echo "  [overwritten] $dst"
            overwritten=$((overwritten + 1))
        else
            echo "  [SKIP — kept existing symlink] $dst -> $current"
            skipped=$((skipped + 1))
        fi
        return
    fi

    if [ -e "$dst" ]; then
        if prompt_overwrite "$dst" "regular file"; then
            rm "$dst"
            ln -s "$src" "$dst"
            echo "  [overwritten] $dst"
            overwritten=$((overwritten + 1))
        else
            echo "  [SKIP — kept existing file] $dst"
            skipped=$((skipped + 1))
        fi
        return
    fi

    ln -s "$src" "$dst"
    echo "  [linked] $dst"
    installed=$((installed + 1))
}

link_tree() {
    local subdir="$1"
    local src_dir="$SRC_ROOT/$subdir"
    local dst_dir="$DST_ROOT/$subdir"

    if [ ! -d "$src_dir" ]; then
        echo "WARN: source subdir missing: $src_dir" >&2
        return
    fi

    echo
    echo "Installing $subdir:"
    while IFS= read -r -d '' src_file; do
        local rel="${src_file#"$src_dir"/}"
        link_one "$src_file" "$dst_dir/$rel"
    done < <(find "$src_dir" -type f -name '*.md' -print0)
}

# Prompt-yes helper. Returns 0 on yes, 1 on no / no tty.
prompt_yes() {
    local question="$1"
    if [ ! -e /dev/tty ] || [ ! -r /dev/tty ]; then
        return 1
    fi
    printf "  %s [y/N] " "$question" >/dev/tty
    local answer=""
    read -r answer </dev/tty
    case "$answer" in
        y|Y|yes|YES) return 0 ;;
        *) return 1 ;;
    esac
}

# jq is no longer a runtime dependency: statusline.sh does all its JSON work in
# statusline-fields.py. It is still what wire_statusline_settings() uses to merge
# the statusLine field into an existing ~/.claude/settings.json, so its absence
# now degrades install-time wiring only — the statusline itself runs fine without it.
ensure_jq() {
    if command -v jq >/dev/null 2>&1; then
        return 0
    fi
    echo
    echo "Dependency: jq (used by this installer to merge settings.json)"
    if ! command -v brew >/dev/null 2>&1; then
        echo "  [WARN] jq not found and brew not available. Install jq manually,"
        echo "         or wire settings.json statusLine by hand (see README)."
        return 0
    fi
    if prompt_yes "jq not found — brew install jq?"; then
        brew install jq
    else
        echo "  [WARN] Skipped. This installer can't auto-wire settings.json statusLine;"
        echo "         wire it by hand (see README). statusline.sh itself needs only python3."
    fi
}

# python3 is load-bearing for the statusline: statusline.sh delegates ALL of its JSON
# parsing to statusline-fields.py. Without python3 the statusline still exits 0 but
# every field comes back empty and ~/.claude/tt-status.json stops updating — the exact
# silent degradation that moving off jq was meant to remove. So check it explicitly
# rather than letting it fail at render time.
ensure_python3() {
    if command -v python3 >/dev/null 2>&1; then
        return 0
    fi
    echo
    echo "Dependency: python3 (required by statusline.sh via statusline-fields.py)"
    if ! command -v brew >/dev/null 2>&1; then
        echo "  [WARN] python3 not found and brew not available. Install python3 manually,"
        echo "         otherwise the statusline renders empty fields and tt-web loses its quota cards."
        return 0
    fi
    if prompt_yes "python3 not found — brew install python?"; then
        brew install python
    else
        echo "  [WARN] Skipped. statusline.sh will render empty fields and won't write tt-status.json."
    fi
}

ensure_local_bin_in_path() {
    local bin_dir="$HOME/.local/bin"
    case ":$PATH:" in
        *":$bin_dir:"*) return 0 ;;
    esac
    echo
    echo "PATH check: ~/.local/bin (tt-web entry)"
    local rc=""
    case "$SHELL" in
        */zsh)  rc="$HOME/.zshrc" ;;
        */bash) rc="$HOME/.bashrc" ;;
        */fish) rc="$HOME/.config/fish/config.fish" ;;
        *)
            echo "  [WARN] Unknown shell ($SHELL); add ~/.local/bin to PATH manually."
            return 0
            ;;
    esac
    if prompt_yes "~/.local/bin not in PATH. Append export to $rc?"; then
        if [[ "$rc" == *fish* ]]; then
            echo 'set -gx PATH $HOME/.local/bin $PATH' >>"$rc"
        else
            echo 'export PATH="$HOME/.local/bin:$PATH"' >>"$rc"
        fi
        echo "  Appended. Reload your shell or 'source $rc' to apply."
    else
        echo "  Skipped. Add ~/.local/bin to PATH manually before using tt-web."
    fi
}

check_codex_cli() {
    if command -v codex >/dev/null 2>&1; then
        return 0
    fi
    echo
    echo "Dependency: codex CLI (required by /custom:execute-plan)"
    echo "  [WARN] 'codex' not on PATH. /custom:execute-plan will not work."
    echo "         Install + login: https://github.com/openai/codex"
}

wire_statusline_settings() {
    local settings="$HOME/.claude/settings.json"
    local target_cmd='~/.claude/statusline.sh'

    echo
    echo "Wiring statusLine into $settings:"

    if ! command -v jq >/dev/null 2>&1; then
        echo "  [SKIP] jq not available — can't safely edit settings.json."
        return 0
    fi

    mkdir -p "$(dirname "$settings")"

    if [ ! -f "$settings" ]; then
        cat >"$settings" <<EOF
{
  "statusLine": {
    "type": "command",
    "command": "$target_cmd"
  }
}
EOF
        echo "  [created] $settings with statusLine"
        return 0
    fi

    local existing
    existing="$(jq -r '.statusLine.command // empty' "$settings" 2>/dev/null || echo "")"
    if [ "$existing" = "$target_cmd" ]; then
        echo "  [already wired] statusLine already points to share's statusline.sh"
    elif [ -z "$existing" ]; then
        local tmp
        tmp="$(mktemp)"
        if jq --arg cmd "$target_cmd" \
            '.statusLine = {type: "command", command: $cmd}' \
            "$settings" >"$tmp"; then
            mv "$tmp" "$settings"
            echo "  [updated] added statusLine to $settings"
        else
            rm -f "$tmp"
            echo "  [WARN] jq failed to merge statusLine into $settings."
        fi
    else
        echo "  [CONFLICT] $settings already has statusLine.command=$existing"
        echo "             Review and decide whether to switch to: $target_cmd"
    fi
}

echo "ai-agent-config-share installer"
echo "  source: $SCRIPT_DIR"
echo "  target: $HOME"

link_tree "commands/custom"
link_tree "commands/routine"
link_tree "references"
link_tree "agents"

# --- Codex agent definitions (symlink .toml files) ---

CODEX_AGENTS_SRC="$SCRIPT_DIR/codex/agents"
CODEX_AGENTS_DST="$HOME/.codex/agents"

if [ -d "$CODEX_AGENTS_SRC" ]; then
    echo
    echo "Installing codex agents:"
    while IFS= read -r -d '' src_file; do
        rel="${src_file#"$CODEX_AGENTS_SRC"/}"
        link_one "$src_file" "$CODEX_AGENTS_DST/$rel"
    done < <(find "$CODEX_AGENTS_SRC" -type f -name '*.toml' -print0)
fi

# --- Agent-browser skill (symlink entire directory to both tools) ---

AGENT_BROWSER_SKILL="$SCRIPT_DIR/claude/skills/agent-browser"

if [ -d "$AGENT_BROWSER_SKILL" ]; then
    echo
    echo "Installing agent-browser skill:"
    link_one "$AGENT_BROWSER_SKILL" "$HOME/.claude/skills/agent-browser"
    link_one "$AGENT_BROWSER_SKILL" "$HOME/.codex/skills/agent-browser"
fi

# --- create-commit skill (Claude-only; referenced by /custom:execute-plan) ---

CREATE_COMMIT_SKILL="$SCRIPT_DIR/claude/skills/create-commit"

if [ -d "$CREATE_COMMIT_SKILL" ]; then
    echo
    echo "Installing create-commit skill:"
    link_one "$CREATE_COMMIT_SKILL" "$HOME/.claude/skills/create-commit"
fi

# --- deep-discuss skill (Claude-only; tradeoff discussion, no plan.md) ---

DEEP_DISCUSS_SKILL="$SCRIPT_DIR/claude/skills/deep-discuss"

if [ -d "$DEEP_DISCUSS_SKILL" ]; then
    echo
    echo "Installing deep-discuss skill:"
    link_one "$DEEP_DISCUSS_SKILL" "$HOME/.claude/skills/deep-discuss"
fi

# --- review-gate skill (post-generation review gate before completion/commit) ---

REVIEW_GATE_SKILL="$SCRIPT_DIR/claude/skills/review-gate"

if [ -d "$REVIEW_GATE_SKILL" ]; then
    echo
    echo "Installing review-gate skill:"
    link_one "$REVIEW_GATE_SKILL" "$HOME/.claude/skills/review-gate"
fi

# --- tdd-workflow skill (Claude-only; TDD RED→GREEN discipline, referenced by execute-ux-contract) ---

TDD_WORKFLOW_SKILL="$SCRIPT_DIR/claude/skills/tdd-workflow"

if [ -d "$TDD_WORKFLOW_SKILL" ]; then
    echo
    echo "Installing tdd-workflow skill:"
    link_one "$TDD_WORKFLOW_SKILL" "$HOME/.claude/skills/tdd-workflow"
fi

# --- game-release-loop skill (Claude-only; browser-game release gate. disable-model-invocation,
#     so it only ever runs when named explicitly — no trigger cost for non-game projects) ---

GAME_RELEASE_LOOP_SKILL="$SCRIPT_DIR/claude/skills/game-release-loop"

if [ -d "$GAME_RELEASE_LOOP_SKILL" ]; then
    echo
    echo "Installing game-release-loop skill:"
    link_one "$GAME_RELEASE_LOOP_SKILL" "$HOME/.claude/skills/game-release-loop"
fi

# --- Claude hooks (symlinked per-file so we never clobber an existing ~/.claude/hooks) ---
# Only the hook scripts are linked here. Activation requires wiring three entries into
# ~/.claude/settings.json (PreToolUse:ask-recommend-gate + PreToolUse:codeagent-stdin-guard
# + Stop:desktop-notify) plus ECC_DISABLED_HOOKS="stop:desktop-notify" — the reference shape
# lives in claude/settings.json and the README 安装 prompt walks Claude Code through the merge.
# Test files ship alongside so the hooks stay verifiable after install
# (`cd ~/.claude/hooks && node --test codeagent-stdin-guard.test.js`).

HOOKS_SRC="$SCRIPT_DIR/claude/hooks"

if [ -d "$HOOKS_SRC" ]; then
    echo
    echo "Installing Claude hook scripts (wire into settings.json via the README 安装 prompt):"
    mkdir -p "$HOME/.claude/hooks/lib"
    for rel in ask-recommend-gate.js desktop-notify.js desktop-notify.test.js \
               codeagent-stdin-guard.js codeagent-stdin-guard.test.js \
               lib/llm-judge.js lib/utils.js; do
        src="$HOOKS_SRC/$rel"
        [ -f "$src" ] && link_one "$src" "$HOME/.claude/hooks/$rel"
    done
fi

# --- codeagent-wrapper binary (arm64 macOS; required by /custom:execute-plan) ---

CODEAGENT_WRAPPER="$SCRIPT_DIR/claude/bin/codeagent-wrapper"

if [ -f "$CODEAGENT_WRAPPER" ]; then
    echo
    echo "Installing codeagent-wrapper binary:"
    arch="$(uname -m)"
    os="$(uname -s)"
    if [ "$os" != "Darwin" ] || [ "$arch" != "arm64" ]; then
        echo "  [WARN] codeagent-wrapper is arm64 macOS only; current platform: $os/$arch."
        echo "         Linking anyway, but /custom:execute-plan will fail at runtime."
    fi
    link_one "$CODEAGENT_WRAPPER" "$HOME/.claude/bin/codeagent-wrapper"
fi

# --- poll-progress.sh (incremental .output reader; used by supervisor commands) ---

POLL_PROGRESS="$SCRIPT_DIR/claude/bin/poll-progress.sh"

if [ -f "$POLL_PROGRESS" ]; then
    echo
    echo "Installing poll-progress.sh:"
    chmod +x "$POLL_PROGRESS"
    link_one "$POLL_PROGRESS" "$HOME/.claude/bin/poll-progress.sh"
fi

# --- statusline scripts (produce ~/.claude/tt-status.json for tt-web) ---

STATUSLINE_FILES=(statusline.sh statusline-fields.py statusline-transcript.py)
have_statusline=0
for f in "${STATUSLINE_FILES[@]}"; do
    [ -f "$SCRIPT_DIR/claude/$f" ] && have_statusline=1 && break
done

if [ "$have_statusline" -eq 1 ]; then
    echo
    echo "Installing statusline scripts:"
    for f in "${STATUSLINE_FILES[@]}"; do
        src="$SCRIPT_DIR/claude/$f"
        [ -f "$src" ] && link_one "$src" "$HOME/.claude/$f"
    done
fi

# --- MCP server CLI tools (npm global packages) ---

# --- Update preference for existing installations ---
# Re-runs can otherwise silently bump versions of already-installed packages
# (npm globals) and refresh side artifacts (Chrome for Testing) and change
# runtime behavior. New installs always proceed; updates require explicit
# consent. Override non-interactively with UPDATE_EXISTING=0/1; non-TTY
# defaults to 0.

UPDATE_EXISTING="${UPDATE_EXISTING:-}"
if [ -z "$UPDATE_EXISTING" ]; then
    echo
    if [ -t 0 ]; then
        echo "Update existing installations? (npm globals, Chrome for Testing)"
        printf "New installs always proceed either way. [y/N] "
        read -r answer
        case "$answer" in
            y|Y|yes|YES) UPDATE_EXISTING=1 ;;
            *)           UPDATE_EXISTING=0 ;;
        esac
    else
        UPDATE_EXISTING=0
        echo "→ non-TTY: UPDATE_EXISTING=0 (existing installs left alone)"
    fi
fi

NPM_GLOBAL_LIST="$(npm list -g --depth=0 2>/dev/null || true)"

ensure_npm_global() {
    local pkg="$1"
    local name
    # Extract package name (strip trailing @version)
    if [[ "$pkg" == @*/* ]]; then
        name="$(echo "$pkg" | sed 's/@[^/]*$//')"
    else
        name="${pkg%%@*}"
    fi
    if echo "$NPM_GLOBAL_LIST" | grep -q "$name"; then
        if [ "$UPDATE_EXISTING" = "1" ]; then
            echo "  Updating $pkg..."
            npm install -g "$pkg"
        else
            echo "  [already installed] $name (skip — UPDATE_EXISTING=0)"
        fi
        return
    fi
    echo "  Installing $pkg..."
    npm install -g "$pkg"
}

echo
echo "Installing CLI tools:"

# Track whether agent-browser was preexisting so we know if `agent-browser install`
# (which refreshes Chrome for Testing) counts as a fresh-install side effect or
# an update. Fresh installs always get Chrome; updates only when opted in.
AGENT_BROWSER_PREEXISTING=0
command -v agent-browser >/dev/null 2>&1 && AGENT_BROWSER_PREEXISTING=1

ensure_npm_global "@modelcontextprotocol/server-github"
ensure_npm_global "@upstash/context7-mcp"
ensure_npm_global "agent-browser"

# Refresh Chrome for Testing only on fresh install or when explicitly updating.
if command -v agent-browser >/dev/null 2>&1; then
    if [ "$AGENT_BROWSER_PREEXISTING" = "0" ] || [ "$UPDATE_EXISTING" = "1" ]; then
        agent-browser install
    else
        echo "  [skip] agent-browser install (Chrome for Testing) — UPDATE_EXISTING=0"
    fi
fi

if [ -z "${GITHUB_PERSONAL_ACCESS_TOKEN:-}" ]; then
    echo
    echo "NOTE: GITHUB_PERSONAL_ACCESS_TOKEN is not set."
    echo "The GitHub MCP server will not work until you set this env var."
fi

echo
echo "Symlink install done. installed=$installed  overwritten=$overwritten  already_linked=$already_linked  skipped=$skipped"

# --- Shared Python venv (uv-managed) for lightweight CLI tools ---
# ip-check (requests) and tt-web (colorama) share one repo-root venv so we don't
# sprinkle ad-hoc `pip install`s across sub-installers (and dodge Homebrew
# Python's PEP 668 block). Pinned to a uv-managed CPython so `brew upgrade python`
# can't rot the venv. Honors UPDATE_EXISTING: fresh venvs install deps; existing
# ones only on consent. Exported REPO_DIR lets the tt-web sub-installer find it.
export REPO_DIR="$SCRIPT_DIR"
command -v uv >/dev/null 2>&1 || brew install uv
VENV_DIR="$REPO_DIR/.venv"
venv_created=0
if [ ! -d "$VENV_DIR" ]; then
  uv venv --python 3.13 "$VENV_DIR"
  venv_created=1
fi
if [ "$venv_created" = "1" ] || [ "$UPDATE_EXISTING" = "1" ]; then
  uv pip install --python "$VENV_DIR/bin/python" -r "$REPO_DIR/requirements.txt"
fi

# --- tt-web sub-installer (localhost token-usage dashboard) ---

TT_WEB_INSTALL="$SCRIPT_DIR/tt-web/install.sh"

if [ -x "$TT_WEB_INSTALL" ]; then
    echo
    echo "Running tt-web sub-installer:"
    "$TT_WEB_INSTALL"
fi

# --- ask-user-mcp sub-installer (Claude-compatible AskUserQuestion for Codex) ---
# Symlink the server into ~/.codex so config.toml's static path resolves regardless
# of where this repo is cloned, then install its runtime node deps.

ASK_USER_INSTALL="$SCRIPT_DIR/ask-user-mcp/install.sh"

if [ -x "$ASK_USER_INSTALL" ]; then
    echo
    echo "Running ask-user-mcp sub-installer:"
    mkdir -p "$HOME/.codex"
    link_one "$SCRIPT_DIR/ask-user-mcp" "$HOME/.codex/ask-user-mcp"
    "$ASK_USER_INSTALL" \
      || echo "WARN: ask-user-mcp deps install failed — AskUserQuestion MCP server will not start" >&2
fi

# --- Dependency validation + settings.json wiring (macOS-assumed) ---

ensure_python3 || true
ensure_jq || true
ensure_local_bin_in_path || true
check_codex_cli || true
wire_statusline_settings || true

if [ "$skipped" -gt 0 ]; then
    echo
    echo "Some targets were left as-is. Re-run this script and choose 'y' at"
    echo "the prompt if you want to overwrite them with the share version."
fi

# ---------------------------------------------------------------
# Manual step: merge top-level config files
# ---------------------------------------------------------------
# CLAUDE.md and AGENTS.md are NOT auto-symlinked because you likely
# already have your own versions and overwriting them would erase
# your customizations. Print clear instructions for two manual paths:
# (A) copy/paste yourself, or (B) hand a prompt to Claude Code.

CLAUDE_MD_SRC="$SCRIPT_DIR/claude/CLAUDE.md"
AGENTS_MD_SRC="$SCRIPT_DIR/codex/AGENTS.md"

cat <<EOF

================================================================
Next steps
================================================================

1. Merge top-level config (CLAUDE.md, AGENTS.md, config.toml)
   These were NOT auto-symlinked — that would overwrite your
   existing customizations. The README has a one-shot prompt
   you can paste into Claude Code to merge them safely.
   Note: in this repo codex/AGENTS.md is a symlink to
   claude/CLAUDE.md, so both merges draw from the same policy text.

2. Verify the install
   Run ./verify.sh for a mechanical check (symlinks, deps,
   settings.json, merged-config anchors). Exit code = FAIL count.
   The README also has a Claude Code prompt that runs verify.sh
   and then does a semantic diff of the manually-merged configs.

EOF
