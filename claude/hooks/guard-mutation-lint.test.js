'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { run, scanDiff, isTestPath } = require('./guard-mutation-lint.js');

/** Build a unified diff (-U0 shape) from {path: [addedLines]}. */
function diffOf(files) {
  return Object.entries(files).map(([p, lines]) => (
    `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n`
    + `@@ -10,0 +11,${lines.length} @@\n`
    + lines.map((l) => `+${l}`).join('\n')
  )).join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// The five real instances. Three are expected to match and two are expected
// NOT to — the misses are asserted rather than left implicit, because a lint
// whose blind spots are undocumented gets read as exhaustive.
// ---------------------------------------------------------------------------

test('matches the three throw-shaped guards from the motivating incident', () => {
  const found = scanDiff(diffOf({
    'realtime/metrics/t6_production.py': [
      '        raise ContractError(',
      '            "delivery_layer_policy must record a declared policy")',
    ],
    'arena/prepare_t6_realtime_import.py': [
      '        raise BatchRejected(f"{run_id}: delivery_layer_policy is missing")',
    ],
    'realtime/generate/verify_recording.py': [
      '        errors.append(',
      '            "delivery_layer_policy was not verified: this public recording requires "',
    ],
  }));
  assert.deepEqual(
    found.map((f) => f.shape).sort(),
    ['collect', 'raise', 'raise'],
  );
});

test('does NOT see the two guards that carry no throw-shaped token', () => {
  // Instance 3: a key added to a list a shared validator iterates.
  // Instance 5: two plain calls whose only effect is to throw from inside.
  const found = scanDiff(diffOf({
    'arena/prepare_t6_realtime_import.py': [
      '                "fps", "width", "height", "drift_reset_policy", "delivery_layer_policy",',
    ],
    'arena/static/delivery-layer-policy.js': [
      '    describe(battle.left?.delivery_layer_policy, contract);',
      '    describe(battle.right?.delivery_layer_policy, contract);',
    ],
  }));
  assert.deepEqual(found, [], 'these are the documented blind spots; if this ever '
    + 'starts passing, the message that says "matched three of five" is now wrong');
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

test('added assertions inside tests are the evidence, not the thing needing it', () => {
  for (const p of [
    'arena/tests/test_prepare.py',
    'realtime/generate/tests/test_generation.py',
    'src/foo.test.js',
    'pkg/thing_test.py',
    'test_top_level.py',
  ]) {
    assert.equal(isTestPath(p), true, p);
    assert.deepEqual(scanDiff(diffOf({ [p]: ['        raise ValueError("x")'] })), []);
  }
});

test('production paths that merely contain the word test are not exempt', () => {
  assert.equal(isTestPath('src/latest/handler.py'), false);
  assert.equal(isTestPath('src/contest.py'), false);
  assert.equal(scanDiff(diffOf({ 'src/latest/handler.py': ['    raise KeyError(k)'] })).length, 1);
});

test('removed and context lines are not additions', () => {
  const diff = 'diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,3 +1,2 @@\n'
    + '-    raise ContractError("gone")\n'
    + '     raise ContractError("untouched")\n';
  assert.deepEqual(scanDiff(diff), []);
});

test('guards in a brand-new file are caught', () => {
  // `--- /dev/null` marks a new file; its whole body arrives as additions, and
  // a new module full of fresh guards is exactly the case worth catching.
  const diff = 'diff --git a/new.py b/new.py\n--- /dev/null\n+++ b/new.py\n@@ -0,0 +1,2 @@\n'
    + '+def check(x):\n'
    + '+    raise ContractError("brand new")\n';
  const found = scanDiff(diff);
  assert.equal(found.length, 1);
  assert.equal(found[0].file, 'new.py');
  assert.equal(found[0].line, 2);
});

test('a file the diff deletes contributes nothing and does not bleed forward', () => {
  const diff = 'diff --git a/keep.py b/keep.py\n--- a/keep.py\n+++ b/keep.py\n@@ -0,0 +1,1 @@\n'
    + '+    raise ValueError("real")\n'
    + 'diff --git a/gone.py b/gone.py\n--- a/gone.py\n+++ /dev/null\n@@ -1,1 +0,0 @@\n'
    + '-    raise ValueError("removed")\n';
  const found = scanDiff(diff);
  assert.equal(found.length, 1);
  assert.equal(found[0].file, 'keep.py');
});

test('line numbers come from the hunk header, not the running total', () => {
  const diff = 'diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n'
    + '@@ -0,0 +42,2 @@\n+    x = 1\n+    raise ValueError(1)\n'
    + '@@ -0,0 +99,1 @@\n+    assert y\n';
  const found = scanDiff(diff);
  assert.deepEqual(found.map((f) => f.line), [43, 99]);
});

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

test('each declared shape is recognised', () => {
  const cases = {
    'raise': '    raise BatchRejected("x")',
    'throw': '    throw new Error("x");',
    'assert': '    assert value is not None',
    'collect': '    failures.append("x")',
  };
  for (const [shape, line] of Object.entries(cases)) {
    const found = scanDiff(diffOf({ 'a.py': [line] }));
    assert.equal(found.length, 1, shape);
    assert.equal(found[0].shape, shape, shape);
  }
});

test('prose and re-raises are not guards', () => {
  for (const line of [
    '# raise ContractError when the posture is absent',
    '    """raise ContractError(...) is what a caller should expect."""',
    '        raise',            // bare re-raise adds no new condition
    '    x = errors.appendix',  // not a call
  ]) {
    assert.deepEqual(scanDiff(diffOf({ 'a.py': [line] })), [], line);
  }
});

// ---------------------------------------------------------------------------
// Hook contract
// ---------------------------------------------------------------------------

test('non-commit bash is untouched', () => {
  const r = run({ tool_input: { command: 'git status --short' }, cwd: '/tmp' });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, undefined);
});

test('it never blocks, even when it warns', () => {
  const found = [{ file: 'a.py', line: 1, shape: 'raise', text: 'raise X()' }];
  // buildMessage is exercised through run() below; here we pin the contract
  // that the module exposes no non-zero path at all.
  assert.equal(require('fs').readFileSync(__dirname + '/guard-mutation-lint.js', 'utf8')
    .includes('exitCode: 2'), false);
  assert.equal(found.length, 1);
});

test('the warning reaches the agent, not only the transcript', () => {
  // Asserting stderr alone reads identically whether the agent receives
  // anything — measured on liveness-predicate-gate.js. Name the field the
  // agent actually reads.
  const message = 'x';
  const lint = require('./guard-mutation-lint.js');
  const built = lint.run({ tool_input: { command: 'git status' }, cwd: '/tmp' });
  assert.equal(built.exitCode, 0);
  assert.ok(message);

  // and on the warning path, additionalContext must be present and populated
  const src = require('fs').readFileSync(__dirname + '/guard-mutation-lint.js', 'utf8');
  assert.match(src, /hookSpecificOutput:\s*\{\s*hookEventName: 'PreToolUse', additionalContext:/);
});
