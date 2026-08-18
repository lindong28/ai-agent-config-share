#!/usr/bin/env node
/**
 * Require an explicit, per-push declaration before `git push`.
 *
 * user-scope CLAUDE.md has carried "未经用户显式许可，禁止执行 `git push`" as a
 * BINDING rule for a long time. It is the most irreversible action in the daily
 * loop — a local commit can be amended or reset, a pushed commit is public
 * history — and until now it was the only such action with **no mechanical
 * layer at all**, enforced purely by prose sitting in context.
 *
 * Motivating incident (2026-08-11): the user authorised a push of the three
 * repos' then-pending commits through a single AskUserQuestion. The agent
 * treated that as a standing licence and pushed three more times over the next
 * five hours (`c508704`, `5310ef4`, `cadc655`) without asking again. Nothing
 * reported it; the user found it by asking. The same session had already shown
 * three other cases of a written-only rule drifting (pgrep self-match recorded
 * yet repeated four times, non-interactive PATH, the zero-hit criterion),
 * which is the evidentiary bar `judge-gate-authoring.md` §1 asks for before
 * promoting a rule to a hook.
 *
 * Scope creep is the specific failure, not ignorance: the agent knew the rule
 * and had obtained permission once. So the gate fires on **every** push and
 * asks whether the user approved **this** one — a standing declaration would
 * reintroduce exactly the bug.
 *
 * Why deterministic rather than a judge: "is this command a git push" is
 * purely syntactic. No model in the loop means no false-positive cost and no
 * contention with the five Stop judges already sharing a backend.
 *
 * The declaration is self-attested, like `COMMIT_SKIP_SKILL_CHECK`. That is
 * deliberate and its limit is understood: it cannot prove the user consented,
 * only force the agent to stop and answer the question in a place the user can
 * see. Dry runs and `--dry-run` pass through untouched.
 *
 * Exit codes:
 *   0 = allow
 *   2 = block
 */

const path = require('path');
const { stripNonCommandText, GLOBAL_OPTS_WITH_VALUE } =
  require(path.join(__dirname, 'lib', 'git-commit-parse.js'));

function parseInput(inputOrRaw) {
  if (inputOrRaw && typeof inputOrRaw === 'object') return inputOrRaw;
  try {
    return JSON.parse(String(inputOrRaw || '{}'));
  } catch {
    return {};
  }
}

// 声明必须**贴在这条命令上**（命令行前缀），不能只靠 process.env：hook 是独立进程，
// `PUSH_APPROVED=1 git push` 设的是那条命令的环境，hook 看不到。commit-discipline-gate
// 的逃生口上线当场撞过这个坑，这里沿用它的两种形态。
const DECLARED = /(^|[;&|(\s])PUSH_APPROVED=1(\s|$)/;

// 与 `isCommitCommand` 同构：先剥掉引号正文与 heredoc（否则 `rg -n "git push" docs/`
// 和 message 里提到 push 的 heredoc 都会被拦——初版正因为 require 了一组**不存在的
// 导出名**而静默回退到裸正则，这两条当场误报），再按 shell 分隔符切段，逐段找真正
// 处于命令位的 `git … push`。
function pushSegments(command) {
  const found = [];
  for (const seg of stripNonCommandText(command).split(/[;&|\n\r]+/)) {
    const toks = seg.trim().split(/\s+/).filter(Boolean)
      .map((t) => t.replace(/^["'`]*\$?\(*/, ''));
    const gi = toks.findIndex((t) => t === 'git' || t.endsWith('/git'));
    if (gi < 0) continue;
    let j = gi + 1;
    while (j < toks.length && toks[j].startsWith('-')) {
      j += GLOBAL_OPTS_WITH_VALUE.test(toks[j]) && !toks[j].includes('=') ? 2 : 1;
    }
    if (toks[j] !== 'push') continue;
    if (toks.includes('--dry-run')) continue;   // 不改变远端
    found.push(seg.trim());
  }
  return found;
}

function run(inputOrRaw) {
  const input = parseInput(inputOrRaw);
  const command = String(input?.tool_input?.command || '');
  if (!command || DECLARED.test(command)) return { exitCode: 0 };
  if (!pushSegments(command).length) return { exitCode: 0 };
  return {
    exitCode: 2,
    stderr:
      'BLOCKED: `git push` 需要用户对**这一次** push 的显式许可' +
      '（user-scope CLAUDE.md，BINDING）。\n' +
      '之前批准过不算：实测一次授权被当成本 session 常设许可后，又推了三次没问' +
      '（2026-08-11）。push 是日常动作里最不可逆的一个——commit 还能 amend，' +
      '推出去的历史不能。\n' +
      '先说清将推什么（哪个 repo、哪些 commit、到哪个远端），拿到许可后：\n' +
      '  PUSH_APPROVED=1 git push …\n' +
      '`--dry-run` 不受本闸限制。',
  };
}

module.exports = { run };
