#!/usr/bin/env node
/**
 * PreCompact hook — capture in-progress task state before context compaction.
 *
 * What it does:
 *   Captures the minimum needed to resume the current task after
 *   compaction wipes working context:
 *     - last user message (from transcript JSONL)
 *     - current task list (from ~/.claude/tasks/<session-id>/*.json —
 *       the authoritative source Claude Code writes when TaskCreate /
 *       TaskUpdate runs; much more reliable than transcript parsing)
 *     - last assistant text (from transcript JSONL)
 *
 *   All three are written to ~/.claude/state/last-compact-snapshot.json.
 *
 *   The companion script post-compact-restore.js (wired to SessionStart
 *   with matcher=compact in settings.json) reads this file and injects
 *   a recovery briefing into the fresh context so the agent does not
 *   have to ask "what's next?".
 *
 * Design notes:
 *   - Fails silently (exit 0) on any error. Never blocks compaction.
 *   - Standalone (no require of lib/utils) so it survives ECC plugin
 *     updates or reinstalls.
 *   - Scans transcript backwards and stops as soon as all three fields
 *     are populated, so cost is bounded for long sessions.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_USER_MSG_CHARS = 2000;
const MAX_ASSISTANT_TEXT_CHARS = 800;

function readStdinJson() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { return null; }
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function extractUserText(message) {
  // user.message.content can be a string (plain prompt) or an array
  // containing tool_result / text parts. We only want the human-typed text.
  const c = message && message.content;
  if (typeof c === 'string') {
    const s = c.trim();
    // Skip synthetic wrappers Claude Code injects (e.g. "<system-reminder>...")
    if (!s || s.startsWith('<')) return null;
    return s.slice(0, MAX_USER_MSG_CHARS);
  }
  if (Array.isArray(c)) {
    const parts = c
      .filter(p => p && p.type === 'text' && typeof p.text === 'string')
      .map(p => p.text);
    if (!parts.length) return null;
    const joined = parts.join('\n').trim();
    return joined ? joined.slice(0, MAX_USER_MSG_CHARS) : null;
  }
  return null;
}

function scanTranscript(transcriptPath) {
  const result = {
    last_user_msg: null,
    last_assistant_action: null,
  };

  let content;
  try { content = fs.readFileSync(transcriptPath, 'utf8'); }
  catch { return result; }

  const lines = content.split('\n');

  // Walk backwards: most recent events first, stop once both fields found.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;

    let rec;
    try { rec = JSON.parse(line); } catch { continue; }

    if (rec.type === 'user' && !result.last_user_msg) {
      const text = extractUserText(rec.message);
      if (text) result.last_user_msg = text;
    }

    if (rec.type === 'assistant' && !result.last_assistant_action) {
      const content = rec.message && rec.message.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (
            item &&
            item.type === 'text' &&
            typeof item.text === 'string' &&
            item.text.trim()
          ) {
            result.last_assistant_action = item.text.trim().slice(0, MAX_ASSISTANT_TEXT_CHARS);
            break;
          }
        }
      }
    }

    if (result.last_user_msg && result.last_assistant_action) break;
  }

  return result;
}

function readTasksForSession(sessionId) {
  // Claude Code stores each TaskCreate'd task as ~/.claude/tasks/<session-id>/<task-id>.json
  // This is authoritative state — reflects all TaskUpdate mutations.
  if (!sessionId) return null;
  const tasksDir = path.join(os.homedir(), '.claude', 'tasks', sessionId);
  let entries;
  try { entries = fs.readdirSync(tasksDir); }
  catch { return null; }

  const tasks = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.join(tasksDir, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.id) {
        tasks.push(parsed);
      }
    } catch { /* skip malformed */ }
  }

  if (!tasks.length) return null;

  // Sort by numeric id when possible, otherwise lexicographic — matches creation order.
  tasks.sort((a, b) => {
    const na = Number(a.id);
    const nb = Number(b.id);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return String(a.id).localeCompare(String(b.id));
  });

  return tasks;
}

function readActivePlan(sessionId) {
  // The one fact compaction destroys that cannot be rederived: which plan
  // directory this session is executing. Written by `active-plan set`;
  // session-scoped so a concurrent session's plan is never picked up.
  if (!sessionId) return null;
  const sid = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '');
  if (!sid) return null;
  const p = path.join(os.homedir(), '.claude', 'state', `active-plan-${sid}.json`);
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return null; }
}

function snapshotPathFor(sessionId) {
  // Session-scoped. A single global file races: with 2+ concurrent sessions,
  // session B can overwrite the snapshot between A's PreCompact and A's
  // SessionStart, injecting B's plan into A's fresh context.
  const stateDir = path.join(os.homedir(), '.claude', 'state');
  const sid = String(sessionId || '').replace(/[^A-Za-z0-9._-]/g, '');
  return sid
    ? path.join(stateDir, `compact-snapshot-${sid}.json`)
    : path.join(stateDir, 'last-compact-snapshot.json'); // legacy fallback
}

function writeSnapshot(snapshot) {
  const stateDir = path.join(os.homedir(), '.claude', 'state');
  try { fs.mkdirSync(stateDir, { recursive: true }); } catch {}
  const snapshotPath = snapshotPathFor(snapshot && snapshot.session_id);
  try {
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
  } catch {
    // swallow — never block compaction
  }
}

function main() {
  const event = readStdinJson();
  if (!event) return;

  const transcriptPath = event.transcript_path;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return;

  const extracted = scanTranscript(transcriptPath);
  const tasks = readTasksForSession(event.session_id);
  const activePlan = readActivePlan(event.session_id);

  const snapshot = {
    timestamp: new Date().toISOString(),
    session_id: event.session_id || null,
    trigger: event.trigger || null, // "manual" or "auto"
    transcript_path: transcriptPath,
    last_user_msg: extracted.last_user_msg,
    tasks: tasks,
    active_plan: activePlan, // {plan,state,journal,dir,title} or null // array of {id,subject,status,description,activeForm,blocks,blockedBy} or null
    last_assistant_action: extracted.last_assistant_action,
  };

  writeSnapshot(snapshot);
}

try { main(); } catch { /* silent */ }
process.exit(0);
