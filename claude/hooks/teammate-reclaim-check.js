#!/usr/bin/env node
/**
 * teammate-reclaim-check — 把 in-process teammate 的回收清点从注意力挪进 harness。
 *
 * 规则载体是 ~/.claude/references/background-agent-monitoring.md 的
 * 「Teammate 生命周期与回收义务」节。本 hook 不新增规则，只提供该节点名的那本
 * 台账——它明写「台账别指望磁盘」，因为 ~/.claude/teams/session-<id>/config.json
 * 的 members 只在部分 session 落盘。转录里的 tool_use / tool_result 是可靠替代。
 *
 * ## 事件
 *
 *   UserPromptSubmit            → additionalContext，把清单摆到主 agent 面前
 *   SessionStart:startup|resume → 清空可行动边界（不产出任何输出）
 *
 * 其它事件即使被接线也只会静默返回（见 evaluate 里的白名单）。
 *
 * 刻意不挂 Stop，两条理由叠加。其一，Stop 的 additionalContext 按契约是"继续
 * 对话"，会强行多给一个回合（实测证实）。其二——即便改用只给用户看的
 * systemMessage 绕开续轮——Stop 在**每个回合边界**触发，无法区分"工作流中途让出
 * 回合、teammate 正在干活"与"会话结束时仍有泄漏"：实测在正常 fan-out 中途就会
 * 向用户报出 5 个**正在工作**的 reviewer。那与本仓 HARNESS-001 记录的 stop-gate
 * 误判 supervisor turn-yield 是同一类错误（对任务阶段无感知），而告警可信度一旦
 * 被这种噪声消耗掉，终态覆盖本身也就失效了。
 *
 * 终态因此**无覆盖**：会话结束时若仍有泄漏，本 hook 不会留下任何记录。曾评估过
 * 用 SessionEnd 只写审计日志来补，结论是不值得——官方明确 `transcript_path`
 * "written asynchronously and might not contain the most recent messages"，而
 * SessionEnd 没有"下一轮"来补读，于是终态审计会系统性漏掉最近的工作，也就是它
 * 唯一想测量的那一类。详见 docs/issues/harness-issues.md HARNESS-064。
 *
 * ## 正确性（本 hook 的承重设计）
 *
 * 风险链：提醒 → 主 agent 相信它 → TaskStop 一个产出尚未到手的 teammate →
 * 工作永久丢失。本 hook 的信息严格少于主 agent 的：转录只给 tool_use /
 * tool_result 与 idle 通知，它不查进程存活、不知道意图。故它只报事实、不断言安全。
 *
 * **idle 不等于产出已交付。** 这是本文件最容易搞错的一点，也曾在第一版里搞错：
 * HARNESS-041 实测记录过 teammate 已 idle 而完整报告因 SendMessage 路由失败
 * 从未到达主 session（一次 fan-out 里约 7/20 份），须逐个催收。所以 idle 层的
 * 措辞是「先确认报告已到手，未到先 SendMessage 索取，然后回收」——与规则载体
 * 同步，而不是"停它不会丢东西"。unknown 层建议的动作也不是停它，而是"你是否
 * 还在等它"这个决定；该决定的错误分支（继续留用）代价为零。
 *
 * 两层都不宣称可安全丢弃任何东西，故任一层被采信都不产生正确性风险。
 *
 * 「反复劝」由状态去重消除：每实例每状态只报一次，且**只对实际展示出来的**实例
 * 记账——否则被截断的实例会被永久静音。
 *
 * ## 可行动边界
 *
 * resume 不恢复 in-process teammate，所以 resume 前的实例必须退出可行动集合。
 * 边界是一个 `{inode, offset}`，惰性建立：没有边界时取当次冻结的文件大小当边界，
 * 于是那次扫描出来的历史全在边界之前、都不可行动。resume 与换文件都把它清空。
 *
 * 这个边界**不能**由"加载时有没有台账"推断——真实接线里 SessionStart 会先存一次
 * 台账，紧随其后的 UserPromptSubmit 必然看到台账已存在，那种推断永不生效。带
 * inode 是因为跨文件的字节偏移不可比。
 *
 * idle 通知不带实例 ID，所以同名多实例时**不归属**（记一笔 idle_ambiguous 供审计，
 * 实例留在 unknown 层）——猜错会把仍在工作的实例标成已停工。
 *
 * ## 可观测性
 *
 * 每次 fire 追加一行到 ~/.claude/logs/teammate-reclaim.jsonl，带实例主键、
 * agent_id、spawn/idle 时间戳与证据偏移，使误报可被逐个复盘、判据可据此收紧。
 *
 * ## 失效模式
 *
 * 任何异常静默退出且不注入——本 hook 是兜底层，不能自己变成故障源。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const LEDGER_VERSION = 3;
const STATE_DIR = path.join(os.homedir(), '.claude', 'state', 'teammate-reclaim');
const LOG_PATH = path.join(os.homedir(), '.claude', 'logs', 'teammate-reclaim.jsonl');
const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects') + path.sep;

/**
 * 本轮读到的 transcript 是否位于 `~/.claude/projects/` 之下——**观察，不是来源推断**。
 *
 * 这条区分是 ADR-018 的全部要点，别把它"改进"成 `origin: production|synthetic`：
 * 那个形态经三轮 decision-review 全部否决。理由是路径惯例**不是契约**——未来若有
 * 生产运行落在临时目录下，分类器会**确定地**把它标成合成，而「作用域只覆盖当天快照」
 * 这句声明约束不了一个持续运行的分类器；且没有任何机制能发现这种**语义**误分类
 * （校验"字段与路径规则一致"发现不了"路径规则把来源判错"）。
 *
 * 记成观察值就没有这两个问题：生产落在别处时它如实记 `false`，那是**正确的观察**；
 * 字段只会因这里的路径谓词写错而错，而那是确定性的、可逐例断言的——**该断言有前提**
 * （harness 传入词法形绝对路径；symlink / cwd / 大小写三条边界见 ADR-018「前提与已知边界」）。
 * 「这行是夹具还是生产」的解释**推迟到读取时**——解释可以随认识修正，写进日志的断言不能。
 *
 * `null` 不是数据缺失，语义是**「本轮运行时该 transcript 读不到」**（transcriptPath 缺失，
 * 或 statSync 失败）。**必须喂 `ingest` 回传的 `observedPath`，不能喂 `led.source.path`**——
 * 后者是台账里上一轮持久化的值，会跨调用存活，拿它当本轮观察就会在一个本轮什么都没读到的
 * 行上给出肯定读数（理由见 `readNewLines` 的注释）。这条曾经写错并被 review-gate 逐出。
 */
