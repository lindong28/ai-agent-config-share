#!/usr/bin/env node
/**
 * At commit time, enumerate the fail-closed guards this diff adds and ask the
 * one question that separates a guard from a decoration: which mutation makes
 * it red?
 *
 * A guard you just wrote is, by default, not covered. The suite passes before
 * you add it and after, so its pass count carries no information about it —
 * and "205 passed" gets read as "the invariant is now held". It ships, and
 * from then on every reader of that code believes something the tests do not
 * check.
 *
 * Motivating measurements (2026-08-19, session dea90a56, five instances in one
 * session, every one found only by the author manually deleting the guard
 * afterwards):
 *   - `t6_production.py` delivery-posture fail-closed — deleted, 276 passed.
 *   - `prepare_t6_realtime_import.py` delivery gate — deleted, 297 passed.
 *   - the same file's audit/summary cross-check entry — deleted, 301 passed.
 *   - `verify_recording.py` "public contract must carry a receipt" — deleted,
 *     205 passed.
 *   - a renderer's pre-validation — deleted, all 6 tests passed; it turned out
 *     to be genuinely redundant, which is also something only the mutation
 *     said.
 * Each went green again only after a rejection case was written for it. Three
 * rounds of high-tier adversarial review ran over that same diff and found
 * none of the five: they report logic defects, and an uncovered guard is not a
 * logic defect. That is why this sits at commit rather than in a review
 * contract.
 *
 * The rule this serves already exists and is always loaded — user CLAUDE.md,
 * 「取证的充分性」: "报通过时跑阴性对照". It did not fire five times in a row
 * because writing a guard does not feel like 下结论; the moment has no reading
 * attached to it. So this adds no rule. It makes the moment visible, on a list
 * you did not have to remember to produce.
 *
 * WHY THIS WARNS AND NEVER BLOCKS
 *
 * Deciding "is this line a guard" means parsing the diff's languages. Its
 * sibling liveness-predicate-gate.js started as a blocker, grew a shell parser
 * to decide precisely, and an adversarial review returned six HIGH findings —
 * every one a place where the parser diverged from the real grammar. It was
 * rewritten as a substring lint. The general result it recorded applies here
 * unchanged: a guard that silently passes the common form is worse than no
 * guard, because "not blocked" gets read as "fine". So this decides nothing.
 * It shows you lines and asks a question; you do the judging.
 *
 * WHAT IT STRUCTURALLY CANNOT SEE (measured on its own motivating incident)
 *
 * Of the five instances above it matches three. The other two carry no
 * throw-shaped token at all: one added a key to a list that a shared validator
 * iterates, and one was a pair of plain calls whose only effect was to throw
 * from inside. There is no syntax to match there. Not warned is not cleared —
 * the message says so, because a lint whose silence reads as a pass is the
 * failure it exists to prevent.
 *
 * Exit code: always 0.
 */

'use strict';

const { execFileSync } = require('child_process');
const { isCommitCommand, commitCwds } = require('./lib/git-commit-parse');

/**
 * Added lines that look like a fail-closed branch.
 *
 * The first three are language syntax — spec'd forms whose producer is
 * required to write them that way, which is the condition user CLAUDE.md
 * 「模式匹配只用于有 spec 的对象」 puts on using a pattern at all.
 *
 * The fourth is not. `errors.append(...)` is a naming convention, and a
 * codebase that accumulates failures under any other name is invisible to it.
 * It is here because the motivating incident's most consequential instance had
 * exactly that shape, and because this hook only ever shows lines to a reader
 * — it never decides. On an unfamiliar repo this is the row to expect to miss.
 */
