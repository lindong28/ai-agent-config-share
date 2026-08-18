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
 * 这三层是**按 key 存在性选一次**的并列关系。此外还有一层**正交**的兜底（不参与上面的选路）：
 *   兜底. 火山 Ark（glm-5.3）—— 仅当调用方传 `opts.fallback: true` **且**上面选中的 HTTP 层返回 null 时。
 *         它换的是供应商与配额：实测同一时刻各发 12 并发，智谱出现 429 限流而 Ark 12/12 通过。
 *         详见 judgeWithRoute 的注释（含启用集合、为何排除 permission-gate、以及它自己那套验收标准）。
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

// 本进程发起过多少次判官调用。**只表达存在性，不表达身份**——路由身份由 judgeWithRoute 逐调用
// 返回、调用方显式携带（ADR-019）。这两件事必须分开：身份放模块级会张冠李戴（HARNESS-314 就是
// stop-gate 一个进程调两次判官把它证伪的），而"这个进程调过判官没有"本就是一个进程级事实，
// 不指向"是谁"，故结构上不可能归错。
//
// 它唯一的消费者是 judge-log：靠它把"这条裁决未经判官"（计数 0）与"调用方漏传了归属声明"
// （计数 >0 却什么都没传）分开。没有它，两者在日志里是同一个形状——两键缺席。
let judgeCallCount = 0;

const GLM_URL = "https://open.bigmodel.cn/api/anthropic/v1/messages";
const GLM_MODEL = "glm-4.6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"; // 性价比层，非最强
const CLI_MODEL = "haiku"; // claude -p 的别名，解析到最新 Haiku（最便宜层）

// 兜底层：火山引擎 Ark 的 agent plan。**只在主判官返回 null 且调用方显式 opt-in 时启用**，见 judgeWithRoute。
// 这几个取值全部来自实测，改任何一个之前先复测：
//   · agent plan **只服务 `glm-5.3`**——`glm-5` / `glm-4.6` 都返回 `UnsupportedModel: does not support
//     the agent plan feature`。所以兜底判官必然是另一个模型、另一套校准，不是主判官的第二条线路。
//   · `thinking:{"type":"disabled"}` 在**这个**端点上返回 `InvalidParameter`（智谱侧同一个 glm-5.3 却支持）。
//     关不掉推理的代价是延迟失控：真实 gate prompt 上实测 5.9–49.1s，且**与 prompt 长短无关**
//     （最慢的 `cant-do-assertion` 只有 375 字节），并会在 `max_tokens` 耗尽时返回 `finish_reason:"length"`
//     加空 content——即"兜底装上了却静默不作为"，日志里与后端挂掉同形。
//   · `reasoning_effort:"low"` 是解药：同一最慢场景 45s → 2–4s，token 消耗 1889 → 3–57，空回答消失。
//     18 次采样（6 场景 ×3）最大 7.3s，故 ARK_TIMEOUT_MS 取 15s（约 2 倍余量）。
//     **别只看耗时判断该参数生效没有**——一个 400 拒绝同样很快返回，两者在耗时列上完全同形；
//     要核 `finish_reason` / `usage` / `content` 才分得开（本仓实测时险些据耗时定稿）。
//   · max_tokens 2048：低推理档下实测消耗 3–57，余量数十倍。调高**不是**更安全——延迟随它上升。
const ARK_URL_DEFAULT = "https://ark.cn-beijing.volces.com/api/plan/v3";
const ARK_MODEL = "glm-5.3";
const ARK_MAX_TOKENS = 2048;
const ARK_TIMEOUT_MS = 15000;

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

