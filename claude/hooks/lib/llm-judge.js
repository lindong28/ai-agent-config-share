#!/usr/bin/env node
/**
 * 共享 LLM 判官后端——给 stop-gate.js / ask-recommend-gate.js 复用。
 *
 * 分层后端（按顺序取第一个可用的）：
 *   1. GLM-4.6     —— 有 ZHIPU_API_KEY 或 ~/.claude/.glm-judge-key 时。智谱 Anthropic 兼容端点，~2s。
 *   2. Anthropic API —— 有 ANTHROPIC_API_KEY 时。Haiku 4.5，~2s。
 *   3. claude -p 订阅 —— 都没有时。用本机登录的 Claude Code 订阅跑 Haiku，~15s（CLI 固有启动开销），
 *                       但免任何 key、官方、会自动刷新 token。带防递归护栏。
 *   都不可用 / 出错 / 超时 → 返回 null（调用方 fail-open，绝不困住 agent）。
 *
 * 防递归（关键）：tier 3 spawn 的 `claude -p` 跑完会触发【它自己那个进程】的 Stop hook → 又跑 stop-gate →
 * 若仍走到 tier 3 → 再 spawn claude -p → 无限递归。护栏：spawn 时往子进程 env 注入 NEST_GUARD=1；
 * 子进程的 hook 继承它，hook 在 main() 开头见到 NEST_GUARD 就直接放行（见两个 hook 的 main）。
 * 此处 claudeCli 也二次自检 NEST_GUARD，belt-and-suspenders。递归被钉死在深度 1。
 *
 * 判官只需对一段 prompt 回一行文本（"ok" / "flag: ..."）；本模块只负责【选后端 + 取原始文本】，
 * prompt 构造与 ok/flag 解析留在各 hook 里（它们判据不同）。
 */
"use strict";
const fs = require("fs");
const os = require("os");
const { spawnSync } = require("child_process");

// spawn claude -p 时注入子进程 env 的哨兵；两个 hook 在 main() 开头检查它以防递归。
const NEST_GUARD = "CLAUDE_LLM_JUDGE_NESTED";

const GLM_URL = "https://open.bigmodel.cn/api/anthropic/v1/messages";
const GLM_MODEL = "glm-4.6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"; // 性价比层，非最强
const CLI_MODEL = "haiku"; // claude -p 的别名，解析到最新 Haiku（最便宜层）
const HTTP_TIMEOUT_MS = 12000;
const CLI_TIMEOUT_MS = 25000; // claude -p 冷启动 ~15s、含嵌套 session hook 开销实测 ~21s；留余量。须 < 各 hook 在 settings 里的 timeout（28s），以便超时清洁 fail-open 而非被硬杀。

function glmKey() {
  if (process.env.ZHIPU_API_KEY) return process.env.ZHIPU_API_KEY;
  try {
    return fs
      .readFileSync(os.homedir() + "/.claude/.glm-judge-key", "utf8")
      .trim();
  } catch {
    return "";
  }
}

// curl 一个 Anthropic 风格 /v1/messages 端点（GLM 与真 Anthropic 同 shape）；返回 assistant 文本或 null。
function curlMessages(url, key, model, prompt, timeoutMs) {
  const r = spawnSync(
    "curl",
    [
      "-s",
      "-X",
      "POST",
      "--max-time",
      String(Math.ceil(timeoutMs / 1000)),
      "-H",
      `x-api-key: ${key}`,
      "-H",
      "anthropic-version: 2023-06-01",
      "-H",
      "content-type: application/json",
      "-d",
      JSON.stringify({
        model,
        max_tokens: 120,
        messages: [{ role: "user", content: prompt }],
      }),
      url,
    ],
    { encoding: "utf8", timeout: timeoutMs + 2000 },
  );
  if (r.error || r.status !== 0 || !r.stdout) return null;
  try {
    return ((JSON.parse(r.stdout).content || [{}])[0].text || "").trim() || null;
  } catch {
    return null;
  }
}

// 解析 claude CLI 真实二进制（交互态 `claude` 是 shell function，PATH 里才是二进制）。找不到 → "claude" 兜底（靠 PATH）。
function resolveClaudeBin() {
  if (process.env.CLAUDE_CLI_PATH && fs.existsSync(process.env.CLAUDE_CLI_PATH))
    return process.env.CLAUDE_CLI_PATH;
  const home = os.homedir();
  for (const p of [
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    home + "/.claude/local/claude",
    home + "/.local/bin/claude",
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return "claude";
}

// tier 3：订阅 CLI 判官，防递归。返回文本或 null。
function claudeCli(prompt) {
  if (process.env[NEST_GUARD]) return null; // 已在嵌套判官内——绝不再 spawn
  const r = spawnSync(
    resolveClaudeBin(),
    ["-p", prompt, "--model", CLI_MODEL, "--output-format", "text", "--strict-mcp-config"],
    {
      encoding: "utf8",
      timeout: CLI_TIMEOUT_MS,
      env: { ...process.env, [NEST_GUARD]: "1" },
    },
  );
  if (r.error || r.status !== 0 || !r.stdout) return null;
  return r.stdout.trim() || null;
}

/**
 * 选第一个可用后端，返回判官的原始文本（已 trim）或 null。
 * 顺序：GLM（ZHIPU）→ Anthropic API（ANTHROPIC_API_KEY）→ claude -p 订阅。
 */
function callJudge(prompt) {
  const gk = glmKey();
  if (gk) return curlMessages(GLM_URL, gk, GLM_MODEL, prompt, HTTP_TIMEOUT_MS);

  const ak = process.env.ANTHROPIC_API_KEY;
  if (ak) return curlMessages(ANTHROPIC_URL, ak, ANTHROPIC_MODEL, prompt, HTTP_TIMEOUT_MS);

  return claudeCli(prompt);
}

module.exports = { callJudge, claudeCli, NEST_GUARD };