const GUARD_SHAPES = [
  { name: 'raise', re: /^\s*raise\s+[A-Za-z_][\w.]*\s*\(/ },
  { name: 'throw', re: /^\s*throw\s+new\s+[A-Za-z_][\w.]*\s*\(/ },
  { name: 'assert', re: /^\s*assert\s+\S/ },
  { name: 'collect', re: /\b\w*(?:error|failure|problem)s?\s*\.\s*(?:append|push)\s*\(/i },
];

/** A file whose added assertions ARE the evidence, not the thing needing it. */
function isTestPath(p) {
  return /(^|\/)tests?\//.test(p)
    || /(^|\/)(?:test_|conftest)/.test(p)
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(p)
    || /_test\.(?:py|go|js|ts)$/.test(p);
}

function parseInput(inputOrRaw) {
  if (typeof inputOrRaw === 'string') {
    try { return inputOrRaw.trim() ? JSON.parse(inputOrRaw) : {}; } catch { return {}; }
  }
  return inputOrRaw && typeof inputOrRaw === 'object' ? inputOrRaw : {};
}

/**
 * The worktree diff against HEAD, not the index.
 *
 * Deliberately the superset: `git commit --only <paths>` commits worktree
 * content rather than what was staged, so an index-only read would miss
 * exactly the spelling the create-commit skill mandates. Over-inclusion is the
 * safe direction for something that only ever asks a question.
 */
function diffAgainstHead(cwd) {
  try {
    return execFileSync('git', ['diff', 'HEAD', '-U0'], {
      cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null; // no commits yet, not a repo, or git unavailable — say nothing
  }
}

/** Added guard-shaped lines, with the file and the post-image line number. */
function scanDiff(diff) {
  const found = [];
  let file = null;
  let skip = true;
  let lineNo = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      // No /dev/null special case: a deleted file's hunk carries only `-`
      // lines, so it can never produce a finding. One was written here and
      // removed after a mutation showed the test covering it stayed green
      // either way — it was inert, and inert code reads as load-bearing.
      file = raw.slice(4).replace(/^b\//, '');
      skip = isTestPath(file);
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = /^@@ -\S+ \+(\d+)/.exec(raw);
      lineNo = m ? Number(m[1]) : 0;
      continue;
    }
    if (skip || raw.startsWith('---') || raw.startsWith('+++')) continue;
    if (!raw.startsWith('+')) continue;
    const text = raw.slice(1);
    const shape = GUARD_SHAPES.find(({ re }) => re.test(text));
    if (shape) found.push({ file, line: lineNo, shape: shape.name, text: text.trim() });
    lineNo += 1;
  }
  return found;
}

function buildMessage(found) {
  const shown = found.slice(0, 20);
  const list = shown
    .map(({ file, line, text }) => `  ${file}:${line}  ${text.slice(0, 100)}`)
    .join('\n');
  const more = found.length > shown.length
    ? `\n  … and ${found.length - shown.length} more\n`
    : '\n';

  return (
    `This commit adds ${found.length} fail-closed guard${found.length === 1 ? '' : 's'}:\n` +
    `${list}${more}` +
    'For each one: which mutation makes it red? Delete it, run the suite, confirm a test ' +
    'fails, restore it. If nothing fails, the guard is not held by anything — the suite ' +
    "passes identically with and without it, so its pass count says nothing about it, and " +
    'it ships as an invariant everyone will believe and nothing checks.\n' +
    'This is not a new rule. User CLAUDE.md 「取证的充分性」 already says to run a negative ' +
    'control when you report a pass; it did not fire because writing a guard does not feel ' +
    'like reporting one. This just attaches the moment to a list.\n' +
    'What it cannot see: guards with no throw-shaped token — a key added to a list some ' +
    'shared validator iterates, or a call whose only effect is to throw from inside. On the ' +
    'incident that motivated this hook it matched three of five. Not warned is not cleared. ' +
    'It also reads the whole worktree diff, not just what you staged, so lines from other ' +
    'work may appear here.'
  );
}

function run(inputOrRaw) {
  const input = parseInput(inputOrRaw);
  const command = String(input?.tool_input?.command || '');
  if (!command || !isCommitCommand(command)) return { exitCode: 0 };

  const cwds = commitCwds(command, input?.cwd || process.cwd());
  const cwd = (cwds && cwds[0]) || input?.cwd || process.cwd();

  const diff = diffAgainstHead(cwd);
  if (!diff) return { exitCode: 0 };

  const found = scanDiff(diff);
  if (!found.length) return { exitCode: 0 };

  const message = buildMessage(found);
  return {
    exitCode: 0,
    // additionalContext is the only channel the agent receives — measured on
    // liveness-predicate-gate.js, both directions: exit 0 with stderr alone
    // produced no observable message in the agent's turn. The agent is the
    // reader here, so stderr alone would make this hook a no-op. stderr is
    // kept for the human reading the transcript.
    stdout: JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `[guard-mutation] ${message}` },
    }),
    stderr: `[Hook] WARNING: ${message}`,
  };
}

module.exports = { run, scanDiff, isTestPath };
