#!/usr/bin/env node
/**
 * Two independent warnings about shell wait loops, reported separately:
 *
 *   [liveness-predicate]  the loop may be reading "is it done yet?" off
 *                         `pgrep -f`, which cannot answer that question.
 *   [unbounded-wait]      the loop's HEADER is lexically infinite (`while :`,
 *                         `while true`, `until false`), so nothing inside it
 *                         can ever stop it.
 *
 * They are orthogonal, and the second was added (2026-08-24) because an
 * incident failed only the second: the predicate was sound and the session
 * still idled for two hours. See INFINITE_HEADER for that case, and for the
 * two broader designs tried and measured to fail open before it. The rest of
 * this header is about the first check.
 *
 * A waiter exits when *your read* of the awaited event says so, not when the
 * event happens. `pgrep -f <pattern>` scans every process's command line, so
 * any other command mentioning the same pattern satisfies it — including a
 * concurrent copy of the check itself. The waiter then observes a match
 * forever while the thing it waited on has long finished.
 *
 * Motivating incident (2026-08-19, session b00dac76): three overlapping
 * waiters started within 66 seconds, all carrying
 * `until ! pgrep -f "rsync.*t2av-e2e"`. Each matched the others. The rsync had
 * completed with all 32 artifacts on disk; the waiters were still spinning
 * seven minutes later and only stopped when another session killed them.
 *
 * Measured properties that make this invisible to review and to one-off
 * testing, which is why a check exists at all (2026-08-19):
 *   - Whether a lone waiter deadlocks is PLATFORM-DEPENDENT. On Linux (procps)
 *     pgrep does not exclude ancestors, so `bash -c 'until ! pgrep -f TOKEN'`
 *     matches the very bash that launched it and a single waiter hangs
 *     deterministically — measured on a Linux host, pgrep returned three pids,
 *     one of them the invoking bash. On macOS/BSD, man pgrep documents that
 *     the process and all its ancestors are excluded, so it takes two waiters
 *     with the same pattern started simultaneously; one second apart and both
 *     exit. Do not read "it did not reproduce on my Mac" as "it cannot happen"
 *     — remote hosts are usually Linux, and that is where the incident ran.
 *   - The invoking shell's command line is truncated (998 bytes observed), so
 *     the same command deadlocks in a session with a short environment prefix
 *     and looks fine in one with a long prefix.
 *
 * WHY THIS IS A LINT AND NOT A GATE
 *
 * The first implementation blocked, and to decide what to block it parsed
 * quote state, here-documents, command-word position, and pgrep's option
 * grammar. An adversarial review returned six HIGH findings, every one of them
 * a place where that parser diverged from the shell: `bash -c "until ! pgrep
 * …"` and `$(pgrep … && …)` slipped past the quote mask; `bash <<'EOF'` was
 * treated as data; `cat <<"END-MARK"` was falsely blocked because the
 * delimiter had a hyphen; `until false || pgrep …` reset the statement scan;
 * `pgrep -u root -f job` parsed the wrong token as the pattern; and
 * `pgrep -f "foo||bar"` was blocked because the `||` inside the pattern read
 * as a shell operator.
 *
 * Worse than any single hole: exempting `$VAR` patterns as "undecidable" let
 * the most ordinary refactor — hoisting the pattern into a variable — pass
 * silently, and a guard that silently passes the common form is worse than no
 * guard, because "not blocked" gets read as "fine".
 *
 * So this no longer decides anything. It is a substring check with no model of
 * the shell, and it warns instead of blocking. It cannot tell a liveness
 * verdict from a diagnostic, and it says so in its own message — the reader
 * does the judging, which is the only place that judgment can be correct.
 *
 * `pkill` is deliberately out of scope: block-broad-kill.js already blocks
 * every pattern-matched kill. Naming it here produced contradictory advice
 * ("use `[f]oo`" from one hook, "no pattern kill at all" from the other).
 *
 * Exit code: always 0. This never blocks.
 */

'use strict';