function transcriptUnderProjects(observedPath) {
  if (typeof observedPath !== 'string' || !observedPath) return null;
  return path.resolve(observedPath).startsWith(PROJECTS_ROOT);
}

/** 一次注入最多点名几个实例。未展示的**不**记账，故余项下次继续出现。 */
const MAX_LISTED_PER_TIER = 6;
/** 单次 read 的块大小（`TEAMMATE_RECLAIM_READ_CHUNK` 可覆盖，供测试真正跨块）。 */
const DEFAULT_READ_CHUNK = 8 * 1024 * 1024;
/** 单次调用的总读取预算（`TEAMMATE_RECLAIM_MAX_READ` 可覆盖，供测试驱动预算耗尽分支）。 */
const DEFAULT_MAX_TOTAL_READ = 512 * 1024 * 1024;

// ---------------------------------------------------------------- ledger

function emptyLedger(sessionId) {
  return {
    version: LEDGER_VERSION,
    session_id: sessionId || null,
    /**
     * 可行动边界。null = 尚未建立，下一次扫描就地建立（取当时的文件大小），
     * 该次扫描发现的一切都算基线之前。resume 与 inode 变化都把它清回 null。
     * 带 inode 是因为跨文件的字节偏移不可比。
     */
    baseline: null,
    /** 单调递增，给同名实例定序——时间戳会在并行 tool block 间打平。 */
    seq: 0,
    source: { path: null, inode: null, offset: 0 },
    // key = spawn 的 tool_use.id：唯一标识一个实例，故 spawn A → stop A → 再
    // spawn A 的第二个实例不会被第一个的历史状态遮蔽。
    instances: {},
    // tool_use 已见、tool_result 未见的挂起调用。只有确认成功才迁移状态。
    pending: { spawn: {}, stop: {} },
  };
}

