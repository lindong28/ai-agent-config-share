#!/usr/bin/env node
/**
 * `in-turn-cadence-advisor` 的夹具。
 *
 * **断言的是 agent 真正读得到的那个字段，不是 stderr。** 这一条是本 hook 第一版的致命缺陷：
 * 它 exit 0 + 只写 stderr，而官方文档与本仓 2026-08-19 的双向 unique-token 实测
 * （记录在 `liveness-predicate-gate.js` 的注释里）都表明 **agent 收不到 exit 0 的 stderr**——
 * 于是那一版是个 no-op，而 15/15 全绿。那份记录逐字点过这个陷阱：
 *   「asserting `stderr` is non-empty reads identically whether the agent receives anything
 *     or not, so the assertion has to name the field the agent actually reads.」
 * 所以下面所有"发没发"的断言都读 `stdout.hookSpecificOutput.additionalContext`。
 *
 * 每条都成对：只断言"该发时发了"，在"恒发"与"发对了"两种情况下输出相同；只断言"不该发时没发"，
 * 在"恒不发"与"判对了"两种情况下也相同。两侧都要。
 *
 * 跑法：node ~/.claude/hooks/in-turn-cadence-advisor.test.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { run } = require('./in-turn-cadence-advisor.js');
const STATE_DIR = path.join(os.homedir(), '.claude', 'state', 'in-turn-cadence');

let FAIL = 0;
function check(name, got, want) {
  if (got === want) { console.log(`  ✓ ${name}`); return; }
  console.log(`  ✗ ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  FAIL++;
}

let n = 0;
function freshSession() {
  const id = `test-cadence-${process.pid}-${++n}`;
  try { fs.unlinkSync(path.join(STATE_DIR, `${id}.json`)); } catch (e) { /* 本来就没有 */ }
  return id;
}
function fire(sid, command) {
  return run({ session_id: sid, tool_input: { command } });
}

/** agent 实际读到的文本。读 stdout 的 additionalContext——**不是** stderr。 */
function agentSees(r) {
  if (!r || !r.stdout) return '';
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch (e) { return ''; }
  const hso = parsed && parsed.hookSpecificOutput;
  if (!hso || hso.hookEventName !== 'PreToolUse') return '';
  return String(hso.additionalContext || '');
}
const said = (r, tag) => agentSees(r).includes(tag);

// ---------------------------------------------------------------- 通道本身
{
  const sid = freshSession();
  let r = null;
  for (let i = 1; i <= 6; i++) r = fire(sid, `visual-budget p${i}.html --ready x`);
  check('触发时 agent 读得到（stdout.additionalContext 非空）', agentSees(r).length > 0, true);
  check('同一条也写了 stderr（给读 transcript 的人）', Boolean(r.stderr), true);
  check('两条通道内容一致', agentSees(r) === r.stderr, true);
  check('hookEventName 是 PreToolUse', JSON.parse(r.stdout).hookSpecificOutput.hookEventName, 'PreToolUse');
  check('不触发时不产生 stdout', Boolean(fire(freshSession(), 'ls').stdout), false);
}

// ---------------------------------------------------------------- 同形计数
{
  const sid = freshSession();
  let hits = 0;
  for (let i = 1; i <= 5; i++) if (said(fire(sid, `visual-budget p${i}.html --ready x`), '[CADENCE]')) hits++;
  check('同形 5 次不提醒（阴性：阈值是 6）', hits, 0);
  check('第 6 次提醒', said(fire(sid, 'visual-budget p6.html --ready x'), 'Delegation Boundary'), true);
  check('第 7 次不再重复（同一形状只发一次）',
        said(fire(sid, 'visual-budget p7.html --ready x'), '[CADENCE]'), false);
}
{
  // 滑动窗口：穿插别的命令不该把计数清零——真实矩阵几乎必然穿插。
  const sid = freshSession();
  const seq = ['visual-budget a --ready x', 'cat out.json', 'visual-budget b --ready x', 'ls',
               'visual-budget c --ready x', 'visual-budget d --ready x', 'echo hi',
               'visual-budget e --ready x', 'visual-budget f --ready x'];
  let fired = false;
  for (const c of seq) if (said(fire(sid, c), '[CADENCE]')) fired = true;
  check('穿插其它命令后仍能命中（滑动窗口，不是连续计数）', fired, true);
}
{
  // 按形状 mute：一次假阳性不该吃掉真正那一发。
  const sid = freshSession();
  for (let i = 0; i < 6; i++) fire(sid, 'git status');          // 先让 `git|` 触发一次
  let fired = false;
  for (let i = 1; i <= 6; i++) if (said(fire(sid, `visual-budget p${i}.html --ready x`), '[CADENCE]')) fired = true;
  check('别的形状触发过之后，目标形状仍会提醒（按形状 mute）', fired, true);
}
{
  const sid = freshSession();
  let hits = 0;
  const cmds = ['git status', 'ls -la', 'grep -n x f', 'python3 a.py', 'curl -sS u', 'node t.js', 'sed -n 1p f'];
  for (const c of cmds) if (said(fire(sid, c), '[CADENCE]')) hits++;
  check('7 次各不同形状不提醒（阳性对照：证明它真在比形状）', hits, 0);
}
{
  const sid = freshSession();
  for (let i = 1; i <= 5; i++) fire(sid, 'visual-budget a --ready x');
  check('带环境变量前缀的第 6 次仍算同形',
        said(fire(sid, 'ARENA_X=1 visual-budget b --ready x'), '[CADENCE]'), true);
}
{
  // 赋值**独占一行**（实测形态：`A=/x/y/repo` 换行后才是真命令）。剥前缀与切段顺序反了时，
  // 形状会变成那个路径的 basename——提醒照发、内容合理、指错对象。所以断言的是**形状文本**，
  // 不是"发没发"：后者在修好与修坏两种情况下都为 true。
  const sid = freshSession();
  let msg = '';
  for (let i = 1; i <= 6; i++) {
    const r = fire(sid, `A=/Users/x/research/ai-agent-config\nvisual-budget p${i}.html --ready x`);
    if (agentSees(r)) msg = agentSees(r);
  }
  check('赋值独占一行时，形状取真命令而非路径 basename',
        msg.includes('`visual-budget|--ready`'), true);
  check('阳性对照·形状不是被剥剩的路径名', msg.includes('ai-agent-config|'), false);
}
{
  const sid = freshSession();
  let hits = 0;
  for (let i = 0; i < 6; i++) if (said(fire(sid, 'A=/tmp/x'), '[CADENCE]')) hits++;
  check('纯赋值不构成一个形状（阴性）', hits, 0);
}

