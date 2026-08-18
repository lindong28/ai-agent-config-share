#!/usr/bin/env node
'use strict';
// commit-discipline-gate 的「本轮调过 create-commit 没有」这条判据。
//
// 两侧都必须覆盖：**没调过要拦**、**调过要放行**。只测前者的话，把判据改成"无条件拦"
// 也全绿——那是无区分力的读数，而误报会训练出"拦了就加环境变量绕过"，等于废掉这道闸。
//
// 还要覆盖第三态：**转录读不到 / 不完整时不判**。把"没证据"当成"没调用"会在转录轮转、
// 体积超限时误拦；这一态与"确实没调用"必须给出不同的返回值，否则判据在这两种情形下
// 输出相同，就不是证据。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const { evaluate, skillInvokedRecently, RECENT_WINDOW } = require('./commit-discipline-gate');

// —— 转录夹具 ——
// 真实转录是 JSONL，每行一条 {message:{role, content:[…]}}。tool_result 也以
// role:"user" 出现，这正是本判据最容易写错的地方（见 hasToolResult 的注释）。
const userMsg = (text) => JSON.stringify({ message: { role: 'user', content: text } });
const toolResult = () => JSON.stringify({
  message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
});
const skillCall = (name) => JSON.stringify({
  message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: { skill: name } }] },
});
const bashCall = () => JSON.stringify({
  message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
});

function fixture(lines) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cdg-')), 'transcript.jsonl');
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return p;
}

const payload = (transcriptPath) => JSON.stringify({
  tool_name: 'Bash',
  cwd: '/nonexistent-for-tests',
  transcript_path: transcriptPath,
  tool_input: { command: 'git commit -m "chore: x"' },
});

test('本轮调过 create-commit → true', () => {
  const p = fixture([userMsg('提交一下'), skillCall('create-commit'), bashCall()]);
  assert.strictEqual(skillInvokedRecently(p), true);
});

test('带命名空间前缀的 skill 名也认', () => {
  // 目录作用域的 skill 会以 `userSettings:create-commit` 一类的形态出现。
  const p = fixture([userMsg('提交'), skillCall('userSettings:create-commit')]);
  assert.strictEqual(skillInvokedRecently(p), true);
});

test('本轮没调过 → false', () => {
  const p = fixture([userMsg('提交一下'), bashCall()]);
  assert.strictEqual(skillInvokedRecently(p), false);
});

test('用户中途插话不切断窗口', () => {
  // 硬边界已撤除：它与窗口步数挡的是同一件事，却在上线后连续两次拦住本该放行的
  // 提交（agent 调 skill 后用户插话；用户敲 /create-commit 后又追加一句）。
  // 用户说话不等于 context 被清空——那是把"谁在说话"当成"指引还在不在"的代理。
  const p = fixture([
    userMsg('提交一下'), skillCall('create-commit'), bashCall(),
    userMsg('顺便问个别的'), bashCall(),
  ]);
  assert.strictEqual(skillInvokedRecently(p), true);
});

test('用户直接敲 /create-commit 也算（转录里没有 tool_use）', () => {
  // slash command 由用户发起，转录里只有两条注入形态的 user 消息、没有 Skill 的
  // tool_use。只认 tool_use 的话，指引明明在场却判"没调过"——上线当场撞到。
  for (const inject of [
    '<command-name>/create-commit</command-name>',
    'Base directory for this skill: /Users/x/.claude/skills/create-commit',
    '(Re-invocation of /create-commit — the skill instructions were previously loaded)',
  ]) {
    const p = fixture([userMsg('提交'), userMsg(inject), bashCall()]);
    assert.strictEqual(skillInvokedRecently(p), true, inject.slice(0, 46));
  }
});

test('skill 注入的伪 user 消息不算边界', () => {
  // 调用 Skill 后，skill 正文以 role:"user" 注入 context。把它当边界的话，
  // 它恰好盖住紧挨着的那次 Skill 调用——闸要找的东西被它自己触发的注入藏住。
  for (const inject of [
    'Base directory for this skill: /Users/x/.claude/skills/create-commit',
    '(Re-invocation of /create-commit — the skill instructions were previously loaded)',
  ]) {
    const p = fixture([
      userMsg('提交一下'), skillCall('create-commit'), userMsg(inject), bashCall(),
    ]);
    assert.strictEqual(skillInvokedRecently(p), true, `注入形态未识别: ${inject.slice(0, 40)}`);
  }
});

test('隔得足够远就不算（session 早期调一次不能永久通行）', () => {
  // 这是必须拦住的那一侧：按 session 判的话它会返回 true。
  const lines = [userMsg('开工'), skillCall('create-commit')];
  for (let i = 0; i < RECENT_WINDOW + 5; i++) lines.push(bashCall());
  assert.strictEqual(skillInvokedRecently(fixture(lines)), false);
});

test('窗口边界内仍算', () => {
  const lines = [userMsg('开工'), skillCall('create-commit')];
  for (let i = 0; i < RECENT_WINDOW - 3; i++) lines.push(bashCall());
  assert.strictEqual(skillInvokedRecently(fixture(lines)), true);
});

test('tool_result 不占窗口名额', () => {
  // tool_result 的 role 是 "user"，不该被算成 agent 的一步。
  // **夹具必须放足够多的 tool_result 才有区分力**：只放一条的话窗口远没耗尽，
  // 算不算它都返回 true —— 那种测试在变异下恒绿，是装饰不是判据（本条初版就是）。
  const lines = [userMsg('提交一下'), skillCall('create-commit')];
  for (let i = 0; i < RECENT_WINDOW + 10; i++) lines.push(toolResult());
  lines.push(bashCall());
  assert.strictEqual(skillInvokedRecently(fixture(lines)), true,
    'tool_result 被算进窗口的话，这里会因窗口耗尽而返回 false');
});