function ledgerPath(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(STATE_DIR, `${safe}.json`);
}

/** @returns {{led: object}} */
function loadLedger(sessionId) {
  try {
    const led = JSON.parse(fs.readFileSync(ledgerPath(sessionId), 'utf8'));
    if (led && led.version === LEDGER_VERSION) {
      led.instances = led.instances || {};
      led.pending = led.pending || { spawn: {}, stop: {} };
      led.pending.spawn = led.pending.spawn || {};
      led.pending.stop = led.pending.stop || {};
      led.source = led.source || { path: null, inode: null, offset: 0 };
      led.baseline = led.baseline || null;
      led.seq = Number(led.seq) || 0;
      return { led };
    }
  } catch { /* 缺失、损坏或版本不符都按新台账处理 */ }
  return { led: emptyLedger(sessionId) };
}

function saveLedger(led) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const target = ledgerPath(led.session_id);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(led));
  fs.renameSync(tmp, target);
}

// ---------------------------------------------------------------- transcript

/**
 * 读转录的新增部分，尽量一次追平。
 *
 * 承重细节：
 *  - 扫描开始时**固定** size：读取期间转录仍在被追加，不固定会读到半条 JSON。
 *  - 按**原始字节**找 \n 并按字节切片，carry 也是 Buffer。绝不逐块 toString：
 *    一个多字节字符跨越读块边界时，两边各自解码都会得到替换字符，那行 JSON 就
 *    解析失败；更糟的是再用解码后字符串算 byteLength 会让后续 offset 漂移。
 *  - offset 只推进到最后一个完整换行：尾部残行留给下一次，不静默丢弃。
 *  - 比对 inode：转录被轮转 / 换文件时从头重扫，而不是用旧 offset 切错位置。
 *  - 循环读到 size 为止。读不完返回 caughtUp=false——调用方据此**放弃本次报告**：
 *    只读了前半段的历史里，已被成功停止的实例会假装还没回收。
 *
 * @returns {{lines: Array<{text: string, offset: number}>, source: object, caughtUp: boolean, observedPath: string|null}}
 */
function maxTotalRead() {
  const raw = Number(process.env.TEAMMATE_RECLAIM_MAX_READ);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_TOTAL_READ;
}

function readChunk() {
  const raw = Number(process.env.TEAMMATE_RECLAIM_READ_CHUNK);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_READ_CHUNK;
}

/**
 * `observedPath`：**本轮**真读到的转录路径，读不到就是 `null`。
 *
 * 别用 `source.path` 代替它——那是**台账里上一轮**持久化下来的值：下面两个提前返回
 * 原样退回传入的 `source`，而 `ingest` 无条件 `led.source = source` 再 `saveLedger`
 * 写回，于是上一次成功读取的路径会跨调用存活。拿它当"本轮观察"会在一个本轮什么都
 * 没读到的行上给出肯定读数，而那正是 ADR-018 要排除的「用旧轮推断本轮」。
 */
