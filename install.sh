#!/usr/bin/env bash
# install.sh — install shared AI agent configs into user-scope dirs.
#
# Auto-installed (safe to share verbatim):
#   Symlinks:
#     <repo>/claude/commands/custom/*.md  → ~/.claude/commands/custom/*.md
#     <repo>/claude/commands/routine/*.md → ~/.claude/commands/routine/*.md
#     <repo>/claude/references/*.md       → ~/.claude/references/*.md
#     <repo>/claude/agents/*.md           → ~/.claude/agents/*.md
#     <repo>/claude/bin/codeagent-wrapper-<os>-<arch> → ~/.claude/bin/codeagent-wrapper
#     <repo>/claude/bin/poll-progress.sh  → ~/.claude/bin/poll-progress.sh
#     <repo>/claude/bin/active-plan       → ~/.claude/bin/active-plan
#     <repo>/claude/hooks/*.js            → ~/.claude/hooks/*.js  (wire via README prompt)
#     <repo>/claude/statusline.sh        → ~/.claude/statusline.sh
#     <repo>/claude/statusline-fields.py → ~/.claude/statusline-fields.py
#     <repo>/claude/statusline-transcript.py → ~/.claude/statusline-transcript.py
#     <repo>/claude/statusline-usage.py  → ~/.claude/statusline-usage.py
#     <repo>/codex/agents/*.toml         → ~/.codex/agents/*.toml
#     <repo>/claude/skills/*/            → ~/.claude/skills/*
#                                        → ~/.codex/skills/*
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
# Platform note: codeagent-wrapper (required by /custom:execute-plan) ships as two
# prebuilt binaries — darwin-arm64 and linux-amd64. The installer picks the one
# matching this host and links it as ~/.claude/bin/codeagent-wrapper. On any other
# platform it warns and skips that one link; the rest of the install is unaffected.
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

# Where link_one parks a target it displaces. Deliberately outside every scan root:
# a backup left next to the original would still be discovered — Codex registers
# ~/.codex/skills/<name>.bak/SKILL.md as a second skill with the same name (verified),
# so "overwrite" would silently leave the old version competing with the new one.
BACKUP_ROOT="$HOME/.ai-agent-config-share-backups/$(date +%Y%m%d-%H%M%S)"

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
        local kind="regular file"
        if [ -d "$dst" ]; then
            kind="directory"
        fi
        if prompt_overwrite "$dst" "$kind"; then
            if [ -d "$dst" ]; then
                # `rm` cannot remove a directory, and `set -e` would abort the whole
                # installer mid-run. Move it aside instead — nothing is destroyed, and
                # the user can restore or delete the backup afterwards. It goes under
                # BACKUP_ROOT rather than beside the original: see that variable.
                local backup
                case "$dst" in
                    "$HOME"/*) backup="$BACKUP_ROOT/${dst#"$HOME"/}" ;;
                    *)         backup="$BACKUP_ROOT/${dst##*/}" ;;
                esac
                local n=1
                while [ -e "$backup" ] || [ -L "$backup" ]; do
                    backup="$backup.$n"
                    n=$((n + 1))
                done
                mkdir -p "$(dirname "$backup")"
                mv "$dst" "$backup"
                echo "  [moved aside] $dst -> $backup"
            else
                rm "$dst"
            fi
            ln -s "$src" "$dst"
            echo "  [overwritten] $dst"
            overwritten=$((overwritten + 1))
        else
            echo "  [SKIP — kept existing $kind] $dst"
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

# --- Skills (every skill directory symlinked into both harnesses) ---
# Glob-driven like link_tree() above, so adding a skill needs no edit here — and
# verify.sh derives its checks from the same listing, which is how deep-discuss
# previously ended up installed but unverified.
#
# Codex reads user skills from ~/.codex/skills (the CODEX_HOME/skills path its own
# skill-installer documents). Caveat: it does not honour Claude's
# `disable-model-invocation` frontmatter, so game-release-loop is explicit-invocation-
# only on the Claude side; in Codex it can auto-trigger off its description.

