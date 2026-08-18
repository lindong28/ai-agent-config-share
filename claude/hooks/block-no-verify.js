#!/usr/bin/env node
/**
 * Block --no-verify flag in git commands.
 *
 * Prevents AI agents from bypassing git hooks (pre-commit, commit-msg,
 * pre-push) by detecting --no-verify, commit -n shorthand, and
 * core.hooksPath overrides.
 *
 * Port of the npm package `block-no-verify@1.1.2` as a local script
 * with run() export for in-process execution via run-with-flags.js.
 *
 * Exit codes:
 *   0 = allow (no bypass attempt detected)
 *   2 = block (bypass attempt detected)
 */

'use strict';

const GIT_COMMANDS_WITH_NO_VERIFY = [
  'commit', 'push', 'merge', 'cherry-pick', 'rebase', 'am',
];

const VALID_BEFORE_GIT = ' \t\n\r;&|$`(<{!"\']/.~\\';

function isInComment(input, idx) {
  const lineStart = input.lastIndexOf('\n', idx - 1) + 1;
  const before = input.slice(lineStart, idx);
  for (let i = 0; i < before.length; i++) {
    if (before.charAt(i) === '#') {
      const prev = i > 0 ? before.charAt(i - 1) : '';
      if (prev !== '$' && prev !== '\\') return true;
    }
  }
  return false;
}

function findGit(input, start) {
  let pos = start;
  while (pos < input.length) {
    const idx = input.indexOf('git', pos);
    if (idx === -1) return null;
    const isExe = input.slice(idx + 3, idx + 7).toLowerCase() === '.exe';
    const len = isExe ? 7 : 3;
    const after = input[idx + len] || ' ';
    if (!/[\s"']/.test(after)) { pos = idx + 1; continue; }
    const before = idx > 0 ? input[idx - 1] : ' ';
    if (VALID_BEFORE_GIT.includes(before)) return { idx, len };
    pos = idx + 1;
  }
  return null;
}

function detectGitCommand(input) {
  let start = 0;
  while (start < input.length) {
    const git = findGit(input, start);
    if (!git) return null;
    if (isInComment(input, git.idx)) { start = git.idx + git.len; continue; }
    for (const cmd of GIT_COMMANDS_WITH_NO_VERIFY) {
      const cmdIdx = input.indexOf(cmd, git.idx + git.len);
      if (cmdIdx === -1) continue;
      const before = cmdIdx > 0 ? input[cmdIdx - 1] : ' ';
      const after = input[cmdIdx + cmd.length] || ' ';
      if (!/\s/.test(before)) continue;
      if (!/[\s;&#|>)\]}"']/.test(after) && after !== '') continue;
      if (/[;|]/.test(input.slice(git.idx + git.len, cmdIdx))) continue;
      if (isInComment(input, cmdIdx)) continue;
      return cmd;
    }
    start = git.idx + git.len;
  }
  return null;
}

function hasNoVerifyFlag(input, command) {
  if (/--no-verify\b/.test(input)) return true;
  if (command === 'commit') {
    if (/\s-n(?:\s|$)/.test(input) || /\s-n[a-zA-Z]/.test(input)) return true;
  }
  return false;
}

function hasHooksPathOverride(input) {
  return /-c\s+["']?core\.hooksPath\s*=/.test(input);
}

// Blank the CONTENT of quoted regions (keep the quote chars and overall length)
// so a git…subcommand or -n flag that lives inside a quoted string (grep/echo
// pattern, commit message) is not mistaken for a real command/flag. The
// hooksPath check runs on the raw segment, so a quoted `-c "core.hooksPath=…"`
// is still caught.
function blankQuotedContent(s) {
  let out = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      const escaped = quote === '"' && s[i - 1] === '\\';
      if (c === quote && !escaped) { quote = null; out += c; }
      else out += ' ';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; out += c; continue; }
    out += c;
  }
  return out;
}

// Split a compound command into segments on UNQUOTED shell separators
// (`;` `|` `&` and newlines — covers `&&` and `||`). Quotes are kept intact
// within segments so a separator inside a quoted string is not a split point.
function splitSegments(s) {
  const segs = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      const escaped = quote === '"' && s[i - 1] === '\\';
      if (c === quote && !escaped) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === ';' || c === '|' || c === '&' || c === '\n') {
      segs.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  segs.push(cur);
  return segs;
}

function parseInput(inputOrRaw) {
  if (typeof inputOrRaw === 'string') {
    try {
      return inputOrRaw.trim() ? JSON.parse(inputOrRaw) : {};
    } catch { return {}; }
  }
  return inputOrRaw && typeof inputOrRaw === 'object' ? inputOrRaw : {};
}

function run(inputOrRaw) {
  const input = parseInput(inputOrRaw);
  const command = String(input?.tool_input?.command || '');
  if (!command) return { exitCode: 0 };

  // Scope detection to each shell segment with quoted content blanked, so a
  // git…subcommand or -n in a quoted pattern / unrelated segment is not
  // misattributed to a real git invocation (HARNESS-018).
  for (const segment of splitSegments(command)) {
    const scanned = blankQuotedContent(segment);
    const gitCommand = detectGitCommand(scanned);
    if (!gitCommand) continue;

    if (hasNoVerifyFlag(scanned, gitCommand)) {
      return {
        exitCode: 2,
        stderr:
          `BLOCKED: --no-verify flag is not allowed with git ${gitCommand}. ` +
          'Git hooks must not be bypassed. Fix the issue that the hook catches instead.',
      };
    }

    if (hasHooksPathOverride(segment)) {
      return {
        exitCode: 2,
        stderr:
          `BLOCKED: Overriding core.hooksPath is not allowed with git ${gitCommand}. ` +
          'Git hooks must not be bypassed.',
      };
    }
  }

  return { exitCode: 0 };
}

module.exports = { run };
