#!/usr/bin/env node
'use strict';

const { run } = require('./liveness-predicate-gate.js');

const D = String.fromCharCode(34); // double quote
const Q = String.fromCharCode(39); // single quote

// The hook never blocks, so exit code carries no information.
//
// What is asserted is delivery on the channel the *agent* actually receives:
// `hookSpecificOutput.additionalContext`. Asserting on stderr instead would
// pass identically while the agent saw nothing — measured 2026-08-19, an
// exit-0 stderr warning produced no observable message in the agent's turn.
// The hook now carries two independent checks, and the assertions are
// per-kind rather than "did anything warn". That is load-bearing, not tidiness:
// the two checks overlap on real commands (a `while :` poller can also grep
// `pgrep -f`). Under a boolean `warns()`, an `expect false` row asserting "this
// -f spelling is
// not matched" would flip to true for the *other* reason, and the rows that
// isolate the `-f` requirement — `pgrep -x`, `pgrep sshd` — would go green with
// the pgrep logic deleted entirely. Reading one kind at a time keeps each row
// discriminating for the thing it was written to discriminate.
const kinds = (command, toolName, toolInput) => {
  const r = run({ tool_name: toolName, tool_input: { command, ...toolInput } });
  if (r.exitCode !== 0) throw new Error(`hook must never block, got exitCode=${r.exitCode}`);
  if (!r.stdout) return [];
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { throw new Error(`stdout is not valid JSON: ${r.stdout}`); }
  const ctx = parsed?.hookSpecificOutput?.additionalContext;
  if (parsed?.hookSpecificOutput?.hookEventName !== 'PreToolUse') {
    throw new Error(`wrong hookEventName: ${parsed?.hookSpecificOutput?.hookEventName}`);
  }
  if (!ctx) throw new Error('stdout present but additionalContext empty');
  if (!r.stderr) throw new Error('agent channel carried the warning but the human channel did not');
  return [...ctx.matchAll(/\[(liveness-predicate|unbounded-wait)\]/g)].map((m) => m[1]);
};

const warns = (command) => kinds(command).includes('liveness-predicate');
const unbounded = (command, toolName, toolInput) =>
  kinds(command, toolName, toolInput).includes('unbounded-wait');

