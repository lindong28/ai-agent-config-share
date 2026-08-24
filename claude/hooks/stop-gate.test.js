#!/usr/bin/env node

'use strict';

// stop-gate 的【消息来源选择】回归测试。
//
// 只覆盖判官之前的确定性分支：`stop_hook_active`（本闸唯一的逃生口，按 agent 隔离）、
// HARNESS-021（未闭合工具调用）、H-006（声明不需要回应即收尾）、以及 commit 决定挂回用户。
// 另含两条钉住"自签口令 STOP-GATE-OK 已删除、不再是旁路"的回归。
// 这些都在 callJudge 之前短路，所以整份测试零网络、零模型、可重复。判官
// 本身的判定质量归 hooks/eval/stop-gate/（场景 + LLM），不在这里测。
//
// 存在的理由：inline-first 是时序敏感的隐蔽逻辑，而 eval runner 只喂
// transcript_path——把来源改回 transcript-first，那套 eval 依然全绿。下面每条断言
// 都是为了让那种回退当场变红。
//
// wire token 一律拼接构造、源文件里不出现完整字面量，与 stop-gate.js 同理：本文件
// 被读回时其内容不应被误解析成真调用。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const hook = path.join(__dirname, 'stop-gate.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-gate-test-'));
const unavailableJudge = path.join(tmp, 'judge-unavailable.sh');
fs.writeFileSync(unavailableJudge, '#!/bin/sh\nexit 1\n');
fs.chmodSync(unavailableJudge, 0o755);

// 判官不可用时本闸 fail-open，所以这套 env 给出一条**确定性的放行路径**，用来做来源优先级
// 那两条断言的 allow 侧信号。此前那个信号是 `STOP-GATE-OK` 逃生口；它已删除（自签放行条），
// 于是 allow 侧改用"判官不可用 → fail-open"，同样零网络、零模型。
const noJudgeEnv = {
  HOME: tmp,
  ZHIPU_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  CLAUDE_CLI_PATH: unavailableJudge,
  CLAUDE_JUDGE_LOG_PATH: path.join(tmp, 'judge.jsonl'),
};

const NS = 'antml:';
const UNCLOSED = 'I will call it now: <' + NS + 'function_calls><' + NS + 'invoke name="Bash">';
// 一段不命中任何确定性分支的普通交付物：走到判官，而判官被上面那套 env 停用 → 放行。
const BENIGN = '我把 3 个文件的改动跑过测试，21/21 通过，读数贴在上面。';
// 曾经的逃生口口令。保留常量只为钉住"它不再是旁路"这条回归。
const RETIRED_TOKEN = 'all done. STOP-GATE' + '-OK: verified by hand';
// H-006：整条消息就是一句"不需要回应"。判官实测判 ok（它无从核实这个断言——有没有
// 待办不在它看得到的文本里），所以这条必须确定性地拦。
const DECLINED = 'No response requested.';
// 同一短语被**引用在**一条实质回复里。初版模式没锚定整句，这条被误拦——宽判据的噪音
// 会训练读者忽略整道闸。这是本文件里唯一一条钉住"已修好的真实回归"的断言。
const QUOTES_PHRASE =
  '我核对了 63 条 clip 的 sha256，与 audit.json 逐条一致。另外顺带确认 monitor ' +
  '那边 no response needed 这个说法在日志里出现过一次，是 wrapper 的正常输出，不是异常。';

/** 写一份最小 transcript，其最后一条 assistant 文本为 `text`。 */
function transcriptWith(name, text) {
  const p = path.join(tmp, `t-${name}.jsonl`);
  fs.writeFileSync(
    p,
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n'
  );
  return p;
}

// 显式清掉判官的递归护栏：hook 见到它会在 main() 开头无条件放行，于是所有期望
// exit 2 的断言都会假失败。父进程带着它跑测试是合法的（嵌套判官调用里就带），所以
// 不能靠"通常没人设"来免疫。
const { NEST_GUARD } = require('./lib/llm-judge');
const cleanEnv = { ...process.env };
delete cleanEnv[NEST_GUARD];

/** 返回 hook 的 exit code：2 = 拦下并要求继续，0 = 放行。 */
function run(payload, extraEnv = {}) {
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...cleanEnv, ...extraEnv },
    timeout: 15000,
  });
  assert.notStrictEqual(r.status, null, `hook 未正常退出: ${r.stderr}`);
  return r.status;
}

