#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { knowledgeReadPaths } = require("../../claude/hooks/lib/codex-shell-read");

const MAX_STDIN = 1024 * 1024;
const CHILD_TIMEOUT_MS = 50_000;
const BLOCKING_MODES = new Set(["permission", "bash", "writer", "ask", "mcp-pre", "stop", "subagent-stop"]);

function repoRoot() {
  if (process.env.NODE_ENV === "test" && process.env.CODEX_HOOK_PARITY_REPO) {
    return path.resolve(process.env.CODEX_HOOK_PARITY_REPO);
  }
  return path.resolve(__dirname, "..", "..");
}

function claudeHook(name) { return path.join(repoRoot(), "claude", "hooks", name); }
function claudeScriptHook(name) { return path.join(repoRoot(), "claude", "scripts", "hooks", name); }

function readInput() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    process.stdin.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, MAX_STDIN - size);
      if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
      size += buffer.length;
      if (size > MAX_STDIN) overflow = true;
    });
    const finish = () => resolve({ raw: Buffer.concat(chunks).toString("utf8"), overflow });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

function rejectOversizedInput(mode) {
  const blocking = BLOCKING_MODES.has(mode);
  let message;
  if (mode === "writer") {
    message = "Codex hook 输入超过 1 MiB，无法完整检查 apply_patch 的全部内容。本次修改已阻止；请拆成更小的 patch 后重试。";
  } else if (mode === "session-end") {
    message = "Codex hook 输入超过 1 MiB，未执行会话结束清理。本次会话的临时 hook 状态可能残留；无需重试，下一次 startup/resume 会先清理。";
  } else {
    const action = blocking
      ? "本次操作已阻止；请缩短输入或拆成更小的工具调用后重试。"
      : "本次 hook 未执行，相关状态尚未更新；请缩短输入后重试。";
    message = `Codex hook 输入超过 1 MiB，无法完整检查 ${mode || "unknown"} 事件。${action}`;
  }
  process.stderr.write(`[codex-hook-dispatch] ${message}\n`);
  process.exitCode = blocking ? 2 : 1;
}

function parseInput(raw) {
  try { return raw.trim() ? JSON.parse(raw) : {}; } catch { return {}; }
}

function normalizeInput(mode, input) {
  const normalized = { ...(input || {}) };
  if (mode === "ask" && normalized.tool_name === "mcp__ask_user__AskUserQuestion") {
    normalized.tool_name = "AskUserQuestion";
  }
  return normalized;
}

function knowledgePathsFromCommand(command) {
  return knowledgeReadPaths(command);
}

function failureText(input) {
  const output = input && input.tool_output;
  return [
    input && input.error,
    input && input.message,
    input && input.tool_response,
    typeof output === "string" ? output : null,
    output && output.output,
    output && output.stderr,
  ].filter(Boolean).map((value) => typeof value === "string" ? value : JSON.stringify(value)).join("\n");
}

function isPostToolFailure(input) {
  if (input && (input.isError === true || input.success === false || input.error)) return true;
  return /\b(error|failed|failure|timed?\s*out|connection\s+(?:closed|refused)|server\s+disconnected)\b/i.test(failureText(input));
}

function syncChild(command, args, raw, options = {}) {
  const result = spawnSync(command, args, {
    input: raw,
    encoding: "utf8",
    cwd: process.cwd(),
    env: { ...process.env, ...(options.env || {}) },
    timeout: options.timeout || CHILD_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    status: Number.isInteger(result.status) ? result.status : 1,
    stdout: result.stdout || "",
    stderr: result.stderr || (result.error ? `${result.error.message}\n` : ""),
  };
}

function asyncChild(command, args, raw, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { if (stdout.length < 4 * 1024 * 1024) stdout += chunk; });
    child.stderr.on("data", (chunk) => { if (stderr.length < 4 * 1024 * 1024) stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeout || CHILD_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: 1, stdout, stderr: `${stderr}${error.message}\n` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ status: Number.isInteger(code) ? code : 1, stdout, stderr: signal ? `${stderr}terminated by ${signal}\n` : stderr });
    });
    child.stdin.end(raw);
  });
}

function asyncNode(script, raw, options = {}) {
  return asyncChild(process.execPath, [script], raw, options);
}

function runWithFlags(hookId, scriptName, raw) {
  return syncChild(process.execPath, [claudeHook("run-with-flags.js"), hookId, scriptName], raw);
}

function runWithFlagsAsync(hookId, scriptName, raw) {
  return asyncChild(process.execPath, [claudeHook("run-with-flags.js"), hookId, scriptName], raw);
}

function runPluginWithFlags(hookId, scriptName, profiles, raw, env = {}) {
  return syncChild(
    process.execPath,
    [claudeScriptHook("run-with-flags.js"), hookId, `scripts/hooks/${scriptName}`, profiles],
    raw,
    { env },
  );
}

function emitBlock(results) {
  const blockers = results.filter((result) => result.status === 2);
  if (!blockers.length) return false;
  for (const result of blockers) process.stderr.write(result.stderr || "Hook blocked the action.\n");
  process.exitCode = 2;
  return true;
}

function setGhostty(state) {
  syncChild("bash", [claudeHook("ghostty-tab-title.sh"), state], "", { timeout: 5000 });
}

function notify(input) {
  syncChild(process.execPath, [claudeHook("desktop-notify.js")], JSON.stringify(input), { timeout: 10000 });
}

function stateDir() {
  const base = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(base, "state", "hook-parity", "active-subagents");
}

function validStatePart(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{3,160}$/.test(value);
}

