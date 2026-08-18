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
 *   gate              哪一道闸。多道共写一个文件（权威名单同上，见 `claude/bin/gate-stats`；此处不写死
 *                     条数——原先写的"三道"在闸增到六道后一直没跟上），故同一次 stop 上各 gate 的裁决可按 ts 对齐
 *   event             hook_event_name（Stop / SubagentStop / PreToolUse）。不可省：stop-gate 同时注册在
 *                     Stop 与 SubagentStop，缺它则两类裁决在读者眼里长得一模一样
 *   verdict           ok | flag | judge_unavailable | skipped —— 见上，这套区分是本模块存在的理由。
 *                     **取值域是共享且可扩的**：各闸按自己的出口自加值（现役另有 continuation-claim
 *                     的 `ok_live_task` / `detect_unavailable` / `ok_override`）。本模块不校验取值，
 *                     所以新增前须先看消费方会把它归哪一档——`gate-stats` 把 flag 后紧跟的非
 *                     `ok`/`flag` 一律算 ambiguous。判据见 references/judge-gate-authoring.md §6
 *   reason            flag 的判官理由，或 skipped 的早退原因码。存在性由 verdict 唯一决定、同一处写入
 *   backend           本进程**选中**的判官路由：`glm` | `anthropic` | `claude-cli` | `none` | `ark`。是"选中"不是"成功
 *                     作答"——判官超时 / 报错时它仍指向那次尝试的对象（此时 `verdict` 为
 *                     `judge_unavailable`）。按它统计作答量须先按 `verdict` 过滤，否则失败尝试会被算进去。
 *                     **写入规则：调用方随本次 `logVerdict` 显式携带 route 才写（ADR-019）。** 所以
 *                     `skipped` **可能带** backend——capability-claim-gate 是两段式，判官抽取成功后第二段
 *                     取证不足仍会 skip（该文件判官调用之后的两处 `skip()`，它们确实经过了判官）。
 *                     缺席即**这条裁决**未经判官——判官前的各条早退，以及 stop-gate 的三条确定性兜底 flag。
 *                     **注意这个口径 2026-08-17 收窄过**：此前是"本进程调用过判官就写"，于是 stop-gate
 *                     里 policy 判官跑过之后的确定性 flag 会继承一个它自己没用过的 backend（HARNESS-314）。
 *                     旧口径的记录都在 `judge-gate.jsonl.legacy-20260817` 里，活日志内口径一致。
 *                     不可省的理由是路由由 key 的存在性决定，而非交互 shell 拿不到 rc 里导出的
 *                     `ZHIPU_API_KEY`——cron / ssh / git hook 触发的同一道闸会静默换成另一层、另一套校准。
 *   model             该路由此次使用的**具体模型 id**。**缺席 = 调用侧解析不到**，当前仅 `claude-cli`
 *                     一层如此（`claude -p --model haiku` 传的是别名，调用侧无从知道它此刻指向哪个版本）。
 *                     刻意留空而不是写死 `haiku`：别名指向换代时任何固定字符串都会保持不变，把"判官换了"
 *                     伪装成"判据变了"，而那正是本组字段要分开的两件事。**`backend` 在而 `model` 缺席
 *                     是一个有意义的状态**（具体模型不可考），不是漏填；两键同时缺席才是"未经判官"
 *   fallback_from     **只在兜底接手时出现**：被它接替的那个主判官（`glm` | `anthropic`）。
 *                     兜底层是火山 Ark，见 `lib/llm-judge.js` 的 judgeWithRoute（含启用集合与排除项）。
 *                     **它不回答"Ark 试过没有"**——那要看 `backend` 与 `judge_failure`，见下。
 *   judge_failure     **只在兜底自己失败时出现**：`no_key` | `timeout` | `spawn_error` |
 *                     `transport_<curl 退出码>` | `empty_response` | `parse_error` | `api_error` |
 *                     `empty_completion` | `empty_content`。单列 `empty_completion` 是因为推理吃满
 *                     max_tokens 时端点回 200 + 空 content，那既不是超时也不是报错，不区分就伪装成后端不可用。
 *
 *   **"Ark 到底有没有真的发出过请求"怎么读**（三键合看，别只看一键）：
 *     `backend:"ark"` + 无 `judge_failure`            → 发出了，且作答成功
 *     `backend:"ark"` + `judge_failure:"no_key"`      → **没发出**：没配 key，那一层直接早退
 *     `backend:"ark"` + 其余 judge_failure            → 发出了（或试图发出），失败在传输 / 解析 / 端点
 *   `backend` 记的是**选中的路由**而非"请求已送达"，所以单看它会把 no_key 那种读成"试过了"。
 *   judge_attribution_missing
 *                     **只在异常时出现**：本进程调用过判官（`judgeCallsMade() > 0`），但这条记录的调用方
 *                     既没携带 route、也没声明 `judged:false`。它是**代码缺陷的信号**，不是一种正常状态——
 *                     正确实现下它恒不出现。存在的理由：没有它，"漏传归属声明"与"这条裁决本就未经判官"
 *                     在日志里是同一个形状（两键缺席），于是漏传会静默伪装成正常记录。
 *                     **已知局限**（ADR-019 里由用户显式 waive）：本仓没有 CI、且工作树存盘即生效，
 *                     所以它只有在某个测试恰好跑到那条出口时才会被看见；消费面只做纯计数展示，无告警
 *
 * **历史分界（2026-08-17，第二次）**：`backend` 的**存在性语义**由"本进程调用过判官"收窄为"这条裁决
 * 经过判官"（ADR-019 / HARNESS-314）。同一步把当时的日志改名为 `judge-gate.jsonl.legacy-20260817`、
 * 主日志从空开始，理由与下面 08-08 那次同构：分界落在**文件名**上，活日志内每条记录语义一致。
 * 该归档里 `backend` 的值域与现在**相同**（都是路由枚举），差别只在存在性口径——所以它与 08-08
 * 那份归档不是一回事，别套用下面那段对 legacy-20260808 的描述。实测影响面很小（改动前近 7 天
 * 1506 条确定性出口里 3 条带着继承来的 backend），但它是**语义**分界，不是数量问题。
 *
 * **历史分界（2026-08-08，第一次）**：这两个键定型于 2026-08-08。此前的记录单看一条无从与"未经判官"区分，故同一步把当时的
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
 * - **"并行启动"：2026-08-10 取证成立，但作用域仅限【同一 matcher 组内】。** 此前一直悬着，因为
 *   本文件记的是**落盘时刻**而非启动时刻，"串行但不短路"会产生同样的时序——当时找到的最强读数
 *   （41 对里 5 对落盘毫秒相同）在两种世界下都可能出现，所以拒绝据它结案是对的。撑开两种世界的量是
 *   **超时上限**：`llm-judge` 的 `HTTP_TIMEOUT_MS = 12000` 且**选定后端后不回落**，故判官后端不可达时
 *   每道闸各自把 12 秒打满。实测多个停止簇里四道判官闸全部落在 `+12.01~12.02s`；**串行下第二道闸要等
 *   第一道 exit 才启动，落盘必然是 12/24/36/48**。（`Stop` 上调判官的其实有五道，第五道
 *   `continuation-claim-gate` 先探运行态、多数停止在 `ok_live_task` / `detect_unavailable` 上早退，
 *   没走到判官，故不出现在这组读数里——不是读数不全。）正常路径同向印证：判官往返 ~1.4s，四条却只散开 0.5s
 *   （`+1.35 / +1.36 / +1.44 / +1.87`）。（该 12s 只在有 HTTP key 时成立；两个 key 都没有时走
 *   tier-3 `claude -p`，上限是 `CLI_TIMEOUT_MS = 25000`，判据形状不变、数值不同。）
 *
 * **别把它外推成"同事件多闸并行"。** 被测的四道闸同属 `settings.json` 里 `Stop` 的**第一个** matcher 组；
 * 跨 matcher 组（如第二组的 `ghostty-tab-title.sh`）与跨事件（PreToolUse 上的插件 hook）**都不在这次
 * 读数的作用域内，仍未取证**。`docs/issues/harness-issues.md` 的 HARNESS-109 / -111 讲的正是跨组与跨事件
 * 那一族，**本条不为它们的并行前提背书**——那两条要的证据得另取（组间需要一个能把两组撑开的量，本文件
 * 记不到 tab-title 的动作，故不可能只靠这份日志判定）。
 *
 * 组内并行的推论：**同组里没有任何一个 hook 知道这次停止的最终裁决**——某道闸正在 exit 2 时，同组的
 * 其余闸已各自按自己的判据放行了。跨组的同名现象（tab 已写 idle 而回合仍在继续）机制上很可能同源，
 * 但那是猜想，不是这次测到的东西。
 *
 * 落盘绝不改变 gate 行为：任何失败都吞掉。日志是诊断设施，不该因自身故障拦住会话或翻转裁决。
 * 单行 < 4KB 且用 O_APPEND，POSIX 下多个 hook 并发追加不会互相撕裂。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