try {

const gate = require('./stop-gate.js');

// —— userReservedActionClause 的**注入条件**（判官裁决测不了，注入条件是纯函数，能测）————
// review 指出：此前所有"flag 侧无回归"读数用的场景**一条都没命中新正则**，那些读数在改动
// 存在与否时完全相同，零区分力。下面按「谁执行」这条轴正反各钉几条。
for (const [text, expected] of [
  ['push 权限是你在 Gate D 明确保留给自己的（原话「我自己 push」）', true],
  ['push 到 origin 由你负责', true],
  ['合并回本地 main 由你负责', true],
  ['你本人点击确认后我再继续', true],
  ['剩下这步你自己来', true],
  // 反向：第一人称「我自己」在绝大多数上下文是 agent 自称，语义与本轴相反，不得注入。
  ['我自己来做剩余测试', false],
  ['我已经 git push 完成了', false],
  ['跑完测试我就 push', false],
  ['改动都在工作树里，还没提交', false],
]) {
  assert.strictEqual(
    gate.USER_RESERVED_RE.test(text),
    expected,
    `注入条件按「谁执行」判，不按是否出现 push（${expected ? '应注入' : '不应注入'}）：${text}`
  );
  assert.strictEqual(
    gate.userReservedActionClause(text) !== '',
    expected,
    `clause 注入与正则一致：${text}`
  );
}
// 解耦＝移走，不是复制：同时命中两个轴的消息不得收到两份"不 flag"。
assert.ok(
  !gate.mergePendingClause('这个 PR 还等你合并').includes('正在读这条消息的用户本人'),
  '原 carve-out 必须已从 mergePendingClause 移走，否则交集消息会被强调两次豁免'
);

// —— delegatedInFlightClause 的**注入条件**（同上：判官裁决归 eval，注入条件是纯函数）————
// 触发键 = bg-shell 协议形 ack 位于尾部 token run 内，**且至少一个 ack id 有运行态对应物**
// （PATTERN-EXCEPTION 与读数见 stop-gate.js 匹配器旁注释）。
// 用例按 held-out 语料的类别钉：真 ack / 叠 token / 已回收去向（注入照发——去向裁量归 clause 文本与判官）/
// 撤回散文断 run / 引用与表格行 / 裸 token 无去向 / 伪造 id 无任务产物。
// 任务产物 fixture：运行态对应物是两个合取——产物在场 + **活写入者**（lsof 有持有者）。
// 本测试进程自己持有 fd 来扮演活写入者；释放 fd 即模拟 active→completed（下方翻转对照）。
const taskRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-taskroot-'));
const tasksDir = path.join(taskRoot, 'claude-eval', '-x-proj', 'sess', 'tasks');
fs.mkdirSync(tasksDir, { recursive: true });
const heldFds = {};
for (const id of ['taskA', 'taskB', 'taskC']) {
  const fp = path.join(tasksDir, `${id}.output`);
  fs.writeFileSync(fp, '');
  heldFds[id] = fs.openSync(fp, 'a');
}
process.env.STOP_GATE_TASK_ROOT = taskRoot;
for (const [text, expected, why] of [
  ['交付正文……\nBG-SHELL-OK: taskA — 仍需要:等完成回调。', true, '末行真 ack'],
  ['正文……\nBG-SHELL-OK: taskB — 仍需要:等回调。\nSTOP-GATE-OK: 已复检。', true, '叠 token(多闸拦截后叠放,6/68 实测形态)'],
  ['正文……\nBG-SHELL-OK: taskA taskB — 两任务均在跑,已建巡检。', true, '单行多 id(owning parser 同形)'],
  ['正文……\nBG-SHELL-OK: taskC — 已回收:结果已从别处取得。', true, '已回收去向仍注入——不豁免由 clause 边界条款与判官判'],
  ['BG-SHELL-OK: taskA — 已回收。\n更正:该任务尚未处理,先别当它已回收。', false, '撤回散文断开 token run'],
  ['讨论:`BG-SHELL-OK: taskA — 仍在跑` 是协议样例。\n以上是分析结论。', false, '行中引用,散文收尾'],
  ['| `BG-SHELL-OK: taskA — 仍在跑` | acked |', false, '表格行不是协议行'],
  ['正文……\nBG-SHELL-OK: taskA', false, '裸 token 无分隔符与去向,owning spec 不认'],
  // —— review 反例(2026-08-18 高档评审 F1/F3)——
  ['BG-SHELL-OK: taskA — 仍需要:等回调。\nTODO-OK: 更正,taskA 已回收。', false, '任意 *-OK 伪装 token 行保 run——成员是枚举闭集,TODO-OK 断开 run'],
  ['正文……\nBG-SHELL-OK:  — 仍需要:等回调。', false, '空 id:owning parser 一个 pending id 也 ack 不掉'],
  ['正文……\nBG-SHELL-OK: ,，、 — 仍需要:等回调。', false, '纯分隔符 id 同上'],
  ['正文……\nIN-FLIGHT: taskA — 等完成回调\nBG-SHELL-OK: taskA — 仍需要:等回调。', true, '规定顺序:IN-FLIGHT 在前、BG ack 收尾'],
  ['正文……\nBG-SHELL-OK: taskA — 仍需要:等回调。\nIN-FLIGHT: taskA — 等完成回调', true, '反序防御:IN-FLIGHT 在闭集内,clause 仍注入(owning parser 会拒 ack,命令侧已规定正序)'],
  // —— closure 反例(2026-08-18 复核):格式合法但 id 无运行态对应物 → 不注入
  ['正文……\nBG-SHELL-OK: stale-or-madeup — 仍需要:等回调。', false, '伪造/过期 id 找不到任务产物,豁免不注入'],
  ['正文……\nBG-SHELL-OK: stale-one taskA — 仍需要:等回调。', true, '多 id 里任一有产物即注入(owning parser 同为交集语义)'],
]) {
  assert.strictEqual(gate.hasTrailingBgAck(text, 'sess'), expected, `注入条件(${why}):${text.slice(0, 40)}`);
  assert.strictEqual(gate.delegatedInFlightClause(text, 'sess') !== '', expected, `clause 注入与匹配器一致(${why})`);
}
// execute-plan 的独立 IN-FLIGHT mandate：同样要求协议形态 + 活运行态对应物。
for (const [text, expected, why] of [
  ['正文……\nIN-FLIGHT: taskA — 等三项修复的完成回调', true, '真实 task + 完整去向'],
  ['正文……\nIN-FLIGHT: stale-or-madeup — 等完成回调', false, '伪造/过期 id'],
  ['正文……\nIN-FLIGHT: taskA', false, '裸 token 无分隔符与去向'],
]) {
  assert.strictEqual(gate.hasTrailingInFlight(text, 'sess'), expected, `IN-FLIGHT 注入条件(${why})`);
  assert.strictEqual(gate.delegatedInFlightClause(text, 'sess') !== '', expected, `IN-FLIGHT clause(${why})`);
}
// 运行态合取的阴性对照:产物根指向空目录时,先前为 true 的同一输入必须翻 false——
// 否则"文件存在判定"在从不检查文件时读数相同。
{
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-emptyroot-'));
  const prev = process.env.STOP_GATE_TASK_ROOT;
  process.env.STOP_GATE_TASK_ROOT = emptyRoot;
  assert.strictEqual(gate.hasTrailingBgAck('正文……\nBG-SHELL-OK: taskA — 仍需要:等回调。', 'sess'), false,
    '空产物根下真 ack 也不注入——证明存在性检查真的在读文件系统');
  process.env.STOP_GATE_TASK_ROOT = prev;
}
// session/项目绑定的阴性对照:同一产物(fd 仍被持有)、别的 session id 且无同项目 cwd → 不注入——
// 历史陈尸 `.output` 属别的 session 目录与别的项目 slug,到不了搜索面。
assert.strictEqual(
  gate.hasTrailingBgAck('正文……\nBG-SHELL-OK: taskA — 仍需要:等回调。', 'another-session'),
  false,
  '产物在 sess 目录下,以 another-session(无 cwd)查询必须不注入'
);
assert.strictEqual(
  gate.hasTrailingBgAck('正文……\nBG-SHELL-OK: taskA — 仍需要:等回调。', undefined),
  false,
  '无 session id 且无 cwd 时不注入(fail-safe 向不注入)'
);
// 只读 holder 负对照:同一产物仅被**只读** fd 持有(tail -f / 查看器形态)必须不注入——
// `lsof -t` 分不开读写,复核实测已完成任务被只读持有时误判在飞;access 模式须含 w/u。
{
  const roFile = path.join(tasksDir, 'taskRO.output');
  fs.writeFileSync(roFile, 'done');
  const roFd = fs.openSync(roFile, 'r');
  assert.strictEqual(
    gate.hasTrailingBgAck('正文……\nBG-SHELL-OK: taskRO — 仍需要:等回调。', 'sess'),
    false,
    '只读 holder 不算活写入者——已完成任务被 tail -f 类持有不得冒充在飞'
  );
  fs.closeSync(roFd);
}
// fork 场景阳性:payload session 与任务目录不一致(实测 fork 即如此),但 cwd 的项目 slug 命中
// 且 fd 被活进程持有 → 注入。
assert.strictEqual(
  gate.hasTrailingBgAck('正文……\nBG-SHELL-OK: taskA — 仍需要:等回调。', 'parent-session-id', '/x/proj'),
  true,
  'fork 场景:session miss 但同项目 + 活写入者 → 注入'
);
// **翻转对照(active→completed)**:释放 fd 后,同一输入必须由 true 翻 false——
// 这是"对应物观测的是仍在飞,不是曾 spawn 过"的判别性证明。
for (const id of Object.keys(heldFds)) fs.closeSync(heldFds[id]);
assert.strictEqual(
  gate.hasTrailingBgAck('交付正文……\nBG-SHELL-OK: taskA — 仍需要:等完成回调。', 'sess'),
  false,
  'fd 释放(任务完成)后同一输入必须翻 false——产物仍在盘上,但活写入者没了'
);
assert.strictEqual(
  gate.hasTrailingInFlight('交付正文……\nIN-FLIGHT: taskA — 等完成回调', 'sess'),
  false,
  'fd 释放后 IN-FLIGHT 同样翻 false——不能靠陈尸产物获豁免'
);
assert.strictEqual(
  gate.hasTrailingBgAck('正文……\nBG-SHELL-OK: taskA — 仍需要:等回调。', 'parent-session-id', '/x/proj'),
  false,
  '同项目 fallback 同样受活写入者约束,fd 释放后翻 false'
);


// —— 来源优先级：payload 存在时必须压过 transcript ————————————————————
// 两个方向都断言，单向断言会被"总是读 transcript"或"总是读 payload"其中之一蒙混。

assert.strictEqual(
  run({ last_assistant_message: UNCLOSED, transcript_path: transcriptWith('benign', BENIGN) },
      noJudgeEnv),
  2,
  'payload 里的未闭合调用应被拦下——若读了 transcript 的正常交付物会误放行'
);

assert.strictEqual(
  run({ last_assistant_message: BENIGN, transcript_path: transcriptWith('unclosed', UNCLOSED) },
      noJudgeEnv),
  0,
  'payload 里的正常交付物应放行（判官不可用 → fail-open）——若读了 transcript 的未闭合调用会误拦'
);

// —— 自签逃生口已删除 ——————————————————————————————————————————————
// 2026-08-17：`STOP-GATE-OK` 曾无条件放行，且排在所有检查最前面。实测后果是本闸在一个 session
// 里开火两次（诊断都准确）后，agent 从提醒文本里学到口令，第三次停止贴上它就完全没被判过。
// 下面两条钉住"口令不再是旁路"：带口令的未闭合调用仍被确定性分支拦下（此前会放行），
// 带口令的普通交付物只因判官不可用而放行、而不是因为那个口令。
assert.strictEqual(
  run({ last_assistant_message: UNCLOSED + '\n\n' + RETIRED_TOKEN }, noJudgeEnv),
  2,
  '带已退役口令的未闭合调用应仍被拦——口令若仍是旁路，这条会变绿'
);

// —— 并发 subagent 不得互相顶掉逃生状态 ————————————————————————————————
// 删掉自签口令后，`stop_hook_active` 是唯一出路，所以它必须按 **agent** 而不只是按 session 隔离。
// 复刻 2026-08-17 生产日志里的真实时序（`judge-gate.jsonl` 408/409/415）：
//   A 被本闸 flag → sibling B 在同一 session 写下 ok → A 原样再停。
// 修好之前 A 读到的是 B 的 ok，`prev === "flag"` 不成立、逃生口失效；那次 A 是靠口令出来的，
// 而口令已经没了。这条断言就是那条出路的守卫。
{
  const logPath = path.join(tmp, 'sibling-interleave.jsonl');
  const SID = 'concurrent-subagents';
  const A = 'agent-A', B = 'agent-B';
  fs.writeFileSync(logPath,
    JSON.stringify({ gate: 'stop-gate', session_id: SID, agent_id: A, verdict: 'flag' }) + '\n' +
    JSON.stringify({ gate: 'stop-gate', session_id: SID, agent_id: B, verdict: 'ok' }) + '\n');
  const env = { ...noJudgeEnv, CLAUDE_JUDGE_LOG_PATH: logPath };
  assert.strictEqual(
    run({ last_assistant_message: UNCLOSED, session_id: SID, agent_id: A,
          stop_hook_active: true }, env),
    0,
    'A 被 flag 后原样再停应放行——sibling B 的 ok 不得顶掉 A 的逃生状态'
  );
  // 反向：B 自己没被本闸拦过，它的重停不该白拿 A 的 flag 当免死金牌。
  assert.strictEqual(
    run({ last_assistant_message: UNCLOSED, session_id: SID, agent_id: B,
          stop_hook_active: true }, env),
    2,
    'B 没被本闸拦过，不应因为 sibling A 挨过 flag 就被放行'
  );
}

// 主 agent 的"无 agent_id"是一个**真实的键**，不是"没传就不筛"。
// 上面 A/B 两条都用非空 agent_id，所以它们在"有 agentId 才筛"的错误实现下**仍然全绿**——
// 那种实现会让 subagent 的记录重新污染主 agent 的逃生状态。这条专钉这个回退方向（复核轮提出）。
{
  const logPath = path.join(tmp, 'main-vs-subagent.jsonl');
  const SID = 'main-plus-subagent';
  fs.writeFileSync(logPath,
    JSON.stringify({ gate: 'stop-gate', session_id: SID, verdict: 'flag' }) + '\n' +
    JSON.stringify({ gate: 'stop-gate', session_id: SID, agent_id: 'sub-1', verdict: 'ok' }) + '\n');
  assert.strictEqual(
    run({ last_assistant_message: UNCLOSED, session_id: SID, stop_hook_active: true },
        { ...noJudgeEnv, CLAUDE_JUDGE_LOG_PATH: logPath }),
    0,
    '主 agent 被 flag 后原样再停应放行——subagent 的 ok 不得顶掉主 agent 的逃生状态'
  );
}

// 第二条钉的是**裁决记录**而非退出码。退出码在这里没有区分力：判官被停用后本闸 fail-open，
// 带不带口令都放行。有区分力的是它**为什么**放行——旧行为在日志里落 `skipped` + reason 含
// 「逃生口」，新行为不该再出现这条。（sibling 闸的控制流测试也是靠改断 verdict 才有区分力的。）
{
  const logPath = path.join(tmp, 'retired-token.jsonl');
  run({ last_assistant_message: BENIGN + '\n\n' + RETIRED_TOKEN },
      { ...noJudgeEnv, CLAUDE_JUDGE_LOG_PATH: logPath });
  const records = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  // 正向断言，不是"没出现某个字符串"：空日志、或换个名字的等价旁路（`return allow()`、
  // 或 reason 不含「逃生口」的 skip）都能通过纯否定断言，而那正是本条要挡的下一次回退。
  // 唯一能证明"它确实走到了判官"的读数是判官那一侧留下的 verdict。
  assert.ok(
    records.some((r) => r.verdict === 'judge_unavailable'),
    `带口令的消息必须一路走到判官（判官被停用故落 judge_unavailable），实得 ${
      JSON.stringify(records.map((r) => [r.verdict, r.reason]))}`
  );
  assert.ok(
    !records.some((r) => String(r.reason || '').includes('逃生口')),
    `已退役的口令不应再落「逃生口」裁决，实得 ${JSON.stringify(records.map((r) => r.reason))}`
  );
}

// —— 回落：payload 不可用时才读 transcript ————————————————————————
// 字段是 optional（Claude Code 2.1.220：producer trim 后为空即 undefined；被中断的
// SubagentStop 不带 messages），所以回落是常规路径而非异常路径。

for (const [name, payloadField] of [
  ['absent', undefined],
  ['empty', ''],
  ['blank', '   \n  '],
  ['non-string', 42],
]) {
  const payload = { transcript_path: transcriptWith(`fb-${name}`, UNCLOSED) };
  if (payloadField !== undefined) payload.last_assistant_message = payloadField;
  assert.strictEqual(run(payload), 2, `payload 字段为 ${name} 时应回落到 transcript 并命中 HARNESS-021`);
}

// —— fail-open：两个来源都拿不到 ————————————————————————————————
assert.strictEqual(run({}), 0, '无 payload 字段且无 transcript_path 应放行');
assert.strictEqual(
  run({ transcript_path: path.join(tmp, 'does-not-exist.jsonl') }),
  0,
  'transcript 读不到应放行，不应抛出'
);

// —— H-006：声明"不需要回应"即收尾 ————————————————————————————————
// 这一族必须在 callJudge 之前短路，理由不是省一次网络往返：判官有约 4.4% 的停止
// 拿不到（实测 77/1759），那时全部 gate fail-open —— 判据所需上下文不在判官手上时，
// 要么确定性地判，要么等于没判。

for (const [name, text] of [
  ['en-requested', 'No response requested.'],
  ['en-needed', 'No response needed.'],
  ['en-parens', '(no response)'],
  ['zh-plain', '无需回应'],
  ['zh-nothing', '不需要做任何事'],
]) {
  assert.strictEqual(
    run({ last_assistant_message: text }), 2,
    `整条消息为「${name}」这类声明时应被拦下`
  );
}

// 反向：引用该短语的实质回复必须放行。**这条是回归锚**——把模式改回不锚定整句，
// 它当场变红；而只有上面那五条正例时，那种放宽会全绿通过。
assert.strictEqual(
  run({ last_assistant_message: QUOTES_PHRASE }), 0,
  '实质回复里引用该短语不应被拦——子串匹配会在这里变红'
);

// 2026-08-17 前这里断言的是"带逃生口时本分支应放行"。逃生口已删除，该断言连同它保护的行为
// 一起翻面——现在的等价断言在上面「自签逃生口已删除」那一节，用 noJudgeEnv 跑，不依赖网络。

// —— stop_hook_active：按**本闸自己**上一条 verdict 判，不再无条件放行 ————————
// 无条件放行时，「上一停被别的闸拦下 → 重发 → 本闸从未判过这段新文本」整条路径不可见。
// 三组断言分别钉住逃生口、别的闸拦下后照常判、以及历史不可考时的保守跳过。
{
  const seedLog = (verdict) => {
    const lp = path.join(tmp, `seed-${verdict}-${Math.abs(Number(process.hrtime.bigint() % 100000n))}.jsonl`);
    if (verdict) fs.writeFileSync(lp, JSON.stringify({ ts: new Date(0).toISOString(), gate: 'stop-gate', verdict, session_id: 'S1' }) + '\n');
    return lp;
  };
  const runWithLog = (payload, logPath) => {
    const r = spawnSync(process.execPath, [hook], {
      input: JSON.stringify(payload), encoding: 'utf8',
      env: { ...cleanEnv, CLAUDE_JUDGE_LOG_PATH: logPath }, timeout: 15000,
    });
    assert.notStrictEqual(r.status, null, `hook 未正常退出: ${r.stderr}`);
    return r.status;
  };
  // hermetic：必须钉 cwd。不传时生产代码回落 process.cwd()（= 本仓 hooks 目录），而本仓
  // CLAUDE.md 自己就是一份谈 agent 提交政策的文档、会被兜底抑制，于是这三条读数变成在测本仓
  // 的文档内容而不是逃生口逻辑。就地建一个无提交政策的空仓，与其余用例同一纪律。
  const hermeticRepo = fs.mkdtempSync(path.join(tmp, 'hermetic-'));
  spawnSync('git', ['init', '-q'], { cwd: hermeticRepo, encoding: 'utf8' });
  const ask = { stop_hook_active: true, session_id: 'S1', cwd: hermeticRepo, last_assistant_message: '改动完成。要我提交吗？' };

  assert.strictEqual(runWithLog(ask, seedLog('flag')), 0,
    'A 本闸上一停判 flag → 逃生口，原样再停即放行');
  assert.strictEqual(runWithLog(ask, seedLog('ok')), 2,
    'B 本闸上一停判 ok（说明拦下本停的是别的闸）→ 照常判，commit 请示仍要拦');
  assert.strictEqual(runWithLog(ask, seedLog(null)), 0,
    'C 本闸无历史记录 → 保守跳过（不可考时不拦）');
}

// —— commit 决定挂回用户 ————————————————————————————————————————
// user-scope CLAUDE.md 默认本地 commit 属 agent 自己的权限，但 project-scope 指令可以覆盖。
// 模式命中且项目规则前提可核实时，该分支硬拦且不经判官；前提无法核实时 fail-open。所以**误报守卫比漏报守卫更要紧**——下面 6 条 ok 全部来自
// 外部评审举出的真实误报形态。只测两条 flag 不够：把三道排除（剥引述 / 否定 / 非本地 commit）
// 删掉后，flag 那几条照样通过，测试与没测同形。

function repoWithInstructions(name, instructions) {
  const repo = path.join(tmp, name);
  fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8' });
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), instructions);
  return repo;
}

