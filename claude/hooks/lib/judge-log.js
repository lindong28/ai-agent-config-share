"use strict";
/**
 * LLM 判官 gate 的裁决落盘——给本目录下调用 `callJudge` 的判官闸共用（当前 6 道，权威名单见
 * `claude/bin/gate-stats`；此处**刻意不枚举**，枚举式清单在这个仓里已经过期过一次）。
 *
 * 为什么存在：这些 gate 都 fail-open，且**只在 block 时**向外说话。于是"这一停没被拦"这一个观测，
 * 同时对应几件不同的事——判官判了 ok、判官后端不可用、hook 早退没走到判官。用户实测问过
 * 「hook 刚才触发了吗？判定是啥？」，当时 harness 结构上答不出来：那两道 gate 不写任何日志，
 * 放行路径零痕迹。（同事件的 bg-shell-reclaim-check.js 一直在写 jsonl，所以这不是一条深思熟虑的
 * 取舍，是两处不一致。）`verdict` 因此必须把这些情形分开，别退化成布尔。
 *
 * **不记被判的那段话**——它可能含 API key、签名 URL、私有 prompt；bg-shell-reclaim-check 对被委派
 * 命令原文立过同一条纪律。改存 `session_id` + `transcript_path` 指针，需要原文时按 id 回转录里取。
 * 但 `reason` 是判官从那段话里**提炼**出来的，它可以逐字复述其中的片段——所以这条纪律不是"日志里
 * 没有原文内容"的保证，只是把面缩到一行。相应地：`reason` 截断到 REASON_MAX，且文件按 0600 建
 * （历史上建成 0644 的也就地收紧——同机其它账户可读过它）。
 *
 * 字段集按 `~/.claude/references/schema-design-principles.md` 定（人读的数据契约：读者用 jq / tail 看）：
 *   ts                ISO 8601，自带时区，不需要读者猜单位
 *   gate              哪一道闸。三道共写一个文件，故同一次 stop 上各 gate 的裁决可按 ts 对齐
 *   event             hook_event_name（Stop / SubagentStop / PreToolUse）。不可省：stop-gate 同时注册在
 *                     Stop 与 SubagentStop，缺它则两类裁决在读者眼里长得一模一样
 *   verdict           ok | flag | judge_unavailable | skipped —— 见上，这套区分是本模块存在的理由。
 *                     **取值域是共享且可扩的**：各闸按自己的出口自加值（现役另有 continuation-claim
 *                     的 `ok_live_task` / `detect_unavailable` / `ok_override`）。本模块不校验取值，
 *                     所以新增前须先看消费方会把它归哪一档——`gate-stats` 把 flag 后紧跟的非
 *                     `ok`/`flag` 一律算 ambiguous。判据见 references/judge-gate-authoring.md §6
 *   reason            flag 的判官理由，或 skipped 的早退原因码。存在性由 verdict 唯一决定、同一处写入
 *   backend           本进程**选中**的判官路由：`glm` | `anthropic` | `claude-cli`。是"选中"不是"成功
 *                     作答"——判官超时 / 报错时它仍指向那次尝试的对象（此时 `verdict` 为
 *                     `judge_unavailable`）。按它统计作答量须先按 `verdict` 过滤，否则失败尝试会被算进去。
 *                     **写入规则：本进程调用过 `callJudge` 就写，与最终 verdict 无关。** 所以
 *                     `skipped` **可能带** backend——capability-claim-gate 是两段式，判官抽取成功后第二段
 *                     取证不足仍会 skip（该文件判官调用之后的两处 `skip()`）。反向亦成立：带了 backend
 *                     就一定调过判官（本进程内）。缺席即本进程未调用过判官——判官前的各条早退，以及
 *                     stop-gate 那条确定性兜底 flag（其 `reason` 已写明"未经判官"）。
 *                     不可省的理由是路由由 key 的存在性决定，而非交互 shell 拿不到 rc 里导出的
 *                     `ZHIPU_API_KEY`——cron / ssh / git hook 触发的同一道闸会静默换成另一层、另一套校准。
 *   model             该路由此次使用的**具体模型 id**。**缺席 = 调用侧解析不到**，当前仅 `claude-cli`
 *                     一层如此（`claude -p --model haiku` 传的是别名，调用侧无从知道它此刻指向哪个版本）。
 *                     刻意留空而不是写死 `haiku`：别名指向换代时任何固定字符串都会保持不变，把"判官换了"
 *                     伪装成"判据变了"，而那正是本组字段要分开的两件事。**`backend` 在而 `model` 缺席
 *                     是一个有意义的状态**（具体模型不可考），不是漏填；两键同时缺席才是"未经判官"
 *
 * **历史分界**：这两个键定型于 2026-08-08。此前的记录单看一条无从与"未经判官"区分，故同一步把当时的
 * 日志整体改名为 `judge-gate.jsonl.legacy-20260808` 并让主日志从空开始——分界因此落在**文件名**上，
 * 活日志里每一条的语义都一致，不需要读者记住一个日期。该归档名不匹配 `tidy()` 的归档正则，不会被自动清理。
 *
 * 那份归档是**混合 schema，不要对它套用上面的契约**（实测 521 行）：476 行两键皆无；45 行带一个过渡形态的
 * `backend`，其值是**具体模型 id**（实测全部为 `glm-4.6`）而非现在的路由枚举，且都没有 `model`。所以在
 * 归档里 `backend` 的值域与语义都与活日志不同——它当时的含义相当于现在的 `model`。
 *   session_id        取回原文用
 *   transcript_path   同上。值按 harness 给的原样记（转录会轮转 / 删除，写入期解析它不划算，见 schema §5）
 *   agent_id / agent_type / agent_transcript_path
 *                     仅 SubagentStop 带。**主 session 的 transcript_path 不含 subagent 说了什么**，
 *                     没有它们就无法把裁决归因到具体哪个 subagent、也取不回被判文本
 *
 * `CLAUDE_JUDGE_LOG_PATH` 覆盖落点。这不是可有可无的旋钮：eval 打的是真实 hook，不隔离就会把成百上千
 * 条合成裁决灌进生产日志（实测一轮下来 220 行里 164 行是 eval 的），审计用途当场作废。
 *
 * ## 同事件多闸的调度关系（**本仓关于这件事的唯一权威处**，各闸头注指到这里）
 *
 * 这条断言此前在 4 处 hook 头注里以既定事实出现、在第 5 处被标为"未取证的转述"，两边互相指认却没人
 * 去取证——而判定它的读数一直躺在本文件产出的日志里。2026-08-08 用它跑了一次：
 *
 * - **前一道闸 `exit 2` 不短路后面的闸：成立。** 两份日志（活的 + `legacy-20260808`）共 749 条记录、
 *   68 条 `flag`，其中 **41 次**在同一 `session_id` 下、该 flag 之后仍有**另一道**闸写出自己的裁决。
 * - **"并行启动"：仍未取证。** 本文件记的是**落盘时刻**，不是启动时刻；"串行但不短路"会产生同样的
 *   时序。上述 41 对里有 **5 对**落盘时刻精确到毫秒相同——是旁证，不是证明。要判它得另取启动时刻。
 *
 * 所以引用时**分开说**：可以依赖"不短路"，不要顺带把"并行"当已知前提用（`docs/issues/harness-issues.md`
 * 的 HARNESS-109 一族缺陷正建在后者上）。
 *
 * 落盘绝不改变 gate 行为：任何失败都吞掉。日志是诊断设施，不该因自身故障拦住会话或翻转裁决。
 * 单行 < 4KB 且用 O_APPEND，POSIX 下多个 hook 并发追加不会互相撕裂。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
// 单向依赖（llm-judge 不引本模块），且各 hook 本就同时 require 两者，故不新增加载成本。
const { lastJudgeRoute } = require("./llm-judge");

const LOG_PATH =
  process.env.CLAUDE_JUDGE_LOG_PATH ||
  path.join(os.homedir(), ".claude", "logs", "judge-gate.jsonl");
/** 超过它就轮转一代。单行 ~200B，8MB 约合几十万次裁决——够回溯，又不会无上限长。 */
const MAX_BYTES = 8 * 1024 * 1024;
/** reason 上限。见文件头：它是判官对被判文本的提炼，可能复述片段。 */
const REASON_MAX = 300;
const MODE = 0o600;

