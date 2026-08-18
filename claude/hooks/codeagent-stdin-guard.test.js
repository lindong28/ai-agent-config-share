#!/usr/bin/env node
/**
 * Tests for codeagent-stdin-guard.js (PreToolUse:Bash hook).
 *
 * High-precision, allow-biased. Ground truth (wrapper source): codeagent-wrapper
 * reads its own stdin on every run except `--help`/`--version`. Block ONLY the
 * unmistakable dangerous signature — a plain `codeagent-wrapper` command (first
 * token after bare VAR=val prefixes) whose first arg is not a help/version flag,
 * first in its pipeline, with no fd-0 `<` redirect and no heredoc. Everything
 * ambiguous (quoted paths, env/sudo/nohup/if/group prefixes, heredocs, command
 * substitution) FAILS OPEN by design; the memory backstops those.
 *
 * Run:  cd ~/.claude/hooks && node --test codeagent-stdin-guard.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { run } = require('./codeagent-stdin-guard.js');

function exit(command) {
  return run(JSON.stringify({ tool_input: { command } })).exitCode;
}

describe('codeagent-stdin-guard: the plain no-stdin run is blocked', () => {
  const block = [
    ['hung dispatch form',
      'CODEX_SANDBOX=read-only codeagent-wrapper --backend codex "$(cat p.md)" /repo'],
    ['plain --backend', 'codeagent-wrapper --backend codex "do a review" /repo'],
    ['default backend, no --backend', 'codeagent-wrapper "do a review" /repo'],
    ['resume form', 'codeagent-wrapper --backend codex resume abc123 "recheck" /repo'],
    ['output redirect only', 'codeagent-wrapper --backend codex "p" /repo > out.log 2>&1'],
    ['stdout piped downstream', 'codeagent-wrapper --backend codex "p" /repo | tee run.log'],
    ['after &&', 'cd /repo && codeagent-wrapper --backend codex "p" /repo'],
    ['unquoted absolute path', '/Users/x/.claude/bin/codeagent-wrapper --backend codex "p" /repo'],
    ['bare env prefix', 'CODEX_TIMEOUT=900000 codeagent-wrapper --backend codex "p" /repo'],
    ['whitespace-isolated background &', 'printf ready & codeagent-wrapper --backend codex "p" /repo'],
    ['prompt with escaped pipe, no stdin', 'codeagent-wrapper --backend codex compare\\ A\\|B /repo'],
    ['--backend token only inside the prompt quote',
      'codeagent-wrapper "review the --backend flag" /repo'],
    ['unrecognized -V flag (wrapper reads stdin)', 'codeagent-wrapper -V'],
    // A real bare dispatch as a later statement (round-4 regression: must not be
    // masked by a `#` in an escaped-space word of an earlier command).
    ['bare dispatch after printf with escaped # word',
      'printf Issue\\ #123; codeagent-wrapper --backend codex "p" /repo'],
  ];
  for (const [name, cmd] of block) {
    it(`blocks: ${name}`, () => {
      assert.equal(exit(cmd), 2, `expected block (2) for: ${cmd}`);
    });
  }
});

describe('codeagent-stdin-guard: a real stdin source is allowed', () => {
  const allow = [
    ['</dev/null appended',
      'CODEX_SANDBOX=read-only codeagent-wrapper --backend codex "$(cat p.md)" /repo </dev/null'],
    ['</dev/null before 2>&1', 'codeagent-wrapper --backend codex "p" /repo </dev/null 2>&1'],
    ['</dev/null after 2>&1', 'codeagent-wrapper --backend codex "p" /repo 2>&1 </dev/null'],
    ['backslash-continued flags + </dev/null',
      'codeagent-wrapper \\\n  --backend codex "p" \\\n  /repo </dev/null'],
    ['heredoc - form', "codeagent-wrapper --backend codex - /repo <<'EOF'\nprompt\nEOF"],
    ['herestring - form', 'codeagent-wrapper --backend codex - /repo <<< "$prompt"'],
    ['explicit input file', 'codeagent-wrapper --backend codex - /repo < prompt.txt'],
    ['process substitution AS stdin', 'codeagent-wrapper --backend codex - /repo < <(cat prompt.md)'],
    ['upstream pipe', 'cat p.md | codeagent-wrapper --backend codex - /repo'],
    ['cross-line pipe', 'cat p.md |\n  codeagent-wrapper --backend codex - /repo'],
    ['escaped pipe in prompt + </dev/null',
      'codeagent-wrapper --backend codex compare\\ A\\|B /repo </dev/null'],
    ['escaped semicolon in prompt + </dev/null',
      'codeagent-wrapper --backend codex fix\\ lint\\;\\ then\\ test /repo </dev/null'],
    // round-4 regressions: a real `<` present → allow, regardless of tricky
    // escaped-`#` words or escaped quotes in the prompt.
    ['escaped # word in prompt + </dev/null',
      'codeagent-wrapper --backend codex fix\\ #123 /repo </dev/null'],
    ['escaped quote in prompt + </dev/null',
      'codeagent-wrapper --backend codex "explain escaped JSON \\\\\\"value" /repo </dev/null'],
    // Any `<` anywhere fails open by design (accepted miss): stdin only in a
    // comment, or process substitution passed as a positional arg.
    ['stdin only inside a comment (accepted fail-open)',
      'codeagent-wrapper --backend codex "p" /repo # feed it with </dev/null'],
    ['process substitution as a positional arg (accepted fail-open)',
      'codeagent-wrapper --backend codex - /repo <(cat prompt.md)'],
  ];
  for (const [name, cmd] of allow) {
    it(`allows: ${name}`, () => {
      assert.equal(exit(cmd), 0, `expected allow (0) for: ${cmd}`);
    });
  }
});

describe('codeagent-stdin-guard: help/version and non-invocations are allowed', () => {
  const allow = [
    ['--help', 'codeagent-wrapper --help'],
    ['-h', 'codeagent-wrapper -h'],
    ['--help before --backend', 'codeagent-wrapper --help --backend codex'],
    ['--version', 'codeagent-wrapper --version'],
    ['-v short version', 'codeagent-wrapper -v'],
    ['--cleanup', 'codeagent-wrapper --cleanup'],
    ['--help with trailing comment mentioning --backend',
      'codeagent-wrapper --help # inspect --backend behavior'],
    ['which', 'which codeagent-wrapper'],
    ['command -v', 'command -v codeagent-wrapper'],
    ['grep for the tool', 'grep -n codeagent-wrapper install.sh'],
    ['pgrep quoted pattern', "pgrep -fl 'codeagent-wrapper --backend codex'"],
    ['echo mention', 'echo "run codeagent-wrapper --backend with </dev/null"'],
    ['trailing comment after echo', 'echo hi # codeagent-wrapper --backend codex "x" /repo'],
    ['unrelated command', 'ls -la /repo'],
  ];
  for (const [name, cmd] of allow) {
    it(`allows: ${name}`, () => {
      assert.equal(exit(cmd), 0, `expected allow (0) for: ${cmd}`);
    });
  }
});

describe('codeagent-stdin-guard: ambiguous forms fail open (allow) by design', () => {
  const allow = [
    ['env wrapper', 'env -u CLAUDECODE codeagent-wrapper --backend codex "p" /repo'],
    ['nohup wrapper', 'nohup codeagent-wrapper --backend codex "p" /repo >run.log'],
    ['sudo wrapper', 'sudo codeagent-wrapper --backend codex "p" /repo'],
    ['quoted executable path', '"$HOME/.claude/bin/codeagent-wrapper" --backend codex "p" /repo'],
    ['quoted env value', 'MODE="review only" codeagent-wrapper --backend codex "p" /repo'],
    ['if condition', 'if codeagent-wrapper --backend codex "p" /repo; then echo ok; fi'],
    ['subshell group', '( codeagent-wrapper --backend codex "p" /repo ) >run.log'],
    ['brace group', '{ codeagent-wrapper --backend codex "p" /repo; } >run.log'],
    ['heredoc present anywhere',
      "cat > p.md <<'EOF'\ncodeagent-wrapper --backend codex notes\nEOF\ncodeagent-wrapper --backend codex \"$(cat p.md)\" /repo"],
    ['command substitution', 'result=$(codeagent-wrapper --backend codex "p" /repo)'],
  ];
  for (const [name, cmd] of allow) {
    it(`allows (fail open): ${name}`, () => {
      assert.equal(exit(cmd), 0, `expected allow (0) for: ${cmd}`);
    });
  }
});

// Raw `codex exec` — the second prompt-as-arg dispatch shape, and the one behind
// the longer of the two recorded hangs (~43 min, background-agent-monitoring.md).
// Before this coverage existed, `codex exec "p"` was allowed while the equivalent
// wrapper form was blocked; that asymmetry is what these cases pin down.
describe('codeagent-stdin-guard: raw `codex exec` without stdin', () => {
  const block = [
    ['bare', 'codex exec "review this repo"'],
    ['absolute path', '/usr/local/bin/codex exec "p"'],
    ['bare env prefix', 'CODEX_TIMEOUT=600000 codex exec "p"'],
    ['second statement', 'cd /repo; codex exec "p"'],
  ];
  for (const [name, cmd] of block) {
    it(`blocks: ${name}`, () => {
      assert.equal(exit(cmd), 2, `expected block (2) for: ${cmd}`);
    });
  }

  const allow = [
    ['redirect from /dev/null', 'codex exec "p" </dev/null'],
    ['heredoc', "codex exec - <<'EOF'\np\nEOF"],
    ['pipe-fed', 'echo p | codex exec -'],
    ['non-exec subcommand', 'codex --help'],
    ['interactive TUI', 'codex'],
    ['mentioned in text, not command position', 'echo "run codex exec later" </dev/null'],
    ['unrelated command naming codex', 'grep -rn codex ~/.claude'],
  ];
  for (const [name, cmd] of allow) {
    it(`allows: ${name}`, () => {
      assert.equal(exit(cmd), 0, `expected allow (0) for: ${cmd}`);
    });
  }

  // Headless `claude -p` is the third prompt-as-arg shape and is deliberately
  // NOT blocked: measured 2026-08-12, it prints `Warning: no stdin data received
  // in 3s, proceeding without it` and continues. A 3-second self-limit is not the
  // failure this hook exists for, and blocking it would be a pure false block.
  it('allows headless `claude -p` (self-limits at 3s; blocking it would be a false block)', () => {
    assert.equal(exit('claude -p "summarise the diff"'), 0);
  });
});