const cases = [
  // [command, expect warning, description]

  // --- must warn ---
  [
    `until ! pgrep -f ${D}rsync.*t2av-e2e${D} >/dev/null; do sleep 45; done; echo PULL_DONE`,
    true,
    'the 2026-08-19 incident command verbatim',
  ],
  [
    `PATTERN=${Q}rsync.*t2av-e2e${Q}\nuntil ! pgrep -f ${D}$PATTERN${D}; do sleep 5; done`,
    true,
    'pattern hoisted into a variable — the ordinary refactor the blocking version let through',
  ],
  [
    // Two waiters both carrying the literal `[r]sync.*t2av` do NOT match each
    // other — the regex wants `rsync`, the text has `[r]sync`. Warning anyway
    // is still right, for the other reason: any unrelated command carrying the
    // real text `rsync…t2av` satisfies it.
    `until ! pgrep -f ${D}[r]sync.*t2av${D}; do sleep 5; done`,
    true,
    'bracket form stops the concurrent-copy match but not unrelated matches',
  ],
  [
    `while pgrep -fl job; do sleep 5; done`,
    true,
    'f not last in a clustered option — `-fl` is the spelling block-broad-kill recommends',
  ],
  [
    `bash -c ${D}until ! pgrep -f job; do sleep 1; done${D}`,
    true,
    'nested shell — the quote mask used to treat this executing text as data',
  ],
  [`until false || pgrep -f job; do sleep 1; done`, true, 'leading operator used to reset the statement scan'],
  [`until ! /usr/bin/pgrep -f job; do sleep 1; done`, true, 'absolute path'],
  [`until ! command pgrep -f job; do sleep 1; done`, true, 'command-word prefix'],
  [`while pgrep -u root -f job; do sleep 5; done`, true, 'option taking a value before -f'],
  [`while pgrep --full job; do sleep 5; done`, true, 'long option'],
  [`while pgrep -af job >/dev/null; do sleep 5; done`, true, 'clustered flag carries f'],
  [
    // Reported by adversarial review 2026-08-24 as an INDEPENDENT pre-existing
    // gap: bash passes `-f job` as argv here, but the raw text has a newline
    // between them, so the regex did not span it. The whole suite was green
    // while this was broken — and stayed green after the fix, until a mutation
    // (removing the unfold) failed to turn anything red. That zero is why this
    // row exists.
    `DEADLINE=$((SECONDS+60))\nwhile pgrep \\\n  -f job && [ $SECONDS -lt $DEADLINE ]; do\n  sleep 5\ndone`,
    true,
    'line continuation between `pgrep` and `-f` — argv-level truth the raw text hides',
  ],

  // --- must stay silent ---
  [
    `pgrep -af job || true`,
    false,
    'diagnostic listing with failure normalized — no loop, so no runaway to warn about',
  ],
  [`pgrep -af rsync | head -5`, false, 'diagnostic inspection'],
  [
    `if pgrep -f job; then echo busy; fi`,
    false,
    'one-shot conditional cannot spin forever — the failure being warned about needs a loop',
  ],
  [
    `until ! kill -0 12345 2>/dev/null; do sleep 5; done`,
    false,
    'the recommended replacement — silent on THIS kind; also silent on unbounded-wait, which does not cover conditioned loops (asserted below as a SCOPE LIMIT)',
  ],
  [`while pgrep sshd; do sleep 5; done`, false, 'no flags at all: matches process names, not command lines'],
  [
    // Isolates the `f` in the flag test. Without it, dropping the -f
    // requirement entirely leaves every other case green — measured.
    `while pgrep -x sshd; do sleep 5; done`,
    false,
    'a flag that is not -f: still matches names only, must stay silent',
  ],
  [`while read -r line; do echo "$line"; done < f`, false, 'a loop with no pgrep at all'],
  ['', false, 'empty command'],
  [`ls -la`, false, 'unrelated command'],

  [
    // Suppressing on `=$(pgrep` was tried 2026-08-19 and reverted: it silenced
    // this — the incident form with `| head -1` appended. A regex cannot tell
    // "take the pid once" from "re-decide every round"; that difference is
    // where pgrep sits relative to the loop.
    'until [ -z "$(pgrep -f job | head -1)" ]; do sleep 5; done',
    true,
    'incident form with a pipe appended — must not be silenced by any capture heuristic',
  ],
  [
    'while pid=$(pgrep -f "rsync.*t2av"); do sleep 5; done',
    true,
    're-decides every round despite the assignment shape',
  ],

  // --- known, accepted imprecision (documented, not aspirational) ---
  [
    'pid=$(pgrep -f job | head -1); while ps -p "$pid"; do sleep 5; done',
    true,
    'KNOWN FALSE POSITIVE: the recommended remedy still warns; the message says so in both directions',
  ],

  [
    `git commit -m ${D}fix: until ! pgrep -f foo deadlocked the batch${D}`,
    true,
    'KNOWN FALSE POSITIVE: a commit message describing the bug warns; accepted because it only warns',
  ],
  [
    `until [ -f /tmp/flag ]; do sleep 5; done`,
    false,
    'KNOWN MISS: file-existence waiter is the same class of indirect predicate, still not covered here',
  ],
];