/** 保留几代归档。不设上限会让"轮转"只是把无上限增长换个文件名承载。 */
const KEEP_ARCHIVES = 3;

/**
 * 一次 stat 同时办两件事：权限过宽则收紧、超限则轮转。
 *
 * **收紧必须在轮转之前**：一份既超限、又是历史上建成 0644 的日志，若先归档，敏感内容就带着 0644 永久
 * 留在归档里，而新主日志以 0600 建出来、看上去一切正常——问题被藏进了一个不再被检查的文件。
 *
 * 轮转目标名带时间戳**与 pid**，不复用固定的 `.1`。同事件的多个 hook 由 harness 并行启动，两个 logger
 * 在阈值附近会各自 stat 到大文件：先动手的把旧日志改名并建了新的，后动手的会把那个刚建的新文件再改名成
 * 同一个目标，把前者刚归档的一整代覆盖掉。只靠毫秒时间戳挡不住——两个进程完全可能落在同一毫秒；pid 在
 * 活进程间唯一，才真正把这条竞态钉死。最坏情况只是多出一个几乎空的归档。
 */
function tidy() {
  let st;
  try {
    st = fs.statSync(LOG_PATH);
  } catch {
    return; // 还不存在——下面 append 会以 MODE 建它
  }
  if (st.mode & 0o077) {
    try {
      fs.chmodSync(LOG_PATH, MODE);
    } catch {
      /* 收紧失败不影响记录 */
    }
  }
  if (st.size <= MAX_BYTES) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  try {
    fs.renameSync(LOG_PATH, `${LOG_PATH}.${stamp}-${process.pid}`);
  } catch {
    return; // 轮转失败就继续往原文件追加，总好过丢记录
  }
  try {
    const dir = path.dirname(LOG_PATH);
    const base = path.basename(LOG_PATH);
    // 只认**本实现自己生成**的归档名（`<base>.<ISO无分隔>-<pid>`）。用 `startsWith(base + ".")` 会把
    // `judge-gate.jsonl.backup`、`…before-cleanup` 这类人手留下的同前缀文件一并纳入删除范围——那是真实
    // 数据丢失，而不是清理。名字里的时间戳在前，故字典序即时间序。
    const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d{4}-\\d{2}-\\d{2}T\\d{9}Z-\\d+$`);
    const archives = fs.readdirSync(dir).filter((f) => re.test(f)).sort();
    for (const f of archives.slice(0, Math.max(0, archives.length - KEEP_ARCHIVES))) {
      fs.unlinkSync(path.join(dir, f));
    }
  } catch {
    /* 清理失败不影响记录 */
  }
}

/**
 * 记一条裁决。`verdict` 的**基线取值**是 ok | flag | judge_unavailable | skipped，但取值域共享且可扩、
 * 本函数不校验——各闸按自己的出口自加值，新增前先看消费方归哪一档。权威说明在本文件顶部字段表的
 * `verdict` 条（勿只读本段：两处曾各说一套）。`reason` 只在 flag / skipped 及各闸自加的早退值上写进去
 * （其余情形它不适用，不是漏填）。`input` 传 hook 的原始 payload 对象即可，本函数自己挑指针字段。
 */
function logVerdict(gate, verdict, reason, input) {
  try {
    const i = input || {};
    const rec = {
      ts: new Date().toISOString(),
      gate,
      event: i.hook_event_name || null,
      verdict,
      ...(reason && (verdict === "flag" || verdict === "skipped")
        ? { reason: String(reason).slice(0, REASON_MAX) }
        : {}),
      // 没调过判官就两个键都不写；调过则必写 backend，而 model 仅在调用侧解析得到时才写——
      // 它的缺席是"具体模型不可考"这一状态本身，不是遗漏。见文件头字段表。
      ...(lastJudgeRoute() ? { backend: lastJudgeRoute().backend } : {}),
      ...(lastJudgeRoute() && lastJudgeRoute().model ? { model: lastJudgeRoute().model } : {}),
      session_id: i.session_id || null,
      transcript_path: i.transcript_path || null,
      // 仅 SubagentStop 带；缺席时不写键，读者据此就能分辨这不是 subagent 的裁决。
      ...(i.agent_id ? { agent_id: i.agent_id } : {}),
      ...(i.agent_type ? { agent_type: i.agent_type } : {}),
      ...(i.agent_transcript_path ? { agent_transcript_path: i.agent_transcript_path } : {}),
    };
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    tidy();
    fs.appendFileSync(LOG_PATH, JSON.stringify(rec) + "\n", { mode: MODE });
  } catch {
    /* 落盘失败绝不影响裁决 */
  }
}

/**
 * 本闸在这个 session 里最近一次的 verdict（无记录返回 null）。
 *
 * 唯一消费者是各闸的 `stop_hook_active` 守卫。那个标志是 Claude Code 给的**全局**状态——"本次继续是
 * 因为某个 Stop hook"——它不说是**哪一道**闸拦的。原先各闸读到它就一律跳过，于是任一闸开火后，其余闸
 * 对**改后的那条消息**全盲；而"改完重发"恰是最容易引入新违规的时刻。
 *
 * 实测（2026-08-09，单个 session 169 条判官记录）：18 条是这种跳过——prose-choice / reverse-assertion /
 * capability-claim 各 5 次、continuation-claim 3 次。其中漏掉的一条正是把并列备选写成正文的收尾；
 * 把同一段文本离线喂给该闸的判官 7/7 全 flag，所以那次漏报不在判据上，在这道守卫上。
 *
 * 用「本闸上一条记录是不是 flag」代替全局标志，两种情形因此分开：
 *   - 本闸自己拦的 → 上一条是 flag → 继续跳过。**逃生口语义不变**：原样再停一次即放行。
 *   - 别的闸拦的 → 本闸上一条是 ok / skipped → 它从未判过这段新文本，照常判。
 * 未改内容的重发不会因此多挨打断：其余闸在上一停（那时标志为假）已判过同一段文本且判了 ok。
 *
 * 取不到 session_id、或日志读不了时返回 null，调用方回落到旧行为（跳过）——宁可漏判一次，
 * 不可因为读不到历史就把 agent 关在循环里。
 */
function lastVerdictOfGate(gate, sessionId) {
  if (!gate || !sessionId) return null;
  let raw;
  try {
    raw = fs.readFileSync(LOG_PATH, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  // 从后往前找第一条命中的：只需要最近那一条。体积由本文件的 tidy() 控制。
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // 半行 / 损坏行跳过，不让它冒充"没有记录"
    }
    if (rec && rec.gate === gate && rec.session_id === sessionId) {
      return typeof rec.verdict === "string" ? rec.verdict : null;
    }
  }
  return null;
}

module.exports = { logVerdict, LOG_PATH, lastVerdictOfGate };