// 兜底层的 key。与 glmKey 同构（env 优先、文件回落）：hook 跑在**非交互** shell 里，cron / ssh / git hook
// 触发时拿不到 rc 导出的变量（见 CLAUDE.md「非交互 Shell 里执行命令」），文件回落是那些环境下唯一的路径。
// 取不到 → 返回 ""，兜底整层不尝试，行为与加这层之前完全一致。
function arkKey() {
  if (process.env.ARK_API_KEY) return process.env.ARK_API_KEY;
  try {
    return fs.readFileSync(os.homedir() + "/.claude/.ark-judge-key", "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * curl 火山 Ark 的 OpenAI 兼容 `/chat/completions`。返回 `{ text, failure }`——**两者恰有一个非 null**。
 *
 * 与 `curlMessages` 不同形，因为端点不同形：认证是 `Authorization: Bearer`（不是 `x-api-key`）、
 * 请求体是 OpenAI shape、应答读 `choices[0].message.content`（不是 `content[0].text`）。
 *
 * `failure` 存在的理由：兜底的失败必须与"没兜底"分得开，否则日志里一片 `judge_unavailable`，
 * 而"主判官挂了没试 Ark"与"两个都试了都挂"是完全不同的两件事（前者是接线漏了，后者是真的都不可用）。
 * 取值刻意含 `empty_completion`——推理吃满 `max_tokens` 时端点回 `finish_reason:"length"` 且 content 为空，
 * 那既不是超时也不是报错，不单列就会伪装成后端不可用。
 */
function curlArk(prompt, timeoutMs) {
  const key = arkKey();
  if (!key) return { text: null, failure: "no_key" };
  const base = (process.env.ARK_BASE_URL || ARK_URL_DEFAULT).replace(/\/+$/, "");
  const r = spawnSync(
    "curl",
    [
      "-s",
      "-X",
      "POST",
      "--max-time",
      String(Math.ceil(timeoutMs / 1000)),
      "-H",
      `Authorization: Bearer ${key}`,
      "-H",
      "content-type: application/json",
      "-d",
      JSON.stringify({
        model: ARK_MODEL,
        max_tokens: ARK_MAX_TOKENS,
        reasoning_effort: "low",
        messages: [{ role: "user", content: prompt }],
      }),
      `${base}/chat/completions`,
    ],
    { encoding: "utf8", timeout: timeoutMs + 2000 },
  );
  // curl 的 28 是超时，其余非零是传输层；spawn 自身失败（r.error）另计。三者分开是为了让
  // "限流窗口里 Ark 也不通"与"本机网络断了"在日志里不同形。
  if (r.error) return { text: null, failure: "spawn_error" };
  if (r.status === 28) return { text: null, failure: "timeout" };
  if (r.status !== 0) return { text: null, failure: `transport_${r.status}` };
  if (!r.stdout) return { text: null, failure: "empty_response" };
  let body;
  try {
    body = JSON.parse(r.stdout);
  } catch {
    return { text: null, failure: "parse_error" };
  }
  if (body.error) return { text: null, failure: "api_error" };
  const choice = (body.choices || [{}])[0] || {};
  const text = ((choice.message || {}).content || "").trim();
  if (!text) {
    return {
      text: null,
      failure: choice.finish_reason === "length" ? "empty_completion" : "empty_content",
    };
  }
  return { text, failure: null };
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
 * 选一个后端，返回 `{ text, route }`：`text` 是判官的原始文本（已 trim）或 null，
 * `route` 是**这一次**调用选中的路由 `{ backend, model }`。
 *
 * **`route` 随返回值走、不落任何模块级状态**（ADR-019）。它描述的是选中的路由，不是"成功作答"的
 * 路由——判官超时或报错时 `text` 为 null 而 `route` 仍指向那次尝试的对象。写裁决日志的调用方必须
 * 把它一路传到自己那条 `logVerdict`；`backend`/`model` 不可省的理由是路由由 key 的存在性决定，
 * 而非交互 shell 拿不到 rc 里导出的 `ZHIPU_API_KEY`（见 CLAUDE.md「非交互 Shell 里执行命令」），
 * 于是 cron / ssh / git hook 触发的同一道闸会静默换成另一个模型、另一套校准；日志不记它，事后就
 * 分不出"判据变了"与"判官换了"。
 *
 * `model` 为 `null` 表示**调用侧解析不到具体版本**（当前仅 tier-3 如此，见下），这是一个有意义的
 * 可观察状态，不是遗漏。
 *
 * 顺序：GLM（ZHIPU）→ Anthropic API（ANTHROPIC_API_KEY）→ claude -p 订阅。
 *
 * **主判官按 key 的存在性选一次，不在 HTTP 两层之间回落**：GLM key 在位时永远走 GLM，不会改投 Anthropic。
 * 这条不变量的**目的**是归因能力——让"同一条输入两次判定不同"排除得掉"换了后端"这个解释。
 *
 * `opts.fallback: true` 是它唯一的例外，且**不损害那个目的**：主判官返回 null（即它根本没作答）时改投
 * 火山 Ark 兜底，而 route 会记下 `backend:"ark"` 与 `fallback_from`，于是"换没换后端"在日志里逐条可读，
 * 归因由记录承载而不再由"禁止切换"承载。**默认 false**——不传即行为与加这层之前完全一致。
 *
 * 启用集合是**六道写裁决日志的闸的主判官调用**。刻意排除两处：
 *   · `permission-gate` —— 它的失败方向与其余六道**相反**：判官不可用 → 落回问用户（比正常更保守），
 *     判官答 `safe` → **自动放行工具调用**。给它接一个未经校准的兜底，是把"不确定就问你"换成
 *     "另一个模型说 safe 就自动放行"，那是提高风险不是提高可用性。它还不写裁决日志（HARNESS-315），
 *     换没换判官事后也查不出来。
 *   · `stop-gate` 的 policy 判官（`{httpOnly:true, timeoutMs:8000}` 那次）—— 它自述是"锦上添花"判据，
 *     且一个进程里已有两次判官调用，再给它叠 15s 会把 hook 预算顶穿。
 * 这两处由 `llm-judge.callsites.test.js` 机械钉住：它枚举两个入口的全部调用点，断言带 `fallback` 的
 * 恰好是那六个。**该断言不禁止 permission-gate 将来改用 judgeWithRoute**（HARNESS-315 的修法要它写日志），
 * 只禁止它带上 fallback。
 *
 * 兜底的验收标准与主判官**不同**，这是刻意的：主判官的对照物是"另一个能工作的判官"，兜底的对照物是
 * **根本没有判官**（主判官已经失败，不兜底就是 fail-open）。故两侧代价不对称——兜底漏一个 flag 等同今天的
 * fail-open、无新损失；兜底误报一个 flag 则是今天不会发生的新增打断。因此兜底校准要求 **ok 侧 100%**
 * （不得引入新误报），flag 侧只要有下限即可，不套用各闸给主判官定的 flag 100%。（2026-08-17 用户裁决。）
 *
 * temperature 可选：HTTP 两层（GLM / Anthropic）透传；判官类调用传 0。
 * tier-3 的 `claude -p` 无温度旋钮，故有 HTTP key 时（恒走前两层）才保证 temp 生效。
 * **temp=0 不等于判定确定**：2026-08-08 实测同一条消息经 prose-choice-gate 判 15 次出现 1 次反向，
 * 全程 GLM（按上一段，不可能是后端切换）。各 gate 的 eval 保留通过率余量正是为此，别按"确定"去掉它。
 */
function judgeWithRoute(prompt, temperature, opts) {
  // `opts.timeoutMs`：可选的**更短**预算，只收紧不放宽（`Math.min`）。存在的理由是预算加总——
  // 一个 hook 进程里若有两次判官调用，各自按默认 12s + 2s 保护上限就吃满 28s 的 hook 超时，
  // 不给 git、文件扫描和 prompt 构造留余量（2026-08-13 复核 finding 2）。默认不传＝行为不变。
  // `opts.httpOnly`：只走 HTTP 两层；两层都无 key 时返回 null 而**不**降级到 tier-3 的
  // `claude -p`。它把"选路"与"调用"合成一次原子决定——先查后调之间 key 文件被轮换/删除时，
  // 预检说 HTTP、实际却落到 CLI，双 CLI 超时路径会重新出现（同上，TOCTOU 那半）。
  const httpTimeout = opts && opts.timeoutMs
    ? Math.min(HTTP_TIMEOUT_MS, opts.timeoutMs)
    : HTTP_TIMEOUT_MS;
  judgeCallCount++;

  // 兜底一次。两个字段各答一个问题，别混：
  //   · **"Ark 有没有被调用过" 由 `backend === "ark"` 回答**，不由 fallback_from 回答。
  //   · `fallback_from` 只回答**它接替了谁**；校准旁路（下面那个 JUDGE_FORCE_BACKEND 分支）
  //     不接替任何人，故它是 null 而 Ark 确实跑了。所以"fallback_from 缺席 ⇒ 没试过 Ark"是错的。
  // 需要区分的那两件事——"主判官挂了但没试兜底"（接线漏了）与"两个都试了都挂"——判据是
  // `backend`：前者 `backend:"glm"` 且 text 为 null，后者 `backend:"ark"` 且 text 为 null。
  // 两者若同形，最要紧的那条双失败路径就永远不可观测。
  const toArk = (from) => {
    const r = curlArk(prompt, ARK_TIMEOUT_MS);
    const route = { backend: "ark", model: ARK_MODEL, fallback_from: from };
    if (r.failure) route.failure = r.failure;
    return { text: r.text, route };
  };

  const wantFallback = !!(opts && opts.fallback);

  // 校准专用旁路：把主判官直接换成 Ark，用来测"Ark 判得准不准"。它测不到生产接线（那由
  // callsites 测试与端到端验收覆盖），别拿它的绿灯当接线已验证。
  //
  // **它同样受 opts.fallback 约束。** 初版把这一行放在 wantFallback 之前，理由是"校准与接线是
  // 两件事、校准不必过接线"——那句话本身没错，但它开出了一条绕过整道 opt-in 防线的第二通路：
  // `callJudge` 也走 judgeWithRoute，于是只要这个环境变量在，**permission-gate 的判官就变成 Ark**，
  // 而那道闸判官答 `safe` 即自动放行工具调用，正是整个 opt-in 要挡的那一件事。
  // callsites 测试挡不住它——那道防线本身完好，洞在它旁边。
  // 加这个约束不损失任何校准能力：被校准的六道闸本就都传 fallback。
  if (wantFallback && process.env.JUDGE_FORCE_BACKEND === "ark") return toArk(null);

  const gk = glmKey();
  if (gk) {
    const text = curlMessages(GLM_URL, gk, GLM_MODEL, prompt, httpTimeout, temperature);
    if (text !== null || !wantFallback) return { text, route: { backend: "glm", model: GLM_MODEL } };
    return toArk("glm");
  }

  const ak = process.env.ANTHROPIC_API_KEY;
  if (ak) {
    const text = curlMessages(ANTHROPIC_URL, ak, ANTHROPIC_MODEL, prompt, httpTimeout, temperature);
    if (text !== null || !wantFallback)
      return { text, route: { backend: "anthropic", model: ANTHROPIC_MODEL } };
    return toArk("anthropic");
  }

  if (opts && opts.httpOnly) {
    return { text: null, route: { backend: "none", model: null } };
  }

  // `model: null` 不是遗漏，是**把"未知"建模成可观察状态**：`claude -p --model haiku` 传的是别名，
  // 调用侧拿不到它此刻解析到哪个具体版本，而别名指向换代时任何固定字符串都会保持不变、把
  // "判官换了"伪装成"判据变了"。写死一个 `haiku` 会让日志把不知道呈现得像知道；留空则读者一眼看出
  // 这一层的具体模型不可考。要关掉这个未知项须改 claudeCli 的输出解析——本模块的分层后端由 7 道 gate
  // 共用（stop / ask-recommend / prose-choice / capability-claim / reverse-assertion / continuation-claim
  // / permission），改错会让它们在无 HTTP key 的环境下一起静默 fail-open，故另案处理。
  return { text: claudeCli(prompt), route: { backend: "claude-cli", model: null } };
}

/**
 * 只要文本、不写裁决日志时用它——返回值与本函数历史签名完全一致（判官原始文本或 null）。
 *
 * **要写裁决日志就别用它，用 `judgeWithRoute`**：`logVerdict` 需要这次调用的路由，而本函数把它丢了。
 * 现役唯一的正当消费者是 `permission-gate`——它不写裁决日志（HARNESS-315），拿到路由也无处可用。
 * 保留本函数而不是让所有调用点改返回类型，是 ADR-019 的取舍：`~/.claude` 直链工作树，改返回类型
 * 会在编辑期间产生"新 llm-judge + 旧 gate"的瞬态，那时 `/^flag/i.test(对象)` 恒不匹配、该闸静默恒判 ok。
 */
function callJudge(prompt, temperature, opts) {
  return judgeWithRoute(prompt, temperature, opts).text;
}

/**
 * 本进程发起过判官调用没有（`judgeWithRoute` 每次调用都 +1，含最终不可用的那些）。
 *
 * **它不回答"是谁在判"**——那由 `judgeWithRoute` 的返回值逐调用携带。分开是 ADR-019 的核心：
 * 身份放模块级会张冠李戴，而存在性不会，因为它根本不指向任何一次具体调用。
 *
 * 唯一消费者是 `judge-log.logVerdict`，用来把两种同形的情况分开：
 *   - 计数 0 + 未携带路由 → 这条裁决**未经判官**（判官前早退），两键缺席是正确的。
 *   - 计数 >0 + 未携带路由且未声明 `judged:false` → **调用方漏了归属声明**，落 `judge_attribution_missing`。
 */
function judgeCallsMade() {
  return judgeCallCount;
}

/**
 * 这次调用会不会落到**快速 HTTP 后端**（GLM / Anthropic），而不是 tier-3 的 `claude -p`。
 *
 * 纯查询、不发请求、不改任何既有行为。存在的理由：调用方需要在**调用之前**知道自己
 * 负担不负担得起。tier-3 单次典型 ~15s、上限 25s，而 hook 超时是 28s——一个进程里串两次
 * tier-3 调用会被硬杀，而不是干净 fail-open（2026-08-13 对抗评审 finding 3）。
 * 判据与 `callJudge` 的选择顺序同源：按 key 的存在性选，不做失败回落。
 */
function hasFastJudgeBackend() {
  return Boolean(glmKey() || process.env.ANTHROPIC_API_KEY);
}

module.exports = { judgeWithRoute, callJudge, claudeCli, judgeCallsMade, hasFastJudgeBackend, NEST_GUARD };