test('转录不存在 → null（不判，不是"没调用"）', () => {
  assert.strictEqual(skillInvokedRecently('/nonexistent/transcript.jsonl'), null);
});

test('转录含坏行 → null（窗口可能不完整，不判）', () => {
  const p = fixture([userMsg('提交'), '{ 这不是 JSON', bashCall()]);
  assert.strictEqual(skillInvokedRecently(p), null);
});

test('evaluate：没调过 skill 的 commit 被拦', () => {
  const p = fixture([userMsg('提交一下'), bashCall()]);
  const r = evaluate(payload(p));
  assert.strictEqual(r.exitCode, 2);
  assert.ok(/create-commit/.test(r.message), ' 拦截理由应点名 skill');
});

test('evaluate：调过 skill 的 commit 放行', () => {
  const p = fixture([userMsg('提交一下'), skillCall('create-commit')]);
  assert.notStrictEqual(evaluate(payload(p)).exitCode, 2);
});

test('evaluate：转录不可读时放行（不把"没证据"当"没调用"）', () => {
  const r = evaluate(payload('/nonexistent/t.jsonl'));
  assert.notStrictEqual(r.exitCode, 2);
});

test('evaluate：无 transcript_path 时放行', () => {
  const r = evaluate(JSON.stringify({
    tool_name: 'Bash', cwd: '/nonexistent-for-tests',
    tool_input: { command: 'git commit -m "chore: x"' },
  }));
  assert.notStrictEqual(r.exitCode, 2);
});

test('evaluate：逃生口的命令前缀形态也认（hook 读不到命令的 env）', () => {
  const p = fixture([userMsg('提交'), bashCall()]);
  const r = evaluate(JSON.stringify({
    tool_name: 'Bash', cwd: '/nonexistent-for-tests', transcript_path: p,
    tool_input: { command: "COMMIT_SKIP_SKILL_CHECK=1 git commit -m 'x'" },
  }));
  assert.notStrictEqual(r.exitCode, 2, '提示里教的就是这种写法，必须真的有效');
});

test('evaluate：声明式逃生口放行', () => {
  const p = fixture([userMsg('提交'), bashCall()]);
  process.env.COMMIT_SKIP_SKILL_CHECK = '1';
  try {
    assert.notStrictEqual(evaluate(payload(p)).exitCode, 2);
  } finally {
    delete process.env.COMMIT_SKIP_SKILL_CHECK;
  }
});

test('evaluate：非 commit 命令不受本判据影响', () => {
  const p = fixture([userMsg('看一下'), bashCall()]);
  const r = evaluate(JSON.stringify({
    tool_name: 'Bash', cwd: '/nonexistent-for-tests', transcript_path: p,
    tool_input: { command: 'git status' },
  }));
  assert.notStrictEqual(r.exitCode, 2);
});

test('Codex transcript：读取 create-commit SKILL.md 的真实工具调用算已调用 skill', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cdg-codex-')), 'rollout.jsonl');
  fs.writeFileSync(p, JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      name: 'exec',
      input: 'sed -n 1,240p /Users/example/.agents/skills/create-commit/SKILL.md',
    },
  }) + '\n');
  assert.strictEqual(skillInvokedRecently(p), true);
});

test('Codex transcript：只提到 create-commit 路径不算读取 skill', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cdg-codex-mention-')), 'rollout.jsonl');
  fs.writeFileSync(p, JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      name: 'exec',
      input: 'echo /Users/example/.agents/skills/create-commit/SKILL.md',
    },
  }) + '\n');
  assert.strictEqual(skillInvokedRecently(p), false);
});

test('Codex transcript：shell wrapper 里的真实读取仍算已读取 skill', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cdg-codex-wrapper-')), 'rollout.jsonl');
  fs.writeFileSync(p, JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      name: 'exec',
      input: "bash -lc 'cat /Users/example/.agents/skills/create-commit/SKILL.md'",
    },
  }) + '\n');
  assert.strictEqual(skillInvokedRecently(p), true);
});

test('Codex transcript：shell wrapper 读取后继续执行命令仍算已读取 skill', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cdg-codex-wrapper-chain-')), 'rollout.jsonl');
  fs.writeFileSync(p, JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      name: 'exec',
      input: "bash -lc 'cat /Users/example/.agents/skills/create-commit/SKILL.md; echo done'",
    },
  }) + '\n');
  assert.strictEqual(skillInvokedRecently(p), true);
});

test('大体积 Codex transcript：assistant 窗口完整时不因 schema 差异退化为 null', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cdg-codex-large-')), 'rollout.jsonl');
  const fd = fs.openSync(p, 'w');
  try {
    fs.ftruncateSync(fd, 65 * 1024 * 1024);
  } finally {
    fs.closeSync(fd);
  }
  const lines = [];
  for (let i = 0; i < RECENT_WINDOW + 5; i++) {
    lines.push(JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `step ${i}` }] },
    }));
  }
  lines.push(JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      name: 'exec',
      input: 'sed -n 1,240p /Users/example/.agents/skills/create-commit/SKILL.md',
    },
  }));
  fs.appendFileSync(p, `${lines.join('\n')}\n`);
  assert.strictEqual(skillInvokedRecently(p), true);
});