// The second check: a lexically infinite loop header. Independent of predicate
// quality by design — CLAUDE.md「等待器自身要有上限」has no exception for a
// sound predicate. The SCOPE LIMIT rows below are the honest part: they are
// genuinely unbounded loops this check does not claim to cover, after two
// earlier designs claimed to cover them and silently exempted them instead.
const boundCases = [
  // [command, expect warning, description, toolName, toolInput]

  // --- must warn: the three literal infinite headers ---
  [
    `while :; do done_n=0; for j in $J; do curl -s --max-time 5 http://127.0.0.1:8908/jobs/$j | grep -q ${D}"completed": true${D} && done_n=$((done_n+1)); done; [ ${D}$done_n${D} = ${D}4${D} ] && break; sleep 20; done`,
    true,
    'the 2026-08-24 incident command verbatim — sound predicate, infinite header, two hours idle',
  ],
  [`while true; do sleep 5; done`, true, '`while true`'],
  [`until false; do sleep 5; done`, true, '`until false` is the same loop spelled the other way'],
  [
    `while :; do check || break; sleep 5; done`,
    true,
    'a `break` does not suppress it — the incident had one, on the outcome that never arrived',
  ],
  [
    `timeout 600 bash -c ${Q}while :; do sleep 5; done${Q}`,
    true,
    '`timeout` is not a bound: background-agent-monitoring.md:68 measured it absent on this machine (exit 127)',
  ],
  [
    `while true; do tail -f log; sleep 5; done`,
    true,
    'Monitor persistent is caller-authored and not a bound — the protocol allows no such exception',
    'Monitor',
    { persistent: true },
  ],

  // --- must stay silent: NOT exemptions, but stated scope limits ---
  // Each of these is genuinely unbounded. The previous design tried to judge
  // them and silently exempted all five while claiming to cover them. Being
  // out of scope and saying so beats being in scope and wrong.
  [
    `until [ -f /tmp/flag ]; do sleep 5; done`,
    false,
    'SCOPE LIMIT: conditioned but unbounded — HARNESS-391 original example is this shape',
  ],
  [`until ! kill -0 12345 2>/dev/null; do sleep 5; done`, false, 'SCOPE LIMIT: conditioned, unbounded'],
  [
    `n=0\nwhile [ ${D}$n${D} -lt 10 ]; true; do sleep 1; done`,
    false,
    'SCOPE LIMIT: bash takes the LAST command of a condition list, so this is infinite — not lexically though',
  ],
  [`while grep -q read status.log; do sleep 5; done`, false, 'SCOPE LIMIT: conditioned, unbounded'],

  // --- must stay silent: ordinary bounded loops (the noise that sank v2) ---
  [`while getopts ${D}ab:${D} opt; do :; done`, false, 'getopts consumes a finite argument list'],
  [`while (($#)); do shift; done`, false, 'argument consumption terminates'],
  [`n=10; while ((n--)); do work; done`, false, 'counting down'],
  [`while shift; do :; done`, false, 'argument consumption terminates — v2 warned on this'],
  [
    `while [ ${D}$retries${D} -ne 0 ]; do retry; retries=$((retries-1)); done`,
    false,
    '`-ne` countdown — v2 warned on this; a warning this common is wallpaper',
  ],
  [
    `DEADLINE=$((SECONDS+300)); while ((SECONDS<DEADLINE)); do curl -s http://x; sleep 5; done`,
    false,
    'a real deadline loop',
  ],
  [
    `i=0\nwhile [ ! -s ${D}$flag${D} ] && [ ${D}$i${D} -lt ${D}$N${D} ]; do sleep 5; i=$((i+1)); done`,
    false,
    'the counter background-agent-monitoring.md:49 actually recommends',
  ],
  [`for i in $(seq 1 15); do curl -s http://x && break; sleep 1; done`, false, 'a counted `for`'],
  [`while read -r line; do echo ${D}$line${D}; done < f`, false, 'iteration, not waiting'],
  [`echo ${D}waiting with no deadline${D}; until [ -f /tmp/x ]; do sleep 5; done`, false, 'prose cannot exempt what was never in scope'],
  ['', false, 'empty command'],
  [`ls -la`, false, 'unrelated command'],
  [
    `until false || pgrep -f job; do sleep 1; done`,
    false,
    'the condition is `false || pgrep …` — decided by pgrep, not infinite; `&&`/`||` must not terminate the header',
  ],

  // --- spellings that must NOT be a way around it (all valid Bash) ---
  // Every one of these was reported by adversarial review as a miss: the
  // constant was there, but a comment, a redirection or an argument sat
  // between it and the terminator.
  [`while true # poll forever\ndo\n  sleep 5\ndone`, true, 'trailing comment, `do` on the next line'],
  [`while : # poll\ndo\n  sleep 5\ndone`, true, 'same, spelled `:`'],
  [`until false # poll\ndo\n  sleep 5\ndone`, true, 'same, spelled `until false`'],
  [`while true 2>/dev/null; do sleep 5; done`, true, 'redirection after the constant'],
  [`while : ${D}polling${D}; do sleep 5; done`, true, 'argument after `:`'],
  [`bash -c ${D}while true; do sleep 5; done${D}`, true, 'nested shell — quote is a keyword position'],
  [`out=$(while :; do echo x; sleep 1; done)`, true, 'inside command substitution'],
  [`make && while :; do sleep 5; done`, true, 'after `&&`'],

  // --- keyword position: these are not loops at all ---
  [`echo while true`, false, '`while` as an argument, not a keyword — warned before keyword position was required'],
  [`# while true; do sleep 5; done`, false, 'a commented-out loop does not run'],
  [
    `git commit -m ${D}fix: while :; do sleep 5; done spun forever${D}`,
    false,
    'was a KNOWN FALSE POSITIVE; requiring keyword position silenced it as a side effect',
  ],

  // --- known, accepted imprecision ---
  [
    `deadline=$((SECONDS+30))\nwhile true; do ((SECONDS >= deadline)) && break; sleep 1; done`,
    true,
    'KNOWN FALSE POSITIVE, deliberate: the bound really is in the body, but telling that apart from the incident (also `while true` + `break`) is the judgement that failed twice',
  ],
];
let failed = 0;
for (const [command, expected, description] of cases) {
  let got;
  try { got = warns(command); } catch (e) { console.log(`FAIL  ${e.message}  ${description}`); failed++; continue; }
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  warn=${got} want=${expected}  ${description}`);
}

for (const [command, expected, description, toolName, toolInput] of boundCases) {
  let got;
  try { got = unbounded(command, toolName, toolInput); } catch (e) { console.log(`FAIL  ${e.message}  ${description}`); failed++; continue; }
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  unbounded=${got} want=${expected}  ${description}`);
}