function readNewLines(source, transcriptPath) {
  if (!transcriptPath) return { lines: [], source, caughtUp: true, observedPath: null };

  let st;
  try { st = fs.statSync(transcriptPath); } catch { return { lines: [], source, caughtUp: true, observedPath: null }; }

  const sameFile = source.path === transcriptPath && source.inode === st.ino;
  let cursor = sameFile ? Number(source.offset) || 0 : 0;
  const size = st.size; // 冻结
  if (cursor > size) cursor = 0; // 被截断过

  const next = { path: transcriptPath, inode: st.ino, offset: cursor };
  if (cursor >= size) return { lines: [], source: next, caughtUp: true, observedPath: transcriptPath };

  const budget = maxTotalRead();
  const chunk = readChunk();
  const lines = [];
  let consumed = 0;
  let carry = Buffer.alloc(0);
  let carryStart = cursor;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    while (cursor < size && consumed < budget) {
      const want = Math.min(size - cursor, chunk, budget - consumed);
      const buf = Buffer.allocUnsafe(want);
      const got = fs.readSync(fd, buf, 0, want, cursor);
      if (got <= 0) break;
      cursor += got;
      consumed += got;

      let block = carry.length ? Buffer.concat([carry, buf.slice(0, got)]) : buf.slice(0, got);
      let from = 0;
      for (;;) {
        const nl = block.indexOf(0x0a, from);
        if (nl === -1) break;
        const raw = block.slice(from, nl);
        if (raw.length) lines.push({ text: raw.toString('utf8'), offset: carryStart + from });
        from = nl + 1;
      }
      carry = block.slice(from);
      carryStart += from;
      next.offset = carryStart;
    }
  } catch {
    return { lines: [], source: next, caughtUp: false, observedPath: transcriptPath };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }

  return { lines, source: next, caughtUp: next.offset >= size, observedPath: transcriptPath };
}

function contentBlocks(entry) {
  const content = entry && entry.message && entry.message.content;
  return Array.isArray(content) ? content : [];
}

/**
 * 认出一条真正的 idle 通知，返回发出者名字。
 *
 * 必须解析内嵌 JSON 并核对 `type`——只测字符串 `idle_notification` 是否出现会
 * 把"一个正在讨论本 hook 的 teammate 发来的普通文本"误判成它转 idle 了。
 * 名字取 JSON 自己的 `from`，不取外层 teammate_id 属性。
 */
function idleNotificationName(entry) {
  if (!entry || entry.type !== 'user') return null;
  const content = entry.message && entry.message.content;
  const text = typeof content === 'string'
    ? content
    : contentBlocks(entry).map(b => (b && b.type === 'text' ? b.text : '')).join('\n');
  if (!text || text.indexOf('idle_notification') === -1) return null;
  if (text.indexOf('<teammate-message') === -1) return null;

  for (const m of text.matchAll(/\{[^{}]*"type"\s*:\s*"idle_notification"[^{}]*\}/g)) {
    let obj;
    try { obj = JSON.parse(m[0]); } catch { continue; }
    if (obj && obj.type === 'idle_notification' && typeof obj.from === 'string' && obj.from) {
      return obj.from;
    }
  }
  return null;
}

/**
 * 同名的存活实例。
 *
 * 返回数组而不是"猜最新那个"：idle 通知里没有实例 ID，同名多实例时**无法**证明
 * 它来自哪一个。猜错的代价是把一个仍在工作的实例标成已停工，然后 idle 层的措辞
 * 会引导主 agent 去停它。所以歧义时不归属（留在 unknown 层，那是安全的一层）。
 */
function liveByName(led, name) {
  return Object.values(led.instances).filter(i => i.state === 'live' && i.name === name);
}