for skill_src in "$SRC_ROOT/skills"/*/; do
    [ -f "$skill_src/SKILL.md" ] || continue
    skill_name="$(basename "$skill_src")"
    echo
    echo "Installing $skill_name skill:"
    link_one "${skill_src%/}" "$HOME/.claude/skills/$skill_name"
    link_one "${skill_src%/}" "$HOME/.codex/skills/$skill_name"
done

# --- Claude hooks (symlinked per-file so we never clobber an existing ~/.claude/hooks) ---
# Only the hook scripts are linked here. Activation requires wiring the entries from
# claude/settings.json's hooks block into ~/.claude/settings.json (see that file for
# the current wiring set — HOOK_WIRING in verify.sh is the required/optional authority)
# plus ECC_DISABLED_HOOKS="stop:desktop-notify" — the reference shape lives in
# claude/settings.json and the README 安装 prompt walks Claude Code through the merge.
# Test files ship alongside so the hooks stay verifiable after install
# (`cd ~/.claude/hooks && node --test *.test.js`).
#
# Four of the Stop hooks are LLM judge gates (continuation / prose-choice /
# capability-claim / reverse-assertion): each one costs a judge call per turn that
# reaches Stop, so they are opt-in at the settings.json merge step, not forced on.
# block-broad-kill / commit-message-language / writer-registry-gate are deterministic.

HOOKS_SRC="$SCRIPT_DIR/claude/hooks"

if [ -d "$HOOKS_SRC" ]; then
    echo
    echo "Installing Claude hook scripts (wire into settings.json via the README 安装 prompt):"
    mkdir -p "$HOME/.claude/hooks/lib"
    # Glob-driven (was a hand-maintained list that drifted every sync): every
    # top-level hook script and its tests, plus lib/. run-tests.sh is repo-run-only
    # (its ../../codex relative paths do not resolve from ~/.claude/hooks).
    while IFS= read -r -d '' src; do
        rel="${src#"$HOOKS_SRC"/}"
        [ "$rel" = "run-tests.sh" ] && continue
        link_one "$src" "$HOME/.claude/hooks/$rel"
    done < <(find "$HOOKS_SRC" -maxdepth 1 -type f \( -name '*.js' -o -name '*.sh' \) -print0)
    while IFS= read -r -d '' src; do
        rel="${src#"$HOOKS_SRC"/}"
        link_one "$src" "$HOME/.claude/hooks/$rel"
    done < <(find "$HOOKS_SRC/lib" -maxdepth 1 -type f \( -name '*.js' -o -name '*.json' \) -print0)
    # Test fixtures live one dir deeper than the top-level glob; the tests that
    # require them ship alongside, so post-install verification needs them too.
    if [ -d "$HOOKS_SRC/bg-shell-reclaim-check.fixtures" ]; then
        mkdir -p "$HOME/.claude/hooks/bg-shell-reclaim-check.fixtures"
        while IFS= read -r -d '' src; do
            rel="${src#"$HOOKS_SRC"/}"
            link_one "$src" "$HOME/.claude/hooks/$rel"
        done < <(find "$HOOKS_SRC/bg-shell-reclaim-check.fixtures" -maxdepth 1 -type f -name '*.js' -print0)
    fi
fi

# --- codeagent-wrapper binary (darwin/arm64 + linux/amd64; required by /custom:execute-plan) ---
#
# Upstream ships a dispatcher that picks the platform artifact at RUN time by
# resolving <its own dir>/../.. as the repo root. That resolution assumes
# ~/.claude is a symlink to the repo's claude/ directory. This installer does not
# work that way — it links individual files into a real ~/.claude — so through the
# installed symlink the dispatcher would resolve the repo root to $HOME and break.
# This repo therefore does not carry it: we select the platform artifact HERE, at
# install time, and link it directly as ~/.claude/bin/codeagent-wrapper.
# Same platform coverage, one less indirection.

detect_platform() {
    # Emits darwin-arm64 / linux-amd64 / empty. Kept in sync with the same
    # function in verify.sh — if you change one, change both.
    #
    # `uname -m` alone is not enough on Apple Silicon: run from a Rosetta
    # (x86_64) shell it reports x86_64, and we would skip the wrapper on a
    # machine that has a perfectly good arm64 build. sysctl.proc_translated=1
    # means "this process is being translated", i.e. the host is really arm64.
    local os arch
    os="$(uname -s)"
    arch="$(uname -m)"
    if [ "$os" = "Darwin" ] && [ "$arch" = "x86_64" ]; then
        # sysctl is not always on PATH (cron, trimmed PATH, some login shells),
        # and a missing binary would read as "not translated" — i.e. exactly the
        # misdetection this correction exists to prevent. Fall back to the
        # absolute path before concluding anything.
        local sysctl_bin=""
        if command -v sysctl >/dev/null 2>&1; then sysctl_bin="$(command -v sysctl)"
        elif [ -x /usr/sbin/sysctl ]; then sysctl_bin=/usr/sbin/sysctl
        fi
        if [ -n "$sysctl_bin" ] \
            && [ "$("$sysctl_bin" -in sysctl.proc_translated 2>/dev/null || true)" = "1" ]; then
            arch=arm64
        fi
    fi
    case "$os/$arch" in
        Darwin/arm64)             printf 'darwin-arm64' ;;
        Linux/x86_64|Linux/amd64) printf 'linux-amd64' ;;
        *)                        printf '' ;;
    esac
}

CODEAGENT_PLATFORM="$(detect_platform)"

CODEAGENT_WRAPPER="$SCRIPT_DIR/claude/bin/codeagent-wrapper-$CODEAGENT_PLATFORM"

echo
echo "Installing codeagent-wrapper binary:"
if [ -z "$CODEAGENT_PLATFORM" ]; then
    echo "  [WARN] No codeagent-wrapper build for $(uname -s)/$(uname -m)."
    echo "         Supported: Darwin/arm64, Linux/x86_64. /custom:execute-plan's"
    echo "         delegation step will be unavailable; everything else installs normally."
elif [ ! -f "$CODEAGENT_WRAPPER" ]; then
    echo "  [WARN] Missing build for this platform: claude/bin/codeagent-wrapper-$CODEAGENT_PLATFORM"
    echo "         /custom:execute-plan's delegation step will be unavailable."
else
    chmod +x "$CODEAGENT_WRAPPER"
    link_one "$CODEAGENT_WRAPPER" "$HOME/.claude/bin/codeagent-wrapper"
    echo "  [platform] $CODEAGENT_PLATFORM"
fi

# --- poll-progress.sh (incremental .output reader; used by supervisor commands) ---

POLL_PROGRESS="$SCRIPT_DIR/claude/bin/poll-progress.sh"

if [ -f "$POLL_PROGRESS" ]; then
    echo
    echo "Installing poll-progress.sh:"
    chmod +x "$POLL_PROGRESS"
    link_one "$POLL_PROGRESS" "$HOME/.claude/bin/poll-progress.sh"
fi

# --- active-plan (locates the plan.md currently in force; used by the plan commands) ---

ACTIVE_PLAN="$SCRIPT_DIR/claude/bin/active-plan"

if [ -f "$ACTIVE_PLAN" ]; then
    echo
    echo "Installing active-plan:"
    chmod +x "$ACTIVE_PLAN"
    link_one "$ACTIVE_PLAN" "$HOME/.claude/bin/active-plan"
fi

# --- probe / observability CLIs (referenced by references/ and skills) ---
for b in page-acceptance page-repetition first-screen-density visual-budget interaction-latency; do
    src="$SCRIPT_DIR/claude/bin/$b"
    [ -f "$src" ] && link_one "$src" "$HOME/.claude/bin/$b"
done

# --- claude/scripts (session locator, MCP dedup, compaction hooks) ---
SCRIPTS_SRC="$SCRIPT_DIR/claude/scripts"
if [ -d "$SCRIPTS_SRC" ]; then
    echo
    echo "Installing claude/scripts:"
    for rel in find-claude-session.sh mcp-dedup.py peer-session-watch.js; do
        [ -f "$SCRIPTS_SRC/$rel" ] && link_one "$SCRIPTS_SRC/$rel" "$HOME/.claude/scripts/$rel"
    done
    while IFS= read -r -d '' src; do
        rel="${src#"$SCRIPTS_SRC"/}"
        link_one "$src" "$HOME/.claude/scripts/$rel"
    done < <(find "$SCRIPTS_SRC/hooks" -maxdepth 1 -type f -name '*.js' -print0)
fi


# --- statusline scripts (produce ~/.claude/tt-status.json for tt-web) ---

STATUSLINE_FILES=(statusline.sh statusline-fields.py statusline-transcript.py statusline-usage.py)
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

# --- Sweep symlinks left behind by earlier versions of this repo ---
# Removing a file from the repo stops install.sh from linking it, but does nothing
# about the link an earlier install already created — and verify.sh cannot see it
# either, because every check walks the *source* tree. A consumer who installed a
# previous version and pulled this one would keep dangling links (e.g. to hooks/eval/,
# rules/, bin/gate-stats) forever. Only links whose target points inside THIS repo and
# whose target no longer exists are removed; foreign links and live links are untouched.
sweep_stale_links() {
    local root="$1" link target swept=0
    [ -d "$root" ] || return 0
    while IFS= read -r -d '' link; do
        target="$(readlink "$link")"
        case "$target" in
            "$SCRIPT_DIR"/*)
                if [ ! -e "$link" ]; then
                    rm -f "$link" && swept=$((swept+1))
                    echo "  [swept] $link → $target (source removed from repo)"
                fi
                ;;
        esac
    done < <(find "$root" -type l -print0 2>/dev/null)
    [ "$swept" -gt 0 ] && echo "  swept $swept stale link(s) under $root"
    return 0
}

echo
echo "Sweeping stale links from earlier installs:"
sweep_stale_links "$HOME/.claude"
sweep_stale_links "$HOME/.codex"
# Empty dirs the swept links used to live in (hooks/eval/<gate>/, rules/common/…).
find "$HOME/.claude/hooks/eval" "$HOME/.claude/rules" -type d -empty -delete 2>/dev/null || true

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

# --- Codex hook parity layer (mirrors the Claude gates on Codex events) ---
# ~/.codex/hooks.json is read by the Codex CLI; the dispatcher resolves hook
# scripts through its own realpath back into this repo, so a symlink suffices.
mkdir -p "$HOME/.codex/bin"
link_one "$SCRIPT_DIR/codex/hooks.json" "$HOME/.codex/hooks.json"
link_one "$SCRIPT_DIR/codex/bin/codex-hook-dispatch.js" "$HOME/.codex/bin/codex-hook-dispatch.js"


# --- Dependency validation + settings.json wiring (macOS-assumed) ---

ensure_python3 || true

# --- ~/.agents/skills wrapper farm (gives Codex $custom-<x> entries for commands) ---
if command -v python3 >/dev/null 2>&1; then
    echo
    echo "Building ~/.agents/skills wrapper farm (gen-agents-skills.py):"
    python3 "$SCRIPT_DIR/codex/bin/gen-agents-skills.py" || echo "  [WARN] gen-agents-skills.py failed — Codex loses \$custom-<x> wrappers until rerun"
fi
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