function stateFile(sessionId) {
  return validStatePart(sessionId) ? path.join(stateDir(), `${sessionId}.json`) : null;
}

function readAgents(sessionId) {
  const file = stateFile(sessionId);
  if (!file) return {};
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

function writeAgents(sessionId, agents) {
  const file = stateFile(sessionId);
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!Object.keys(agents).length) {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
    return;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(agents), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function updateSubagent(input, active) {
  const sessionId = input.session_id;
  const agentId = input.agent_id || input.subagent_id;
  if (!validStatePart(sessionId) || !validStatePart(agentId)) return;
  const agents = readAgents(sessionId);
  if (active) agents[agentId] = { type: input.agent_type || null, started_at: new Date().toISOString() };
  else delete agents[agentId];
  writeAgents(sessionId, agents);
}

function hasActiveSubagent(input) {
  return Object.keys(readAgents(input.session_id)).length > 0;
}

function cleanupSession(input) {
  const file = stateFile(input.session_id);
  if (file) try { fs.unlinkSync(file); } catch { /* already gone */ }
}

function handleSessionStart(input) {
  if (["startup", "resume"].includes(input.source)) cleanupSession(input);
}

async function handlePermission(raw, input) {
  const result = runWithFlags("permission-gate", "permission-gate.js", raw);
  let decision = null;
  try { decision = JSON.parse(result.stdout); } catch { decision = null; }
  const specific = decision && decision.hookSpecificOutput;
  if (specific && specific.decision && specific.decision.behavior === "ask") {
    notify({ ...input, hook_event_name: "Notification", notification_type: "permission_prompt", message: `Codex needs permission to use ${input.tool_name || "a tool"}` });
    setGhostty("alert");
  }
  if (specific) process.stdout.write(JSON.stringify(decision));
  if (result.stderr) process.stderr.write(result.stderr);
}

async function handleBash(raw) {
  const specs = [
    ["block-no-verify", "block-no-verify.js"],
    ["codeagent-stdin-guard", "codeagent-stdin-guard.js"],
    ["block-broad-kill", "block-broad-kill.js"],
    ["push-approval-gate", "push-approval-gate.js"],
    ["commit-message-language", "commit-message-language.js"],
    ["commit-discipline-gate", "commit-discipline-gate.js"],
  ];
  emitBlock(await Promise.all(specs.map(([id, script]) => runWithFlagsAsync(id, script, raw))));
}

async function handleWriter(raw) {
  emitBlock([runWithFlags("writer-registry-gate", "writer-registry-gate.js", raw)]);
}

async function handleAsk(input) {
  const normalized = normalizeInput("ask", input);
  emitBlock([syncChild(process.execPath, [claudeHook("ask-recommend-gate.js")], JSON.stringify(normalized))]);
}

async function handleMcp(raw, post) {
  const input = parseInput(raw);
  if (post && !isPostToolFailure(input)) return;
  const result = runPluginWithFlags(
    post ? "post:mcp-health-check" : "pre:mcp-health-check",
    "mcp-health-check.js",
    "standard,strict",
    raw,
    { CLAUDE_HOOK_EVENT_NAME: post ? "PostToolUseFailure" : "PreToolUse" },
  );
  if (result.stderr) process.stderr.write(result.stderr);
  if (!post) emitBlock([result]);
}

async function handleSkillAudit(input) {
  const command = input && input.tool_input && input.tool_input.command;
  for (const filePath of knowledgePathsFromCommand(command)) {
    const synthetic = JSON.stringify({
      ...input,
      tool_name: "Read",
      tool_input: { file_path: filePath },
    });
    syncChild(process.execPath, [claudeScriptHook("skill-audit.js")], synthetic, { timeout: 5000 });
  }
}

async function handleStop(raw, input) {
  const scripts = [
    "stop-gate.js",
    "continuation-claim-gate.js",
    "prose-choice-gate.js",
    "capability-claim-gate.js",
    "reverse-assertion-gate.js",
    "bg-shell-reclaim-check.js",
  ].filter((script) => script !== "continuation-claim-gate.js" || !hasActiveSubagent(input));
  const results = await Promise.all(scripts.map((script) => asyncNode(claudeHook(script), raw)));
  if (emitBlock(results)) return;
  setGhostty("idle");
  notify({ ...input, hook_event_name: "Stop" });
  setGhostty("alert");
}

async function handleSubagentStop(raw, input) {
  const result = await asyncNode(claudeHook("stop-gate.js"), raw);
  if (emitBlock([result])) return;
  updateSubagent(input, false);
}

async function main() {
  const mode = process.argv[2] || "";
  const { raw, overflow } = await readInput();
  if (overflow) {
    rejectOversizedInput(mode);
    return;
  }
  const input = parseInput(raw);
  switch (mode) {
    case "permission": await handlePermission(raw, input); break;
    case "bash": await handleBash(raw); break;
    case "writer": await handleWriter(raw); break;
    case "ask": await handleAsk(input); break;
    case "mcp-pre": await handleMcp(raw, false); break;
    case "mcp-post": await handleMcp(raw, true); break;
    case "skill-audit": await handleSkillAudit(input); break;
    case "stop": await handleStop(raw, input); break;
    case "subagent-start": updateSubagent(input, true); break;
    case "subagent-stop": await handleSubagentStop(raw, input); break;
    case "session-start": handleSessionStart(input); break;
    case "session-end": cleanupSession(input); setGhostty("idle"); break;
    default: break;
  }
}

module.exports = { normalizeInput, knowledgePathsFromCommand, isPostToolFailure, hasActiveSubagent };

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[codex-hook-dispatch] ${error.message}\n`);
    process.exitCode = 1;
  });
}