function foldLine(led, line, offset = 0) {
  let entry;
  try { entry = JSON.parse(line); } catch { return; }

  const idleName = idleNotificationName(entry);
  if (idleName) {
    const candidates = liveByName(led, idleName);
    if (candidates.length === 1) {
      candidates[0].idle_at = entry.timestamp || candidates[0].idle_at || null;
      candidates[0].idle_offset = offset;
    } else if (candidates.length > 1) {
      // 归属不可判定：记一笔供审计，但不给任何实例盖 idle。
      led.idle_ambiguous = (Number(led.idle_ambiguous) || 0) + 1;
      for (const c of candidates) c.idle_ambiguous = true;
    }
    return;
  }

  for (const block of contentBlocks(entry)) {
    if (!block || typeof block !== 'object') continue;

    if (block.type === 'tool_use') {
      if (block.name === 'Agent') {
        led.pending.spawn[block.id] = {
          name: (block.input && block.input.name) || null,
          at: entry.timestamp || null,
        };
      } else if (block.name === 'TaskStop') {
        const input = block.input || {};
        led.pending.stop[block.id] = { target: input.task_id || null, at: entry.timestamp || null };
      }
      continue;
    }

    if (block.type !== 'tool_result') continue;
    const id = block.tool_use_id;
    const result = entry.toolUseResult;

    if (led.pending.spawn[id]) {
      const req = led.pending.spawn[id];
      delete led.pending.spawn[id];
      // 只有确认 spawn 成功才进台账。失败的调用（fork failed / pane 耗尽 /
      // session limit——见 HARNESS-037/041）必须不留痕，否则永久误报一个
      // 从未存在的名字。
      const ok = !block.is_error && result && typeof result === 'object'
        && result.status === 'teammate_spawned';
      if (!ok) continue;
      const name = result.name || req.name
        || (typeof result.agent_id === 'string' ? result.agent_id.split('@')[0] : null);
      if (!name) continue;
      led.instances[id] = {
        name,
        team: result.team_name || null,
        // agent_id 只作内部辅助索引：spawn 结果明确要求不得把它写进面向用户的
        // 文本，而 TaskStop 本来就收 name。
        agent_id: result.agent_id || null,
        prompt_head: typeof result.prompt === 'string' ? result.prompt.slice(0, 40) : null,
        spawned_at: entry.timestamp || req.at || null,
        spawn_offset: offset,
        // 偏移只在同一个文件内可比。转录换 inode 后旧实例的偏移与新 baseline
        // 不可比，否则一个旧实例会在 baseline 重建后被重新认作"边界之后"。
        spawn_inode: (led.source && led.source.inode !== undefined) ? led.source.inode : null,
        idle_at: null,
        idle_offset: null,
        state: 'live',
        seq: ++led.seq,
        reported: [],
      };
      continue;
    }

    if (led.pending.stop[id]) {
      const req = led.pending.stop[id];
      delete led.pending.stop[id];
      const ok = !block.is_error && result && typeof result === 'object'
        && result.task_type === 'in_process_teammate';
      // task_type 同时把后台 bash 任务的 TaskStop 排除在外——同一个工具兼管两者。
      if (!ok) continue;
      const victim = pickStopTarget(led, req.target, result.command);
      if (victim) victim.state = 'stopped';
    }
  }
}

/**
 * 把一次成功的 TaskStop 归到某个实例。
 *
 * TaskStop 的 input 收 name，result 却回一个不透明内部 id（既非 name 亦非
 * agent_id），所以只能反过来从 name 找。同名多实例时用 result.command
 * （prompt 前缀）精确消歧；消歧不了取 seq 最大的存活实例。
 */
function pickStopTarget(led, targetName, command) {
  const live = Object.values(led.instances).filter(i => i.state === 'live');
  let pool = targetName ? live.filter(i => i.name === targetName) : live;
  // 「name@team」形态：先整串匹配，不中再退到 name 段并核对 team。
  if (!pool.length && targetName && targetName.includes('@')) {
    const [bare, team] = targetName.split('@');
    pool = live.filter(i => i.name === bare && (!team || !i.team || i.team === team));
  }
  if (!pool.length) return null;
  if (pool.length > 1 && typeof command === 'string') {
    const head = command.replace(/\.\.\.$/, '').slice(0, 30);
    if (head) {
      const exact = pool.filter(i => i.prompt_head && i.prompt_head.startsWith(head));
      if (exact.length) pool = exact;
    }
  }
  return pool.reduce((a, b) => (b.seq > a.seq ? b : a));
}

