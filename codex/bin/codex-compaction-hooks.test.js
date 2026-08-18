#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { after, before, test } = require("node:test");

const REPO = path.resolve(__dirname, "../..");
const CONFIG = path.join(REPO, "codex", "hooks.json");
const ACTIVE_PLAN = path.join(REPO, "claude", "bin", "active-plan");

let fakeHome;
let transcriptPath;
let planPath;
let programPath;

function loadConfig() {
  assert.equal(fs.existsSync(CONFIG), true, "codex/hooks.json must exist");
  return JSON.parse(fs.readFileSync(CONFIG, "utf8"));
}

function findCommand(config, eventName, matcher) {
  const groups = config.hooks && config.hooks[eventName];
  assert.ok(Array.isArray(groups), `${eventName} hook groups must exist`);
  const group = groups.find((candidate) => candidate.matcher === matcher);
  assert.ok(group, `${eventName} matcher ${matcher} must exist`);
  assert.equal(group.hooks.length, 1, `${eventName} must have one canonical handler`);
  const handler = group.hooks[0];
  assert.equal(handler.type, "command");
  assert.equal(handler.async, undefined, `${eventName} recovery hook must stay synchronous`);
  return handler.command;
}

function hookEnvironment(extra = {}) {
  return {
    ...process.env,
    HOME: fakeHome,
    PATH: "/usr/bin:/bin",
    CODEX_THREAD_ID: "",
    CLAUDE_CODE_SESSION_ID: "",
    CLAUDE_SESSION_ID: "",
    ...extra,
  };
}

function runCommand(command, input, extraEnv = {}) {
  return spawnSync("/bin/sh", ["-c", command], {
    encoding: "utf8",
    input: JSON.stringify(input),
    env: hookEnvironment(extraEnv),
  });
}

function declareActive(target, type, sid) {
  const result = spawnSync(process.execPath, [ACTIVE_PLAN, "set", target, "--type", type], {
    encoding: "utf8",
    env: hookEnvironment({ CODEX_THREAD_ID: sid }),
  });
  assert.equal(result.status, 0, `active-plan producer failed: ${result.stderr}`);
}

function runRecovery(type, target, sid) {
  const config = loadConfig();
  declareActive(target, type, sid);
  const pre = runCommand(findCommand(config, "PreCompact", "manual|auto"), {
    session_id: sid,
    transcript_path: transcriptPath,
    cwd: REPO,
    hook_event_name: "PreCompact",
    trigger: "manual",
    turn_id: `turn-${sid}`,
  });
  assert.equal(pre.status, 0, pre.stderr);
  const start = runCommand(findCommand(config, "SessionStart", "compact"), {
    session_id: sid,
    transcript_path: transcriptPath,
    cwd: REPO,
    hook_event_name: "SessionStart",
    source: "compact",
  });
  assert.equal(start.status, 0, start.stderr);
  assert.notEqual(start.stdout, "", "SessionStart(compact) must inject recovery context");
  return JSON.parse(start.stdout).hookSpecificOutput.additionalContext;
}

before(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-compaction-hooks-"));
  const localBin = path.join(fakeHome, ".local", "bin");
  fs.mkdirSync(localBin, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(localBin, "node"));
  const hookDir = path.join(fakeHome, ".claude", "scripts", "hooks");
  fs.mkdirSync(hookDir, { recursive: true });
  for (const script of ["pre-compact.js", "post-compact-restore.js"]) {
    fs.symlinkSync(path.join(REPO, "claude", "scripts", "hooks", script), path.join(hookDir, script));
  }
  const fixtures = path.join(fakeHome, "fixtures");
  fs.mkdirSync(path.join(fixtures, "plan"), { recursive: true });
  fs.mkdirSync(path.join(fixtures, "program"), { recursive: true });
  planPath = path.join(fixtures, "plan", "plan.md");
  programPath = path.join(fixtures, "program", "program.md");
  fs.writeFileSync(planPath, "# Plan\n");
  fs.writeFileSync(path.join(fixtures, "plan", "state.md"), "# State\n");
  fs.writeFileSync(path.join(fixtures, "plan", "journal.md"), "# Journal\n");
  fs.writeFileSync(programPath, "# Program\n");
  transcriptPath = path.join(fixtures, "transcript.jsonl");
  fs.writeFileSync(transcriptPath, "");
});

after(() => {
  if (fakeHome) fs.rmSync(fakeHome, { recursive: true, force: true });
});

test("Codex hook config carries both synchronous compaction handlers", () => {
  const config = loadConfig();
  assert.match(findCommand(config, "PreCompact", "manual|auto"), /pre-compact\.js/);
  assert.match(findCommand(config, "SessionStart", "compact"), /post-compact-restore\.js/);
});

test("real Codex producer and hook envelopes recover program and plan markers", () => {
  const programSid = `codex-program-${crypto.randomUUID()}`;
  const program = runRecovery("program", programPath, programSid);
  assert.match(program, /ACTIVE PROGRAM/);
  assert.match(program, new RegExp(programPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const planSid = `codex-plan-${crypto.randomUUID()}`;
  const plan = runRecovery("plan", planPath, planSid);
  assert.match(plan, /ACTIVE LONG-TASK PLAN/);
  assert.match(plan, /state\s+: .*state\.md/);
  assert.match(plan, /journal: .*journal\.md/);
});

test("producer and hook session mismatch never injects the other session's marker", () => {
  const owner = `codex-owner-${crypto.randomUUID()}`;
  const other = `codex-other-${crypto.randomUUID()}`;
  const config = loadConfig();
  declareActive(programPath, "program", owner);
  const pre = runCommand(findCommand(config, "PreCompact", "manual|auto"), {
    session_id: other,
    transcript_path: transcriptPath,
    cwd: REPO,
    hook_event_name: "PreCompact",
    trigger: "auto",
    turn_id: `turn-${other}`,
  });
  assert.equal(pre.status, 0, pre.stderr);
  const start = runCommand(findCommand(config, "SessionStart", "compact"), {
    session_id: other,
    transcript_path: transcriptPath,
    cwd: REPO,
    hook_event_name: "SessionStart",
    source: "compact",
  });
  assert.equal(start.status, 0, start.stderr);
  assert.equal(start.stdout, "", "mismatched session without useful state must inject nothing");
});

test("hook inventory validator detects removed handlers and changed matchers", () => {
  const config = loadConfig();
  const missing = structuredClone(config);
  delete missing.hooks.PreCompact;
  assert.throws(() => findCommand(missing, "PreCompact", "manual|auto"), /PreCompact hook groups must exist/);

  const changed = structuredClone(config);
  const compact = changed.hooks.SessionStart.find((group) => group.matcher === "compact");
  assert.ok(compact, "fixture guard: SessionStart(compact) must exist before mutation");
  compact.matcher = "startup|resume";
  assert.throws(() => findCommand(changed, "SessionStart", "compact"), /SessionStart matcher compact must exist/);

  assert.doesNotThrow(() => findCommand(loadConfig(), "PreCompact", "manual|auto"));
  assert.doesNotThrow(() => findCommand(loadConfig(), "SessionStart", "compact"));
});