/**
 * A `pgrep` invocation matching against full command lines.
 *
 * `f` may sit anywhere in a clustered short option — `-fl` is a real and
 * common spelling (block-broad-kill.js recommends it for diagnostics), and
 * anchoring on `f\b` missed it.
 */
const PGREP_FULL = /\bpgrep\b[^\n;|&]*?(?:\s-[a-zA-Z]*f[a-zA-Z]*\b|\s--full\b)/;

/** A shell wait loop. Presence only — no position analysis, by design. */
const WAIT_LOOP = /\b(?:until|while)\b/;

/**
 * Line continuations are removed before ANY matching below.
 *
 * `pgrep \<newline> -f job` reaches the shell as the argv `-f job`, so a check
 * reading the raw text misses it — found by adversarial review, and it was
 * missing while the whole suite was green. This is a lexical rule of the
 * shell, not an inference about it.
 */
const unfold = (command) => command.replace(/\\\r?\n/g, ' ');

/**
 * The second, independent check: a loop whose HEADER is lexically infinite.
 *
 * A pure trigger with NO exemption. That shape was chosen from measurement.
 * Two earlier designs each tried to certify a loop as BOUNDED, and both failed
 * open — adversarial review found eight holes this author did not:
 *
 *   1. bound tokens searched over the whole command: exempted by the word
 *      `deadline` in an ordinary English sentence, by a `timeout 5 cmd` in the
 *      loop BODY, and by an earlier, already-finished bounded loop.
 *   2. a comparison inside the loop's own condition: exempted
 *      `while [ "$n" -lt 10 ]; true; do` — bash takes the LAST command of a
 *      condition list, so that loop is infinite (measured: `while false; true`
 *      does enter the body) — plus `[ "$n" -lt 60 ] || kill -0 "$pid"`, the
 *      `-lt` inside `echo "attempt -lt limit"`, the `>>` of `((x >> 1))`, and
 *      the ordinary word `read` in `while grep -q read status.log`. It also
 *      warned on `getopts`, `((n--))`, `while shift`, `(($#))` and `-ne`
 *      countdowns — an unacceptable rate for a hook on every Bash call.
 *
 * All eight holes were in the EXEMPTION. "Is this loop bounded" is not a
 * syntactic property of the text, so a matcher cannot own it; "is this header
 * literally `while true`" is. What is left out is now left out visibly — the
 * message says so — instead of being exempted silently.
 *
 * Deliberately NOT covered: `until [ -f flag ]; do sleep 5; done` and friends,
 * unbounded but conditioned. HARNESS-391's original 2026-08-20 example has
 * that shape. A stated scope limit, not an oversight.
 *
 * Three things the shape has to get right, each found by adversarial review
 * rather than by reasoning, and each a valid Bash spelling:
 *   - a trailing comment, redirection or argument may sit between the constant
 *     and the terminator — `while true # poll` + newline `do`,
 *     `while true 2>/dev/null;`, `while : "polling";` are all real and all
 *     slipped past a version that demanded the terminator immediately.
 *     Hence `[^;&|\n\r]*`, which swallows those but stops at any statement
 *     separator or pipe.
 *   - the keyword must be in keyword POSITION. Without that, `echo while true`
 *     and a commented-out `# while true; do …` both warned.
 *   - `&&` and `||` are NOT accepted terminators: `until false || pgrep -f job`
 * has the condition `false || pgrep …`, which is decided by pgrep and is not
 * infinite at all. Allowing them made that a false positive, found by running
 * the existing pgrep fixtures against the new check rather than by the suite,
 * which only asserted the other kind on that row.
 *
 * A `break` in the body does not suppress this, by design: the 2026-08-24
 * incident was `while :;` plus `[ "$done_n" = "4" ] && break`, and that break
 * fires only on the outcome being waited for — the thing that did not happen.
 */