// ---------------------------------------------------------------- report

/**
 * 可行动 = 存活，且其 spawn 落在已建立的可行动边界之后、**并出自同一个文件**。
 * 边界未建立、或当前 source 与建立边界时不是同一个文件（偏移不可比）时，一律
 * 不可行动——"宁少报不误报"：报一个已不存在的名字，会把主 agent 引向对一个
 * **复用了同名**的新实例动手。
 */
function actionable(led, inst) {
  if (inst.state !== 'live') return false;
  const b = led.baseline;
  if (!b) return false;                                  // 边界未建立 → 一律不可行动
  if (b.inode !== null && led.source && led.source.inode !== b.inode) return false;
  // 实例的偏移必须与边界出自同一个文件，否则两个数字没有可比性。**严格相等**：
  // 放行 undefined/null 会让"归属未知"的实例照旧参与偏移比较，那正是本条要堵的
  // 复活路径（旧台账里的实例、或任何没记下归属的实例）。
  if (inst.spawn_inode !== b.inode) return false;
  return (Number(inst.spawn_offset) || 0) >= (Number(b.offset) || 0);
}

function classify(led) {
  const idle = [];
  const unknown = [];
  for (const inst of Object.values(led.instances)) {
    if (!actionable(led, inst)) continue;
    const tier = inst.idle_at ? 'idle' : 'unknown';
    if (inst.reported.includes(tier)) continue; // 同一状态只报一次
    (tier === 'idle' ? idle : unknown).push(inst);
  }
  const recentFirst = (a, b) => b.seq - a.seq;
  idle.sort(recentFirst);
  unknown.sort(recentFirst);
  return { idle, unknown };
}

function label(inst) {
  const when = (inst.idle_at || inst.spawned_at || '').slice(11, 16);
  return when ? `${inst.name}（${inst.idle_at ? 'idle' : 'spawn'} ${when}）` : inst.name;
}

/**
 * @returns {{text: string, shownIdle: object[], shownUnknown: object[]}}
 *   只有 shown* 里的实例会被记账——未展示的必须保持未记账，否则第 7 个起
 *   永远不会再被点名。
 */
function render(tiers) {
  const shownIdle = tiers.idle.slice(0, MAX_LISTED_PER_TIER);
  const shownUnknown = tiers.unknown.slice(0, MAX_LISTED_PER_TIER);
  const lines = ['[teammate 回收清点] 本 session 派出、转录里无对应成功 TaskStop 的 in-process teammate：'];

  if (shownIdle.length) {
    lines.push('');
    lines.push('**已 idle**（收到过 idle_notification）→ 先确认它的报告确实已经到手；**没到手就先 `SendMessage` 索取**（idle 只说明它当前空闲，不说明报告已送达——实测有过 idle 而报告从未到达的情形），拿到后不再需要它就 `TaskStop`：');
    for (const i of shownIdle) lines.push(`- ${label(i)}`);
    if (tiers.idle.length > shownIdle.length) {
      lines.push(`- …另有 ${tiers.idle.length - shownIdle.length} 个，下次继续列`);
    }
  }

  if (shownUnknown.length) {
    lines.push('');
    lines.push('**状态未知**（无 idle 信号，可能仍在产出）→ **不要仅凭本条 `TaskStop`**；先判断你是否还在等它的产出，已决定不再等才按「绕过即回收」停：');
    for (const i of shownUnknown) lines.push(`- ${label(i)}`);
    if (tiers.unknown.length > shownUnknown.length) {
      lines.push(`- …另有 ${tiers.unknown.length - shownUnknown.length} 个，下次继续列`);
    }
  }

  lines.push('');
  lines.push('依据是转录事件，不查进程存活，也不能证明任何产出已经落袋。仍需留用的记下理由即可——同一实例的同一状态不会再提醒。');
  return { text: lines.join('\n'), shownIdle, shownUnknown };
}

