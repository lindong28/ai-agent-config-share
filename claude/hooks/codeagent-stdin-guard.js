#!/usr/bin/env node
/**
 * Block the common codeagent-wrapper dispatch that provides no stdin.
 *
 * Ground truth from the wrapper source (ccg-workflow/codeagent-wrapper): it
 * reads its own stdin (`io.ReadAll`) before launching the backend on EVERY run
 * except `--help` / `--version`, which exit immediately. With no EOF (a
 * background / empty pipe) that read never returns: a silent ~20-minute hang
 * with zero output that no completion callback covers (HARNESS-049). Feeding
 * EOF fixes it — append `</dev/null` (the prompt is passed as an argument, so
 * stdin is unused), or use a heredoc / pipe / the `-` stdin form.
 *
 * DESIGN — high-precision, allow-biased. Lexical shell parsing cannot decide
 * every invocation (four Codex review rounds showed each added lexing pass
 * introduced its own false-blocks). So the ONE structural rule that keeps this
 * false-block-safe: decide "is a real stdin redirect present?" on the RAW string
 * first, and if ANY `<` appears anywhere, ALLOW. That means no fragile lexing
 * (quote/comment/backslash handling) can ever corrupt stdin detection into a
 * false block. What remains — identifying codeagent-wrapper in command position
 * — fails OPEN on every ambiguity (quoted path, env/sudo/nohup/if/group prefix,
 * command substitution). The trade is missed exotic forms (a `<` inside the
 * prompt, or a `</dev/null` hidden in a comment) — backstopped by a memory — in
 * exchange for near-zero false-blocks on a hook that runs on every Bash call.
 *
 * Block iff the command contains no `<` at all AND, in the first pipe-stage of
 * some statement, the plain command token (first token after bare `VAR=val`
 * prefixes) is codeagent-wrapper (bare or path-suffixed) whose first argument is
 * not one of the wrapper's no-stdin flags (--help/-h/--version/-v/--cleanup).
 *
 * ACCEPTED RESIDUALS (allow-biased best-effort; five Codex rounds confirmed a
 * fully-correct guard needs a real bash parser, disproportionate here):
 *   - false-allow (miss): a transparent prefix (`time`/`env`/`nohup` …
 *     codeagent-wrapper), a `<` literal inside the prompt, or a `</dev/null`
 *     hidden in a comment — all fail open; the cross-session memory backstops.
 *   - false-block (rare, recoverable): a wrapper dispatch commented out after a
 *     `;` inside a `#` comment, or a backgrounded `… &` whose implicit
 *     /dev/null stdin the guard can't see — adding `</dev/null` is harmless.
 *
 * Exit codes:
 *   0 = allow
 *   2 = block (plain codeagent-wrapper run with no stdin)
 */

'use strict';

// Blank the CONTENT of quoted regions (keep quote chars/length) so a quoted `;`
// or `&&` is not a statement split point and a quoted `codeagent-wrapper` is not
// read as a command. Counts backslash parity so `\"` / `\'` inside a double /
// ANSI-C quote does not end the quote early. Used ONLY for splitting and command
// identification — never for stdin detection, which runs on the raw string.
function blankQuotedContent(s) {
  let out = '';
  let quote = null;
  let ansiC = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      let escaped = false;
      if (quote === '"' || ansiC) {
        let bs = 0;
        for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) bs++;
        escaped = bs % 2 === 1;
      }
      if (c === quote && !escaped) { quote = null; ansiC = false; out += c; }
      else out += ' ';
      continue;
    }
    if (c === '$' && (s[i + 1] === "'" || s[i + 1] === '"')) {
      out += c; out += s[i + 1]; quote = s[i + 1]; ansiC = s[i + 1] === "'"; i++;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; ansiC = false; out += c; continue; }
    out += c;
  }
  return out;
}

// Collapse a pipeline whose `|` is split across lines (backslash continuation
// or a newline adjacent to the `|`) so its downstream (pipe-fed) stage is not
// misread as an unfed first stage. Only ever merges → can only cause a fail-open
// allow, never a false block. Operates on blanked text.
function joinPipeContinuations(s) {
  return s
    .replace(/\\\n/g, ' ')
    .replace(/\|[ \t]*\n[ \t]*/g, '| ')
    .replace(/\n[ \t]*\|/g, ' |');
}