// Instrument sanity: the runner must be able to observe a warning at all. If
// this ever passes silently, every `warn=false` above is vacuous.
const sanity = run({ tool_input: { command: `until ! pgrep -f sentinel; do sleep 1; done` } });
if (!/WARNING/.test(sanity.stderr || '')) {
  console.log('FAIL  instrument sanity: hook produced no warning for the canonical case');
  failed++;
}

// Per-kind controls. `kinds()` reads a tag out of the message, so a typo in
// either tag would silently turn one whole block into "nothing ever warns" —
// which reads exactly like "every case passed". Each control asserts one kind
// fires ALONE on a command chosen to carry only that defect, so it doubles as
// the negative control for the other kind.
// Must still be a wait loop — the first draft of this control used a
// loop-free command, so BOTH kinds were absent and "predicate alone" was
// vacuously false. It failed, which is the only reason this note exists.
const onlyPredicate = kinds(`while pgrep -f job; do sleep 5; done`);
if (!(onlyPredicate.includes('liveness-predicate') && !onlyPredicate.includes('unbounded-wait'))) {
  console.log(`FAIL  control: expected liveness-predicate alone, got ${JSON.stringify(onlyPredicate)}`);
  failed++;
}
const onlyBound = kinds(`while :; do curl -s http://x; sleep 5; done`);
if (!(onlyBound.includes('unbounded-wait') && !onlyBound.includes('liveness-predicate'))) {
  console.log(`FAIL  control: expected unbounded-wait alone, got ${JSON.stringify(onlyBound)}`);
  failed++;
}
// Both at once must produce both, not the first one found.
const both = kinds(`while :; do pgrep -fl job; sleep 5; done`);
if (!(both.includes('liveness-predicate') && both.includes('unbounded-wait'))) {
  console.log(`FAIL  control: a command failing both checks must report both, got ${JSON.stringify(both)}`);
  failed++;
}
// And it must never block, on any case above.
if (sanity.exitCode !== 0) {
  console.log('FAIL  instrument sanity: hook returned a blocking exit code');
  failed++;
}

const total = cases.length + boundCases.length;
console.log(
  failed === 0
    ? `\nAll ${total} cases passed (${cases.length} liveness-predicate, ${boundCases.length} unbounded-wait) + 5 controls.`
    : `\n${failed} case(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