// 单向依赖（llm-judge 不引本模块），且各 hook 本就同时 require 两者，故不新增加载成本。
// **只取调用计数，不取路由**：路由由调用方逐调用携带（ADR-019）。计数只用于把"未经判官"
// 与"漏了归属声明"分开，见 logVerdict。
const { judgeCallsMade } = require("./llm-judge");

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
 * 轮转目标名带时间戳**与 pid**，不复用固定的 `.1`。同一 matcher 组内的多个 hook 由 harness 并行启动
 * （见上「同事件多闸的调度关系」，含其作用域），两个 logger
 * 在阈值附近会各自 stat 到大文件：先动手的把旧日志改名并建了新的，后动手的会把那个刚建的新文件再改名成
 * 同一个目标，把前者刚归档的一整代覆盖掉。只靠毫秒时间戳挡不住——两个进程完全可能落在同一毫秒；pid 在
 * 活进程间唯一，才真正把这条竞态钉死。最坏情况只是多出一个几乎空的归档。
 */
/**
 * 本实现自己生成的归档分片（`<base>.<ISO无分隔>-<pid>`），按时间序（名字里时间戳在前，字典序即时间序）。
 *
 * **一份定义、两个消费者**：`tidy()` 用它决定删哪些，计数用它决定读哪些。曾经各写一遍，于是计数那侧
 * 用了 `startsWith(base + ".")`——而 tidy 上方的注释正警告过这么做会吞掉 `judge-gate.jsonl.backup`、
 * `…legacy-20260808` 这类人手留下的同前缀文件。在 tidy 那侧是误删，在计数那侧是把旧世代的记录算进
 * 当前 session，两边都错，且错得不一样。
 */
