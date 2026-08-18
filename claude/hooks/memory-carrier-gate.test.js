#!/usr/bin/env node
/**
 * Tests for memory-carrier-gate.js (PreToolUse:Write|Edit|MultiEdit hook).
 *
 * The gate's whole value is that it fires on the first write to a memory file
 * and then gets out of the way. Both halves need a reverse guard: a gate that
 * never fires and a gate that fires forever are equally useless, and the second
 * one is worse because it looks like it is working.
 *
 * Run:  cd ~/.claude/hooks && node --test memory-carrier-gate.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { run, isGatedPath } = require('./memory-carrier-gate.js');

const MEM = '/Users/x/.claude/projects/-Users-x-research-foo/memory/some-fact.md';

function call(file_path, session_id) {
  return run(JSON.stringify({ session_id, tool_input: { file_path } }));
}

describe('memory-carrier-gate: path matching', () => {
  it('gates a memory entry', () => {
    assert.equal(isGatedPath(MEM), true);
  });

  it('does not gate the MEMORY.md index (would double-fire per memory)', () => {
    assert.equal(
      isGatedPath('/Users/x/.claude/projects/-Users-x-research-foo/memory/MEMORY.md'),
      false,
    );
  });

  it('does not gate ordinary project files', () => {
    assert.equal(isGatedPath('/Users/x/research/foo/src/main.py'), false);
    assert.equal(isGatedPath('/Users/x/research/foo/docs/memory-design.md'), false);
  });

  it('does not gate a memory-looking path outside .claude/projects', () => {
    assert.equal(isGatedPath('/Users/x/notes/memory/some-fact.md'), false);
  });
});

describe('memory-carrier-gate: firing behaviour', () => {
  it('blocks the first write and names the distinguishing test', () => {
    const r = call(MEM, `s-${process.pid}-first`);
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /该不该有 git 载体/);
    assert.match(r.stderr, /durable-solution-carriers\.md/);
  });

  it('allows the same write when re-issued (buys one beat, not a veto)', () => {
    const session = `s-${process.pid}-second`;
    assert.equal(call(MEM, session).exitCode, 2);
    assert.equal(call(MEM, session).exitCode, 0);
    assert.equal(call(MEM, session).exitCode, 0);
  });

  it('gates each memory file separately within one session', () => {
    const session = `s-${process.pid}-perfile`;
    const other = MEM.replace('some-fact.md', 'other-fact.md');
    assert.equal(call(MEM, session).exitCode, 2);
    assert.equal(call(other, session).exitCode, 2);
  });

  it('lets non-memory writes straight through', () => {
    assert.equal(call('/Users/x/research/foo/README.md', 'sX').exitCode, 0);
  });

  it('survives malformed input without blocking', () => {
    assert.equal(run('not json').exitCode, 0);
    assert.equal(run('').exitCode, 0);
    assert.equal(run({}).exitCode, 0);
  });
});