const projectOverrideRepo = repoWithInstructions(
  'project-override',
  [
    '# Project instructions',
    '',
    '## Commit policy (MANDATORY)',
    '',
    '**Never `git commit` on your own initiative.** Only commit when the user has explicitly confirmed the problem is fully solved.',
    '',
  ].join('\n')
);
const userDefaultRepo = repoWithInstructions(
  'user-default',
  '# Project instructions\n\nThis project has no project-specific commit policy.\n'
);
const userDefaultNestedCwd = path.join(userDefaultRepo, 'nested', 'work');
fs.mkdirSync(userDefaultNestedCwd, { recursive: true });
const agentsOverrideRepo = repoWithInstructions(
  'agents-override',
  '# Project instructions\n\nThis project has no project-specific commit policy.\n'
);
fs.writeFileSync(
  path.join(agentsOverrideRepo, 'AGENTS.md'),
  '# Agent instructions\n\nOnly commit after the user has explicitly confirmed the result.\n'
);
// finding 7 的覆盖：读取面与措辞集各自都要有能变红的守卫，否则删掉其中任一分支仍全绿。
// **准确说法**（初稿这里写成"每条只依赖一个读取面或一种措辞"，2026-08-13 复核指出不实）：
// 前两条各自同时依赖一个新载体**和**一条新措辞正则，所以它们变红只证明"这两者至少有一个缺了"，
// 单独定位要靠下面逐条的变异对照；后两条（中文措辞、中间层）才是单因子。
const localMdOnlyRepo = repoWithInstructions(
  'local-md-only',
  '# Project instructions\n\nThis project has no project-specific commit policy.\n'
);
fs.writeFileSync(
  path.join(localMdOnlyRepo, 'CLAUDE.local.md'),
  '# Local overrides\n\nAsk the user before committing.\n'
);
const overrideMdOnlyRepo = repoWithInstructions(
  'agents-override-md-only',
  '# Project instructions\n\nThis project has no project-specific commit policy.\n'
);
fs.writeFileSync(
  path.join(overrideMdOnlyRepo, 'AGENTS.override.md'),
  '# Override\n\nDo not commit automatically.\n'
);
const zhPhrasingRepo = repoWithInstructions(
  'zh-phrasing',
  '# 项目说明\n\n提交前须经用户明确确认。\n'
);
// 指令不在仓库根、而在 cwd 与 root 之间的某一级——真实的指令扫描是逐级上溯的。
const intermediateLevelRepo = repoWithInstructions(
  'intermediate-level',
  '# Project instructions\n\nThis project has no project-specific commit policy.\n'
);
const intermediateCwd = path.join(intermediateLevelRepo, 'sub', 'deep');
fs.mkdirSync(intermediateCwd, { recursive: true });
fs.writeFileSync(
  path.join(intermediateLevelRepo, 'sub', 'CLAUDE.md'),
  '# Subtree instructions\n\nNever `git commit` on your own initiative.\n'
);
// 三条**取消要求**样本：字面含要求词、语义却是取消它。它们被读成禁令而抑制检查，是**接受的
// 过度抑制**（代价＝少提醒一次），不是待修 bug。曾加过反否定守卫来放行它们，结果 
// `Never commit without asking the user.` 因含 `without asking` 被守卫抹成"非禁令"——用一个
// 安全侧失效换来了不安全侧失效，守卫已整体撤除。这三条断言现在钉住的是那个撤除决定：
// 谁再把守卫加回来，它们就会变红。
const cancelledRequirementRepos = [
  ['en-need-not-ask', 'You do not need to ask the user before committing.'],
  ['en-adjective-automatically', 'Do not commit automatically generated files.'],
  ['zh-cancelled', '提交前的检查无需用户确认。'],
].map(([name, body]) => [name, repoWithInstructions(name, `# Project instructions\n\n${body}\n`)]);
// 三条英文 alternation 各自单独成立（复核指出它们此前无任何断言覆盖）。
const alternationRepos = [
  ['autonomously', 'Do not commit autonomously.'],
  ['by-yourself', "Don't commit by yourself."],
  ['unprompted', 'Never commit unprompted.'],
].map(([name, body]) => [name, repoWithInstructions(`alt-${name}`, `# Project instructions\n\n${body}\n`)]);
// 撤除反否定守卫的**回归锚**。这四条都在同一句/同一段里既有真禁令、又有一个会被误读成
// "取消要求"的词；守卫在时它们会被抹成非禁令 → 检查开火 → 推着 agent 违反项目规则（不安全侧）。
const guardRegressionRepos = [
  ['without-asking', 'Never commit without asking the user.'],
  ['cancel-then-require', 'You do not need to ask the user before committing.  Ask the user before committing.'],
  ['semicolon-bleed', 'Do not commit automatically; no need to update the changelog.'],
  ['zh-semicolon-bleed', '无需为文档更新询问用户；提交前须经用户明确确认。'],
].map(([name, body]) => [name, repoWithInstructions(`guard-${name}`, `# Project instructions\n\n${body}\n`)]);
// symlink 别名 cwd：上溯必须限制在 git 返回的真实 root 之内，否则仓**外**祖先里的指令文件
// 也会抑制这道检查。这里造一个指向仓内子目录的 symlink，其词法祖先链根本不经过真实 root。
const outsideAncestor = path.join(tmp, 'outside-ancestor');
fs.mkdirSync(path.join(outsideAncestor, 'link-parent'), { recursive: true });
fs.writeFileSync(
  path.join(outsideAncestor, 'CLAUDE.md'),
  '# Outside the repo\n\nNever `git commit` on your own initiative.\n'
);
const symlinkedRepo = repoWithInstructions(
  'symlinked-target',
  '# Project instructions\n\nThis project has no project-specific commit policy.\n'
);
fs.mkdirSync(path.join(symlinkedRepo, 'sub'), { recursive: true });
let symlinkedCwd = null;
try {
  symlinkedCwd = path.join(outsideAncestor, 'link-parent', 'into-repo');
  fs.symlinkSync(path.join(symlinkedRepo, 'sub'), symlinkedCwd, 'dir');
} catch { symlinkedCwd = null; }
// 第四轮复核举出的四条真实禁令措辞，此前一条都不命中（→ 会在禁止自主提交的仓里照常开火）。
const round4PhrasingRepos = [
  ['unless-requested', 'Do not create commits unless explicitly requested by the user.'],
  ['obtain-confirmation', 'Obtain confirmation from the user prior to committing.'],
  ['only-when-requested', 'Only commit when explicitly requested.'],
  ['seek-approval', 'Agents must seek maintainer approval before committing.'],
].map(([n, body]) => [n, repoWithInstructions(`r4-${n}`, `# Project instructions\n\n${body}\n`)]);
// symlink 的**反向**失效：禁令位于真实目标路径的中间层。上溯若不先 realpath，界限判定会在
// 词法 symlink 路径上首次即失败 → 只扫 root → 漏掉该禁令 → 错误开火（不安全侧）。
// 既有那条 symlink 断言只覆盖"仓外禁令不得介入"，抓不到这一半。
const symlinkMidRepo = repoWithInstructions(
  'symlink-mid',
  '# Project instructions\n\nThis project has no project-specific commit policy.\n'
);
fs.mkdirSync(path.join(symlinkMidRepo, 'mid', 'leaf'), { recursive: true });
fs.writeFileSync(
  path.join(symlinkMidRepo, 'mid', 'CLAUDE.md'),
  '# Subtree\n\nNever `git commit` on your own initiative.\n'
);
let symlinkMidCwd = null;
try {
  symlinkMidCwd = path.join(tmp, 'alias-into-mid');
  fs.symlinkSync(path.join(symlinkMidRepo, 'mid', 'leaf'), symlinkMidCwd, 'dir');
} catch { symlinkMidCwd = null; }
// 近似命中兜底：同一小窗口里既有 commit 又有许可/批准/sign-off，却没被任何完整模式接住时，
// 按"这里大概率有一条我没读懂的提交政策"保守抑制。它**缩小**而非消除残余风险——见下面第二组。
const nearMissRepo = repoWithInstructions(
  'near-miss',
  '# Project instructions\n\nCommitting requires maintainer sign-off.\n'
);
// 与 git commit 无关的"提交/批准"共现（中文里"提交"常指 submit）**会**被兜底抑制。
// 这是 2026-08-13 用户裁决接受的代价：实测原来的窄窗口对 8 条全新禁令写法只命中 1 条，
// 放宽后 8/8，代价就是这类共现。两侧不对称——少提醒一次 vs 推着 agent 违反项目规则。
// 这条断言现在钉住的是**那个裁决**：谁把窗口收窄回去，它会变红。
const submitNotCommitRepo = repoWithInstructions(
  'submit-not-commit',
  '# 项目说明\n\n不要用该模式的审批出口提交一份过渡稿——那类出口的语义是批准即开工。\n'
);
const commitMessageOnlyRepo = repoWithInstructions(
  'commit-message-only',
  '# Conventions\n\nWrite clear commit messages. Use conventional commits.\n'
);
// **通用性回归集**：这 8 条是 2026-08-13 专门挑的、开发调参时一条都没用过的写法。
// 用它们测当时的实现只命中 1/8——说明模式集实质是照开发样本拟合的，"对任意项目有效"当时不成立。
// 放宽兜底 + 补一条纯禁令模式后 8/8。留在这里是因为覆盖面会静默退化：任何收窄都该在这里变红。
const generalityRepos = [
  ['ask-me-first', 'Always ask me first before you commit anything.'],
  ['made-by-humans', 'Commits are made by humans in this repo.'],
  ['must-not-create', 'The agent must not create git commits.'],
  ['go-ahead', 'No commits without my go-ahead.'],
  ['leave-uncommitted', 'Leave changes uncommitted; I will review and commit them.'],
  ['zh-maintainer', '本项目由维护者统一提交，agent 不要自行 git commit。'],
  ['zh-wait-review', '改完先别提交，等我看过再说。'],
  ['zh-heading', '## Git workflow\n\n提交由人工完成。'],
].map(([n, body]) => [n, repoWithInstructions(`gen-${n}`, `# Project instructions\n\n${body}\n`)]);
// 反向：放宽不等于"见 commit 就抑制"。这三条必须仍开火，否则这道检查等于被关掉。
const stillFiresRepos = [
  ['style-only', '# Style guide\n\nTwo-space indent. Prefer const.'],
  ['commit-msg-convention', 'Write clear commit messages. Use conventional commits.'],
  ['explicitly-free', 'Commit freely; we squash on merge.'],
].map(([n, body]) => [n, repoWithInstructions(`fire-${n}`, `# Project instructions\n\n${body}\n`)]);
const missingInstructionsRepo = path.join(tmp, 'missing-instructions');
fs.mkdirSync(missingInstructionsRepo);
spawnSync('git', ['init', '-q'], { cwd: missingInstructionsRepo, encoding: 'utf8' });
const oversizedInstructionsRepo = repoWithInstructions(
  'oversized-instructions',
  'x'.repeat(256 * 1024 + 1)
);
// 项目指令不只落在仓库根的 CLAUDE.md。这个仓的禁令**只**放在 `.claude/CLAUDE.md`——
// 若读取面漏掉该位置，检查就会开火，本条即变红。它是「缺席=确证没有覆盖」那条的成对守卫：
// 没有它，读取面查得不全也照样全绿，而"查得不全"正是把未知说成已知的那个失效方向。
const nestedOnlyOverrideRepo = path.join(tmp, 'nested-only-override');
fs.mkdirSync(path.join(nestedOnlyOverrideRepo, '.claude'), { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: nestedOnlyOverrideRepo, encoding: 'utf8' });
fs.writeFileSync(
  path.join(nestedOnlyOverrideRepo, '.claude', 'CLAUDE.md'),
  '## Commit policy (MANDATORY)\n\n**Never `git commit` on your own initiative.**\n'
);
// noJudgeEnv 已上移到文件头部（来源优先级那两条断言也要用它）。

