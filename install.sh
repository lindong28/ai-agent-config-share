#!/usr/bin/env bash
# install.sh — install shared AI agent configs into user-scope dirs.
#
# Auto-installed (safe to share verbatim):
#   Symlinks:
#     <repo>/claude/commands/custom/*.md → ~/.claude/commands/custom/*.md
#     <repo>/claude/references/*.md      → ~/.claude/references/*.md
#     <repo>/codex/agents/*.toml         → ~/.codex/agents/*.toml
#     <repo>/claude/skills/agent-browser → ~/.claude/skills/agent-browser
#                                      → ~/.codex/skills/agent-browser
#   npm global packages:
#     MCP server CLI tools referenced by codex/config.toml
#     agent-browser
#
# Manual merge required (preserves existing customizations):
#   <repo>/claude/CLAUDE.md  → merge into ~/.claude/CLAUDE.md
#   <repo>/codex/AGENTS.md   → merge into ~/.codex/AGENTS.md
#   <repo>/codex/config.toml → merge into ~/.codex/config.toml
#
# Symlink policy: if a target path already exists (file, dir, or symlink
# pointing elsewhere), prompt the user whether to overwrite it. In a
# non-interactive shell the prompt defaults to skip (preserve existing).

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

prompt_overwrite() {
    # Ask the user whether to replace an existing target with our symlink.
    # Returns 0 (yes) or 1 (no / no tty). Silent — caller prints messaging.
    #
    # Reads from /dev/tty directly because the caller runs inside a
    # `while read; done < <(find ...)` loop, where stdin is the find pipe,
    # not the terminal. /dev/tty bypasses that.
    if [ ! -e /dev/tty ] || [ ! -r /dev/tty ]; then
        return 1
    fi

    local dst="$1"
    local detail="$2"
    {
        echo "  [CONFLICT] $dst already exists ($detail)"
        printf "  Replace with symlink to share version? [y/N] "
    } >/dev/tty
    local answer=""
    read -r answer </dev/tty
    case "$answer" in
        y|Y|yes|YES) return 0 ;;
        *) return 1 ;;
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

echo "ai-agent-config-share installer"
echo "  source: $SCRIPT_DIR"
echo "  target: $HOME"

link_tree "commands/custom"
link_tree "references"

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

# --- MCP server CLI tools (npm global packages) ---

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
        echo "  [already installed] $name"
        return
    fi
    echo "  Installing $pkg..."
    npm install -g "$pkg"
}

echo
echo "Installing CLI tools:"
ensure_npm_global "@modelcontextprotocol/server-github"
ensure_npm_global "@modelcontextprotocol/server-memory"
ensure_npm_global "@modelcontextprotocol/server-sequential-thinking"
ensure_npm_global "@upstash/context7-mcp"
ensure_npm_global "agent-browser"

# Download Chrome for Testing (idempotent — skips if already present)
if command -v agent-browser >/dev/null 2>&1; then
    agent-browser install
fi

if [ -z "${GITHUB_PERSONAL_ACCESS_TOKEN:-}" ]; then
    echo
    echo "NOTE: GITHUB_PERSONAL_ACCESS_TOKEN is not set."
    echo "The GitHub MCP server will not work until you set this env var."
fi

echo
echo "Symlink install done. installed=$installed  overwritten=$overwritten  already_linked=$already_linked  skipped=$skipped"

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
Next step: merge top-level config
================================================================

CLAUDE.md, AGENTS.md, and config.toml were NOT auto-symlinked —
that would overwrite your existing customizations. The README has a
one-shot prompt you can paste into Claude Code to merge them safely.

EOF
