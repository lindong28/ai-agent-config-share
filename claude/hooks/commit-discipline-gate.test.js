#!/usr/bin/env node

'use strict';

// commit-discipline-gate 的【轮窗口边界】回归测试。
//
// 只覆盖确定性分支：转录扫描如何切"本轮"。这里零网络、零模型、可重复。
//
// 存在的理由是一次实测失效：`Skill(create-commit)` 的 tool_use 在转录第 4243 行、
// commit 尝试在其后，中间第 4250 行是 skill 正文的注入消息（role:user、不含
// tool_result）。旧实现把它当轮边界，扫描停在那里，**永远看不到 4243 行的 skill
// 调用**——也就是说，调用 skill 这个动作本身制造了让检测必然失败的边界，这道闸
// 对它唯一要检的东西结构性失明。
//
// 下面每条断言都是为了让那种回退当场变红。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const hook = path.join(__dirname, 'commit-discipline-gate.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-gate-test-'));

const rec = (m) => JSON.stringify({ message: m }) + '\n';
const skillCall = rec({
  role: 'assistant',
  content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'create-commit' } }],
});
const toolResult = rec({ role: 'user', content: [{ type: 'tool_result', content: 'ok' }] });
const realUserTurn = rec({ role: 'user', content: '帮我提交一下' });
// 注入正文的两种真实前缀（首次加载 / 再次调用），都取自实测转录。
const injectFirst = rec({
  role: 'user',
  content: 'Base directory for this skill: /Users/x/.claude/skills/create-commit\n# Create Commit',
});
const injectAgain = rec({
  role: 'user',
  content: '(Re-invocation of /create-commit — the skill instructions were previously loaded)',
});

const assistantStep = () => rec({
  role: 'assistant',
  content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }],
});

function transcript(name, ...records) {
  const p = path.join(tmp, `t-${name}.jsonl`);
  fs.writeFileSync(p, records.join(''));
  return p;
}

/** 返回 hook 是否放行（true = 放行，false = 拦下）。 */
function allows(transcriptPath) {
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({
      transcript_path: transcriptPath,
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "chore(x): y"' },
      cwd: tmp,
    }),
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.notStrictEqual(r.status, null, `hook 未正常退出: ${r.stderr}`);
  const out = (r.stdout || '') + (r.stderr || '');
  return !/COMMIT-DISCIPLINE/.test(out);
}

try {

// —— 核心回归：skill 注入的 user 消息不得截断窗口 ————————————————————
// 顺序即实测顺序：真·用户轮 → Skill 调用 → 注入正文 → 工具往返 → commit。
for (const [name, inject] of [['first-load', injectFirst], ['re-invoke', injectAgain]]) {
  assert.strictEqual(
    allows(transcript(`inj-${name}`, realUserTurn, skillCall, inject, toolResult)),
    true,
    `skill 注入（${name}）被当成轮边界时，4243 行那样的 skill 调用就扫不到了`
  );
}

// —— 反向：隔得足够远的 skill 调用**必须**不再算数 ————————————————————
// 原判据是"真正的用户轮是边界"，已撤除：它与窗口步数挡的是同一件事（永久通行），
// 却在上线后连续两次拦住本该放行的提交——用户说话不等于 context 被清空。
// 这条守的意图没变（不能让 session 早期调一次就永久通行），换成不误伤的判据来守：
// 隔了超过窗口步数就不算。缺这条的话，把窗口改成无限大也会全绿。
{
  const far = [skillCall];
  for (let i = 0; i < 60; i++) far.push(assistantStep());   // > RECENT_WINDOW
  assert.strictEqual(
    allows(transcript('far', ...far)),
    false,
    '隔了超过窗口步数的 skill 调用不应再算数'
  );
}
// —— 基线：本轮没调过 skill 就该拦 ————————————————————————————————
assert.strictEqual(
  allows(transcript('none', realUserTurn, toolResult)),
  false,
  '本轮无 skill 调用应拦下'
);

console.log('commit-discipline-gate.test.js: ok');

} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