// —— 2026-08-13 对抗评审引入的三道守卫 ————————————————————————————————
// 这三条守的都是**把项目文本发给外部判官**这条新路径的前置条件，正则版没有它们。
{
  // ① symlink 逃逸：目标必须解析后仍在仓内。lstat 只确认目录项存在，readFile 会跟随 symlink，
  //    于是一个恶意仓库能让任意可读文件的内容随 prompt 外传（canary 实测确认过）。
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET-CANARY-must-not-leave\n');
  const escapeRepo = path.join(tmp, 'symlink-escape');
  fs.mkdirSync(escapeRepo);
  spawnSync('git', ['init', '-q'], { cwd: escapeRepo, encoding: 'utf8' });
  let escapeMade = true;
  try {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(escapeRepo, 'CLAUDE.md'));
  } catch { escapeMade = false; }
  if (escapeMade) {
    const got = gate.collectProjectInstructions(escapeRepo);
    assert.ok(!got.text.includes('SECRET-CANARY'), '指向仓外的指令 symlink 内容不得被收集（会随 prompt 外传）');
    assert.ok(!got.verifiable, '仓外 symlink → 无法核实');
  }
  // 阴性对照：**仓内**的 symlink 是合法用法，必须仍读得到——否则上一条会退化成"禁用 symlink"。
  const innerRepo = path.join(tmp, 'symlink-inner');
  fs.mkdirSync(path.join(innerRepo, 'real'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: innerRepo, encoding: 'utf8' });
  fs.writeFileSync(path.join(innerRepo, 'real', 'policy.md'), 'Ask the user before committing.\n');
  let innerMade = true;
  try {
    fs.symlinkSync(path.join(innerRepo, 'real', 'policy.md'), path.join(innerRepo, 'CLAUDE.md'));
  } catch { innerMade = false; }
  if (innerMade) {
    const got = gate.collectProjectInstructions(innerRepo);
    assert.ok(
      got.verifiable && got.text.includes('Ask the user before committing.'),
      '仓内 symlink 仍须读得到——逃逸守卫不得退化成禁用 symlink'
    );
  }
  // ③ dangling symlink：lstat 成功 ⇒ 目录项存在，此后 realpath 失败属"存在但读不了"。
  //    若当成"不存在"继续，一个悬空的 CLAUDE.md 会产生 verifiable:true/text:""，即"确证无覆盖"，
  //    提醒照常开火——而真相是那里有一个我们读不了的指令文件。
  const danglingRepo = path.join(tmp, 'dangling-symlink');
  fs.mkdirSync(danglingRepo);
  spawnSync('git', ['init', '-q'], { cwd: danglingRepo, encoding: 'utf8' });
  let dangMade = true;
  try {
    fs.symlinkSync(path.join(danglingRepo, 'no-such-target.md'), path.join(danglingRepo, 'CLAUDE.md'));
  } catch { dangMade = false; }
  if (dangMade) {
    const got = gate.collectProjectInstructions(danglingRepo);
    assert.ok(!got.verifiable, '悬空的指令 symlink 属"存在但读不了" → 必须报无法核实，不得当成不存在');
  }
  // ② 总量上限与分类器上限必须是同一个：否则会出现 collector 说"可核实"、分类器却判不动的
  //    静默带，而那一带里提醒无声消失。用一份刚好超过总量上限、但每个文件都不超单文件上限的
  //    fixture 钉住它——旧的 256 KiB 单文件 fixture 走不到这条分支。
  const bigRepo = path.join(tmp, 'aggregate-over-cap');
  fs.mkdirSync(bigRepo);
  spawnSync('git', ['init', '-q'], { cwd: bigRepo, encoding: 'utf8' });
  const chunk = 'x'.repeat(100 * 1024); // 每个都远小于 256 KiB 单文件上限
  fs.writeFileSync(path.join(bigRepo, 'CLAUDE.md'), chunk);
  fs.writeFileSync(path.join(bigRepo, 'AGENTS.md'), chunk);
  assert.ok(
    !gate.collectProjectInstructions(bigRepo).verifiable,
    '各文件都不超单文件上限、但合计超过总量上限 → 必须报无法核实，不得报可核实'
  );
}

