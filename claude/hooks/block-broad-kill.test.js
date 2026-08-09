#!/usr/bin/env node
'use strict';

const { run } = require('./block-broad-kill.js');

const Q = String.fromCharCode(39); // single quote, kept out of literals so this
const D = String.fromCharCode(34); // file never contains a scannable `pkill …`

// A commit message written as a heredoc that *describes* a broad kill.
const HEREDOC_MSG = [
  `git commit -m ${D}$(cat <<${Q}EOF${Q}`,
  'feat(hooks): guard broad kills',
  '',
  `An agent ran pkill -f ${D}agent-browser${D} and killed five live sessions.`,
  'EOF',
  `)${D}`,
].join('\n');

// A multi-line single-quoted script that merely mentions the command.
const QUOTED_SCRIPT = [
  `node -e ${Q}`,
  '  const cases = [',
  '    "pkill -f foo",',
  '  ];',
  `${Q}`,
].join('\n');

const cases = [
  // [command, expected exit code, description]
  ['pkill -f "agent-browser"', 2, 'the original incident command'],
  ['pkill node', 2, 'kill by process name'],
  ['killall Chrome', 2, 'killall'],
  ['sudo pkill -f foo', 2, 'sudo prefix'],
  ['/usr/bin/pkill -f foo', 2, 'absolute path'],
  ['ls && pkill -f foo', 2, 'later half of a compound command'],
  [`${HEREDOC_MSG}\npkill -f foo`, 2, 'a real call after a heredoc still blocks'],
  [`${QUOTED_SCRIPT}\nkillall foo`, 2, 'a real call after a quoted script still blocks'],

  ['kill 50689', 0, 'kill by pid — the sanctioned path'],
  ['kill -9 50689', 0, 'kill by pid with a signal'],
  ['pgrep -fl agent-browser', 0, 'listing without killing'],
  ['echo "pkill -f foo"', 0, 'a quoted literal is not an invocation'],
  ['# pkill -f foo', 0, 'a comment'],
  ['./my-pkill-wrapper', 0, 'substring of a longer word'],
  [HEREDOC_MSG, 0, 'heredoc commit message (regression: blocked its own commit)'],
  [QUOTED_SCRIPT, 0, 'multi-line quoted script (regression: blocked its own test)'],
  // The token appears, but as an argument to a lookup builtin — nothing is killed.
  // These blocked routine PATH debugging until the check moved to command position.
  ['which pkill', 0, 'which <killer>: a lookup, names no victim'],
  ['command -v pkill', 0, 'command -v <killer>: a lookup'],
  ['type killall', 0, 'type <killer>: a lookup'],
  ['hash pkill', 0, 'hash <killer>: a lookup'],
  ['pgrep -fl pkill', 0, 'the killer name as a search pattern'],
  // Still blocked: the killer really is the command word, however it is reached.
  ['sudo pkill -f foo', 2, 'behind sudo'],
  ['command pkill -f foo', 2, 'behind the command builtin (no -v)'],
  ['FOO=1 pkill -f foo', 2, 'behind an env assignment'],
  ['/usr/bin/pkill -f foo', 2, 'by absolute path'],
];

let failed = 0;
for (const [command, want, desc] of cases) {
  const got = run({ tool_input: { command } }).exitCode;
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? '  ok  ' : '  FAIL'} exit=${got} want=${want}  ${desc}`);
}

const negatives = cases.filter(c => c[1] === 0).length;
console.log(
  failed
    ? `\n${failed} case(s) failed`
    : `\nall ${cases.length} cases pass (${negatives} negative controls)`
);
process.exit(failed ? 1 : 0);