const INFINITE_HEADER =
  /(?:^|[;&|(){}"'\n\r]|\b(?:do|then|else)\b)\s*(?:while\s+(?::|true)|until\s+false)(?![\w-])[^;&|\n\r]*(?:[;\n\r]|\s+do\b|$)/;



function parseInput(inputOrRaw) {
  if (typeof inputOrRaw === 'string') {
    try { return inputOrRaw.trim() ? JSON.parse(inputOrRaw) : {}; } catch { return {}; }
  }
  return inputOrRaw && typeof inputOrRaw === 'object' ? inputOrRaw : {};
}

function run(inputOrRaw) {
  const input = parseInput(inputOrRaw);
  const raw = String(input?.tool_input?.command || '');
  if (!raw) return { exitCode: 0 };
  const command = unfold(raw);

  const findings = [];

  if (PGREP_FULL.test(command) && WAIT_LOOP.test(command)) {
    findings.push(['liveness-predicate', PGREP_MESSAGE]);
  }
  if (INFINITE_HEADER.test(command)) {
    findings.push(['unbounded-wait', UNBOUNDED_MESSAGE]);
  }

  if (!findings.length) return { exitCode: 0 };

  const message = findings.map(([kind, text]) => `[${kind}] ${text}`).join('\n\n');

  return {
    exitCode: 0,
    // `additionalContext` is the only channel the *agent* receives. Measured
    // 2026-08-19 with a unique-token probe, both directions: a PreToolUse hook
    // exiting 0 with text on stderr produced no observable message in the
    // agent's turn; the same call carrying
    // `hookSpecificOutput.additionalContext` arrived as a system-reminder. The
    // agent is the reader this warning exists for — it is the one writing the
    // command — so stderr alone would have made this hook a no-op. stderr is
    // kept as well, for the human reading the transcript.
    //
    // This generalizes past this hook: doc-file-warning.js warns the same way
    // (exit 0 + stderr) and by this reading has never reached the agent it
    // means to warn. Recording it here rather than in the issue ledger because
    // that file had two other live writers at the time; it is owed an entry
    // once they clear. The trap that hides it is in the *test*, not the hook:
    // asserting `stderr` is non-empty reads identically whether the agent
    // receives anything or not, so the assertion has to name the field the
    // agent actually reads.
    //
    // Known noise, first real-world sample (2026-08-19): the two regexes are
    // conjoined over the whole command string, so a call whose only mention of
    // `pgrep -f` sits inside a heredoc of prose — a review prompt describing
    // this very bug — warns anyway. Accepted: narrowing it means re-growing
    // the statement-level parser this hook exists to be rid of.
    stdout: JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: message },
    }),
    stderr: `[Hook] WARNING: ${message}`,
  };
}

const PGREP_MESSAGE =
    'This wait loop may be deciding "is it done yet?" from `pgrep -f`. That scans every ' +
    "process's command line, so anything else mentioning the same text satisfies it and the " +
    'loop never exits — silently, with no error. A plain pattern is matched by a concurrent ' +
    'copy of this very check; the `[p]attern` spelling avoids that one, but any unrelated ' +
    'command carrying the real text still matches.\n' +
    'Wait on a direct signal instead: `wait <pid>` for a child of this shell, `ps -p <pid>` for ' +
    'a pid you recorded, or have the awaited step write its own marker and wait for that. Each ' +
    'has a precondition and a way to get it wrong — the shapes are in ' +
    '~/.claude/references/background-agent-monitoring.md, section "等待器的判据与上界". Do not ' +
    'improvise one from this message; it deliberately gives no copyable recipe, because the ' +
    'one that fits in a sentence (`<cmd> && echo done > flag`) is the one that reference tells ' +
    'you not to write.\n' +
    'This check is a substring match with no model of the shell: it cannot tell a liveness ' +
    'verdict from a diagnostic listing, and it misses every other indirect predicate (file ' +
    'existence, log greps, port probes), and it only looks for `until` / `while` — other loop \n' +
    'shapes are invisible to it. Not warned is not cleared. And the reverse: if you already \n' +
    'take the pid once and poll that pid, this does not apply to you — it cannot tell that \n' +
    'shape apart, because the difference is where pgrep sits relative to the loop, and this \n' +
    'check has no model of the shell. Suppressing on `=$(pgrep` was tried and reverted: it \n' +
    'silenced the incident form itself once `| head -1` was appended to it.';