function auditLog(record) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `${JSON.stringify(record)}\n`);
  } catch { /* 日志失败绝不影响主路径 */ }
}

/** 供事后逐个复盘误报：主键 + 归属证据，而不只是名字。 */
function auditEntry(inst, tier) {
  return {
    name: inst.name,
    tier,
    agent_id: inst.agent_id,
    team: inst.team,
    seq: inst.seq,
    spawned_at: inst.spawned_at,
    spawn_offset: inst.spawn_offset,
    idle_at: inst.idle_at,
    idle_offset: inst.idle_offset,
    idle_ambiguous: Boolean(inst.idle_ambiguous),
    spawn_inode: inst.spawn_inode === undefined ? null : inst.spawn_inode,
  };
}

// ---------------------------------------------------------------- core

/**
 * 折叠转录增量到台账，并在需要时就地建立可行动边界。
 *
 * 边界**不能**由"加载时有没有台账"推断：真实接线里 SessionStart 会先把台账存下来，
 * 于是紧随其后的 UserPromptSubmit 一定看到"台账已存在"，冷重建保护永不生效。
 * 所以改成显式的、惰性建立的边界：没有边界就取当次冻结的文件大小当边界，本次
 * 折叠出来的一切都落在它之前，因而都不可行动。
 *
 * @returns {{caughtUp: boolean, scanned: number, establishedBaseline: boolean, observedPath: string|null}}
 */
function ingest(led, transcriptPath) {
  let established = false;
  const sourceChanged = led.baseline && led.baseline.inode !== null
    && led.source && led.source.inode !== null
    && led.source.inode !== led.baseline.inode;
  if (sourceChanged) led.baseline = null;   // 换过文件：旧偏移与新文件不可比

  if (!led.baseline && transcriptPath) {
    let st = null;
    try { st = fs.statSync(transcriptPath); } catch { st = null; }
    if (st) {
      led.baseline = { inode: st.ino, offset: st.size, at: new Date().toISOString() };
      established = true;
    }
  }

  const { lines, source, caughtUp, observedPath } = readNewLines(led.source, transcriptPath);
  // 先落 source 身份，再折叠：foldLine 要靠 led.source.inode 给实例记归属，
  // 折叠后才赋值会让首次扫描记成 null、换文件那次记成旧 inode。
  led.source = source;
  for (const { text, offset } of lines) foldLine(led, text, offset);
  return { caughtUp, scanned: lines.length, establishedBaseline: established, observedPath };
}

/**
 * @param sink 落审计记录的出口。**只为测试留的缝**：默认就是 auditLog，生产路径不变。
 *   没有它 `common` 只流向未导出的 auditLog，于是"喂哪个值给 transcript_under_projects"
 *   这条接线在外部完全不可观察——review-gate 实测该处变异可 59/0 全绿存活。
 * @returns {{additionalContext?: string, systemMessage?: string}} 无事可报则空对象。
 */