// ---------------------------------------------------------------- 续审计数
{
  const sid = freshSession();
  const c = "CODEX_SANDBOX=read-only codeagent-wrapper --progress --backend codex resume 01a0-xyz - /tmp/wd";
  check('第 1 次续审不提醒', said(fire(sid, c), '[CADENCE]'), false);
  check('同一 continuation handle 第 2 次续审提醒', said(fire(sid, c), '修复轮预算'), true);
  check('同一 handle 第 3 次不提醒', said(fire(sid, c), '修复轮预算'), false);
  check('同一 handle 第 4 次再次提醒', said(fire(sid, c), '修复轮预算'), true);
}
{
  const sid = freshSession();
  const a = "codeagent-wrapper --backend codex resume 01a0-a - /tmp/wd";
  const b = "codeagent-wrapper --backend codex resume 01a0-b - /tmp/wd";
  check('不同 handle 的第 1 次不会互相凑成两轮·A', said(fire(sid, a), '修复轮预算'), false);
  check('不同 handle 的第 1 次不会互相凑成两轮·B', said(fire(sid, b), '修复轮预算'), false);
  check('A 自己第 2 次才提醒', said(fire(sid, a), '修复轮预算'), true);
  check('B 自己第 2 次也提醒', said(fire(sid, b), '修复轮预算'), true);
}
{
  // 生产失守会话已经写过旧版 session-global mute。升级后不能继承那次 mute，否则修复只对新会话生效。
  const sid = freshSession();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(STATE_DIR, `${sid}.json`), JSON.stringify({
    recent: [], resumes: 73, notifiedShapes: [], notified: { resume: true },
  }));
  const c = "codeagent-wrapper --backend codex resume 01legacy - /tmp/wd";
  check('旧版 session-global mute 不压住新分桶的第 1 次', said(fire(sid, c), '修复轮预算'), false);
  check('旧版 session-global mute 不压住新分桶的第 2 次', said(fire(sid, c), '修复轮预算'), true);
}
{
  const sid = freshSession();
  const first = "CODEX_SANDBOX=read-only codeagent-wrapper --progress --backend codex - /tmp/wd";
  let hits = 0;
  for (let i = 0; i < 5; i++) if (said(fire(sid, first), '修复轮预算')) hits++;
  check('5 次首轮派发不触发续审计数器（阳性对照）', hits, 0);
}

// ---------------------------------------------------------------- 降级路径
check('无 session_id 时静默放行', run({ tool_input: { command: 'ls' } }).exitCode, 0);
check('无 command 时静默放行', run({ session_id: 'x' }).exitCode, 0);
check('原始字符串输入可解析', run(JSON.stringify({ session_id: freshSession(), tool_input: { command: 'ls' } })).exitCode, 0);
check('坏 JSON 不抛异常', run('{not json').exitCode, 0);

try {
  for (const f of fs.readdirSync(STATE_DIR)) {
    if (f.startsWith(`test-cadence-${process.pid}-`)) fs.unlinkSync(path.join(STATE_DIR, f));
  }
} catch (e) { /* 目录可能不存在 */ }

console.log(FAIL === 0 ? '\n✓ 全部通过' : `\n✗ ${FAIL} 条失败`);
process.exit(FAIL === 0 ? 0 : 1);