// —— 项目指令的读取面：断言【收集到了什么文本】，不断言 exit code ————————————
// 分类已归判官（projectForbidsSelfCommit）。于是 exit code 在"读取面坏了"与"判官不可用"两种
// 情况下**完全相同**（都 fail-open 到不开火），拿它测读取面是零区分力——拆分前那批断言正是
// 这样变成空断言的。这里改断言纯函数 collectProjectInstructions 的产出，它不调判官。
// 措辞识别的质量（哪些写法算禁令）不再属于确定性套件，归 eval 侧实测。
for (const [name, cwd, needle] of [
  ['CLAUDE.local.md', localMdOnlyRepo, 'Ask the user before committing.'],
  ['AGENTS.override.md', overrideMdOnlyRepo, 'Do not commit automatically.'],
  ['AGENTS.md', agentsOverrideRepo, 'Only commit after the user has explicitly confirmed'],
  ['.claude/CLAUDE.md', nestedOnlyOverrideRepo, 'Never `git commit` on your own initiative.'],
  ['cwd 与 root 之间的中间层', intermediateCwd, 'Never `git commit` on your own initiative.'],
  ['symlink cwd 的真实中间层', symlinkMidCwd, 'Never `git commit` on your own initiative.'],
  ['仓库根 CLAUDE.md', projectOverrideRepo, 'Never `git commit` on your own initiative.'],
]) {
  if (!cwd) continue;
  const got = gate.collectProjectInstructions(cwd);
  assert.ok(got.verifiable, `读取面须可核实（${name}）`);
  assert.ok(got.text.includes(needle), `该载体的内容必须被读进来（${name}）`);
}
// 仓外祖先的指令不得被收进来。**这条守的是 `realpathSync`，不是 `within()`**——实测：把
// `within()` 换成无界循环，本条仍全绿，因为 realpath 已经把 symlink cwd 解到仓内、走不到界限。
// `within()` 是第二道，其活路径是 realpath 抛错那一支，当前 fixture 造不出来；标注在此以免
// 后人把这条读成 within() 的守卫（那正是空断言的形状）。
if (symlinkedCwd) {
  assert.ok(
    !gate.collectProjectInstructions(symlinkedCwd).text.includes('Outside the repo'),
    'symlink cwd 须先 realpath——仓外祖先的指令文件不得进入收集结果'
  );
}
// 三态各自可判：确证无 / 无法核实（超限）/ 无法核实（非 git 仓）。
{
  const none = gate.collectProjectInstructions(missingInstructionsRepo);
  assert.ok(none.verifiable && none.text === '', '一个指令文件都没有 = 可核实且文本为空');
  assert.ok(!gate.collectProjectInstructions(oversizedInstructionsRepo).verifiable, '超限 = 无法核实');
  assert.ok(!gate.collectProjectInstructions('/tmp').verifiable, '非 git 仓 = 无法核实');
}
// exit code 只剩判官无关的那两格：确证没有项目覆盖 → 照常开火；非 git 仓 → 不开火。
assert.strictEqual(
  run({ cwd: missingInstructionsRepo, last_assistant_message: '改动做完了，要我提交吗？' }, noJudgeEnv),
  2,
  '确证没有任何项目指令文件 → 检查照常开火（这一格不经判官）'
);
assert.strictEqual(
  run({ cwd: '/tmp', last_assistant_message: '改动做完了，要我提交吗？' }, noJudgeEnv),
  0,
  '非 git 仓无法核实 → 不开火'
);

