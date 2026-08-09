#!/usr/bin/env node
/**
 * Block pattern-matched process killing (pkill / killall).
 *
 * These select victims by name or command line, so one call reaches every
 * process that matches — including processes owned by other concurrent agent
 * sessions. That failure is silent on the caller's side: the kill succeeds,
 * nothing is reported, and the other session only sees its daemon die for no
 * reason. `kill <pid>` has no such reach and stays allowed.
 *
 * Motivating incident (2026-08-07): an agent debugging one wedged
 * agent-browser daemon ran `pkill -f "agent-browser"`. Every agent-browser
 * daemon shares the same argv with no session name in it, so the pattern
 * matched all five live sessions. The agent-browser skill prohibits exactly
 * this in writing, and the agent had that skill loaded — so the gap was not
 * missing guidance but the absence of enforcement.
 *
 * Why a hook rather than another rule: the judgment is purely syntactic
 * (killing by pattern vs. by pid), so there is no false-positive cost that
 * would need a model in the loop.
 *
 * Exit codes:
 *   0 = allow
 *   2 = block
 */

'use strict';

// Selects victims by pattern, not by pid.
const BROAD_KILLERS = ['pkill', 'killall'];

// Characters that may precede a command name for it to be a real invocation
// (start of segment, whitespace, or a path prefix like /usr/bin/).
const VALID_BEFORE = ' \t\n\r;&|$`(<{!"\'/.~\\';

/** Replace quoted spans with spaces so their contents cannot look like code. */
function blankQuotedContent(input) {
  let out = '';
  let quote = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote && input[i - 1] !== '\\') { quote = null; out += ch; }
      else out += ' ';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    out += ch;
  }
  return out;
}

/**
 * Blank here-document bodies.
 *
 * Must run before segment splitting: a heredoc body is data, but its lines
 * look exactly like commands once the input is split on newlines. Commit
 * messages in this workflow are written as heredocs, so a message that merely
 * *describes* a broad kill would otherwise be blocked — which is how this
 * hook's own commit first failed.
 */
function blankHeredocBodies(input) {
  const lines = input.split('\n');
  const out = [];
  let terminator = null;
  for (const line of lines) {
    if (terminator !== null) {
      out.push(line.trim() === terminator ? line : '');
      if (line.trim() === terminator) terminator = null;
      continue;
    }
    out.push(line);
    // `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"` — take the last opener on the line.
    const opens = [...line.matchAll(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g)];
    if (opens.length) terminator = opens[opens.length - 1][2];
  }
  return out.join('\n');
}

/** Split on shell separators so an unrelated segment cannot be misattributed. */
function splitSegments(input) {
  return input.split(/(?:\|\||&&|[;\n|&])/);
}

function isInComment(segment, idx) {
  const lineStart = segment.lastIndexOf('\n', idx - 1) + 1;
  const before = segment.slice(lineStart, idx);
  for (let i = 0; i < before.length; i++) {
    if (before[i] === '#' && before[i - 1] !== '$' && before[i - 1] !== '\\') return true;
  }
  return false;
}

/**
 * Wrappers that precede the real command word without changing what it is.
 * `command` is here because `command pkill -f x` does kill; the `-v` form is
 * handled by the "stop at the first option" rule below, which leaves the command
 * word as `-v` and therefore matches nothing.
 */
const COMMAND_PREFIXES = new Set(['sudo', 'env', 'nohup', 'exec', 'command', 'builtin', 'time', 'doas']);

/**
 * The command word of an already-blanked segment, or '' if there isn't one.
 *
 * Existence of the token is not the question — position is. `which pkill`,
 * `command -v pkill` and `type killall` all contain the token as an *argument*,
 * name no victim, and kill nothing; blocking them turns a safety gate into a
 * blocker on routine PATH debugging. Only the word in command position actually
 * runs the killer.
 */
function commandWordOf(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  for (const raw of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) continue;   // FOO=bar prefix assignment
    if (raw.startsWith('-')) return raw;                  // an option: not a command word
    const bare = raw.replace(/^.*\//, '');                // /usr/bin/pkill -> pkill
    if (COMMAND_PREFIXES.has(bare)) continue;
    return bare;
  }
  return '';
}

/** Find a real invocation of `name` in an already-blanked segment. */
function findCommand(segment, name) {
  // Position check first: it is the cheap, decisive one.
  if (commandWordOf(segment) !== name) return -1;
  let pos = 0;
  while (pos < segment.length) {
    const idx = segment.indexOf(name, pos);
    if (idx === -1) return -1;
    const after = segment[idx + name.length] || ' ';
    const before = idx > 0 ? segment[idx - 1] : ' ';
    // Reject substrings of a longer word (e.g. `pkill-wrapper`, `mypkill`).
    if (/[\s"']/.test(after) && VALID_BEFORE.includes(before) && !isInComment(segment, idx)) {
      return idx;
    }
    pos = idx + 1;
  }
  return -1;
}

function parseInput(inputOrRaw) {
  if (typeof inputOrRaw === 'string') {
    try { return JSON.parse(inputOrRaw); } catch { return {}; }
  }
  return inputOrRaw && typeof inputOrRaw === 'object' ? inputOrRaw : {};
}

function run(inputOrRaw) {
  const input = parseInput(inputOrRaw);
  const command = String(input?.tool_input?.command || '');
  if (!command) return { exitCode: 0 };

  // Order matters: quote state spans newlines, so quoted content must be
  // blanked across the whole command before it is split on them. Blanking
  // per-segment instead resets the quote state at every newline and exposes
  // the inside of a multi-line quoted string as if it were code — which is how
  // this hook first blocked its own test script.
  for (const segment of splitSegments(blankQuotedContent(blankHeredocBodies(command)))) {
    for (const killer of BROAD_KILLERS) {
      if (findCommand(segment, killer) === -1) continue;
      return {
        exitCode: 2,
        stderr:
          `BLOCKED: \`${killer}\` selects processes by pattern, so it also kills ` +
          'matching processes owned by other concurrent agent sessions — and it ' +
          'reports nothing back to you when it does.\n' +
          'Resolve the pid first, then kill only that pid:\n' +
          "  pgrep -fl '<pattern>'   # confirm exactly which pids match, and that they are yours\n" +
          '  kill <pid>\n' +
          'For an agent-browser daemon take the pid from `agent-browser doctor` ' +
          "(its `Session <name> (pid <N>)` line) rather than from pgrep or a pid file.",
      };
    }
  }

  return { exitCode: 0 };
}

module.exports = { run };
