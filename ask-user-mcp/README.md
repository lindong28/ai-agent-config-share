# ask-user-mcp

**What**: MCP (stdio) server exposing a Claude-compatible `AskUserQuestion` tool, implemented with MCP **elicitation** (`elicitation/create`, form mode). It lets non-Claude harnesses (currently Codex CLI) render native option-picker forms for the 70+ shared skills/commands that reference `AskUserQuestion`, without editing any of them.

Behavior mirrors Claude Code's built-in tool: 1–4 questions, 2–4 options each, `multiSelect` support, and a free-text "Other" field that overrides the selection. Decline/cancel is reported back to the model with an instruction not to answer on the user's behalf. If the client doesn't support elicitation, the tool returns a fallback instruction (numbered options in chat, stop and wait) matching the "Harness 适配" table in `claude/CLAUDE.md`.

**Install**: `./install.sh` (installs npm deps; invoked by root `install.sh`).

**Check**:

```bash
echo '{}' | node server.mjs --help 2>/dev/null; echo "syntax ok: $?"
# real check: in Codex TUI run a prompt that triggers a choice; a form should pop up.
```

**Consumers**:

- Codex CLI — registered as `[mcp_servers.ask-user]` in `codex/config.toml` (requires `[approval_policy.granular] mcp_elicitations = true`).
- Any future MCP client that declares the `elicitation` capability.
