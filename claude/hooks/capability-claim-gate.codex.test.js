#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const gatePath = path.join(__dirname, "capability-claim-gate.js");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capability-codex-"));
const transcript = path.join(dir, "rollout.jsonl");
fs.writeFileSync(transcript, [
  JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: "pwd" } }),
  JSON.stringify({ type: "response_item", payload: { type: "function_call", namespace: "collaboration", name: "spawn_agent", arguments: "{}" } }),
  JSON.stringify({ type: "response_item", payload: { type: "function_call", namespace: "ask_user", name: "AskUserQuestion", arguments: "{}" } }),
  "",
].join("\n"));

const probe = spawnSync(process.execPath, ["-e", `
  process.env.CODEX_HOOK_TEST_EXPORTS = '1';
  const gate = require(${JSON.stringify(gatePath)});
  const got = gate.attemptedTools(${JSON.stringify(transcript)});
  console.log(JSON.stringify([...got.exact].sort()));
`], { encoding: "utf8", timeout: 5000 });

assert.equal(probe.status, 0, probe.stderr);
const names = JSON.parse(probe.stdout);
assert.ok(names.includes("bash"), "Codex exec must count as Bash evidence");
assert.ok(names.includes("agent"), "Codex spawn_agent must count as Agent evidence");
assert.ok(names.includes("mcp__ask_user__askuserquestion"), "namespaced function calls need a canonical MCP alias");
console.log("capability claim Codex transcript test passed");