function listArchives() {
  const dir = path.dirname(LOG_PATH);
  const base = path.basename(LOG_PATH);
  const re = new RegExp(
    `^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d{4}-\\d{2}-\\d{2}T\\d{9}Z-\\d+$`
  );
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((f) => re.test(f)).sort().map((f) => path.join(dir, f));
}

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
    const archives = listArchives().map((f) => path.basename(f)).sort();
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
 *
 * `meta`（可选，第 5 参）是**逐调用事实的元数据袋**，当前认两个键：
 *   - `route`：`judgeWithRoute()` 返回的 `{backend, model}`，**这条裁决**由判官作出时必传。
 *   - `judged: false`：显式声明"本进程判过判官，但这条裁决不是判官出的"。只有 `stop-gate` 那条
 *     「把要不要提交交回用户」的确定性 flag 需要它（policy 判官在它上游跑过）。
 * 判官前的早退两者都不传即可——本进程没调过判官，不会被判成漏传。
 *
 * **为什么是一个袋子而不是裸 route**：ADR-005（已采纳、尚未实施）已把"可选第 5 参"分配给
 * `judged_text_sha256`，其存在性语义（不传即不写）与 route 完全同构。两个逐调用事实共用一个参数位，
 * 比并列两个可选位置参好——后者漏传了哪一个在调用点上看不出来。ADR-019 refines ADR-005 的这一点。
 */