const UNBOUNDED_MESSAGE =
  'This loop header is infinite by construction — `while :` / `while true` / `until false` ' +
  'have no exit condition at all, so whatever ends this loop has to be inside the body: a ' +
  '`break`, `exit`, or `return`. That is worth a second look, because if the awaited thing ' +
  'reaches a state your `break` does not cover, nothing else will stop it, and the failure ' +
  'is silent in both directions: no error, no exit, and an idle session looks exactly like ' +
  'one whose job is still running.\n' +
  '~/.claude/CLAUDE.md states the rule without exceptions: 等待器自身要有上限. It is independent ' +
  'of how good your predicate is — a bound is required even for a direct signal (`wait <pid>`, ' +
  '`kill -0 <pid>`), because a bound protects against waiting forever, not against reading ' +
  'wrong.\n' +
  'Motivating incident (2026-08-24, session 28383173): `while :; do … curl … | grep -q ' +
  '\'"completed": true\'; sleep 20; done` awaited four paid video jobs, with ' +
  '`[ "$done_n" = "4" ] && break`. All four reached a FAILED terminal state within 18s. That ' +
  'server sets `completed` on BOTH terminal states on purpose — its source says so — so the ' +
  'predicate should have matched and the break should have fired. It did not: the waiter ' +
  'produced zero bytes, never woke the session, and the session idled for two hours. Why the ' +
  'read failed was never established. That is the whole argument for a bound — a soundly ' +
  'written predicate AND a correctly written break both failed to help, and neither failure ' +
  'was visible from outside.\n' +
  'Give the loop a bound, and decide what happens when it is reached — the shapes are in ' +
  '~/.claude/references/background-agent-monitoring.md, section "等待器的判据与上界". No ' +
  'copyable snippet here on purpose: the bound and the on-timeout action depend on what is ' +
  'being awaited. Two things that reference measured and rejected as bounds, so that reading ' +
  'it does not cost you a second round: `timeout` is GNU coreutils and is ABSENT on this ' +
  'machine (`timeout` and `gtimeout` both command-not-found, exit 127, which reads as the ' +
  'awaited command failing); and the harness\'s own `timeout_ms` does not terminate ' +
  '`run_in_background` tasks — two runs declaring 20 and 30 minutes were measured still ' +
  'running at 49.6 and 59.1 minutes, ended by hand. 上限只能写进被派发的脚本本身.\n' +
  'Scope. It looks for the three literal headers above, roughly in keyword position. Loops with ' +
  'a real condition are not matched, so `getopts`, `((n--))`, `while shift` and counter loops ' +
  'stay quiet — and so does a conditioned loop that is genuinely unbounded ' +
  '(`until [ -f /tmp/flag ]; do sleep 5; done`), which this does NOT cover. It certifies ' +
  'nothing as bounded, on purpose: two earlier versions tried to and were measured exempting ' +
  'genuinely infinite loops eight ways.\n' +
  'Measured imprecision, both directions, so you do not have to rediscover it. Warns when it ' +
  'should not: a `while true` whose bound really is in the body ' +
  '(`((SECONDS >= deadline)) && break`) — telling that apart from the incident, also a ' +
  '`while true` with a `break`, is the judgement that failed twice; one of these headers ' +
  'quoted inside a string; `while` as a bare argument (`printf ... while true`); and a header ' +
  'whose redirection fails, so the body never runs. Stays quiet when it should not: `2>&1`, ' +
  '`&>/dev/null`, or a quoted argument containing `&` or `|` after the constant, and the ' +
  'header sitting after `time`, `!`, a backtick, or `if`. Those gaps are recorded in ' +
  '`docs/issues/harness-issues.md` under HARNESS-391 rather than patched, because each round ' +
  'of patching this matcher has so far produced a new one. Not warned is not cleared.';

module.exports = { run };
