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
        if (isReadableFile(journalPath)) {
          lines.push(`- journal: ${journalPath}  (append-only 过程时间线：巡检打点、派发记录、教训)`);
        } else {
          lines.push(`- MISSING journal: ${journalPath} — ledger 目录应含 journal.md：` +
            '曾有则先找回（git/备份）；找不回或从未创建则现在新建，首条以当场时钟读数记录缺口或起点，勿以空文件冒充连续历史。');
        }
        lines.push('');
        activePlanAction = 'Action: 按 ledger 的状态与 next action 列接续；停轮对账规则见 ' +
          '`~/.claude/commands/custom/run-program.md`。';
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

try { main(); } catch { /* silent */ }
process.exit(0);
