#!/usr/bin/env node
/**
 * bg-shell-reclaim-check — 停止前把「长时间没交代过的后台 shell」摆到 agent 面前。
 *
 * 为什么存在：一次实测事故。三个 `until ! pgrep -f "pytest"; do sleep N; done`
 * 的等待循环空转了 15 小时（`pgrep -f` 匹配完整命令行，而循环自己的命令行里就含
 * "pytest"，于是它永远匹配到自身、条件永不满足），期间 agent 反复宣告「清理完成、
 * 无待办」。用户看到的是矛盾状态：要么该等这些 shell（那就不该说停），要么该回收
 * 它们。两个既有 hook 各覆盖了一半却都够不着这里——
 *
 *   - stop-gate.js 时机对（Stop）但只读 lastAssistantMessage，进程事实为零；
 *     且其 eval 标定明写 `waiting-bg-task → ok`，对"带着活任务宣告结束"无意见。
 *   - teammate-reclaim-check.js 判据对（真去清点）但只管 in-process teammate，
 *     且注册在 UserPromptSubmit / SessionStart——都在矛盾已经展示给用户之后。
 *
 * 本 hook **不判断任务是否卡死**，这是刻意的。初版试过"存活 + 输出零增长 = 卡死"，
 * 被独立审查按本仓自己的 background-agent-monitoring.md 判为不成立：进程存活 +
 * 输出停滞不足以判挂起（压缩、编译、快照、迁移、缓冲输出都能合法静默十几分钟，
 * 该文件还记录过一次约 20 分钟静默任务被误杀）；反向也漏——打 heartbeat 的死循环
 * 永远"在增长"。判据两个方向都失效，说明"从外部分类卡死"这条路本身不成立。
 *
 * 现在报告的是一个**能自证的事实**：这个后台任务已存活超过阈值，且本 hook 尚未
 * 收到过针对它的处置说明（注意这不等于"agent 从未交代过"——hook 看不到会话里
 * 说过什么，只看得到自己收没收到过 scoped ack）。分类交给 agent——它知道自己起了什么、在等什么、值不值得等；
 * hook 只负责让这件事无法被静默略过。同理不叫 agent 直接 kill：
 * teammate-reclaim-check 的注释记录过那条风险链——提醒 → agent 相信它 →
 * 停掉一个产出尚未到手的任务 → 工作永久丢失。
 *
 * 不读、不记、不显示被委派命令的原文：命令行可能含 API key、签名 URL、私有 prompt。
 * 只出 task id 与持有进程数，agent 自己能从转录里查出那是什么任务。
 *
 * 交代闭环（pendingAck）：初版只"提醒一次"，被审查指出那一次可能花在中途的普通
 * Stop 上——等 agent 真正带着该任务宣告完成时，它已经用掉了唯一的机会、反而沉默。
 * 现在首次阻断只把 task 记为 pending；随后的 stop_hook_active=true 那次不阻断，
 * 而是从最后一条消息里解析**按 task id 具名**的 ack，覆盖到的才转 acked。没覆盖到
 * 的保持 pending，在下一次普通 Stop 再次提醒。这不制造死循环（active=true 从不阻断），
 * 也不重新分类卡死，只保证"最终必须明确交代"——但强制不了交代内容为真。
 *
 * 逃生口：`BG-SHELL-OK: <task id ...>`，须点名 task id 才对该任务生效。
 * 任何异常一律 fail-open：这道 gate 的作用是提醒，不该因自身故障卡住会话。
 *
 * stop-gate.js 先 `exit 2` **不会短路**本 hook——实测与唯一权威处见 `lib/judge-log.js` 头部
 * 「同事件多闸的调度关系」。注意那里把"并行启动"单独标为**未取证**：本文件原有的旁证
 * （ghostty-tab-title.sh 的铃声先于 stop-gate 裁决响起）与"串行但不短路"同样相容，不构成证明。
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

let lastAssistantMessage;
try {
  ({ lastAssistantMessage } = require("./lib/transcript"));
} catch {
  lastAssistantMessage = () => "";
}

/** 超过这个存活时长仍未被交代过的后台任务，提醒一次。默认 30 分钟。 */
const AGE_MS = Number(process.env.BG_SHELL_AGE_MS || 30 * 60 * 1000);
const STATE_DIR = path.join(os.homedir(), ".claude", "state", "bg-shell-reclaim");
const LOG_PATH = path.join(os.homedir(), ".claude", "logs", "bg-shell-reclaim.jsonl");

