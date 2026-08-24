#!/usr/bin/env node
/**
 * 两个**回合内**的节奏 advisory。它们对应的规则都已写对、也都被实测违反过，缺的只是
 * 「那个真会到来的时刻」——两条规则各自的正文都点名了这一点：
 *
 *   · `~/.claude/CLAUDE.md`「Delegation Boundary」：「**要有一个真会到来的时刻，否则它一次
 *     也不会发生**」，并把动作绑到"即将连跑同一形状的机械步骤 ≥6 次"。实测一个 session 里
 *     该条触发 ≥3 次、表态 0 次，无人发现——因为它既不产生工具调用、也不产生可 grep 的 token。
 *   · `~/.claude/skills/review-gate/SKILL.md`「修复轮预算」：「**本条无强制层**：全部轨迹级
 *     判官挂在回合边界，而本循环整段跑在一个回合内部（高档 reviewer 走后台 Bash，连
 *     `SubagentStop` 都不触发）——出 re-failure 时的升级点是 **`PostToolUse` 上按 reviewer
 *     续审次数计数的 in-turn tripwire**」。该 tripwire 此前不存在；实测因此多跑了一整轮
 *     对抗审（体量与一轮正规 review 相当）。
 *
 * **两条都只发 advisory，不阻断。** 判据里承重的那一半是语义判断——"这些步骤形状是否同构、
 * 规格是否已定"、"本轮新 finding 有几条可追到上一轮修复"——按
 * 没有规范约束产出方，模式匹配不收敛——那类判断归语义判断（上游 pattern-matching-scope.md 有完整判据，本仓未收录）。本 hook 只负责
 * **数一个有 spec 的对象**（命令行首 token；POSIX shell 语法是有规范的），把回合内的触发点
 * 造出来，真值判定留给模型。
 *
 * 状态按 session 落 `~/.claude/state/in-turn-cadence/<session_id>.json`。同形机械步骤按形状
 * 只提醒一次；续审预算按 continuation handle 每两次提醒一次——review 单元会在同一长 session
 * 里反复出现，全 session 一次会被更早的无关单元永久消耗。
 *
 * **投递通道**：`stdout` 里的 `hookSpecificOutput.additionalContext`，**不是 stderr**。
 * 本仓 2026-08-19 用 unique-token 探针双向实测过（记录在 `liveness-predicate-gate.js` 的注释里）：
 * exit 0 + stderr 的 hook「produced no observable message in the agent's turn」——官方文档同样明写
 * *stderr from a hook that exits 0 … Claude never sees it*。而本 hook 唯一的读者就是 agent，
 * 所以只写 stderr 等于建了个 no-op。stderr 仍然保留，给读 transcript 的人。
 *
 * **挂 PreToolUse 而不是 PostToolUse**（`review-gate/SKILL.md` 原文点的是后者）：
 * `additionalContext` 只在 PreToolUse 上被实测过，PostToolUse 的字段未测、不可外推。
 * 换到 PreToolUse 顺带更贴规则原文——两条规则要的都是"**在跑之前**答一句"，
 * 而 PostToolUse 最早也只能在动作发生后才开口。
 *
 * **测试必须断言 agent 真正读的那个字段**，不是 stderr：断言 stderr 非空，在"agent 收到"与
 * "一次也没收到"两种情况下**输出完全相同**——这正是上面那份记录点名的陷阱，本 hook 第一版
 * 就掉进去了，15/15 全绿而实际是 no-op。
 *
 * Exit codes: 恒 0。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR = path.join(os.homedir(), '.claude', 'state', 'in-turn-cadence');

// 同形连跑的阈值。CLAUDE.md 写的是 ≥6，这里取 6。
const SAME_SHAPE_THRESHOLD = 6;
// 滑动窗口长度。取 12 是为了让"6 次同形里穿插几次别的"仍能命中，同时不至于把整场 session
// 的历史都算进来。**未标定**，与其余两个阈值同论。
const SAME_SHAPE_WINDOW = 12;
// 续审轮阈值。这里只制造 review-gate「连续 2 轮过半自伤」的可观察检查点；来源归因仍由模型判。
const RESUME_THRESHOLD = 2;

function parseInput(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw || '')); } catch (e) { return null; }
}

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function writeState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state), 'utf8');
  } catch (e) { /* 状态写不下去时本 hook 静默降级为不提醒——它是 advisory，不该因此打断工具链 */ }
}

/**
 * 命令的「形状」＝ 可执行名 + **长选项名的集合**（不含选项值、不含位置参数）。
 *
 * 位置参数必须排除，这是第一版的实测缺陷：把首个非 flag token 当子命令，于是
 * `visual-budget page1.html --ready x` 与 `visual-budget page2.html --ready x` 被算成两种形状，
 * 连跑计数永远到不了阈值——而"只换数据、不换调用形态"恰恰**就是**本计数器要数的那一类。
 *
 * 代价是子命令式工具（`git status` vs `git commit`）会塌成同一形状 `git`，于是连续 6 次不同
 * 子命令的 git 调用也会提醒一次。**这个方向的误差是有意选的**：本 hook 是每 session 只发
 * 一次的非阻断 advisory，误报的代价是一句话，漏报的代价是整条规则再次归零——而它此前的
 * 实测遵守率就是 0。真值判定（"这些步骤是否真的同构、规格是否已定"）本就归模型，不归这里。
 */
