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

// 本进程上一次 callJudge 选中的判官路由（见 lastJudgeRoute 的注释）。每个 hook 是独立进程，
// 故这份模块级状态天然按调用隔离，不需要重置。
let lastRoute = null;

const GLM_URL = "https://open.bigmodel.cn/api/anthropic/v1/messages";
const GLM_MODEL = "glm-4.6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"; // 性价比层，非最强
const CLI_MODEL = "haiku"; // claude -p 的别名，解析到最新 Haiku（最便宜层）
const HTTP_TIMEOUT_MS = 12000;
// claude -p 冷启动 ~15s、含嵌套 session hook 开销实测 ~21s；留余量。
//
// 这两个上限是各调用方 hook 在 settings 里 timeout 的下界：判官耗时 + 该 hook 在判官之后还要做的同步
// 工作，必须仍小于它的 timeout，否则超时会把它硬杀、而不是让它清洁 fail-open。注意 callJudge() 选定
// 第一个有 key 的后端后不再回落，所以单次调用只付其中一个上限：有 HTTP key 时是 HTTP_TIMEOUT_MS+2s
// （curl 的 spawn 余量），两个 key 都没有时才是 CLI_TIMEOUT_MS。
//
// 现状：stop-gate 28s（判官之后无同步工作）；ask-recommend-gate 40s（判官放行后还要同步发桌面通知——
// tmux 客户端查询最坏 4s，加 desktop-notify 的 TTY_WALK_BUDGET_MS 最坏 3s，合计 ≤7s）。
// 给某个调用方新增判官之后的同步工作时，同步核对并抬高它的 timeout。
const CLI_TIMEOUT_MS = 25000;

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
// temperature 可选：判官类用途传 0——它**压低但不消除**方差（实测见下方 callJudge 的注释）；不传则用端点默认。
function curlMessages(url, key, model, prompt, timeoutMs, temperature) {
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
        ...(temperature !== undefined ? { temperature } : {}),
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
 * 选一个后端，返回判官的原始文本（已 trim）或 null。
 * 顺序：GLM（ZHIPU）→ Anthropic API（ANTHROPIC_API_KEY）→ claude -p 订阅。
 *
 * **按 key 的存在性选一次，不做失败回落**：GLM key 在位时永远走 GLM，它超时或报错就直接返回 null，
 * 不会改投 Anthropic。所以"同一条输入两次判定不同"排除不掉模型本身的非确定性——它不可能是换了后端。
 *
 * temperature 可选：HTTP 两层（GLM / Anthropic）透传；判官类调用传 0。
 * tier-3 的 `claude -p` 无温度旋钮，故有 HTTP key 时（恒走前两层）才保证 temp 生效。
 * **temp=0 不等于判定确定**：2026-08-08 实测同一条消息经 prose-choice-gate 判 15 次出现 1 次反向，
 * 全程 GLM（按上一段，不可能是后端切换）。各 gate 的 eval 保留通过率余量正是为此，别按"确定"去掉它。
 */
function callJudge(prompt, temperature) {
  const gk = glmKey();
  if (gk) {
    lastRoute = { backend: "glm", model: GLM_MODEL };
    return curlMessages(GLM_URL, gk, GLM_MODEL, prompt, HTTP_TIMEOUT_MS, temperature);
  }

  const ak = process.env.ANTHROPIC_API_KEY;
  if (ak) {
    lastRoute = { backend: "anthropic", model: ANTHROPIC_MODEL };
    return curlMessages(ANTHROPIC_URL, ak, ANTHROPIC_MODEL, prompt, HTTP_TIMEOUT_MS, temperature);
  }

  // `model: null` 不是遗漏，是**把"未知"建模成可观察状态**：`claude -p --model haiku` 传的是别名，
  // 调用侧拿不到它此刻解析到哪个具体版本，而别名指向换代时任何固定字符串都会保持不变、把
  // "判官换了"伪装成"判据变了"。写死一个 `haiku` 会让日志把不知道呈现得像知道；留空则读者一眼看出
  // 这一层的具体模型不可考。要关掉这个未知项须改 claudeCli 的输出解析——本模块的分层后端由 7 道 gate
  // 共用（stop / ask-recommend / prose-choice / capability-claim / reverse-assertion / continuation-claim
  // / permission），改错会让它们在无 HTTP key 的环境下一起静默 fail-open，故另案处理。
  lastRoute = { backend: "claude-cli", model: null };
  return claudeCli(prompt);
}

/**
 * 本进程上一次 callJudge 选中的判官路由 `{ backend, model }`；没调过判官时为 null（早退路径即如此）。
 *
 * - `backend`：走了哪一层（`glm` / `anthropic` / `claude-cli`）。
 * - `model`：该层此次使用的**具体模型 id**；`null` 表示**调用侧解析不到**（当前仅 tier-3 如此，见 callJudge）。
 *   两者分开正是为了让"不知道具体模型"成为数据里的可观察状态，而不是一个看起来像模型名的别名字符串。
 *
 * 存在的理由是**跨环境**而非跨调用：路由由 key 的存在性决定，而非交互 shell 拿不到 rc 里导出的
 * `ZHIPU_API_KEY`（见 CLAUDE.md「非交互 Shell 里执行命令」），于是 cron / ssh / git hook 触发的
 * 同一道闸会静默换成另一个模型、另一套校准。裁决日志不记它，事后就分不出"判据变了"与"判官换了"。
 * 返回的是**选中**的路由，不是"成功作答"的路由——判官不可用时它仍指向那次尝试的对象。
 * 同一进程内多次调用 callJudge 时它只保留最后一次；各 hook 每进程至多调一次判官，故当前无歧义，
 * 但若将来某个 hook 要连调两次，得改成由调用方显式携带、而不是继续读这份"最近一次"状态。
 */
function lastJudgeRoute() {
  return lastRoute;
}

module.exports = { callJudge, claudeCli, lastJudgeRoute, NEST_GUARD };