for (const [name, msg] of [
  ['问句形', '改动落在工作树、未提交。要我把它也提交吗？'],
  ['待令形', '改动都还没提交。要我走 create-commit 落成 commit 就说一声。'],
  ['英文', 'Changes are done and verified. Should I commit them?'],
  // 下面四条来自 2026-08-10 外部评审的第二轮反例。前两条钉住「排除器必须按小句、不能按整条消息」——
  // 整条消息级排除时，任意位置出现 push 或一个否定词就会让后面真正的请示整条失效。
  ['同句含 push 否定', '我不会 push；本地改动已完成，要我提交吗？'],
  ['前句含否定', '改动还没有 commit。要我提交吗？'],
  // 后两条钉住「不许剥行内反引号与引号」——剥了会把请示句里的动词本身删掉。
  ['动词在反引号内', '要我现在走 `create-commit` 吗？'],
  ['动词在引号内', '要我把它落成「本地 commit」吗？'],
  // 逗号把 cue 与动词隔开的常见语序；模式的间隔窗口若禁逗号会漏。
  ['逗号隔开', '改动与验证均完成。我现在落一条本地提交，可以吗？'],
  ['条件式待令', '改动完成；如果你没意见，我就 commit。'],
  // 请示后带一句补充仍要拦——判别面取收尾 3 小句而非 1 句，正是为了它。
  ['请示后带补充', '改动都还没提交（两个仓共 7 个文件）。要我走 create-commit 落成 commit 就说一声——两个仓分开提。'],
]) {
  // hermetic：必须钉住 cwd 与 noJudgeEnv。不传 cwd 时生产代码回落 process.cwd()，这些用例的读数
  // 就取决于测试从哪个仓启动——从一个自身禁止自主 commit（或指令文件超限）的仓里跑，期望 2 的用例
  // 会静默变成 0；不传 noJudgeEnv 则真判官可能介入，把确定性分支的读数搅成判官的意见。
  // 用**无任何指令文件**的仓：这两个循环测的是消息侧检测（判官无关）。用带 CLAUDE.md 的
  // fixture 会让整条走文档分类的 fail-open，读数与消息侧对错无关，即零区分力。
  assert.strictEqual(
    run({ cwd: missingInstructionsRepo, last_assistant_message: msg }, noJudgeEnv),
    2,
    `commit 决定挂回用户应被拦（${name}）`
  );
}