// Split into statements on `;` `\n` `&&` `||` and a whitespace-isolated `&`
// (never a `&` inside a redirect like `2>&1`). Operates on blanked text.
function splitStatements(s) {
  const stmts = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const n = s[i + 1];
    const p = s[i - 1];
    if ((c === '&' && n === '&') || (c === '|' && n === '|')) {
      stmts.push(cur); cur = ''; i++; continue;
    }
    if (c === ';' || c === '\n') { stmts.push(cur); cur = ''; continue; }
    if (c === '&' && (p === undefined || /\s/.test(p)) && (n === undefined || /[\s;\n]/.test(n))) {
      stmts.push(cur); cur = ''; continue;
    }
    cur += c;
  }
  stmts.push(cur);
  return stmts;
}

const BARE_ENV_PREFIX = /^(?:\s*[A-Za-z_][A-Za-z0-9_]*=\S*)*\s*/;
// The wrapper (main.go run()) exits WITHOUT reading stdin iff os.Args[1] is one
// of these; everything else reads stdin. Matched against the first argument.
const NO_STDIN_FLAGS = new Set(['--help', '-h', '--version', '-v', '--cleanup']);

// [commandToken, firstArg] of a stage, past bare env assignments.
function stageTokens(stage) {
  const m = stage.replace(BARE_ENV_PREFIX, '').match(/^(\S+)(?:\s+(\S+))?/);
  return m ? [m[1], m[2] || ''] : ['', ''];
}

function isWrapperToken(tok) {
  return tok === 'codeagent-wrapper' || tok.endsWith('/codeagent-wrapper');
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
  if (!command.includes('codeagent-wrapper')) return { exitCode: 0 };
  // Any `<` anywhere (input redirect / heredoc / herestring / process sub) →
  // a stdin source is plausibly present → fail open. Checked on the raw string
  // so no downstream lexing can misplace it into a false block.
  if (command.includes('<')) return { exitCode: 0 };

  for (const statement of splitStatements(joinPipeContinuations(blankQuotedContent(command)))) {
    const stage = statement.split('|')[0]; // only the first stage lacks upstream stdin
    const [cmd, firstArg] = stageTokens(stage);
    if (!isWrapperToken(cmd)) continue;
    if (NO_STDIN_FLAGS.has(firstArg)) continue; // wrapper exits without reading stdin
    return {
      exitCode: 2,
      stderr:
        'BLOCKED: `codeagent-wrapper` here has no stdin, so it will block ' +
        'reading its own stdin before the backend launches — a silent ~20-min ' +
        'hang with no output. Append `</dev/null` (the prompt is passed as an ' +
        'argument, so stdin is unused), or provide stdin via a heredoc / pipe / ' +
        'the `-` form.',
    };
  }

  return { exitCode: 0 };
}

module.exports = { run };

// Direct-invocation entrypoint. Upstream reaches run() through a hook-profile
// dispatcher (run-with-flags.js); this repo wires hooks straight into
// settings.json, so the entrypoint lives here — without it the file would load,
// export, and exit 0, i.e. silently never guard anything.
//
// Contract mirrors the dispatcher: write stderr (Claude Code shows it to the
// agent on a block), exit with run()'s code. Nothing on stdout — for PreToolUse,
// exit 0 with no output already means "allow", and emitting the payload back
// would risk being read as hook JSON.
//
// CODEAGENT_STDIN_GUARD=0 disables it without editing settings.json: this hook
// runs on every Bash call and is allow-biased but not false-block-proof, so an
// escape hatch has to exist that does not require a config edit mid-task.
if (require.main === module) {
  if (process.env.CODEAGENT_STDIN_GUARD === '0') process.exit(0);

  const MAX_STDIN = 1024 * 1024;
  let data = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (data.length < MAX_STDIN) data += chunk;
  });
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    const { exitCode, stderr } = run(data);
    if (stderr) process.stderr.write(stderr.endsWith('\n') ? stderr : `${stderr}\n`);
    process.exit(exitCode);
  });
}
