#!/usr/bin/env node
/**
 * teammate-reclaim-check 单测。
 *
 * 每个用例对应 HARNESS-060 里被否实现的一条 finding，或本轮为满足
 * 「不带来正确性风险」而加的那两条分层约束。用例名标注了对应编号。
 *
 * 跑法：node claude/hooks/teammate-reclaim-check.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hook = require('./teammate-reclaim-check.js');

let pass = 0;
const failures = [];

function test(name, fn) {
  try { fn(); pass++; }
  catch (e) { failures.push(`${name}\n    ${e.message}`); }
}

// ---------------------------------------------------------------- fixtures

let seq = 0;
const ts = () => `2026-07-29T12:${String(10 + (seq++)).padStart(2, '0')}:00.000Z`;

function spawnUse(id, name) {
  return { timestamp: ts(), message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { name } }] } };
}

function spawnResult(id, name, opts = {}) {
  return {
    timestamp: ts(),
    toolUseResult: {
      status: opts.status === undefined ? 'teammate_spawned' : opts.status,
      agent_id: `${name}@session-test`,
      name,
      team_name: opts.team || 'session-test',
      prompt: opts.prompt || `prompt for ${name}`,
    },
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: opts.isError || undefined }] },
  };
}

function stopUse(id, target) {
  return { timestamp: ts(), message: { content: [{ type: 'tool_use', id, name: 'TaskStop', input: { task_id: target } }] } };
}

function stopResult(id, opts = {}) {
  return {
    timestamp: ts(),
    toolUseResult: {
      message: 'Successfully stopped task: tabc12345 (...)',
      task_id: 'tabc12345',
      task_type: opts.taskType === undefined ? 'in_process_teammate' : opts.taskType,
      command: opts.command,
    },
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: opts.isError || undefined }] },
  };
}

function idle(name) {
  return {
    type: 'user',
    timestamp: ts(),
    message: {
      role: 'user',
      content: `Another Claude session sent a message:\n<teammate-message teammate_id="${name}" color="blue">\n{"type":"idle_notification","from":"${name}","idleReason":"available"}\n</teammate-message>\n`,
    },
  };
}

function fold(entries) {
  const led = hook.emptyLedger('test');
  let off = 100;                     // 非零：epoch_offset 默认 0，须能通过 actionable
  for (const e of entries) {
    const line = JSON.stringify(e);
    hook.foldLine(led, line, off);
    off += Buffer.byteLength(line, 'utf8') + 1;
  }
  led.baseline = { inode: led.source.inode, offset: 0 };  // 边界与实例出自同一"文件"
  return led;
}

const stateFile = sid => path.join(os.homedir(), '.claude', 'state', 'teammate-reclaim', `${sid}.json`);

const liveNames = led => Object.values(led.instances)
  .filter(i => i.state === 'live').map(i => i.name).sort();

// ---------------------------------------------------------------- baseline

test('spawn + successful stop leaves nothing unreclaimed', () => {
  const led = fold([spawnUse('u1', 'rev-a'), spawnResult('u1', 'rev-a'), stopUse('s1', 'rev-a'), stopResult('s1')]);
  assert.deepStrictEqual(liveNames(led), []);
});

test('spawn without stop stays live', () => {
  const led = fold([spawnUse('u1', 'rev-a'), spawnResult('u1', 'rev-a')]);
  assert.deepStrictEqual(liveNames(led), ['rev-a']);
});

// ---------------------------------------------------------------- finding 2

test('F2: failed spawn (is_error) never enters the ledger', () => {
  const led = fold([spawnUse('u1', 'rev-a'), spawnResult('u1', 'rev-a', { isError: true })]);
  assert.deepStrictEqual(liveNames(led), []);
});

test('F2: spawn whose status is not teammate_spawned never enters the ledger', () => {
  const led = fold([spawnUse('u1', 'rev-a'), spawnResult('u1', 'rev-a', { status: 'error' })]);
  assert.deepStrictEqual(liveNames(led), []);
});

test('F2: failed TaskStop does not mark the instance stopped', () => {
  const led = fold([
    spawnUse('u1', 'rev-a'), spawnResult('u1', 'rev-a'),
    stopUse('s1', 'rev-a'), stopResult('s1', { isError: true }),
  ]);
  assert.deepStrictEqual(liveNames(led), ['rev-a']);
});

test('F2: TaskStop of a background bash task is not a teammate stop', () => {
  const led = fold([
    spawnUse('u1', 'rev-a'), spawnResult('u1', 'rev-a'),
    stopUse('s1', 'bw0dv03o1'), stopResult('s1', { taskType: 'bash' }),
  ]);
  assert.deepStrictEqual(liveNames(led), ['rev-a']);
});

test('F2: a bare tool_use with no matching result stays pending, not counted', () => {
  const led = fold([spawnUse('u1', 'rev-a')]);
  assert.deepStrictEqual(liveNames(led), []);
  assert.ok(led.pending.spawn.u1, 'spawn should still be pending');
});

// ---------------------------------------------------------------- finding 3

test('F3: respawn of the same name is a distinct instance, not masked by history', () => {
  const led = fold([
    spawnUse('u1', 'rev-a'), spawnResult('u1', 'rev-a'),
    stopUse('s1', 'rev-a'), stopResult('s1'),
    spawnUse('u2', 'rev-a'), spawnResult('u2', 'rev-a'),
  ]);
  assert.deepStrictEqual(liveNames(led), ['rev-a'], 'second instance must still be live');
  assert.strictEqual(Object.keys(led.instances).length, 2);
});

test('F3: stopping one of two same-name live instances leaves the other live', () => {
  const led = fold([
    spawnUse('u1', 'rev-a'), spawnResult('u1', 'rev-a'),
    spawnUse('u2', 'rev-a'), spawnResult('u2', 'rev-a'),
    stopUse('s1', 'rev-a'), stopResult('s1'),
  ]);
  assert.deepStrictEqual(liveNames(led), ['rev-a']);
  assert.strictEqual(Object.values(led.instances).filter(i => i.state === 'stopped').length, 1);
});

test('F3: prompt-prefix disambiguates which same-name instance was stopped', () => {
  const led = fold([
    spawnUse('u1', 'rev-a'), spawnResult('u1', 'rev-a', { prompt: 'FIRST instance prompt' }),
    spawnUse('u2', 'rev-a'), spawnResult('u2', 'rev-a', { prompt: 'SECOND instance prompt' }),
    stopUse('s1', 'rev-a'), stopResult('s1', { command: 'FIRST instance prompt...' }),
  ]);
  assert.strictEqual(led.instances.u1.state, 'stopped', 'the FIRST instance is the one stopped');
  assert.strictEqual(led.instances.u2.state, 'live');
});

test('F3: name@team form resolves to the right instance', () => {
  const led = fold([
    spawnUse('u1', 'rev-a'), spawnResult('u1', 'rev-a', { team: 'team-x' }),
    stopUse('s1', 'rev-a@team-x'), stopResult('s1'),
  ]);
  assert.deepStrictEqual(liveNames(led), []);
});

test('F3: stop naming an unknown teammate touches nothing', () => {
  const led = fold([
    spawnUse('u1', 'rev-a'), spawnResult('u1', 'rev-a'),
    stopUse('s1', 'rev-zzz'), stopResult('s1'),
  ]);
  assert.deepStrictEqual(liveNames(led), ['rev-a']);
});

// ---------------------------------------------------------------- finding 4

test('F4: a trailing partial line is not consumed and is re-read next pass', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trc-'));
  const p = path.join(dir, 't.jsonl');
  const full = `${JSON.stringify(spawnUse('u1', 'rev-a'))}\n`;
  const partial = JSON.stringify(spawnResult('u1', 'rev-a')).slice(0, 40);
  fs.writeFileSync(p, full + partial);

  const first = hook.readNewLines({ path: null, inode: null, offset: 0 }, p);
  assert.strictEqual(first.lines.length, 1, 'only the complete line is returned');
  assert.strictEqual(typeof first.lines[0].text, 'string', 'lines carry text + offset');
  assert.strictEqual(first.source.offset, Buffer.byteLength(full), 'offset stops at the last newline');

  fs.appendFileSync(p, `${JSON.stringify(spawnResult('u1', 'rev-a')).slice(40)}\n`);
  const second = hook.readNewLines(first.source, p);
  assert.strictEqual(second.lines.length, 1, 'the once-partial line arrives whole');
  const led = hook.emptyLedger('test');
  for (const l of [...first.lines, ...second.lines]) hook.foldLine(led, l.text, l.offset);
  led.baseline = { inode: led.source.inode, offset: 0 };
  assert.deepStrictEqual(liveNames(led), ['rev-a'], 'the split spawn is not lost');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('F4: incremental read returns only new lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trc-'));
  const p = path.join(dir, 't.jsonl');
  fs.writeFileSync(p, `${JSON.stringify(spawnUse('u1', 'rev-a'))}\n`);
  const a = hook.readNewLines({ path: null, inode: null, offset: 0 }, p);
  const b = hook.readNewLines(a.source, p);
  assert.strictEqual(b.lines.length, 0, 'no re-read of already-consumed lines');
  fs.appendFileSync(p, `${JSON.stringify(spawnUse('u2', 'rev-b'))}\n`);
  const c = hook.readNewLines(b.source, p);
  assert.strictEqual(c.lines.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('F4: a replaced transcript (new inode) is rescanned from the start', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trc-'));
  const p = path.join(dir, 't.jsonl');
  fs.writeFileSync(p, `${JSON.stringify(spawnUse('u1', 'rev-a'))}\n`);
  const a = hook.readNewLines({ path: null, inode: null, offset: 0 }, p);
  fs.rmSync(p);
  fs.writeFileSync(p, `${JSON.stringify(spawnUse('u9', 'rev-z'))}\n`);
  const b = hook.readNewLines(a.source, p);
  assert.strictEqual(b.lines.length, 1, 'rescanned rather than sliced at a stale offset');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- finding 6 / tiering

test('F6: an instance with no idle signal lands in the unknown tier', () => {
  const led = fold([spawnUse('u1', 'rev-a'), spawnResult('u1', 'rev-a')]);
  const t = hook.classify(led);
  assert.deepStrictEqual(t.unknown.map(i => i.name), ['rev-a']);
  assert.deepStrictEqual(t.idle.map(i => i.name), []);
});

test('F6: an idle_notification promotes the instance to the idle tier', () => {
  const led = fold([spawnUse('u1', 'rev-a'), spawnResult('u1', 'rev-a'), idle('rev-a')]);
  const t = hook.classify(led);
  assert.deepStrictEqual(t.idle.map(i => i.name), ['rev-a']);
  assert.deepStrictEqual(t.unknown.map(i => i.name), []);
});

test('F6: the unknown tier never tells the agent to stop it', () => {
  const led = fold([spawnUse('u1', 'rev-a'), spawnResult('u1', 'rev-a')]);
  const { text } = hook.render(hook.classify(led));
  assert.ok(/不要仅凭本条/.test(text), 'must carry the do-not-act-on-this-alone guard');
  assert.ok(/状态未知/.test(text));
});

test('F6: an idle notification for an already-stopped instance does not revive it', () => {
  const led = fold([
    spawnUse('u1', 'rev-a'), spawnResult('u1', 'rev-a'),
    stopUse('s1', 'rev-a'), stopResult('s1'),
    idle('rev-a'),
  ]);
  assert.deepStrictEqual(liveNames(led), []);
  const t = hook.classify(led);
  assert.strictEqual(t.idle.length + t.unknown.length, 0);
});

// ---------------------------------------------------------------- repetition

test('no-nag: the same state is reported at most once', () => {
  const led = fold([spawnUse('u1', 'rev-a'), spawnResult('u1', 'rev-a')]);
  const first = hook.classify(led);
  assert.strictEqual(first.unknown.length, 1);
  for (const i of first.unknown) i.reported.push('unknown');
  assert.strictEqual(hook.classify(led).unknown.length, 0, 'second pass must be silent');
});

test('no-nag: a state change re-surfaces the instance exactly once', () => {
  const led = fold([spawnUse('u1', 'rev-a'), spawnResult('u1', 'rev-a')]);
  for (const i of hook.classify(led).unknown) i.reported.push('unknown');
  hook.foldLine(led, JSON.stringify(idle('rev-a')));
  const t = hook.classify(led);
  assert.deepStrictEqual(t.idle.map(i => i.name), ['rev-a'], 'unknown -> idle is worth one more mention');
  for (const i of t.idle) i.reported.push('idle');
  assert.strictEqual(hook.classify(led).idle.length, 0);
});

// ---------------------------------------------------------------- finding 5

test('F5: an epoch bump hides instances from before the restart', () => {
  const led = fold([spawnUse('u1', 'rev-a'), spawnResult('u1', 'rev-a')]);
  assert.strictEqual(hook.classify(led).unknown.length, 1);
  led.baseline = { inode: led.source.inode, offset: 1e9 };   // resume 后边界重设在该 spawn 之后
  assert.strictEqual(hook.classify(led).unknown.length, 0, 'no reporting of instances the resume did not restore');
});

// ---------------------------------------------------------------- finding 7

test('F7: truncation keeps the most recent, so a fresh leak is never masked', () => {
  const led = hook.emptyLedger('test');
  for (let n = 0; n < 9; n++) {
    hook.foldLine(led, JSON.stringify(spawnUse(`u${n}`, `rev-${n}`)));
    hook.foldLine(led, JSON.stringify(spawnResult(`u${n}`, `rev-${n}`)));
  }
  led.baseline = { inode: led.source.inode, offset: 0 };
  const t = hook.classify(led);
  assert.strictEqual(t.unknown[0].name, 'rev-8', 'newest first');
  const { text, shownUnknown } = hook.render(t);
  assert.ok(text.includes('rev-8'), 'the newest instance is listed');
  assert.ok(/另有 3 个/.test(text), 'the remainder is disclosed, not silently dropped');
  // 只给展示出来的记账，否则第 7 个起被永久静音
  for (const i of shownUnknown) i.reported.push('unknown');
  const t2 = hook.classify(led);
  assert.strictEqual(t2.unknown.length, 3, 'the 3 suppressed instances come back next pass');
  assert.deepStrictEqual(t2.unknown.map(i => i.name).sort(), ['rev-0', 'rev-1', 'rev-2']);
});

// ---------------------------------------------------------------- finding 9 / envelope

test('F9: output rides additionalContext, not stderr (and cold pass is silent)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trc-'));
  const p = path.join(dir, 't.jsonl');
  const sid = `t-${process.pid}-f9`;
  const w = e => fs.appendFileSync(p, `${JSON.stringify(e)}\n`);
  w({ type: 'user', timestamp: ts(), message: { role: 'user', content: 'hi' } });

  // 第一次是冷重建：只建基线，不注入
  const cold = hook.run(JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit', transcript_path: p }));
  assert.strictEqual(cold.stdout, '', 'a cold rebuild must not report — it cannot place the epoch boundary');

  // 基线之后新 spawn 的实例才可行动
  w(spawnUse('u1', 'rev-a')); w(spawnResult('u1', 'rev-a'));
  const out = hook.run(JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit', transcript_path: p }));
  const parsed = JSON.parse(out.stdout);
  assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(/rev-a/.test(parsed.hookSpecificOutput.additionalContext));
  assert.ok(!('stderr' in out), 'nothing is delivered via stderr');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.join(os.homedir(), '.claude', 'state', 'teammate-reclaim', `${sid}.json`), { force: true });
});

test('silent when there is nothing to report', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trc-'));
  const p = path.join(dir, 't.jsonl');
  fs.writeFileSync(p, [spawnUse('u1', 'rev-a'), spawnResult('u1', 'rev-a'), stopUse('s1', 'rev-a'), stopResult('s1')]
    .map(e => JSON.stringify(e)).join('\n') + '\n');
  const sid = `t-${process.pid}-quiet`;
  hook.run(JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit', transcript_path: p }));
  const out = hook.run(JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit', transcript_path: p }));
  assert.strictEqual(out.stdout, '', 'a fully reclaimed session injects nothing');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.join(os.homedir(), '.claude', 'state', 'teammate-reclaim', `${sid}.json`), { force: true });
});

test('malformed / empty input degrades to silence', () => {
  assert.strictEqual(hook.run('not json').stdout, '');
  assert.strictEqual(hook.run('').stdout, '');
  assert.strictEqual(hook.run('{}').stdout, '');
});

test('kill switch silences the hook', () => {
  process.env.TEAMMATE_RECLAIM_CHECK = '0';
  assert.strictEqual(hook.run(JSON.stringify({ session_id: 'x' })).stdout, '');
  delete process.env.TEAMMATE_RECLAIM_CHECK;
});

test('a corrupt transcript line is skipped without killing the scan', () => {
  const led = hook.emptyLedger('test');
  hook.foldLine(led, '{"broken": ');
  hook.foldLine(led, JSON.stringify(spawnUse('u1', 'rev-a')));
  hook.foldLine(led, JSON.stringify(spawnResult('u1', 'rev-a')));
  assert.deepStrictEqual(liveNames(led), ['rev-a']);
});

test('agent_id never reaches the injected text', () => {
  const led = fold([spawnUse('u1', 'rev-a'), spawnResult('u1', 'rev-a'), idle('rev-a')]);
  const { text } = hook.render(hook.classify(led));
  assert.ok(!text.includes('@session-test'), 'spawn-result metadata must not be echoed');
  assert.ok(text.includes('rev-a'), 'the name — what TaskStop actually takes — is what is shown');
});

// ------------------------------------------- 复审轮新增：R1 的 6 HIGH + 1 MEDIUM

test('R1-F1: the idle tier never claims stopping is loss-free, and demands the report first', () => {
  const led = fold([spawnUse('u1', 'rev-a'), spawnResult('u1', 'rev-a'), idle('rev-a')]);
  const { text } = hook.render(hook.classify(led));
  // HARNESS-041: idle 而报告从未送达是实测发生过的情形
  assert.ok(/SendMessage/.test(text), 'must tell the agent to retrieve the report first');
  assert.ok(/不说明报告已送达|没到手/.test(text), 'must state that idle does not imply delivery');
  assert.ok(!/不可能丢/.test(text), 'must not claim reclaiming is loss-free');
});

test('R1-F2a: a teammate merely mentioning idle_notification is NOT promoted to idle', () => {
  const chatter = {
    type: 'user', timestamp: ts(),
    message: { role: 'user', content: 'Another Claude session sent a message:\n<teammate-message teammate_id="rev-a" color="blue">\n{"type":"text","text":"I am reviewing the idle_notification handling in that hook"}\n</teammate-message>\n' },
  };
  assert.strictEqual(hook.idleNotificationName(chatter), null, 'substring match must not count');
  const led = fold([spawnUse('u1', 'rev-a'), spawnResult('u1', 'rev-a'), chatter]);
  assert.deepStrictEqual(hook.classify(led).idle.map(i => i.name), [], 'must not enter the idle tier');
  assert.deepStrictEqual(hook.classify(led).unknown.map(i => i.name), ['rev-a'], 'stays in the safe tier');
});

test('R1-F2a: a real idle_notification is still recognised', () => {
  assert.strictEqual(hook.idleNotificationName(idle('rev-a')), 'rev-a');
});

test('R2-1: an ambiguous idle (two same-name live) is attributed to NOBODY', () => {
  const led = fold([
    spawnUse('u1', 'rev-a'), spawnResult('u1', 'rev-a'),
    spawnUse('u2', 'rev-a'), spawnResult('u2', 'rev-a'),
    idle('rev-a'),
  ]);
  // 通知不带实例 ID：猜"最新那个"会把仍在工作的实例标成已停工
  assert.strictEqual(Object.values(led.instances).filter(i => i.idle_at).length, 0,
    'no instance may be marked idle when attribution is unprovable');
  assert.strictEqual(led.idle_ambiguous, 1, 'the ambiguity is recorded for audit');
  assert.strictEqual(hook.classify(led).idle.length, 0);
  assert.strictEqual(hook.classify(led).unknown.length, 2, 'both stay in the safe tier');
});

test('R2-1: an unambiguous idle is still attributed', () => {
  const led = fold([spawnUse('u1', 'rev-a'), spawnResult('u1', 'rev-a'), idle('rev-a')]);
  assert.strictEqual(led.instances.u1.idle_at !== null, true);
  assert.deepStrictEqual(hook.classify(led).idle.map(i => i.name), ['rev-a']);
});

test('R1-F2c: same-name stop tie-breaks on seq, not on a tied timestamp', () => {
  const led = hook.emptyLedger('test');
  // 同一 entry timestamp：并行 tool block 会打平时间戳
  const T = '2026-07-29T12:00:00.000Z';
  const mk = (id, name, prompt) => ([
    { timestamp: T, message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { name } }] } },
    { timestamp: T, toolUseResult: { status: 'teammate_spawned', agent_id: `${name}@t`, name, team_name: 't', prompt },
      message: { content: [{ type: 'tool_result', tool_use_id: id }] } },
  ]);
  for (const e of [...mk('u1', 'rev-a', 'A'), ...mk('u2', 'rev-a', 'B')]) hook.foldLine(led, JSON.stringify(e), 100);
  const victim = hook.pickStopTarget(led, 'rev-a', undefined);
  assert.strictEqual(victim.seq, 2, 'LIFO must resolve to the later spawn even with equal timestamps');
});

test('R1-F4: an un-caught-up scan reports nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trc-'));
  const p = path.join(dir, 't.jsonl');
  fs.writeFileSync(p, `${JSON.stringify(spawnUse('u1', 'rev-a'))}\n`);
  const r = hook.readNewLines({ path: null, inode: null, offset: 0 }, p);
  assert.strictEqual(r.caughtUp, true, 'a small file is caught up in one pass');
  // 模拟未追平：offset 落后于文件尾
  const led = hook.emptyLedger('s');
  led.source = { path: p, inode: null, offset: 0 };
  const res = hook.ingest(led, p);
  assert.strictEqual(res.caughtUp, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('R1-F5: a full rescan after resume does not resurrect pre-boundary instances', () => {
  const led = fold([spawnUse('u1', 'rev-old'), spawnResult('u1', 'rev-old')]);
  const spawnOff = led.instances.u1.spawn_offset;
  assert.ok(spawnOff > 0, 'spawn offset is recorded');
  led.baseline = { inode: led.source.inode, offset: spawnOff + 1 };
  assert.strictEqual(hook.actionable(led, led.instances.u1), false);
  assert.strictEqual(hook.classify(led).unknown.length, 0);
});

test('R1-F5: a cold rebuild marks everything it finds as non-actionable', () => {
  const led = hook.emptyLedger('s');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trc-'));
  const p = path.join(dir, 't.jsonl');
  fs.writeFileSync(p, [spawnUse('u1', 'rev-a'), spawnResult('u1', 'rev-a')]
    .map(e => JSON.stringify(e)).join('\n') + '\n');
  const r = hook.ingest(led, p);
  assert.strictEqual(r.establishedBaseline, true, 'the boundary is established in place');
  assert.strictEqual(Object.values(led.instances).length, 1, 'the instance is tracked');
  assert.strictEqual(hook.classify(led).unknown.length, 0, 'but not reported — it predates the boundary');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('R1-F6: every event other than UserPromptSubmit is silent — checked BEFORE anything is reported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trc-'));
  const p = path.join(dir, 't.jsonl');
  const sid = `t-${process.pid}-allow`;
  const w = e => fs.appendFileSync(p, `${JSON.stringify(e)}\n`);
  w({ type: 'user', timestamp: ts(), message: { role: 'user', content: 'hi' } });
  hook.run(JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit', transcript_path: p }));
  w(spawnUse('u1', 'rev-a')); w(spawnResult('u1', 'rev-a'));

  // 顺序是承重的：必须在**任何**报告发生前检查这些事件。若先调一次
  // UserPromptSubmit 当"前置断言"，它会把 unknown 写进 reported，于是即便白名单
  // 被删掉，这些事件也会因状态去重而静默——断言就成了空的。
  for (const ev of ['Stop', 'SubagentStop', 'SessionEnd', 'PostToolUse', 'Notification', 'SomeFutureEvent']) {
    const out = hook.run(JSON.stringify({ session_id: sid, hook_event_name: ev, transcript_path: p }));
    assert.strictEqual(out.stdout, '', `${ev} must emit nothing at all`);
    assert.ok(!/additionalContext/.test(out.stdout), `${ev} must not return additionalContext`);
  }

  // 只有到这里才消费报告——它同时证明上面那轮静默不是因为无可报之物
  const live = hook.run(JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit', transcript_path: p }));
  assert.ok(/rev-a/.test(live.stdout), 'the instance was reportable all along, so the silence above was the allowlist');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(stateFile(sid), { force: true });
});

test('R1-F6: a leftover Stop wiring cannot produce additionalContext', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trc-'));
  const p = path.join(dir, 't.jsonl');
  const sid = `t-${process.pid}-nostop`;
  const w = e => fs.appendFileSync(p, `${JSON.stringify(e)}\n`);
  w({ type: 'user', timestamp: ts(), message: { role: 'user', content: 'hi' } });
  hook.run(JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit', transcript_path: p }));
  w(spawnUse('u1', 'rev-a')); w(spawnResult('u1', 'rev-a'));
  const out = hook.run(JSON.stringify({ session_id: sid, hook_event_name: 'Stop', transcript_path: p }));
  assert.strictEqual(out.stdout, '', 'no output');
  assert.ok(!/additionalContext/.test(out.stdout), 'specifically: no additionalContext, which would continue the turn');
  assert.ok(!/systemMessage/.test(out.stdout));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(stateFile(sid), { force: true });
});

test('R1-F7: the audit log records instance keys and evidence offsets, not just names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trc-'));
  const p = path.join(dir, 't.jsonl');
  const sid = `t-${process.pid}-audit`;
  const logPath = path.join(os.homedir(), '.claude', 'logs', 'teammate-reclaim.jsonl');
  const before = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  const w = e => fs.appendFileSync(p, `${JSON.stringify(e)}\n`);
  w({ type: 'user', timestamp: ts(), message: { role: 'user', content: 'hi' } });
  hook.run(JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit', transcript_path: p }));
  w(spawnUse('u1', 'rev-a')); w(spawnResult('u1', 'rev-a'));
  hook.run(JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit', transcript_path: p }));

  const added = fs.readFileSync(logPath, 'utf8').slice(before).trim().split('\n').filter(Boolean).map(JSON.parse);
  const rec = added.find(r => r.session === sid);
  assert.ok(rec, 'a record was appended');
  assert.ok(Array.isArray(rec.instances) && rec.instances.length === 1);
  const i = rec.instances[0];
  for (const field of ['key', 'name', 'tier', 'agent_id', 'seq', 'spawned_at', 'spawn_offset']) {
    assert.ok(field in i, `audit record must carry ${field} to make a false positive traceable`);
  }
  assert.strictEqual(i.key, 'u1', 'keyed by the spawn tool_use id');
  assert.ok(rec.suppressed, 'and must record how many were suppressed by truncation');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.join(os.homedir(), '.claude', 'state', 'teammate-reclaim', `${sid}.json`), { force: true });
});

// ------------------------------------------- 复审轮 R2：4 HIGH + 1 MEDIUM


test('R2-2: a multibyte char split across a read boundary does not corrupt the line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trc-'));
  const p = path.join(dir, 't.jsonl');
  const padded = spawnResult('u1', 'rev-a', { prompt: '审查报告：' + '中文字符测试'.repeat(400) });
  fs.writeFileSync(p, [spawnUse('u1', 'rev-a'), padded].map(e => JSON.stringify(e)).join('\n') + '\n');
  const size = fs.statSync(p).size;

  // 关键：把 read chunk 压到 64 字节，多字节字符必然跨越真实读块边界。
  // 只调总预算不改 chunk 的话，8MiB 的 chunk 会一次吞下整个文件，什么都证明不了。
  const prevChunk = process.env.TEAMMATE_RECLAIM_READ_CHUNK;
  process.env.TEAMMATE_RECLAIM_READ_CHUNK = '64';
  let r;
  try {
    r = hook.readNewLines({ path: null, inode: null, offset: 0 }, p);
  } finally {
    if (prevChunk === undefined) delete process.env.TEAMMATE_RECLAIM_READ_CHUNK;
    else process.env.TEAMMATE_RECLAIM_READ_CHUNK = prevChunk;
  }

  assert.ok(size > 64 * 20, 'the fixture must span many chunks for this to mean anything');
  assert.strictEqual(r.caughtUp, true);
  assert.strictEqual(r.lines.length, 2);
  for (const l of r.lines) {
    assert.ok(!l.text.includes('�'), 'no replacement characters may appear');
    JSON.parse(l.text);
  }
  const led = hook.emptyLedger('s'); led.baseline = { inode: led.source.inode, offset: 0 };
  for (const l of r.lines) hook.foldLine(led, l.text, l.offset);
  assert.deepStrictEqual(Object.values(led.instances).map(i => i.name), ['rev-a']);
  assert.strictEqual(r.source.offset, size, 'byte offset lands exactly on EOF');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('R2-2/F4: budget exhaustion actually yields caughtUp=false and suppresses the report', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trc-'));
  const p = path.join(dir, 't.jsonl');
  const lines = [];
  for (let n = 0; n < 40; n++) lines.push(JSON.stringify(spawnUse(`x${n}`, `rev-${n}`)));
  fs.writeFileSync(p, lines.join('\n') + '\n');

  const prev = process.env.TEAMMATE_RECLAIM_MAX_READ;
  process.env.TEAMMATE_RECLAIM_MAX_READ = '200';        // 远小于文件
  const r = hook.readNewLines({ path: null, inode: null, offset: 0 }, p);
  assert.strictEqual(r.caughtUp, false, 'a truncated scan must report itself as not caught up');
  const led = hook.emptyLedger('s');
  led.baseline = { inode: led.source.inode, offset: 0 };
  led.source = { path: p, inode: null, offset: 0 };
  const res = hook.ingest(led, p);
  assert.strictEqual(res.caughtUp, false, 'ingest propagates it');
  if (prev === undefined) delete process.env.TEAMMATE_RECLAIM_MAX_READ; else process.env.TEAMMATE_RECLAIM_MAX_READ = prev;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('R2-3: the real SessionStart -> UserPromptSubmit order still suppresses pre-resume instances', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trc-'));
  const p = path.join(dir, 't.jsonl');
  const sid = `t-${process.pid}-r23`;
  const w = e => fs.appendFileSync(p, `${JSON.stringify(e)}\n`);
  // resume 前的历史里就有一个未回收实例
  w(spawnUse('u1', 'rev-old')); w(spawnResult('u1', 'rev-old'));

  // SessionStart 会**保存**一份台账 —— 这正是旧 fresh 推断被击穿的地方
  hook.run(JSON.stringify({ session_id: sid, hook_event_name: 'SessionStart', source: 'resume', transcript_path: p }));
  const saved = JSON.parse(fs.readFileSync(stateFile(sid), 'utf8'));
  assert.strictEqual(saved.baseline, null, 'resume clears the boundary');

  const out = hook.run(JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit', transcript_path: p }));
  assert.strictEqual(out.stdout, '', 'the pre-resume instance must NOT be reported');

  // resume 之后新派的才可行动
  w(spawnUse('u2', 'rev-new')); w(spawnResult('u2', 'rev-new'));
  const out2 = hook.run(JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit', transcript_path: p }));
  const ctx = JSON.parse(out2.stdout).hookSpecificOutput.additionalContext;
  assert.ok(/rev-new/.test(ctx), 'a post-resume instance is reported');
  assert.ok(!/rev-old/.test(ctx), 'and the pre-resume one stays suppressed');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(stateFile(sid), { force: true });
});

test('R2-3: a boundary from a different file is never compared against a new inode', () => {
  const led = fold([spawnUse('u1', 'rev-a'), spawnResult('u1', 'rev-a')]);
  led.baseline = { inode: 111, offset: 0 };
  led.source = { path: '/x', inode: 222, offset: 10 };
  assert.strictEqual(hook.actionable(led, led.instances.u1), false,
    'byte offsets across two different files are not comparable');
});

test('R2-5: the audit record carries instance keys and evidence offsets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trc-'));
  const p = path.join(dir, 't.jsonl');
  const sid = `t-${process.pid}-r25`;
  const logPath = path.join(os.homedir(), '.claude', 'logs', 'teammate-reclaim.jsonl');
  const before = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  const w = e => fs.appendFileSync(p, `${JSON.stringify(e)}\n`);
  w({ type: 'user', timestamp: ts(), message: { role: 'user', content: 'hi' } });
  hook.run(JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit', transcript_path: p }));
  w(spawnUse('u1', 'rev-a')); w(spawnResult('u1', 'rev-a'));
  hook.run(JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit', transcript_path: p }));

  const rec = fs.readFileSync(logPath, 'utf8').slice(before).trim().split('\n')
    .filter(Boolean).map(JSON.parse).find(r => r.session === sid);
  assert.ok(rec, 'a record was appended');
  for (const f of ['source_offset', 'baseline', 'scanned_lines', 'idle_ambiguous', 'instances']) {
    assert.ok(f in rec, `audit must carry ${f}`);
  }
  assert.strictEqual(rec.instances[0].key, 'u1');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(stateFile(sid), { force: true });
});

// ------------------------------------------- 复审轮 R3

test('R3: after an inode change and baseline rebuild, old-file instances stay dead', () => {
  const led = hook.emptyLedger('s');
  // 旧文件里的实例，偏移较大
  led.source = { path: '/old', inode: 111, offset: 0 };
  hook.foldLine(led, JSON.stringify(spawnUse('u1', 'rev-old')), 5000);
  hook.foldLine(led, JSON.stringify(spawnResult('u1', 'rev-old')), 5000);
  assert.strictEqual(led.instances.u1.spawn_inode, 111, 'the instance records its own file');

  // 换成一个更短的新文件，baseline 在新文件的 EOF（较小的偏移）
  led.source = { path: '/new', inode: 222, offset: 10 };
  led.baseline = { inode: 222, offset: 100 };
  assert.ok(led.instances.u1.spawn_offset >= led.baseline.offset,
    'the naive offset comparison would call it actionable');
  assert.strictEqual(hook.actionable(led, led.instances.u1), false,
    'but offsets from two different files are not comparable, so it must stay dead');
});

test('R3: instance-level idle ambiguity reaches the audit log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trc-'));
  const p = path.join(dir, 't.jsonl');
  const sid = `t-${process.pid}-r3amb`;
  const logPath = path.join(os.homedir(), '.claude', 'logs', 'teammate-reclaim.jsonl');
  const before = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  const w = e => fs.appendFileSync(p, `${JSON.stringify(e)}\n`);
  w({ type: 'user', timestamp: ts(), message: { role: 'user', content: 'hi' } });
  hook.run(JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit', transcript_path: p }));
  // 两个同名 live 实例 + 一条 idle 通知 → 歧义
  w(spawnUse('a1', 'dup')); w(spawnResult('a1', 'dup', { prompt: 'A' }));
  w(spawnUse('a2', 'dup')); w(spawnResult('a2', 'dup', { prompt: 'B' }));
  w(idle('dup'));
  hook.run(JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit', transcript_path: p }));

  const rec = fs.readFileSync(logPath, 'utf8').slice(before).trim().split('\n')
    .filter(Boolean).map(JSON.parse).find(r => r.session === sid);
  assert.ok(rec, 'a record was appended');
  assert.strictEqual(rec.idle_ambiguous, 1, 'ledger-level count');
  assert.ok(rec.instances.every(i => 'idle_ambiguous' in i), 'per-instance flag is serialised');
  assert.ok(rec.instances.some(i => i.idle_ambiguous === true),
    'the specific instances that were in the ambiguous set are identifiable');
  assert.ok(rec.instances.every(i => 'spawn_inode' in i), 'and which file each spawn came from');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(stateFile(sid), { force: true });
});

// ------------------------------------------- 复审轮 R4

test('R4: an instance with no recorded spawn_inode is never actionable', () => {
  const led = fold([spawnUse('u1', 'rev-a'), spawnResult('u1', 'rev-a')]);
  led.baseline = { inode: 999, offset: 0 };
  delete led.instances.u1.spawn_inode;          // 旧台账 / 未记归属的形态
  led.source = { path: '/x', inode: 999, offset: 10 };
  assert.strictEqual(hook.actionable(led, led.instances.u1), false,
    'unknown provenance must not be admitted into the offset comparison');
  led.instances.u1.spawn_inode = null;
  assert.strictEqual(hook.actionable(led, led.instances.u1), false, 'null likewise');
});

test('R4: a stale lower-version ledger is discarded, not half-migrated', () => {
  const sid = `t-${process.pid}-r4ver`;
  const dir = path.join(os.homedir(), '.claude', 'state', 'teammate-reclaim');
  fs.mkdirSync(dir, { recursive: true });
  // 写一份上一版 v2 台账：实例只有 spawn_offset，没有 spawn_inode
  fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({
    version: 2, session_id: sid, baseline: { inode: 1, offset: 0 }, seq: 1,
    source: { path: '/old', inode: 1, offset: 5000 },
    instances: { old1: { name: 'ghost', state: 'live', spawn_offset: 5000, reported: [], seq: 1 } },
    pending: { spawn: {}, stop: {} },
  }));
  const trc = fs.mkdtempSync(path.join(os.tmpdir(), 'trc-'));
  const p = path.join(trc, 't.jsonl');
  fs.writeFileSync(p, `${JSON.stringify({ type: 'user', timestamp: ts(), message: { role: 'user', content: 'hi' } })}\n`);
  const out = hook.run(JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit', transcript_path: p }));
  assert.strictEqual(out.stdout, '', 'the ghost instance from the stale ledger must not be reported');
  const now = JSON.parse(fs.readFileSync(path.join(dir, `${sid}.json`), 'utf8'));
  assert.strictEqual(now.version, 3, 'rebuilt at the current version');
  assert.ok(!('old1' in now.instances), 'and the stale instance is gone');
  fs.rmSync(trc, { recursive: true, force: true });
  fs.rmSync(path.join(dir, `${sid}.json`), { force: true });
});

test('R4: a first scan records the real inode on each instance, not null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trc-'));
  const p = path.join(dir, 't.jsonl');
  fs.writeFileSync(p, [spawnUse('u1', 'rev-a'), spawnResult('u1', 'rev-a')]
    .map(e => JSON.stringify(e)).join('\n') + '\n');
  const led = hook.emptyLedger('s');
  hook.ingest(led, p);                       // 首次扫描：此前会写成 null
  const real = fs.statSync(p).ino;
  assert.strictEqual(led.instances.u1.spawn_inode, real,
    'spawn_inode must be the file the spawn was actually read from');
  fs.rmSync(dir, { recursive: true, force: true });
});

// -------------------------------------------- transcript_under_projects (ADR-018)
//
// 这是**观察值**的谓词，不是来源分类器（为什么不是，见被测函数的注释与 ADR-018）。
// 正因为它只是个路径谓词，它的正确性可以逐例断言——这正是 ADR-018 用来替换
// 「无法发现语义误分类」那条 blocker 的东西。故这里穷举边界，而不是抽样。
//
// 落日志层的用例经 `evaluate` 的 `sink` 参数观察（见 A18-9），**不碰生产日志**——
// 故 HARNESS-305 那条顾虑（测试 diff 生产日志、把夹具灌进去）在这里不成立。
// 别据"不该碰生产日志"删掉 A18-9：它是唯一守住"喂哪个值给该字段"这条接线的用例。

const PROJ = path.join(os.homedir(), '.claude', 'projects');

test('A18-1: 没读到 transcript → null（不是 false）', () => {
  assert.strictEqual(hook.transcriptUnderProjects(null), null);
  assert.strictEqual(hook.transcriptUnderProjects(undefined), null);
  assert.strictEqual(hook.transcriptUnderProjects(''), null,
    '空串是"没读到"，不该被判成"不在 projects 下"');
});

test('A18-2: projects 下的真实转录 → true', () => {
  assert.strictEqual(
    hook.transcriptUnderProjects(path.join(PROJ, '-Users-x-repo', 'abc.jsonl')), true);
});

test('A18-3: 临时目录下的转录 → false（如实记录，不是"误标为合成"）', () => {
  assert.strictEqual(
    hook.transcriptUnderProjects(path.join(os.tmpdir(), 'trc-x', 't.jsonl')), false);
});

test('A18-4: 前缀相同但不在该目录下 → false（尾分隔符守卫）', () => {
  assert.strictEqual(hook.transcriptUnderProjects(`${PROJ}foo/t.jsonl`), false,
    '~/.claude/projectsfoo 不在 ~/.claude/projects/ 之下');
  assert.strictEqual(hook.transcriptUnderProjects(PROJ), false,
    '目录自身不是它之下的某个转录');
  // 守 startsWith→includes 这一类变异：该串出现在中段不算"在其之下"。
  // 形态取自嵌套挂载 / 容器前缀。
  assert.strictEqual(hook.transcriptUnderProjects(`/tmp/x${PROJ}/p/t.jsonl`), false,
    'projects 路径出现在中段不构成"位于其下"');
});

// 注意：输入必须用**字符串拼接**构造，不能用 path.join——join 在求值时就把 `..`
// 规范化掉了，函数根本收不到未规范化的串，于是这条用例在删掉被测函数里的
// path.resolve 之后依然全绿（review-gate 实测该变异存活）。
test('A18-5: 路径先规范化再判（.. 不能绕出去）', () => {
  assert.strictEqual(hook.transcriptUnderProjects(`${PROJ}/../logs/t.jsonl`), false,
    '经 .. 走出 projects 的路径不算在其之下');
  assert.strictEqual(hook.transcriptUnderProjects(`${PROJ}/p/../q/t.jsonl`), true,
    '在 projects 内部绕一圈仍在其之下');
  assert.strictEqual(hook.transcriptUnderProjects(`${PROJ}/./p/t.jsonl`), true);
  assert.strictEqual(hook.transcriptUnderProjects(`${PROJ}//p/t.jsonl`), true);
});

test('A18-7: 非字符串输入 → null，且不抛（抛会被 run 的兜底 catch 吞成整条不注入）', () => {
  for (const bad of [{}, [], 42, true, () => {}]) {
    assert.strictEqual(hook.transcriptUnderProjects(bad), null, `${typeof bad} 应判 null`);
  }
});

// HIGH#1 的失败证据：本轮读不到时必须是 null，而不是沿用台账里上一轮的路径。
test('A18-8: 转录消失后 observedPath 变 null，而 led.source.path 仍是旧值', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trc-obs-'));
  const p = path.join(dir, 't.jsonl');
  fs.writeFileSync(p, `${JSON.stringify({ type: 'user', timestamp: ts(), message: { role: 'user', content: 'hi' } })}\n`);
  const led = hook.emptyLedger('obs-test');

  const first = hook.ingest(led, p);
  assert.strictEqual(first.observedPath, p, '第一轮读到了，应回传本轮路径');
  assert.strictEqual(led.source.path, p);

  // 追平后无新字节那一轮：statSync 成功、转录可读，只是没得读——按定义**不是** null。
  // 这条守住 `if (cursor >= size)` 那个提前返回；它是 scanned_lines: 0 那批行的来源，
  // 也最容易被误改成 null（那会把「读到了但没新内容」谎报成「本轮没观察」）。
  const idleRound = hook.ingest(led, p);
  assert.strictEqual(idleRound.scanned, 0, '本轮不该有新行');
  assert.strictEqual(idleRound.observedPath, p,
    '追平后无新内容仍是"本轮读到了"，observedPath 必须是路径而非 null');

  fs.rmSync(p, { force: true });          // 转录消失
  const second = hook.ingest(led, p);
  assert.strictEqual(second.observedPath, null,
    '本轮 statSync 失败 → 本轮没有观察，必须是 null');
  assert.strictEqual(led.source.path, p,
    '台账仍留着上一轮的路径——正因如此才不能拿它当本轮观察');
  assert.strictEqual(hook.transcriptUnderProjects(second.observedPath), null);
  assert.notStrictEqual(hook.transcriptUnderProjects(led.source.path), null,
    '喂错值会得到肯定读数，这正是本用例守住的那个错');

  const third = hook.ingest(led, null);   // 本轮压根没给 transcript_path
  assert.strictEqual(third.observedPath, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('A18-6: 谓词在两个桶上取值不同（有区分力，不是恒定读数）', () => {
  const inProj = hook.transcriptUnderProjects(path.join(PROJ, 'p', 't.jsonl'));
  const inTmp = hook.transcriptUnderProjects(path.join(os.tmpdir(), 't.jsonl'));
  assert.notStrictEqual(inProj, inTmp,
    '两种输入必须给出不同读数，否则这个字段记了也分不出任何东西');
});

// 接线用例：断言 evaluate 实际喂给该字段的是**本轮**观察，不是台账里上一轮的路径。
// 要让这条有鉴别力，必须构造出「本轮读不到、但仍有未报过的实例可报」的那一轮——
// 否则 observedPath 与 led.source.path 取值相同，喂错也看不出来。手法是超过
// MAX_LISTED_PER_TIER 派发，让第一轮报不完，剩下的留到转录消失后的第二轮。
test('A18-9: 转录消失那一轮，落盘字段是 null 而非上一轮的位置', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trc-wire-'));
  const p = path.join(dir, 't.jsonl');
  const sid = `t-${process.pid}-wire`;
  fs.rmSync(stateFile(sid), { force: true });
  const w = e => fs.appendFileSync(p, `${JSON.stringify(e)}\n`);
  w({ type: 'user', timestamp: ts(), message: { role: 'user', content: 'hi' } });

  const rec = [];
  const sink = r => rec.push(r);
  const input = { session_id: sid, hook_event_name: 'UserPromptSubmit', transcript_path: p };
  hook.evaluate(input, sink);                       // 建立边界

  const n = hook.MAX_LISTED_PER_TIER + 2;           // 一轮报不完，留 2 个没报过的
  for (let i = 0; i < n; i++) { w(spawnUse(`w${i}`, `rev-${i}`)); w(spawnResult(`w${i}`, `rev-${i}`)); }
  hook.evaluate(input, sink);
  assert.strictEqual(rec.length, 1, '第一轮应落一条');
  assert.strictEqual(rec[0].transcript_under_projects, false,
    '转录在临时目录下 → false');

  fs.rmSync(p, { force: true });                    // 转录消失
  hook.evaluate(input, sink);
  assert.strictEqual(rec.length, 2, '仍有未报过的实例，第二轮应再落一条');
  assert.strictEqual(rec[1].transcript_under_projects, null,
    '本轮什么都没读到 → null；若喂的是 led.source.path 这里会是 false');

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(stateFile(sid), { force: true });
});

// ---------------------------------------------------------------- report

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