const allow = () => process.exit(0);

/** BG_SHELL_DEBUG=1 时把判定链打到 stderr。Stop hook 的失败是静默的，没有它只能靠猜。 */
const dbg = process.env.BG_SHELL_DEBUG
  ? (...a) => process.stderr.write("[bg-shell dbg] " + a.join(" ") + "\n")
  : () => {};

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * 找出**属于本会话、仍在运行**的后台任务。
 *
 * 前两版都栽在同一个形态上：用名字或文本推断归属。
 *   v1 拿 `session_id` 拼路径——但 hook 收到的是转录 UUID，任务目录用的是另一个 id，
 *      于是真实环境下每次静默放行（合成测试直接喂对目录名，把这个假设绕过去了）。
 *   v2 从转录正则扫 `.../tasks/<id>.output`——但审查者抽样证明这些串也出现在普通
 *      user / attachment / queue-operation 记录里，锚点不是来源证明；而且一个转录
 *      可以对应多个 tasks 目录（resume 会新建），缓存单个目录会永久漏掉新的。
 *
 * 归属其实有一个不可伪造的载体：**进程血缘**。后台任务与本 hook 都是同一个 claude
 * 进程的后代。所以走祖先链找到 claude、枚举其全部后代、看谁以写模式持有
 * `.../tasks/<id>.output`——目录是结果而不是输入。转录里提到什么都进不来，
 * resume 新建的目录自动覆盖，也完全不必读那份 21MB 的转录。
 */
