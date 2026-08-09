#!/usr/bin/env node

'use strict';

// reverse-assertion-gate 的【判官之前的确定性分支】回归测试。
//
// 零网络、零模型：下面每条断言覆盖的分支都在 callJudge 之前短路。判官的判定质量归
// hooks/eval/reverse-assertion-gate/（场景 + LLM），不在这里测。
//
// 存在的理由（2026-08-08 复核轮点名）：本 gate 的一个 HIGH 修复是**删掉转录回落**——
// 内联字段缺席时不再读转录尾窗，因为那时尾窗里最后一条非空 assistant 消息是**上一条**，
// 拿它阻断这一回合是纯错误。但 eval runner 的每一次调用都固定传 `last_assistant_message`，
// 所以谁把回落加回来，那 18 个场景照样全绿。本文件就是让那种回退当场变红的东西。
//
// **断言 verdict 而不只是 exit code**：回落若被加回来、判官恰好判 ok，退出码同样是 0。
// 只断言 exit 0 的测试在"回落已删"与"回落又回来"两种情况下输出相同——那正是本 gate 自己
// 拦的那类无区分力读数。故经 CLAUDE_JUDGE_LOG_PATH 把裁决引到临时文件，断言它是 `skipped`。
// 附带效果：正确实现下本测试不发任何网络请求，只有被改坏的实现才会去调判官。
//
// 已知未覆盖：judge 应答的**整串单行匹配**（另一个 HIGH 修复）。它是 judge() 内的局部逻辑，
// 要测就得把解析拆出来 export，而那需要给文件加 `require.main === module` 守卫、改变现有
// spawn-only 的测试约定（sibling 全部如此）。当前替代保障是：实测判官应答恒为单行
// （见 eval/README「怎么证明这套 eval 有效」），以及协议外输出一律 fail-open、不会误拦。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const hook = path.join(__dirname, 'reverse-assertion-gate.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reverse-assertion-test-'));

// 一段确定会被判 flag 的反向断言（eval 的 ssh-authz 场景同源）。放进 transcript 里，
// 用来证明"即使尾窗里躺着一条该拦的消息，没有内联字段时也不去读它"。
const FLAGGABLE =
  'gpu-box 的 SSH key 没被 GitHub 授权。跑 `ssh -T git@github.com` 回的是 ' +
  'Permission denied (publickey)。你去 Settings 里加一把 key，加完我接着部署。';

/** 写一份最小 transcript，其最后一条 assistant 文本为 `text`。 */
function transcriptWith(name, text) {
  const p = path.join(tmp, `t-${name}.jsonl`);
  fs.writeFileSync(
    p,
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n'
  );
  return p;
}

// 显式清掉判官的递归护栏：hook 见到它会直接 skip，于是所有断言都会以"正确的理由"通过，
// 测试形同虚设。父进程带着它跑测试是合法的（嵌套判官调用里就带），不能靠"通常没人设"免疫。
const { NEST_GUARD } = require('./lib/llm-judge');
const cleanEnv = { ...process.env };
delete cleanEnv[NEST_GUARD];

let logSeq = 0;

/** 跑一次 hook，返回 { status, verdict }。verdict 取自本次调用独占的裁决日志。 */
function run(payload, extraEnv) {
  const logPath = path.join(tmp, `verdicts-${logSeq++}.jsonl`);
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...cleanEnv, ...extraEnv, CLAUDE_JUDGE_LOG_PATH: logPath },
    timeout: 20000,
  });
  assert.notStrictEqual(r.status, null, `hook 未正常退出: ${r.stderr}`);
  let verdict = null;
  try {
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length) verdict = JSON.parse(lines[lines.length - 1]).verdict;
  } catch {
    /* 没写成日志 → verdict 保持 null，断言会报出来 */
  }
  return { status: r.status, verdict };
}

try {

// —— 核心：没有内联消息时**不读转录** ————————————————————————————
// transcript 里放的是一条必被 flag 的消息。若回落被加回来，verdict 会变成 flag（或 ok /
// judge_unavailable），三者都 ≠ skipped，本条当场变红。

for (const [name, field] of [
  ['absent', undefined],
  ['empty', ''],
  ['blank', '   \n  '],
  ['non-string', 42],
]) {
  const payload = { hook_event_name: 'Stop', transcript_path: transcriptWith(`fb-${name}`, FLAGGABLE) };
  if (field !== undefined) payload.last_assistant_message = field;
  const { status, verdict } = run(payload);
  assert.strictEqual(
    verdict,
    'skipped',
    `内联字段为 ${name} 时必须 skip，实际 verdict=${verdict}——转录回落被重新引入了？`
  );
  assert.strictEqual(status, 0, `内联字段为 ${name} 时必须放行（fail-open）`);
}

// 连 transcript_path 都没有：同样 skip，且不得抛出。
{
  const { status, verdict } = run({ hook_event_name: 'Stop' });
  assert.strictEqual(verdict, 'skipped', '无内联消息且无 transcript_path 应记 skipped');
  assert.strictEqual(status, 0, '同上，必须放行');
}

// —— 防死循环：stop_hook_active 先于一切 ————————————————————————
// 它是"每停至多拦一次"的唯一载体；若被移到消息解析之后，误拦就会变成无限循环。
{
  const { status, verdict } = run({
    hook_event_name: 'Stop',
    stop_hook_active: true,
    last_assistant_message: FLAGGABLE,
  });
  assert.strictEqual(verdict, 'skipped', 'stop_hook_active 必须在调判官之前短路');
  assert.strictEqual(status, 0, 'stop_hook_active 必须放行');
}

// —— 防判官嵌套递归：NEST_GUARD ————————————————————————————————
// tier-3 判官（claude -p）跑完会触发它自己那个进程的 Stop hook；没有这道守卫就是无限递归。
{
  const { status, verdict } = run(
    { hook_event_name: 'Stop', last_assistant_message: FLAGGABLE },
    { [NEST_GUARD]: '1' }
  );
  assert.strictEqual(verdict, 'skipped', 'NEST_GUARD 在场时必须在调判官之前短路');
  assert.strictEqual(status, 0, 'NEST_GUARD 在场时必须放行');
}

// —— 畸形输入 fail-open ————————————————————————————————————————
// hook 由 harness 喂 stdin，协议变更或管道异常都可能给出非 JSON；此时绝不能困住会话。
{
  const logPath = path.join(tmp, 'verdicts-malformed.jsonl');
  const r = spawnSync(process.execPath, [hook], {
    input: 'not json at all',
    encoding: 'utf8',
    env: { ...cleanEnv, CLAUDE_JUDGE_LOG_PATH: logPath },
    timeout: 20000,
  });
  assert.strictEqual(r.status, 0, 'stdin 非 JSON 时必须放行');
}

console.log('reverse-assertion-gate.test.js: ok');

} finally {
  // finally 而非顺序执行：断言失败也要清掉临时目录，否则失败路径每跑一次泄漏一个。
  fs.rmSync(tmp, { recursive: true, force: true });
}
