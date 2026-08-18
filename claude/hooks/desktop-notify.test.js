#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const hook = path.join(__dirname, 'desktop-notify.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-notify-test-'));

/**
 * Run the hook against one payload with a stub Mosh relay that dumps whatever
 * it is handed. Returns the hook's stdout plus the relayed payload (null when
 * the relay was never invoked — i.e. the hook stayed silent).
 */
function runHook(name, payload) {
  const capture = path.join(tmp, `relay-${name}`);
  const result = spawnSync(process.execPath, [hook], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, HOME: tmp, TMUX: 'diagnostic', CAPTURE: capture },
    timeout: 10000,
  });
  assert.strictEqual(result.status, 0, result.stderr);
  return {
    stdout: result.stdout,
    relayed: fs.existsSync(capture) ? JSON.parse(fs.readFileSync(capture, 'utf8')) : null,
  };
}

try {
  // The stub answers with the real relay's success marker so the verdict
  // parsing path (exact-line match on stderr) is exercised too.
  const relay = path.join(tmp, '.local', 'bin', 'agent-desktop-notify');
  fs.mkdirSync(path.dirname(relay), { recursive: true });
  fs.writeFileSync(relay, '#!/bin/sh\ncat >"$CAPTURE"\necho relayed >&2\n');
  fs.chmodSync(relay, 0o755);

  // A transcript whose LAST assistant text is the one that must surface.
  const transcript = path.join(tmp, 'transcript.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '先前的一段' }] } }),
    JSON.stringify({ type: 'user', message: { content: 'go on' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '修复完成\n细节若干' }] } }),
    '',
  ].join('\n'));

  // Stop still works: payload carries the message inline, stdout passes through
  // for chained hooks. Nothing registers this event any more, but the ECC hook
  // id stop:desktop-notify can, so the path must not rot.
  const stopPayload = JSON.stringify({
    cwd: '/work/system-config',
    hook_event_name: 'Stop',
    last_assistant_message: '修复完成',
  });
  const stop = runHook('stop', stopPayload);
  assert.strictEqual(stop.stdout, stopPayload);
  assert.strictEqual(stop.relayed.cwd, '/work/system-config');
  assert.strictEqual(stop.relayed.last_assistant_message, '修复完成');

  // idle_prompt is the real turn-ended signal. Its payload has no
  // last_assistant_message, so the body must be recovered from the transcript —
  // and the relay must receive that normalized shape, not the raw payload.
  const idle = runHook('idle', JSON.stringify({
    cwd: '/work/system-config',
    hook_event_name: 'Notification',
    notification_type: 'idle_prompt',
    transcript_path: transcript,
    message: 'Claude is waiting for your input',
  }));
  assert.strictEqual(idle.stdout, '', 'Notification stdout must not look like a decision');
  assert.strictEqual(idle.relayed.cwd, '/work/system-config');
  assert.strictEqual(idle.relayed.last_assistant_message, '修复完成\n细节若干');

  // A turn-ended signal with an unreadable transcript still notifies; the relay
  // falls back to "Done" rather than the hook going silent.
  const idleNoTranscript = runHook('idle-bare', JSON.stringify({
    cwd: '/work/system-config',
    hook_event_name: 'Notification',
    notification_type: 'idle_prompt',
    transcript_path: path.join(tmp, 'missing.jsonl'),
  }));
  assert.strictEqual(idleNoTranscript.relayed.last_assistant_message, null);

  // Non-attention notification types stay silent end to end.
  const auth = runHook('auth', JSON.stringify({
    cwd: '/work/system-config',
    hook_event_name: 'Notification',
    notification_type: 'auth_success',
  }));
  assert.strictEqual(auth.stdout, '');
  assert.strictEqual(auth.relayed, null, 'auth_success must not notify');

  // AskUserQuestion is not a turn end but IS attention-worthy — over mosh the
  // relay is its only route to the user (OSC 9 never survives mosh), so it
  // must relay its rendered body. Still no stdout that a PreToolUse hook could
  // mistake for a permission decision.
  const ask = runHook('ask', JSON.stringify({
    cwd: '/work/system-config',
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ header: '修法', question: '按哪条路修？' }] },
  }));
  assert.strictEqual(ask.stdout, '');
  assert.ok(ask.relayed, 'AskUserQuestion must reach the relay');
  assert.strictEqual(ask.relayed.body, '[system-config] ❓ 等你选择 · 修法');
  assert.strictEqual(ask.relayed.last_assistant_message, null,
    'a question is not a turn end; the relay body must carry the question, not the transcript');

  // permission_prompt likewise relays its rendered body.
  const perm = runHook('perm', JSON.stringify({
    cwd: '/work/system-config',
    hook_event_name: 'Notification',
    notification_type: 'permission_prompt',
    message: 'Claude needs your permission to use Bash',
  }));
  assert.strictEqual(perm.stdout, '');
  assert.ok(perm.relayed, 'permission_prompt must reach the relay');
  assert.strictEqual(perm.relayed.body, '[system-config] 🔐 Claude needs your permission to use Bash');

  // Every relayed payload now carries the rendered body alongside the
  // turn-end fields, so the relay can prefer it.
  assert.strictEqual(idle.relayed.body, '[system-config] 修复完成');

  // kind splits attention notices (someone is waiting) from turn-end so the
  // relay/terminal-notifier can give them a non-evicting notification group.
  assert.strictEqual(ask.relayed.kind, 'attention');
  assert.strictEqual(perm.relayed.kind, 'attention');
  assert.strictEqual(idle.relayed.kind, 'turn-end');
  assert.strictEqual(stop.relayed.kind, 'turn-end');

  // --- pending-permission stash enrichment -------------------------------
  // One file per entry (written by permission-gate.js); the reader aggregates
  // the session's directory and consumes every file it saw.
  const sid = 'sess-1234-abcd';
  const stashDir = path.join(tmp, '.claude', 'logs', 'pending-permission', sid);
  const writeEntry = (name, entry) => {
    fs.mkdirSync(stashDir, { recursive: true });
    fs.writeFileSync(path.join(stashDir, name), JSON.stringify(entry));
  };

  // One fresh entry → the body names tool + redacted target, and the stash is
  // consumed so a later unrelated prompt cannot replay it.
  writeEntry('1-1-1.json', { tool: 'Edit', target: 'foo.js', ts: Date.now() });
  const permRich = runHook('perm-rich', JSON.stringify({
    cwd: '/work/system-config',
    hook_event_name: 'Notification',
    notification_type: 'permission_prompt',
    session_id: sid,
    message: 'Claude needs your permission',
  }));
  assert.strictEqual(permRich.relayed.body, '[system-config] 🔐 等你审批 · 近期请求记录: Edit foo.js');
  assert.ok(!fs.existsSync(stashDir) || fs.readdirSync(stashDir).length === 0,
    'stash must be consumed on read');

  // Several fresh entries → a count, not a guess at which dialog is up.
  writeEntry('2-1-1.json', { tool: 'Edit', target: 'a.js', ts: Date.now() });
  writeEntry('2-1-2.json', { tool: 'Bash', target: 'git', ts: Date.now() });
  const permMulti = runHook('perm-multi', JSON.stringify({
    cwd: '/work/system-config',
    hook_event_name: 'Notification',
    notification_type: 'permission_prompt',
    session_id: sid,
  }));
  assert.strictEqual(permMulti.relayed.body, '[system-config] 🔐 等你审批 · 近期至少 2 个请求');

  // Expired entries fall back to the generic body — never a stale target —
  // and are consumed as well.
  writeEntry('3-1-1.json', { tool: 'Edit', target: 'old.js', ts: Date.now() - 10 * 60 * 1000 });
  const permStale = runHook('perm-stale', JSON.stringify({
    cwd: '/work/system-config',
    hook_event_name: 'Notification',
    notification_type: 'permission_prompt',
    session_id: sid,
    message: 'Claude needs your permission',
  }));
  assert.strictEqual(permStale.relayed.body, '[system-config] 🔐 Claude needs your permission');
  assert.ok(!fs.existsSync(stashDir) || fs.readdirSync(stashDir).length === 0,
    'stale entries are consumed too');

  // A single entry older than the naming window is COUNTED, never NAMED — a
  // survivor from an already-answered prompt must not be pinned on the prompt
  // that is waiting now (whose own stash write may have failed).
  writeEntry('5-1-1.json', { tool: 'Edit', target: 'answered.js', ts: Date.now() - 30 * 1000 });
  const permAged = runHook('perm-aged', JSON.stringify({
    cwd: '/work/system-config',
    hook_event_name: 'Notification',
    notification_type: 'permission_prompt',
    session_id: sid,
  }));
  assert.strictEqual(permAged.relayed.body, '[system-config] 🔐 等你审批 · 近期至少 1 个请求');

  // A session id that fails validation must not be used as a path component.
  fs.mkdirSync(path.join(tmp, '.claude', 'logs', 'pending-permission', 'x'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.claude', 'logs', 'pending-permission', 'x', '4-1-1.json'),
    JSON.stringify({ tool: 'Edit', target: 'evil.js', ts: Date.now() }));
  const permBadSid = runHook('perm-badsid', JSON.stringify({
    cwd: '/work/system-config',
    hook_event_name: 'Notification',
    notification_type: 'permission_prompt',
    session_id: '../pending-permission/x',
    message: 'Claude needs your permission',
  }));
  assert.strictEqual(permBadSid.relayed.body, '[system-config] 🔐 Claude needs your permission');

  // --- local branch: terminal-notifier group split ------------------------
  // Neither tmux nor ssh, relay declines, not Ghostty → the local
  // terminal-notifier fallback runs; attention notices must use their own
  // group so a later turn-end cannot evict them from Notification Center.
  fs.writeFileSync(relay, '#!/bin/sh\ncat >/dev/null\necho skipped:not-mosh >&2\n');
  const binDir = path.join(tmp, 'stub-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const tnCapture = path.join(tmp, 'tn-args');
  fs.writeFileSync(path.join(binDir, 'terminal-notifier'),
    '#!/bin/sh\nprintf "%s\\n" "$@" >"$TN_CAPTURE"\n');
  fs.chmodSync(path.join(binDir, 'terminal-notifier'), 0o755);

  function runLocal(payload) {
    fs.rmSync(tnCapture, { force: true });
    const env = {
      ...process.env,
      HOME: tmp,
      PATH: `${binDir}:${process.env.PATH}`,
      TN_CAPTURE: tnCapture,
      TERM_PROGRAM: 'xterm',
    };
    delete env.TMUX;
    delete env.TMUX_PANE;
    delete env.SSH_TTY;
    delete env.SSH_CONNECTION;
    delete env.GHOSTTY_RESOURCES_DIR;
    const result = spawnSync(process.execPath, [hook], {
      input: payload, encoding: 'utf8', env, timeout: 10000,
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(tnCapture), 'local fallback must reach terminal-notifier');
    const args = fs.readFileSync(tnCapture, 'utf8').split('\n');
    return args[args.indexOf('-group') + 1];
  }

  const localPermGroup = runLocal(JSON.stringify({
    cwd: '/work/system-config',
    hook_event_name: 'Notification',
    notification_type: 'permission_prompt',
    message: 'Claude needs your permission',
  }));
  assert.strictEqual(localPermGroup, 'claude-system-config-attn');

  const localIdleGroup = runLocal(JSON.stringify({
    cwd: '/work/system-config',
    hook_event_name: 'Notification',
    notification_type: 'idle_prompt',
    transcript_path: transcript,
  }));
  assert.strictEqual(localIdleGroup, 'claude-system-config');

  process.stdout.write('desktop notification event routing + Mosh relay: ok\n');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