function logVerdict(gate, verdict, reason, input, meta) {
  try {
    const i = input || {};
    const m = meta || {};
    // 归属四态（ADR-019）。`route` 由调用方从 `judgeWithRoute` 的返回值一路传下来；`judged:false`
    // 是"本进程判过判官，但**这条**裁决不是判官出的"的显式声明（全仓只有 stop-gate 那条
    // 「把要不要提交交回用户」的确定性 flag 需要它——policy 判官在它上游跑过）。
    // 两者都没传、而本进程确实调过判官 → 调用方漏了声明，落一个刺眼的键；否则这次漏传会
    // 伪装成"未经判官"，与真·未经判官逐字同形。
    // 四态**互斥**：同时给 route 与 `judged:false` 是自相矛盾（既称由判官作出、又称非判官所出），
    // 判官前就声明 `judged:false` 同样是错的（本进程根本没判过，该状态无对象）。两者都当作
    // 归属声明缺陷落痕，而不是静默择一——静默择一会让一个矛盾的调用点看起来完全正常。
    const contradictory = !!m.route && m.judged === false;
    const uncalledDeclaration = m.judged === false && judgeCallsMade() === 0;
    const attributionMissing =
      contradictory || uncalledDeclaration || (!m.route && m.judged !== false && judgeCallsMade() > 0);
    const rec = {
      ts: new Date().toISOString(),
      gate,
      event: i.hook_event_name || null,
      verdict,
      ...(reason && (verdict === "flag" || verdict === "skipped")
        ? { reason: String(reason).slice(0, REASON_MAX) }
        : {}),
      // 本次裁决经过判官才写 backend，而 model 仅在调用侧解析得到时才写——它的缺席是
      // "具体模型不可考"这一状态本身，不是遗漏。见文件头字段表。
      ...(m.route && !contradictory ? { backend: m.route.backend } : {}),
      ...(m.route && !contradictory && m.route.model ? { model: m.route.model } : {}),
      // 兜底两键。缺席是常态（主判官作答时不写），在场才有信息：
      //   fallback_from —— 被兜底接替的**那个主判官**，仅此而已。**别拿它答"Ark 试过没有"**：
      //     那由 `backend === "ark"` 答。校准旁路不接替任何人，此时它缺席而 Ark 确实跑了。
      //     要区分的那两件事——"主判官挂了却没试兜底"（接线漏了）与"两个都试了都挂"——判据同样是
      //     `backend`（前者 `glm`、后者 `ark`，两者的 verdict 都是 judge_unavailable）。
      //   failure       —— 兜底自己怎么失败的（timeout / empty_completion / api_error …）。
      //     单列 `empty_completion` 是因为推理吃满 max_tokens 时端点回 200 + 空 content，
      //     那既不是超时也不是报错，不区分就会伪装成"后端不可用"。
      ...(m.route && !contradictory && m.route.fallback_from
        ? { fallback_from: m.route.fallback_from }
        : {}),
      ...(m.route && !contradictory && m.route.failure ? { judge_failure: m.route.failure } : {}),
      ...(attributionMissing ? { judge_attribution_missing: true } : {}),
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
/*
 * `agentId` 是**身份的一部分**，不是可选的筛选条件：并发 subagent 共用同一个 `session_id`，
 * 只按 (gate, session_id) 查会让 sibling 的裁决冒充自己的上一条。实测（2026-08-17 生产日志）：
 * subagent A 被本闸 flag（11:14:21）→ sibling B 在同一 session 写下 ok（11:14:41）→ A 重停时
 * 读到的是 B 的 ok，`prev === "flag"` 不成立，逃生口失效。那次 A 是靠 `STOP-GATE-OK` 自签口令
 * 出来的；口令删除后（见 stop-gate.js），这条路径就是实打实的重复阻断。
 *
 * 主 agent 的裁决不带 `agent_id`，所以 `undefined` 与"某个 subagent"必须是不同的键，不能用
 * "调用方没传就不筛"来实现——那正是本 bug 的形状。
 */
function lastVerdictOfGate(gate, sessionId, agentId) {
  if (!gate || !sessionId) return null;
  const wantAgent = agentId || null;
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
    if (
      rec &&
      rec.gate === gate &&
      rec.session_id === sessionId &&
      (rec.agent_id || null) === wantAgent
    ) {
      return typeof rec.verdict === "string" ? rec.verdict : null;
    }
  }
  return null;
}

/**
 * 本 session 内某道闸给出过多少次某个 verdict。
 *
 * 存在的理由是一次实测：某 session 的主线程 stop-gate 开火 **8 次**（11:50→23:02 贯穿全程），
 * 措辞高度重复——4 次"把定序权甩给用户"、4 次"承认未完成但无正当理由"——且**每一次 flag 之后
 * 都紧跟一次** `stop_hook_active` 放行（8/8）。这些只落在日志里。**对 agent 与用户都不可见的
 * 累计量，等于没有发生过**：每一次单看都像"被拦一下、改一改、过了"，只有把它们数起来才看得出
 * 是同一件事在重复第八次。
 *
 * 计数按 `agent_id` 分开（与 lastVerdictOfGate 同一条件）：同一 session 里子代理另有 3 次 flag，
 * 混进来会把主线程的行为读数抬高 37%，而它们是不同执行体的事。
 *
 * 只读日志、不写：它是给放行路径加一句可见的读数用的，不改变任何放行/阻断判定。
 */
function countVerdictsOfGate(gate, sessionId, agentId, verdict) {
  if (!gate || !sessionId || !verdict) return 0;
  const wantAgent = agentId || null;
  // **必须连归档一起读**：tidy() 超过 MAX_BYTES 就把活日志改名成 `${LOG_PATH}.<stamp>-<pid>`。
  // 只读活分片时，一个跨越轮转的 session 会看到 N 骤降（真实 8、分片内 1），甚至因 n<2 而完全
  // 静默——那正是本读数要报的情形。它测的必须是"本 session 已 flag N 次"，不是"当前分片内 N 次"。
  const parts = [LOG_PATH, ...listArchives()];
  let raw = "";
  let readAny = false;
  for (const part of parts) {
    try {
      raw += fs.readFileSync(part, "utf8");
      readAny = true;
    } catch {
      /* 单个分片读不到就跳过：缺一片让 N 偏小，好过整体返回 0 */
    }
  }
  if (!readAny) return 0;
  let n = 0;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let rec;
    try {
      rec = JSON.parse(t);
    } catch {
      continue; // 半行 / 损坏行跳过，与 lastVerdictOfGate 同一处置
    }
    if (
      rec &&
      rec.gate === gate &&
      rec.session_id === sessionId &&
      (rec.agent_id || null) === wantAgent &&
      rec.verdict === verdict
    ) {
      n++;
    }
  }
  return n;
}

module.exports = { logVerdict, LOG_PATH, lastVerdictOfGate, countVerdictsOfGate };
