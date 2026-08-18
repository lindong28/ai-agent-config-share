#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const REPO = path.resolve(__dirname, "..", "..");
const DISPATCHER = path.join(__dirname, "codex-hook-dispatch.js");

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

function fakeHookRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hook-edge-"));
  for (const script of ["stop-gate.js", "continuation-claim-gate.js", "prose-choice-gate.js", "capability-claim-gate.js", "reverse-assertion-gate.js", "bg-shell-reclaim-check.js"]) {
    writeExecutable(path.join(root, "claude", "hooks", script), "process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));\n");
  }
  writeExecutable(path.join(root, "claude", "hooks", "desktop-notify.js"), "process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));\n");
  writeExecutable(path.join(root, "claude", "hooks", "ghostty-tab-title.sh"), "#!/bin/sh\nexit 0\n");
  writeExecutable(path.join(root, "claude", "hooks", "run-with-flags.js"), "process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));\n");
  return root;
}

test("oversized blocking input fails closed while lifecycle input fails loudly", () => {
  const root = fakeHookRoot();
  const oversized = "x".repeat(1024 * 1024);
  const writer = runDispatcher("writer", {
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_input: { command: oversized },
  }, { CODEX_HOOK_PARITY_REPO: root });
  assert.equal(writer.status, 2, "an oversized blocking hook payload must fail closed");
  assert.match(writer.stderr, /输入超过 1 MiB.*无法完整检查 apply_patch/u);
  assert.match(writer.stderr, /请拆成更小的 patch 后重试/u);

  const lifecycle = runDispatcher("session-end", {
    hook_event_name: "SessionEnd",
    session_id: "oversized-session",
    message: oversized,
  }, { CODEX_HOOK_PARITY_REPO: root });
  assert.equal(lifecycle.status, 1, "an oversized lifecycle payload must fail loudly");
  assert.match(lifecycle.stderr, /未执行会话结束清理/u);
  assert.match(lifecycle.stderr, /无需重试.*startup\/resume/u);
});

for (const source of ["startup", "resume"]) {
  test(`SessionStart:${source} clears stale subagent state before the next Stop`, () => {
    const root = fakeHookRoot();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hook-state-"));
    const stateEnv = { CODEX_HOME: home, CODEX_HOOK_PARITY_REPO: root };
    const stateFile = path.join(home, "state", "hook-parity", "active-subagents", "resume-session.json");
    const continuationMarker = path.join(root, "continuation-ran");
    writeExecutable(
      path.join(root, "claude", "hooks", "continuation-claim-gate.js"),
      `const fs=require('fs'); process.stdin.resume(); process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(continuationMarker)},'yes');process.exit(0);});\n`,
    );

    const start = runDispatcher("subagent-start", {
      hook_event_name: "SubagentStart",
      session_id: "resume-session",
      agent_id: `agent-${source}`,
    }, stateEnv);
    assert.equal(start.status, 0, start.stderr);
    assert.equal(fs.existsSync(stateFile), true, "fixture must create stale state");

    const sessionStart = runDispatcher("session-start", {
      hook_event_name: "SessionStart",
      source,
      session_id: "resume-session",
    }, stateEnv);
    assert.equal(sessionStart.status, 0, sessionStart.stderr);
    assert.equal(fs.existsSync(stateFile), false, `${source} must clear stale subagent state`);

    const stop = runDispatcher("stop", {
      hook_event_name: "Stop",
      session_id: "resume-session",
      last_assistant_message: "done",
    }, stateEnv);
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(fs.existsSync(continuationMarker), true, "the next Stop must run continuation-claim-gate");
  });
}

test("SessionStart:compact does not clear current subagent state", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hook-state-"));
  const stateEnv = { CODEX_HOME: home };
  const stateFile = path.join(home, "state", "hook-parity", "active-subagents", "compact-session.json");
  runDispatcher("subagent-start", {
    hook_event_name: "SubagentStart",
    session_id: "compact-session",
    agent_id: "agent-compact",
  }, stateEnv);
  assert.equal(fs.existsSync(stateFile), true, "fixture must create active state");
  const compact = runDispatcher("session-start", {
    hook_event_name: "SessionStart",
    source: "compact",
    session_id: "compact-session",
  }, stateEnv);
  assert.equal(compact.status, 0, compact.stderr);
  assert.equal(fs.existsSync(stateFile), true, "compact restore must not clear active subagent state");
});
