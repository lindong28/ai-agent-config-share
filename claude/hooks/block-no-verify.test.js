#!/usr/bin/env node
/**
 * Tests for block-no-verify.js (PreToolUse:Bash hook).
 *
 * Regression coverage for HARNESS-018: the hook scanned the WHOLE command
 * string, so (A) a `git…commit` substring inside a quoted grep/echo pattern
 * was treated as a real git command, and (B) a `-n` flag from an unrelated
 * segment (e.g. `sed -n`) was attributed to the git invocation. Either alone
 * could false-block a read-only / unrelated compound command.
 *
 * Run:  cd ~/.claude/hooks && node --test block-no-verify.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { run } = require('./block-no-verify.js');

function exit(command) {
  return run(JSON.stringify({ tool_input: { command } })).exitCode;
}

describe('block-no-verify: real bypass attempts still blocked (reverse guard)', () => {
  const block = [
    ['git commit -n', 'git commit -n'],
    ['git commit --no-verify', 'git commit --no-verify'],
    ['git push --no-verify', 'git push --no-verify'],
    ['git commit -nm shorthand', 'git commit -nm "msg"'],
    ['hooksPath override (unquoted)', 'git -c core.hooksPath=/dev/null commit -m x'],
    ['hooksPath override (quoted value)', 'git -c "core.hooksPath=/dev/null" commit -m x'],
    ['git commit -n after &&', 'npm test && git commit -n'],
  ];
  for (const [name, cmd] of block) {
    it(`blocks: ${name}`, () => {
      assert.equal(exit(cmd), 2, `expected block (2) for: ${cmd}`);
    });
  }
});

describe('block-no-verify: compound / quoted false positives allowed', () => {
  const allow = [
    // HARNESS-018 repro: git…commit in grep pattern + -n from sed elsewhere
    ['grep pattern + sed -n', `grep -rIn "End git commit messages with" . ; sed -n '1,15p' x.js`],
    // real git commit in one segment, unrelated -n in another
    ['real commit + unrelated sed -n', `git commit -m "msg" ; sed -n '1,5p' x.js`],
    // fake git in grep pattern, grep's own -n flag in same segment
    ['grep -n with git in pattern', `grep -n "git commit" .`],
    // -n inside the commit message string, not a flag
    ['-n inside commit message', `git commit -m "fix -n bug"`],
    // plain legitimate commit
    ['plain commit', `git commit -m "msg"`],
    // echo mentioning the flag as data
    ['echo mentions flag as text', `echo "do not use git commit --no-verify"`],
    // unrelated command with -n and the word git elsewhere
    ['head -n with git word in path', `head -n 5 git-notes.txt`],
  ];
  for (const [name, cmd] of allow) {
    it(`allows: ${name}`, () => {
      assert.equal(exit(cmd), 0, `expected allow (0) for: ${cmd}`);
    });
  }
});
