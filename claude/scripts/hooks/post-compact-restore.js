#!/usr/bin/env node
/**
 * SessionStart hook (matcher=compact) — restore pre-compaction task state.
 *
 * What it does:
 *   Reads the snapshot written by pre-compact.js and emits a JSON envelope
 *   on stdout with hookSpecificOutput.additionalContext, so Claude Code
 *   injects a recovery briefing into the fresh post-compaction context.
 *
 * Why a separate script from pre-compact.js:
 *   PreCompact's stdout is NOT injected into the model's context (per
 *   Claude Code hook docs). Only SessionStart / UserPromptSubmit can inject.
 *   So we split: PreCompact writes to disk, SessionStart reads and injects.
 *
 * Safety:
 *   - Fails silently (exit 0, no output) if snapshot missing, unparseable,
 *     or stale (> 10 min old). This means on a clean new session with an
 *     old snapshot lying around, we won't spuriously inject stale state.
 *     (Stale-window is belt-and-suspenders: Claude Code's matcher=compact
 *     filter already scopes us to post-compaction SessionStart events.)
 *   - Never throws; any error short-circuits to a clean exit.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = path.join(os.homedir(), '.claude', 'state');

function snapshotPathFor(sessionId) {
  // No legacy global fallback on the READ side. Without a session id the
  // ownership check cannot run, so falling back to the shared file would
  // re-open exactly the cross-session injection this scoping removes.
  // Injecting nothing is the safe failure: the agent re-reads its own files.
  const sid = String(sessionId || '').replace(/[^A-Za-z0-9._-]/g, '');
  return sid ? path.join(STATE_DIR, `compact-snapshot-${sid}.json`) : null;
}

function readEventSessionId() {
  // SessionStart delivers the event on stdin; we must restore only THIS
  // session's snapshot, never whichever one was written most recently.
  try { return (JSON.parse(fs.readFileSync(0, 'utf8')) || {}).session_id || null; }
  catch { return null; }
}
const MAX_SNAPSHOT_AGE_MS = 10 * 60 * 1000; // 10 minutes

function isReadableFile(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

// The action is built as DATA, then rendered — not assembled as prose. Two review
// rounds were spent trying to hold "verification completes before resuming" with regexes
// over the rendered sentence; each round the reviewer produced another wording that kept
// every keyword and inverted the behaviour. That is the failure mode `pattern-matching-
// scope.md` names: matching natural language against a spec that does not constrain its
// producer. Here the producer IS constrained — the invariant is "exactly one step of kind
// `resume`, and it is last", which a test reads off the structure instead of the prose.
function programActionSteps({ journalPresent, AUTHORITY_HINT, LEDGER_SCOPE, JOURNAL_CAVEAT, STALENESS_NOTE }) {
  // 漏传一个注入串不会报错，它会渲染成字面 `undefined` 并照常发给恢复出的 agent。既有的
  // fail-closed 纪律只覆盖步骤顺序，不覆盖内容。
  //
  // throw 会让 main() 吞掉异常、整份 briefing 都不注入——连 ledger / journal 路径和 task
  // list 一起丢。之所以仍这么写，理由是**这条路径运行期不可达**：四个片段都是调用点紧邻的
  // 无条件字符串字面量，取值不受任何运行期数据影响，只有一次代码编辑能打开它，而那一刻
  // golden 测试是红的。别把它读成「丢整份 briefing 本来就安全」——在触发前提可达的调用点
  // 上那是错的，那里该做的是只降级出问题的那一步。
  for (const [name, value] of Object.entries({ AUTHORITY_HINT, LEDGER_SCOPE, JOURNAL_CAVEAT, STALENESS_NOTE })) {
    if (typeof value !== 'string' || !value) throw new Error(`missing briefing fragment: ${name}`);
  }
  const clues = journalPresent
    ? {
        kind: 'clues',
        text: '通读 journal 找分歧线索（不限末尾几条）：从未入表的任务、既有行的验收判据/路由/' +
          'next action 更正、用户新增或改变的要求。' + JOURNAL_CAVEAT,
      }
    : {
        kind: 'clues',
        text: 'journal 缺失，表外任务没有线索源——改从 transcript、当前 task list、' +
          '以及带本 program tag 的一手产物里找；穷举不了就如实记「本次恢复未能穷举表外任务」，不得当作没有。',
      };
  return [
    {
      kind: 'verify',
      text: (journalPresent
        ? '逐行核 ledger 状态表：' + AUTHORITY_HINT
        : '逐行核 ledger 状态表，每一行都核、不只在飞的那些：' + AUTHORITY_HINT) + LEDGER_SCOPE,
    },
    clues,
    { kind: 'repair', text: '把前两步核出的偏差修进表' + (journalPresent ? '。' : '，并按上面 MISSING 那条重建 journal。') },
    { kind: 'resume', text: '完成第 1–3 步之后，才' + (journalPresent ? '按修好的表接续。' : '接续。') + STALENESS_NOTE },
  ];
}

function renderProgramAction(steps) {
  const resumeAt = steps.findIndex((step) => step.kind === 'resume');
  // Throw rather than emit a briefing whose gating is silently wrong: a resume step that
  // is not last would tell the recovering agent it may act before verifying. main() then
  // swallows it and exits 0 with NO briefing at all — that is the intended failure, not a
  // loud one: the agent re-reads its own files, which beats being handed a wrong gate.
  if (resumeAt !== steps.length - 1) throw new Error('the resume step must be last');
  if (steps.filter((step) => step.kind === 'resume').length !== 1) throw new Error('exactly one resume step');
  return 'Action: **先核后续**，顺序不可颠倒。' +
    steps.map((step, i) => `(${i + 1}) ${step.text}`).join('');
}

function buildBriefing(s) {
  const lines = [];
  let activePlanAction = null;
  lines.push('[CONTEXT WAS JUST COMPACTED] Recovery briefing captured by the PreCompact hook:');
  lines.push('');

  // Highest-value item first: the plan directory cannot be rederived from a
  // compaction summary, and long-task-protocol requires re-reading these
  // files before deciding the next action.
  const ap = s.active_plan;
  if (ap && ap.plan) {
    const markerType = Object.prototype.hasOwnProperty.call(ap, 'type') ? ap.type : 'plan';
    if (markerType === 'program') {
      if (isReadableFile(ap.plan)) {
        lines.push('## ACTIVE PROGRAM — read the ledger before doing anything else');
        lines.push(`- program: ${ap.plan}`);
        // journal.md resolves at read time — it may be created after the marker
        // was declared. Absence is surfaced, not skipped: silence would make a
        // lost journal indistinguishable from a healthy recovery. Absence
        // itself is ambiguous (lost vs. never started), so the line says how to
        // tell the two apart instead of asserting either.
        const journalPath = ap.journal || path.join(path.dirname(ap.plan), 'journal.md');
        const journalPresent = isReadableFile(journalPath);
        if (journalPresent) {
          lines.push(`- journal: ${journalPath}  (append-only 过程时间线：巡检打点、派发记录、教训)`);
        } else {
          lines.push(`- MISSING journal: ${journalPath} — ledger 目录应含 journal.md：` +
            '曾有则先找回（git/备份）；找不回或从未创建则现在新建，首条以当场时钟读数记录缺口或起点，勿以空文件冒充连续历史。');
        }
        lines.push('');
        // 核过再接续，而不是直接照着表走。ledger 的状态表是可变快照，更新它要定位行、
        // 重读、改写，新任务还要补整行；journal 只需追加。成本不对称使「表落后于事实」
        // 成为常态，而停轮对账的各条都是对**已存在的行**做形状检查（句柄空不空、next
        // action 空不空），一行陈旧但形状完好的行照样全过，缺失的行更是走不到。压缩是
        // 这份陈旧唯一会造成实伤的时刻：此处若只说「按状态与 next action 接续」，恢复出
        // 的 agent 会把一份看起来权威的旧状态当成现实，比没有台账更坏。
        //
        // 但它也**不能被收窄成「只找漏行」**：既有行的验收判据、路由、next action 更正
        // 同样先落在 journal 里，而那时一手产物还没动；漏行本身也可能只出现在较早的条目
        // 里。所以 journal 是**全部分歧的线索源**（因此要通读、不限末尾几条），线索一律
        // 回到权威源核实。这两次收放都是评审逼出来的：先当状态源会越过验收，收成只找漏行
        // 会漏掉既有行的更正——改此处前先确认没有再滑向任一侧。
        // 另一处易错：journal 里的「已完成/已交付」是过程事件，不等于 accepted——验收是
        // 单独一步，不得由对账代劳。
        // 步骤编号不是排版：它把「核完才接续」变成结构上可判的东西。上一版靠禁用
        // 「先按…接续」这类说法来防顺序颠倒，那是对自然语言做黑名单——评审当场给出
        // 绕过（保留全部措辞，另插一句「无需等待核验完成即可继续」）。编号之后，不变量
        // 落在「接续只出现在最后一步、且该步显式引用前几步」上，测试可以直接钉它。
        //
        // journal 的定位也经两轮修正：它不是状态源（据它改状态会把过程事件翻成 accepted，
        // 越过验收），但也不能收窄成「只找漏行」——既有行的验收判据、路由、next action
        // 更正同样先出现在 journal 里，而那时一手产物还没动。所以它是**分歧线索源**，
        // 线索一律回到权威源核实。权威链按 run-program.md 术语表：执行态以一手产物为准，
        // 同步锚点是判断 ledger 是否过期的唯一依据。
        const AUTHORITY_HINT = '核的是每行的同步锚点与证据指针指向的一手产物（执行态以它为准）。';
        // 十列按 task 切分，于是不属于任何一行的当前态只能落在表格以外，而上一句把注意力
        // 收在「状态表」上。三处措辞是评审逼出来的，改前先读这三条：
        //   1. 说「可能还写着」而不是「还写着」——表格以外必然非空（run-program.md 的必含项
        //      里 program_id / goal / fit_reason / created_at 都在那儿），但那些是不可变元数据，
        //      断言它们「是当前态」对多数 ledger 字面为假。
        //   2. 结尾必须带回权威链。表内每行要「核」一手产物，若表格以外的正文只需「读」就
        //      算数，它就拿到了一个连表内行都没有的权威档——而外部句柄、端口恰是最易过期的。
        //   3. 用「表格以外」不用「表外」：下一步 step 2 的「表外任务」指的是没有行的 task，
        //      两个所指相隔约 40 字；journal 缺失时 step 2 是唯一的发现通道，混掉它代价最大。
        const LEDGER_SCOPE = 'ledger 是一份文件不是一张表：表格以外的正文可能还写着不属于任何' +
          '一行的当前态，一并读、同样以一手产物为准。';
        const JOURNAL_CAVEAT = '线索一律回到对应权威源核实，不得据 journal 直接改状态，' +
          '也不得把其中的「已完成/已交付」写成 accepted——验收是单独一步。';
        const STALENESS_NOTE = '陈旧不限于 in-flight——pending / dispatched / awaiting-verify 同样会过期，' +
          'accepted 也可能被新证据推翻。停轮对账规则见 `~/.claude/commands/custom/run-program.md`。';
        activePlanAction = renderProgramAction(programActionSteps({
          journalPresent, AUTHORITY_HINT, LEDGER_SCOPE, JOURNAL_CAVEAT, STALENESS_NOTE,
        }));
      } else {
        lines.push('## ACTIVE PROGRAM — ledger unavailable');
        lines.push(`- UNAVAILABLE ledger: ${ap.plan}`);
        lines.push('');
        activePlanAction = 'Action: locate the ledger at the path above, or confirm the program was closed and clear ' +
          'the marker with `~/.claude/bin/active-plan clear`. Do not apply long-task recovery semantics.';
      }
    } else if (markerType === 'plan') {
      lines.push('## ACTIVE LONG-TASK PLAN — read these before doing anything else');
      if (ap.title) lines.push(`Task: ${ap.title}`);
      lines.push(`- plan:    ${ap.plan}`);
      // Resolve existence at read time: the marker stores expected paths, and
      // state.md / journal.md may have been created after the plan was declared.
      const exists = (f) => { try { return Boolean(f) && fs.existsSync(f); } catch { return false; } };
      const missing = [];
      for (const [label, f, note] of [
        ['state  ', ap.state, '(progress snapshot; open issues live here)'],
        ['journal', ap.journal, '(decisions & lessons; avoids repeating mistakes)'],
      ]) {
        if (exists(f)) lines.push(`- ${label}: ${f}  ${note}`);
        else missing.push(label.trim());
      }
      if (missing.length) {
        lines.push(`- NOTE: ${missing.join(' and ')} not found in ${ap.dir || 'the plan directory'} — ` +
                   'long-task-protocol requires them; create them before continuing.');
      }
      lines.push('');
      lines.push('`~/.claude/references/long-task-protocol.md` requires reading state.md and journal.md ' +
                 'before choosing the next action. The plan directory IS the handoff — no handoff document is needed.');
      lines.push('');
      activePlanAction = 'Action: read state.md and journal.md, then resume the in_progress task recorded there. ' +
        'Do NOT ask the user "what next?" and do NOT rely on the task list above — long-task sessions ' +
        'track progress in state.md, not in TaskCreate/TaskUpdate.';
    } else {
      const renderedType = JSON.stringify(markerType);
      lines.push('## ACTIVE MARKER — type is unrecognized; no recovery protocol was selected');
      lines.push(`- target: ${ap.plan}`);
      lines.push(`- type: ${renderedType === undefined ? String(markerType) : renderedType}`);
      lines.push('');
      activePlanAction = 'Action: inspect or repair this active marker before resuming. ' +
        'Do not apply long-task or program recovery semantics.';
    }
  } else {
    lines.push('## No active long-task plan was declared for this session');
    lines.push('If you are in fact executing a plan, declare it now so the next compaction can recover it:');
    lines.push('`~/.claude/bin/active-plan set <path/to/plan.md> --title "..."`');
    lines.push('');
  }

  if (s.last_user_msg) {
    lines.push('## Last user request (verbatim)');
    lines.push('> ' + s.last_user_msg.trim().replace(/\n/g, '\n> '));
    lines.push('');
  }

  if (Array.isArray(s.tasks) && s.tasks.length) {
    lines.push('## Task list at compaction time (from ~/.claude/tasks/<session>/)');
    for (const t of s.tasks) {
      const status = (t.status || 'pending').toString();
      const mark = status === 'completed' ? 'x' : status === 'in_progress' ? '>' : ' ';
      const focus = status === 'in_progress' ? '  ← CURRENT FOCUS' : '';
      const subject = (t.subject || t.activeForm || '').toString().slice(0, 200);
      lines.push(`- [${mark}] #${t.id} (${status}) ${subject}${focus}`);
    }
    lines.push('');
  }

  if (s.last_assistant_action) {
    lines.push('## What the agent was doing immediately before compaction');
    lines.push(s.last_assistant_action.trim());
    lines.push('');
  }

  lines.push('---');
  lines.push(
    activePlanAction ||
      'Action: resume the in_progress task above. Do NOT ask the user "what next?" — the state above tells you. ' +
      'If the todo list is empty or unclear, re-read the last user request and continue from there.'
  );

  return lines.join('\n');
}

function main() {
  const sid = readEventSessionId();
  const snapshotPath = snapshotPathFor(sid);
  if (!snapshotPath || !fs.existsSync(snapshotPath)) return;

  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  } catch { return; }

  // Belt-and-suspenders: the path is already session-scoped, but refuse a
  // snapshot whose recorded owner disagrees rather than injecting its plan.
  if (sid && snapshot.session_id && snapshot.session_id !== sid) return;

  // Freshness check (belt-and-suspenders on top of matcher=compact scoping)
  const ts = snapshot && snapshot.timestamp;
  if (ts) {
    const age = Date.now() - new Date(ts).getTime();
    if (!Number.isFinite(age) || age < 0 || age > MAX_SNAPSHOT_AGE_MS) return;
  }

  // Require at least one useful field; otherwise injection adds noise without value.
  const hasTasks = Array.isArray(snapshot.tasks) && snapshot.tasks.length > 0;
  const hasPlan = Boolean(snapshot.active_plan && snapshot.active_plan.plan);
  if (!snapshot.last_user_msg && !hasTasks && !snapshot.last_assistant_action && !hasPlan) {
    return;
  }

  const briefing = buildBriefing(snapshot);

  const output = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: briefing,
    },
  };

  process.stdout.write(JSON.stringify(output));
}

if (require.main === module) {
  try { main(); } catch { /* silent */ }
  process.exit(0);
} else {
  // Required by the test so the invariant can be asserted on the step structure itself.
  module.exports = { programActionSteps, renderProgramAction };
}
