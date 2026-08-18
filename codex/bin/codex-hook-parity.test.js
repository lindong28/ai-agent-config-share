#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO = path.resolve(__dirname, "..", "..");
const SETTINGS = path.join(REPO, "claude", "settings.json");
const MANIFEST = path.join(REPO, "codex", "hook-parity.json");
const CONFIG = path.join(REPO, "codex", "hooks.json");
const DISPATCHER = path.join(REPO, "codex", "bin", "codex-hook-dispatch.js");

function sourceHandlers(settings) {
  const out = [];
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    for (const group of groups) {
      for (const hook of group.hooks || []) {
        out.push({ event, matcher: group.matcher || "*", type: hook.type, command: hook.command || "" });
      }
    }
  }
  return out;
}

function key(value) { return JSON.stringify(value); }

function writeExecutable(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function runDispatcher(mode, input, env = {}) {
  return spawnSync(process.execPath, [DISPATCHER, mode], {
    input: JSON.stringify(input),
    encoding: "utf8",
    cwd: REPO,
    env: { ...process.env, NODE_ENV: "test", ...env },
    timeout: 10000,
  });
}

const settings = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
assert.equal(fs.existsSync(MANIFEST), true, "Codex hook parity manifest must exist");
const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const expected = sourceHandlers(settings);
assert.equal(expected.length, 20, "fixture guard: active Claude handler count changed");
assert.deepEqual(
  new Set(manifest.handlers.map((entry) => key(entry.source))),
  new Set(expected.map(key)),
  "every active Claude user-policy handler must have one explicit Codex classification",
);
assert.equal(manifest.handlers.length, expected.length, "manifest must not contain duplicates");
for (const entry of manifest.handlers) {
  assert.ok(["fixture-verified", "live-verified", "harness-specific-excluded"].includes(entry.status), `${entry.id} has an invalid status`);
  assert.ok(entry.reason, `${entry.id} must explain its mapping or exclusion`);
}

assert.equal(fs.existsSync(DISPATCHER), true, "Codex hook dispatcher must exist");
const config = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
const configCommands = Object.values(config.hooks).flatMap((groups) =>
  groups.flatMap((group) => (group.hooks || []).map((hook) => hook.command || ""))
);
const passthroughHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hook-stdout-"));
writeExecutable(
  path.join(passthroughHome, ".claude", "hooks", "ghostty-tab-title.sh"),
  "#!/bin/sh\ncat\n",
);
const hookInput = JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash" });
const titleCommands = configCommands.filter((command) => command.includes("ghostty-tab-title.sh"));
assert.ok(titleCommands.length > 0, "fixture guard: Codex must register terminal-title hooks");
for (const command of titleCommands) {
  const result = spawnSync("/bin/sh", ["-c", command], {
    input: hookInput,
    encoding: "utf8",
    env: { ...process.env, HOME: passthroughHome },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "Codex title hooks must not echo event input as hook output");
}
// share carries a curated hook subset: permission / mcp-health / skill-audit dispatch
// modes are not registered here (their Claude-side hooks are not part of this repo).
for (const mode of ["bash", "writer", "ask", "stop", "subagent-stop", "session-start", "session-end"]) {
  assert.ok(
    configCommands.some((command) => command.includes("codex-hook-dispatch.js") && command.includes(` ${mode}'`)),
    `hooks.json must register ${mode}`,
  );
}

const dispatcher = require(DISPATCHER);
const ask = dispatcher.normalizeInput("ask", {
  hook_event_name: "PreToolUse",
  tool_name: "mcp__ask_user__AskUserQuestion",
  tool_input: { questions: [] },
});
assert.equal(ask.tool_name, "AskUserQuestion");

assert.equal(dispatcher.isPostToolFailure({ tool_response: "completed successfully" }), false);
assert.equal(dispatcher.isPostToolFailure({ tool_response: "MCP error: connection closed" }), true);
assert.deepEqual(
  dispatcher.knowledgePathsFromCommand("sed -n '1,240p' /Users/example/.agents/skills/create-commit/SKILL.md"),
  ["/Users/example/.agents/skills/create-commit/SKILL.md"],
);
assert.deepEqual(
  dispatcher.knowledgePathsFromCommand("echo /Users/example/.agents/skills/create-commit/SKILL.md"),
  [],
  "mentioning a skill path must not be recorded as reading it",
);
assert.deepEqual(
  dispatcher.knowledgePathsFromCommand("bash -lc 'cat /Users/example/.agents/skills/create-commit/SKILL.md'"),
  ["/Users/example/.agents/skills/create-commit/SKILL.md"],
  "one shell wrapper around a real reader must retain read semantics",
);
assert.deepEqual(
  dispatcher.knowledgePathsFromCommand("bash -lc 'cat /Users/example/.agents/skills/create-commit/SKILL.md; echo done'"),
  ["/Users/example/.agents/skills/create-commit/SKILL.md"],
  "a reader followed by another command inside the wrapper must retain read semantics",
);
assert.deepEqual(
  dispatcher.knowledgePathsFromCommand("bash -lc 'echo /Users/example/.agents/skills/create-commit/SKILL.md'"),
  [],
  "a shell wrapper must not turn a path mention into a read",
);

// Any Stop blocker must suppress the end-of-turn notification.
const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hook-parity-"));
const marker = path.join(fakeRoot, "notified");
for (const script of ["stop-gate.js", "continuation-claim-gate.js", "prose-choice-gate.js", "capability-claim-gate.js", "reverse-assertion-gate.js", "bg-shell-reclaim-check.js"]) {
  writeExecutable(path.join(fakeRoot, "claude", "hooks", script), "process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));\n");
}
writeExecutable(
  path.join(fakeRoot, "claude", "hooks", "desktop-notify.js"),
  `const fs=require('fs'); process.stdin.resume(); process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(marker)},'yes');});\n`,
);
writeExecutable(path.join(fakeRoot, "claude", "hooks", "ghostty-tab-title.sh"), "#!/bin/sh\nexit 0\n");
writeExecutable(
  path.join(fakeRoot, "claude", "hooks", "run-with-flags.js"),
  "process.stdin.resume(); process.stdin.on('end',()=>setTimeout(()=>process.exit(0),250));\n",
);

const bashStarted = Date.now();
const bash = runDispatcher("bash", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "true" } }, {
  CODEX_HOOK_PARITY_REPO: fakeRoot,
});
assert.equal(bash.status, 0, bash.stderr);
assert.ok(Date.now() - bashStarted < 900, "the six Claude Bash gates must retain concurrent launch semantics");

// share does not register the permission dispatch mode (permission-gate is not part of this repo).

let stop = runDispatcher("stop", { hook_event_name: "Stop", last_assistant_message: "done" }, { CODEX_HOOK_PARITY_REPO: fakeRoot });
assert.equal(stop.status, 0, stop.stderr);
assert.equal(fs.existsSync(marker), true, "all-clear Stop must notify after gates complete");
fs.unlinkSync(marker);

writeExecutable(
  path.join(fakeRoot, "claude", "hooks", "reverse-assertion-gate.js"),
  "process.stdin.resume(); process.stdin.on('end',()=>{process.stderr.write('blocked by fixture\\n');process.exit(2);});\n",
);
stop = runDispatcher("stop", { hook_event_name: "Stop", last_assistant_message: "done" }, { CODEX_HOOK_PARITY_REPO: fakeRoot });
assert.equal(stop.status, 2);
assert.match(stop.stderr, /blocked by fixture/);
assert.equal(fs.existsSync(marker), false, "blocked Stop must not notify");

// share does not register the skill-audit dispatch mode (scripts/hooks/skill-audit.js is not part of this repo).

console.log("codex hook parity tests passed");
