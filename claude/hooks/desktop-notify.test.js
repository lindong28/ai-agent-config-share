#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const hook = path.join(__dirname, 'desktop-notify.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-notify-test-'));

try {
  const relay = path.join(tmp, '.local', 'bin', 'agent-desktop-notify');
  const capture = path.join(tmp, 'relay-payload');
  fs.mkdirSync(path.dirname(relay), { recursive: true });
  fs.writeFileSync(relay, '#!/bin/sh\ncat >"$CAPTURE"\n');
  fs.chmodSync(relay, 0o755);

  const payload = JSON.stringify({
    cwd: '/work/system-config',
    last_assistant_message: '修复完成',
  });
  const result = spawnSync(process.execPath, [hook], {
    input: payload,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: tmp,
      TMUX: 'diagnostic',
      CAPTURE: capture,
    },
    timeout: 10000,
  });

  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout, payload);
  assert.strictEqual(fs.readFileSync(capture, 'utf8'), payload);
  process.stdout.write('desktop notification Mosh relay integration: ok\n');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