function psTable() {
  const out = execFileSync("ps", ["-eo", "pid=,ppid=,comm="], {
    encoding: "utf8",
    timeout: 3000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parent = new Map();
  const comm = new Map();
  const children = new Map();
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = +m[1];
    const ppid = +m[2];
    parent.set(pid, ppid);
    comm.set(pid, m[3]);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  return { parent, comm, children };
}

/** 一次性记录能力不可用——静默失效的 gate 与不存在的 gate 无法区分。 */
function noteUnusable(stateFile, session, reason) {
  dbg("unusable:", reason);
  updateState(stateFile, (state) => {
    if (!state.unusableLogged) {
      state.unusableLogged = true;
      logFire({ at: new Date().toISOString(), session, unusable: reason });
    }
    return state;
  });
}

function sessionDescendants() {
  let t;
  try {
    t = psTable();
  } catch (e) {
    return { ok: false, reason: (e && e.code) || "ps-failed" };
  }
  const { parent, comm, children } = t;
  let p = process.pid;
  let claude = null;
  for (let i = 0; i < 16 && p > 1; i++) {
    if ((comm.get(p) || "").split("/").pop().includes("claude")) {
      claude = p;
      break;
    }
    p = parent.get(p) || 1;
  }
  if (!claude) return { ok: false, reason: "no-claude-ancestor" };
  const seen = new Set();
  const stack = [claude];
  while (stack.length) {
    for (const k of children.get(stack.pop()) || []) {
      if (!seen.has(k)) {
        seen.add(k);
        stack.push(k);
      }
    }
  }
  seen.delete(process.pid);
  return { ok: true, pids: seen };
}

/**
 * 在给定进程集合里找出以**写**模式持有 `.../tasks/<id>.output` 的那些。
 *
 * 只认写持有者：`tail -f`、编辑器、索引器会让已结束的任务看起来还在跑，报出的
 * PID 属于无关进程——agent 若据此动手就杀错对象。lsof 的 `a` 字段给访问模式。
 * 一个 output 可能有多个写进程（管道链），全给，只报首个会让回收做不干净。
 */
// 必须符合 harness 的实际形态 `<tmp>/claude-<uid>/<project-slug>/<runtime-id>/tasks/<id>.output`。
// 只要求以 `/tasks/<id>.output` 结尾太松：本会话起的普通程序写出同形路径也会被当成任务。
const OUTPUT_RE = /\/claude-\d+\/[^/]+\/[^/]+\/tasks\/([A-Za-z0-9_-]+)\.output$/;

function liveTasks(pids) {
  return pids && pids.size ? runLsof(["-F", "pan", "-p", [...pids].join(",")]) : { byId: new Map(), usable: true };
}

function runLsof(args) {
  const byId = new Map(); // id -> {pids:[], file}
  let out = "";
  let usable = true;
  let reason = null;
  try {
    out = execFileSync("lsof", args, {
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (e) {
    // 先按异常类型判，不看有没有 stdout：超时 / 被信号杀 / maxBuffer 都可能带**部分**
    // 输出，把截断的结果当完整的用，会漏掉排在后面的任务并据此错误裁剪台账。
    const clean = e && e.status === 1 && !e.signal && !e.killed;
    usable = !!clean;
    reason = clean ? null : (e && (e.code || (e.killed ? "timeout" : `status${e.status}`))) || "lsof-failed";
    out = clean ? (e && e.stdout) || "" : "";
  }
  let pid = null;
  let mode = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) {
      pid = line.slice(1).trim();
      mode = "";
    } else if (line.startsWith("a")) {
      mode = line.slice(1).trim();
    } else if (line.startsWith("n") && pid) {
      const f = line.slice(1).trim();
      const m = OUTPUT_RE.exec(f);
      if (m && (mode.includes("w") || mode.includes("u"))) {
        const rec = byId.get(m[1]) || { pids: [], file: f };
        if (!rec.pids.includes(pid)) rec.pids.push(pid);
        byId.set(m[1], rec);
      }
      mode = "";
    }
  }
  return { byId, usable, reason };
}

function readState(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    return d && typeof d === "object" && d.tasks ? d : { tasks: {} };
  } catch {
    return { tasks: {} };
  }
}

/**
 * 读-改-写全程持锁。只用临时文件 + rename 挡得住半份 JSON，挡不住丢更新：
 * 两个 Stop 同时读到旧状态、各自修改、后写者覆盖前者，pending/acked 会凭空消失。
 * 锁拿不到就放弃本次写（fail-open）——迟一轮提醒好过污染台账。
 */
/** session_id 会拼进文件路径，必须先验形：`../../settings` 会解析到 ~/.claude/settings.json。 */
const VALID_SESSION = /^[\w.-]+$/;
function validSession(id) {
  return typeof id === "string" && VALID_SESSION.test(id) && id !== "." && id !== "..";
}

/**
 * 读-改-写，**不加跨进程锁**，这是权衡后的选择。
 *
 * 锁要防的是同 session 两个 Stop 并发时的丢更新。但本 state 的每一项都是自愈的：
 * 存活性每轮从 lsof 重新推导，`pending` 丢了下轮重新标记，`acked` 丢了至多多提醒
 * 一次，年龄取自 output 文件的 birthtime 而非 state。**丢一次更新的代价上限是一次
 * 多余提醒。** 而正确的跨进程锁在这里要处理初始化竞态、持有者暂停/机器睡眠下的
 * 陈旧回收、以及回收-重建之间的 TOCTOU——三轮审查证明这套协议的复杂度远超它保护
 * 的东西。真正必须防的只有"半份 JSON"（那会让整份台账重置），tmp + rename 已足够。
 *
 * 返回是否成功提交：调用方据此决定能不能阻断（state 没落盘就阻断会造成永远 ack
 * 不掉的死拦）。
 */
function updateState(file, fn) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const next = fn(readState(file));
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

function logFire(entry) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    // mode 只在创建时生效；早期版本留下的 0644 日志不会自动收紧，显式 chmod。
    try {
      if (fs.statSync(LOG_PATH).mode & 0o077) fs.chmodSync(LOG_PATH, 0o600);
    } catch {
      /* 不存在则由下面的 mode 创建 */
    }
    // 0600：本文件记录任务 id 与时间，虽已不含命令原文，仍无必要对同机其他用户可读。
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch {
    /* 日志失败不影响裁决 */
  }
}

function humanAge(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分钟`;
}

/** 任务起始时刻取 .output 的创建时间；birthtime 不可用的文件系统退回 ctime。 */
function startedAt(file) {
  try {
    const st = fs.statSync(file);
    const b = st.birthtimeMs;
    return b && b > 0 ? b : st.ctimeMs;
  } catch {
    return null;
  }
}

/**
 * ack 只认约定形态：`BG-SHELL-OK: <id> [<id> ...] — <说明>`，且只取冒号到破折号之间。
 * 用 `slice(marker).includes(id)` 是错的——"BG-SHELL-OK: taskA — taskA 已回收；
 * taskB 尚未处置"会把 taskB 一并永久赦免，方向恰好与它的用途相反。说明文字里提到
 * 某个 id 是常态，那不是处置声明。
 */
function ackedIdsIn(msg, pendingIds) {
  const out = new Set();
  if (!msg) return out;
  // 必须是**最后一个非空行**：只找"最后一条匹配行"的话，marker 之后再写一句
  // "更正：该任务尚未处理" 也照样生效——那与 agent 的实际意思相反。
  const lines = msg.split("\n").filter((l) => l.trim());
  const line = lines[lines.length - 1] || "";
  if (!/^\s*BG-SHELL-OK\s*:/.test(line)) return out;
  // 分隔符按"空白包围的破折号"识别，不能禁止 body 里出现 `-`——task id 允许含连字符，
  // 禁止它会让那类任务永远 ack 不掉、永久 pending。
  const m = line.match(/^\s*BG-SHELL-OK\s*:(.*?)\s[—–-]{1,2}\s+(\S.*)$/);
  // 必须有分隔符且后面有非空说明：裸的 `BG-SHELL-OK: taskA` 不算处置，
  // 那只是复述 id，本 gate 要的是"去向"。
  if (!m) return out;
  const body = m[1];
  const tokens = new Set(body.split(/[\s,，、]+/).filter(Boolean));
  for (const id of pendingIds) if (tokens.has(id)) out.add(id); // 精确相等，不是子串
  return out;
}

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return allow();
  }
  if (!input) return allow();

  // 验形必须先于构造任何路径：`../../settings` 会让 stateFile 落到 ~/.claude/settings.json，
  // 而下面确实会写它——一次畸形输入就能覆盖用户配置。
  if (!validSession(input.session_id)) return allow();
  const stateFile = path.join(STATE_DIR, `${input.session_id}.json`);

  let lastMsg = "";
  if (input.transcript_path) {
    try {
      lastMsg = lastAssistantMessage(input.transcript_path) || "";
    } catch {
      lastMsg = "";
    }
  }

  // 阻断后的那一次 Stop：绝不再阻断（否则死循环），改为收 ack。
  if (input.stop_hook_active === true) {
    updateState(stateFile, (state) => {
      const pend = Object.keys(state.tasks).filter((id) => state.tasks[id].pending);
      for (const id of ackedIdsIn(lastMsg, pend)) {
        state.tasks[id].pending = false;
        state.tasks[id].acked = true;
      }
      return state;
    });
    return allow();
  }

  const disc = sessionDescendants();
  if (!disc.ok) {
    noteUnusable(stateFile, input.session_id, `ps:${disc.reason}`);
    return allow(); // 连宿主都定位不到就别猜
  }

  // **只认后代**，不再枚举目录里的其它写者。第二步曾试过"由后代反推目录、再扫目录下
  // 全部写者"以覆盖自我 daemonize 的任务，但那一步无法证明目录独占（并发 session /
  // resume 是否共用未经实证）、无法排除本会话普通程序写出的同形路径，还会在目录读
  // 失败时把台账清空。对一个**提醒型** hook，可靠但不完备是正确取舍：漏报退回现状，
  // 误报却会拿别人的进程卡住用户的会话。
  // 已知不完备：任务若自我 daemonize（中间 shell 退出、子进程重挂到 init）就检测不到。
  const { byId, usable, reason } = liveTasks(disc.pids);
  dbg("liveTasks=", JSON.stringify([...byId.keys()]), "usable=", String(usable));
  if (!usable) {
    noteUnusable(stateFile, input.session_id, `lsof:${reason}`);
    return allow();
  }

  const now = Date.now();
  let candidates = [];
  const committed = updateState(stateFile, (state) => {
    // 裁剪依据是"当前有写持有者"。任务结束而 .output 保留是常态，只按文件存在裁剪会
    // 让条目永久残留，task id 复用时还会继承旧的 acked——该提醒的任务被当成已交代过。
    for (const id of Object.keys(state.tasks)) if (!byId.has(id)) delete state.tasks[id];

    for (const [id, info] of byId) {
      const rec = state.tasks[id] || { pending: false, acked: false };
      state.tasks[id] = rec;
      if (rec.acked) continue;
      const born = startedAt(info.file);
      const aliveFor = now - (born || now);
      if (rec.pending || aliveFor > AGE_MS) {
        rec.pending = true; // 已 pending 但上一轮没收到具名 ack → 再提醒
        candidates.push({ id, pids: info.pids, aliveFor });
      }
    }
    return state;
  });

  // 只有 pending 真的落盘了才阻断。否则（磁盘满 / 权限变化）state 里没有 pending，
  // 随后的 active Stop 找不到可 ack 的条目，下一次普通 Stop 又重来——形成一个
  // "怎么解释都解除不了"的死拦。宁可这次不提醒。
  if (!committed) {
    dbg("state 未提交，放弃本次阻断，候选=", String(candidates.length));
    return allow();
  }
  const flagged = candidates;
  if (!flagged.length) return allow();

  logFire({
    at: new Date(now).toISOString(),
    session: input.session_id,
    flagged: flagged.map((f) => ({ id: f.id, pids: f.pids, aliveForMs: f.aliveFor })),
  });

  const lines = flagged
    .map(
      (f) =>
        `  • ${f.id}：已运行 ${humanAge(f.aliveFor)}，仍有 ${f.pids.length} 个写进程（pid ${f.pids.join(", ")}）`,
    )
    .join("\n");

  process.stderr.write(
    `[BG-SHELL] 这次停止时，下列后台任务仍在运行，且本 hook 还没收到过针对它们的处置说明：\n${lines}\n\n` +
      "这会让调用方看到矛盾状态：要么该等它们（那就不该宣告完成），要么该回收它们。\n" +
      "本 hook 只知道它们还活着、活了多久——**不知道它们是卡住了还是在正常干活**，那要你判断（用 task id 回查你起它们时的命令与目的）：\n" +
      "• 已经没有意义（等的条件永不满足、等的东西早已结束、产出你已从别处取得）→ TaskStop 或 kill 回收。\n" +
      "• 仍需要它 → 别宣告完成；写明在等什么、预期多久、完成后你会做什么。\n" +
      "两种情况都要重发本回合的【完整交付物】，末尾另起一行：\n" +
      `BG-SHELL-OK: ${flagged.map((f) => f.id).join(" ")} — <逐个写去向>\n` +
      "**必须点名 task id**，没点到的会在下次停止时再次提醒。\n" +
      `（阈值见 BG_SHELL_AGE_MS，当前 ${humanAge(AGE_MS)}。）\n`,
  );
  process.exit(2);
}

try {
  main();
} catch {
  allow();
}