function shapeOf(command) {
  // **先剥赋值、再切段**，顺序不能反：`\s+` 里包含换行，而赋值独占一行时（`A=/path\ncmd …`）
  // 先切段会把赋值切成第一段、剥不掉，于是 `A=/x/y/repo` 的 basename `repo` 被当成命令名——
  // 实测发出过一条形状为 `repo|` 的提醒，内容合理但指错了对象。
  const first = String(command || '')
    // `(?:\s+|$)` 里的 `$` 不可省：整串**只有**赋值时（`A=/tmp/x`），要求后跟空白会让它剥不掉，
    // 于是这条根本不是命令的行也拿到一个形状（`x|`）并参与计数。
    .replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*(?:\s+|$))+/, '')  // 剥掉前置环境变量赋值
    .split(/[\n;|&]/)[0]                       // 只看第一段，管道后半段是消费者不是动作
    .trim();
  const toks = first.split(/\s+/).filter(Boolean);
  if (!toks.length) return null;
  const cmd = path.basename(toks[0]);
  const flags = [...new Set(
    toks.slice(1)
      .filter((t) => /^--[a-z][a-z0-9-]*$/i.test(t))
      .map((t) => t.split('=')[0]),
  )].sort();
  return `${cmd}|${flags.join(',')}`;
}

function resumeHandle(command) {
  const m = /codeagent-wrapper[^\n]*\bresume\s+([A-Za-z0-9_-]+)/.exec(String(command || ''));
  return m ? m[1] : null;
}

function run(inputOrRaw) {
  const input = parseInput(inputOrRaw);
  const command = String(input?.tool_input?.command || '');
  const sessionId = String(input?.session_id || '');
  if (!command || !sessionId) return { exitCode: 0 };

  const file = path.join(STATE_DIR, `${sessionId}.json`);
  const state = readState(file) || { recent: [], reviewResumes: {}, notifiedShapes: [] };
  if (!Array.isArray(state.recent)) state.recent = [];
  if (!Array.isArray(state.notifiedShapes)) state.notifiedShapes = [];
  if (!state.reviewResumes || typeof state.reviewResumes !== 'object' || Array.isArray(state.reviewResumes)) {
    state.reviewResumes = {};
  }
  const notes = [];

  // ---- 计数器一：滑动窗口内同一形状的出现次数 ----
  //
  // **不用"连续"计数**：那样穿插一次 `cat out.json` 就把 streak 归零，而验证矩阵里几乎必然
  // 穿插——目标场景因此基本到不了阈值（外部复核实测指出）。改成"最近 WINDOW 次调用里该形状
  // 出现 ≥ 阈值"，穿插不再致命。
  //
  // **mute 按形状各记一次，不是全局一次**：全局 mute 时，一次普通的 commit 序列
  // （status/diff/add/status/commit/log 六次 `git|`）就会把整个 session 唯一的那一发消耗掉，
  // 真正的 21 格矩阵到来时已经哑了（同一份复核实测）。按形状 mute 后，假阳性只哑掉它自己那个形状。
  const shape = shapeOf(command);
  if (shape) {
    state.recent.push(shape);
    if (state.recent.length > SAME_SHAPE_WINDOW) state.recent.shift();
  }
  const shapeCount = shape ? state.recent.filter((x) => x === shape).length : 0;

  if (shape && shapeCount === SAME_SHAPE_THRESHOLD && !state.notifiedShapes.includes(shape)) {
    state.notifiedShapes.push(shape);
    notes.push(
      `[CADENCE] \`${shape}\` 在最近 ${state.recent.length} 次 Bash 调用里出现了 ${SAME_SHAPE_THRESHOLD} 次。` +
      'CLAUDE.md「Delegation Boundary」要求**在跑第一次之前**先答一句委派与否——现在补一句：' +
      '这些步骤形状同构吗？规格已经定死了吗？两者都是 → 它可委派（用户额度 Codex 松、Claude Code 紧）；' +
      '每一步要读上一步结果才知道下一步做什么 → 不可委派，答"不委派"并写出理由即可。' +
      '这个形状每 session 只提醒一次（换个形状仍会再提醒一次）——**提醒不因为你答过而消失，' +
      '它只是不再重复**，所以"没再提醒"不等于"我答过了"。'
    );
  }

  // ---- 计数器二：reviewer 续审轮次 ----
  // 只认 `codeagent-wrapper … resume <handle>`——首轮派发不计。按 handle 分桶，避免同一 session
  // 里无关 reviewer 互相凑数；每两次再提醒，避免早期 review 单元永久吃掉全 session 唯一机会。
  const handle = resumeHandle(command);
  if (handle) {
    state.reviewResumes[handle] = Number(state.reviewResumes[handle] || 0) + 1;
    const resumes = state.reviewResumes[handle];
    if (resumes % RESUME_THRESHOLD === 0) {
      notes.push(
        `[CADENCE] reviewer continuation \`${handle}\` 已续审 ${resumes} 次。` +
        'review-gate「修复轮预算」的判据是**连续 2 轮、该轮新 finding 中过半可追到本方上一轮修复**' +
        '——它此刻可能已经成立。**在动手改下一行之前**，先对最近两轮的新 finding 逐条标' +
        '"来源=上一轮修复 / 独立"，再对照该判据。成立就按它走 `AskUserQuestion` 交用户裁决继续或收口，' +
        '不要先修完再说：实测那一轮"越界修复"的体量与一整轮正规 review 相当，且它自己又引入了新缺陷。' +
        '同一 continuation 每 2 次续审提醒一次；提醒只制造检查点，不替代上面的来源归因。'
      );
    }
  }

  writeState(file, state);
  if (!notes.length) return { exitCode: 0 };
  const message = notes.join('\n\n');
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: message },
    }),
    stderr: message,
  };
}

module.exports = { run };

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    const r = run(raw);
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr + '\n');
    process.exit(r.exitCode || 0);
  });
}