for (const [name, msg] of [
  ['引述标记内', '反例是：「要我提交吗？」——这句在评审里被讨论过。'],
  ['ASCII 引号引述', '反例是："要我提交吗？" 用的是 ASCII 引号。'],
  ['代码围栏内', '模式示例：\n```\n要我提交吗\n```\n以上是测试用例，不是我在问。'],
  ['否定形', '不需要我提交，改动按要求留在工作树。'],
  ['非 Git 的提交', '分析写完了。需要我提交这份报告吗？'],
  ['对象是 push', '本地 commit 已完成，要不要我提交到远端并 push？'],
  ['纯状态陈述', '已修正措辞。改动已落地，未 commit。'],
  // **本闸上线后拦下的第一条真实误报**（2026-08-10）：一份讲这条判据本身的交付报告，中段两处引文各命中一次，
  // 而收尾并没有在问任何人。修法是把判别面收窄到收尾 3 小句——复述总在行文中间，真请示总在收尾。
  ['中段复述、收尾未问',
   '修了两个误报：一是「要我提交吗」这类引文被硬拦，二是 ``要我走 `create-commit` 吗`` 里的动词被剥掉。\n' +
   '两套 eval 各 17/17，控制流测试通过，已提交 f0ed7e4。'],
]) {
  assert.strictEqual(
    run({ cwd: missingInstructionsRepo, last_assistant_message: msg }, noJudgeEnv),
    0,
    `不该被 commit 分支拦（${name}）`
  );
}


console.log('stop-gate.test.js: ok');

} finally {
  // finally 而非顺序执行：断言失败也要清掉临时目录，否则失败路径每跑一次泄漏一个。
  fs.rmSync(tmp, { recursive: true, force: true });
}
