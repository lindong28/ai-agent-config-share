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
  const relay = path.join(tmp, '.local', 'bin', 'agent-desktop-notify');
  fs.mkdirSync(path.dirname(relay), { recursive: true });
  fs.writeFileSync(relay, '#!/bin/sh\ncat >"$CAPTURE"\n');
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

  // AskUserQuestion notifies the desktop but is not a turn end — no relay, and
  // no stdout that a PreToolUse hook could mistake for a permission decision.
  const ask = runHook('ask', JSON.stringify({
    cwd: '/work/system-config',
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ header: '修法', question: '按哪条路修？' }] },
  }));
  assert.strictEqual(ask.stdout, '');
  assert.strictEqual(ask.relayed, null, 'AskUserQuestion is not a turn end');

  process.stdout.write('desktop notification event routing + Mosh relay: ok\n');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