function evaluate(input, sink = auditLog) {
  const sessionId = input.session_id || input.sessionId || null;
  const event = input.hook_event_name || input.hookEventName || 'UserPromptSubmit';
  const transcriptPath = input.transcript_path || input.transcriptPath || null;
  const { led } = loadLedger(sessionId);
  led.session_id = sessionId;

  if (event === 'SessionStart') {
    // resume 不恢复 in-process teammate，所以 resume 之前的实例必须全部退出可行动
    // 集合。清掉边界即可——下一次扫描会就地把边界重设在当时的文件尾。
    if (input.source === 'resume' || input.source === 'startup') {
      led.baseline = null;
      led.pending = { spawn: {}, stop: {} };
      saveLedger(led);
    }
    return {};
  }

  const { caughtUp, scanned, establishedBaseline, observedPath } = ingest(led, transcriptPath);
  if (!caughtUp) {
    // 只读了历史的一部分：已被成功停止的实例会假装还没回收。宁可不报。
    saveLedger(led);
    return {};
  }

  const common = {
    ts: new Date().toISOString(),
    session: sessionId,
    event,
    scanned_lines: scanned,
    source_offset: led.source.offset,
    baseline: led.baseline,
    established_baseline: establishedBaseline,
    idle_ambiguous: Number(led.idle_ambiguous) || 0,
    // 观察事实，不是来源判定——语义与"为什么不是 origin"见 transcriptUnderProjects 与 ADR-018。
    // 喂 observedPath（本轮真读到的），不是 led.source.path（台账里上一轮的）。
    transcript_under_projects: transcriptUnderProjects(observedPath),
  };

  // 白名单之外的事件一律静默返回。**不能**让未知事件落到下面的注入路径：
  // hook 数组会跨 settings 层（project / local / managed / plugin）合并，删掉 user
  // 层的接线不会删掉别层的同名接线。若任何一层仍把本 hook 挂在 Stop，落到注入
  // 路径就会返回 `hookSpecificOutput.additionalContext` —— 而 Stop 的
  // additionalContext 按契约是"继续对话"，正好重新制造本轮要消除的续轮。
  if (event !== 'UserPromptSubmit') {
    saveLedger(led);
    return {};
  }

  const tiers = classify(led);
  if (!tiers.idle.length && !tiers.unknown.length) {
    saveLedger(led);
    return {};
  }

  const { text, shownIdle, shownUnknown } = render(tiers);
  // 只给展示出来的记账，未展示的下次继续出现。
  for (const inst of shownIdle) inst.reported.push('idle');
  for (const inst of shownUnknown) inst.reported.push('unknown');
  saveLedger(led);

  sink({
    ...common,
    suppressed: {
      idle: tiers.idle.length - shownIdle.length,
      unknown: tiers.unknown.length - shownUnknown.length,
    },
    instances: [
      ...shownIdle.map(i => ({ key: keyOf(led, i), ...auditEntry(i, 'idle') })),
      ...shownUnknown.map(i => ({ key: keyOf(led, i), ...auditEntry(i, 'unknown') })),
    ],
  });

  return { additionalContext: text };
}

function keyOf(led, inst) {
  for (const [k, v] of Object.entries(led.instances)) if (v === inst) return k;
  return null;
}

// ---------------------------------------------------------------- harness

function buildOutput(result, event) {
  const out = {};
  if (result.additionalContext) {
    out.hookSpecificOutput = { hookEventName: event, additionalContext: result.additionalContext };
  }
  if (result.systemMessage) out.systemMessage = result.systemMessage;
  return Object.keys(out).length ? JSON.stringify(out) : '';
}

/** run-with-flags 的 in-process 快路径契约，也便于测试直接驱动。 */
function run(rawInput) {
  if (process.env.TEAMMATE_RECLAIM_CHECK === '0') return { stdout: '' };
  let input;
  try { input = JSON.parse(rawInput || '{}'); } catch { return { stdout: '' }; }
  let result = {};
  try { result = evaluate(input) || {}; } catch { result = {}; }
  const event = input.hook_event_name || input.hookEventName || 'UserPromptSubmit';
  return { stdout: buildOutput(result, event) };
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { raw += c; });
  process.stdin.on('end', () => {
    let out = { stdout: '' };
    try { out = run(raw); } catch { /* silent */ }
    process.stdout.write(out.stdout || '');
    process.exit(0);
  });
  process.stdin.on('error', () => { process.exit(0); });
}

module.exports = {
  run, evaluate, ingest, foldLine, emptyLedger, classify, render, MAX_LISTED_PER_TIER,
  readNewLines, pickStopTarget, idleNotificationName, actionable,
  transcriptUnderProjects,
};

if (require.main === module) main();
