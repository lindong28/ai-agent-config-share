#!/usr/bin/env node
/**
 * Desktop Notification Hook (Notification · ask-recommend-gate)
 *
 * Notifies when Claude needs the user's attention:
 *   - Notification/idle_prompt        → a turn finished        ("[project] <summary>")
 *   - Notification/permission_prompt  → waiting to approve     ("[project] 🔐 …")
 *   - AskUserQuestion                 → waiting for a choice   ("[project] ❓ 等你选择 · …")
 * auth_success/elicitation_* are ignored — not attention-worthy.
 *
 * "A turn finished" deliberately reads idle_prompt and NOT the Stop event, even
 * though Stop is the event literally named "Claude finished responding". Hooks
 * in the same matcher group run in PARALLEL (measured 2026-08-10; see the
 * "同事件多闸的调度关系" section in lib/judge-log.js for the reading and its
 * scope), so a Stop-registered notifier sharing that group fires before its
 * siblings have ruled: any of the five judge gates can exit 2 and force the
 * turn to continue. (A notifier in its own matcher group would be the
 * cross-group case, which is still unmeasured — so it is not ruled out
 * either.) That
 * produces a notification pulling the user to a tab still visibly working.
 * (A 300s ECC format/typecheck hook used to widen this window to minutes; it
 * was removed from Stop on 2026-08-10, which shrinks the window but does not
 * close it.) idle_prompt is emitted by the CLI
 * itself only once nothing is loading, no tool is pending, no /loop is running,
 * and the user has not touched the terminal since the last message, so it
 * cannot fire mid-work no matter what hooks are registered. Its cost is the
 * `messageIdleNotifThresholdMs` delay (a ~/.claude.json global-config key,
 * pinned low in this repo's claude.json — the 60000 default is far too slow).
 *
 * Correspondingly the AskUserQuestion notification is NOT registered on
 * PreToolUse: it is emitted by ask-recommend-gate.js on its allow path, since
 * that gate can deny the call outright and a parallel notifier would announce a
 * question the user is never shown.
 *
 * Three backends:
 *
 *   0. Mosh relay (always attempted, self-gating): every attention-worthy
 *      event is offered to agent-desktop-notify, which walks process ancestry
 *      and relays to the MacBook only when the transport really is mosh (or
 *      the tmux session is detached). Mosh drops OSC 9, so for mosh users this
 *      is the only path that works — for questions and permissions as much as
 *      for turn-end. When it relays, the local terminal-notifier fallback is
 *      suppressed (the banner already reached the user's machine).
 *   1. Ghostty (primary for ssh/local): an OSC 9 escape written to the
 *      terminal's tty. Clicking the notification focuses the Ghostty surface
 *      that emitted it — i.e. jumps straight to the tab this session lives in.
 *      terminal-notifier cannot do this (it only foregrounds the app on
 *      whatever tab is current).
 *   2. terminal-notifier (fallback): for non-Ghostty terminals, or when the
 *      tty can't be located. Guaranteed present by install.sh.
 *
 * Every invocation appends (best-effort) one line to
 * ~/.claude/logs/desktop-notify.log — event, chosen branch, targets, relay
 * verdict — because hook stderr is not persisted and silent delivery failures
 * were otherwise undiagnosable. An unwritable log directory or a hard kill of
 * the hook process still loses the line; the log is evidence when present,
 * not proof of absence.
 *
 * Over SSH the choice is forced. terminal-notifier would fire on the *remote*
 * host (the SSH target) — invisible to the user sitting at the local terminal.
 * An OSC 9 escape written to the ssh pty, by contrast, travels back through the
 * connection and is rendered by the local terminal emulator. So in an SSH
 * session we always use OSC 9 (to SSH_TTY) and never fall back to terminal-
 * notifier. Note SSH does not forward TERM_PROGRAM / GHOSTTY_RESOURCES_DIR, so
 * isGhostty() can't be trusted remotely — the ssh pty path is the reliable
 * signal. (Requires macOS notification permission for the *local* terminal.)
 *
 * Inside tmux the escape goes straight to the attached clients' ttys, which are
 * the outer terminals' own streams (SSH-forwarded home when remote) and so need
 * no cooperation from tmux. Routing it through tmux's passthrough DCS instead
 * would subject it to pane-visibility gating and drop exactly the notifications
 * that matter — the ones for a pane you are not watching. See tmuxClientTTYs().
 *
 * Tab title and bell are intentionally NOT handled here — ghostty-tab-title.sh
 * owns the tab indicator. This hook only emits the desktop notification.
 *
 * Hook ID : stop:desktop-notify (historical — the ECC registration under that id
 *           stays disabled via ECC_DISABLED_HOOKS; this copy is invoked from
 *           settings.json's Notification event and from ask-recommend-gate.js)
 * Profiles: standard, strict
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { log } = require('./lib/utils');
const { lastAssistantMessage } = require('./lib/transcript');

const MAX_BODY_LENGTH = 100;
const ACTIVATE_BUNDLE_ID = 'com.mitchellh.ghostty';
const TRACE_PATH = path.join(process.env.HOME || '', '.claude', 'logs', 'desktop-notify.log');
const TRACE_MAX_BYTES = 512 * 1024;

/**
 * Durable one-line trace per invocation. stderr from hooks is not persisted
 * anywhere, which made every past delivery failure in this file invisible
 * until a user complained — the log is the only after-the-fact evidence of
 * which branch ran and where the escape/relay went. Truncate-at-cap instead
 * of rotating: this is diagnostic breadcrumb, not an audit trail.
 */
function trace(fields) {
  try {
    fs.mkdirSync(path.dirname(TRACE_PATH), { recursive: true });
    try {
      if (fs.statSync(TRACE_PATH).size > TRACE_MAX_BYTES) fs.truncateSync(TRACE_PATH, 0);
    } catch {}
    fs.appendFileSync(TRACE_PATH, `${new Date().toISOString()} ${JSON.stringify(fields)}\n`);
  } catch {}
}

/**
 * Extract a short summary from the last assistant message.
 */
function extractSummary(message) {
  if (!message || typeof message !== 'string') return 'Done';

  const firstLine = message
    .split('\n')
    .map(l => l.trim())
    .find(l => l.length > 0);

  if (!firstLine) return 'Done';

  return firstLine.length > MAX_BODY_LENGTH
    ? `${firstLine.slice(0, MAX_BODY_LENGTH)}...`
    : firstLine;
}

/**
 * Get project name from cwd.
 */
function getProjectName(cwd) {
  return cwd ? path.basename(cwd) : 'unknown';
}

function isGhostty() {
  return process.env.TERM_PROGRAM === 'ghostty' ||
         process.env.GHOSTTY_RESOURCES_DIR != null;
}

/**
 * Detect an SSH session. SSH_TTY also gives the exact pty whose output flows
 * back to the local terminal — the channel an OSC 9 escape must travel through.
 */
function isSSH() {
  return process.env.SSH_TTY != null || process.env.SSH_CONNECTION != null;
}

/**
 * Detect a tmux session. Inside tmux, OSC escapes must be wrapped in tmux's
 * passthrough DCS to reach the outer terminal, and must be written to the pane
 * tty (SSH_TTY is stale/absent inside long-lived panes).
 */
function isTmux() {
  return process.env.TMUX != null;
}

// O_NONBLOCK bounds the one otherwise-unbounded step in this file: opening or
// writing a tty whose reader is wedged (backpressured pty, hung mosh client)
// would block the hook synchronously with no timeout, starving the relay that
// runs after it. Nonblocking turns that into an immediate EAGAIN, which
// notifyGhostty already treats as delivery failure. The escapes are a few
// hundred bytes — far under any pty buffer — so a healthy tty never hits a
// short write.
const DEVICE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK;

function isCharDevice(devPath) {
  try {
    return fs.statSync(devPath).isCharacterDevice();
  } catch {
    return false;
  }
}

/**
 * Locate the terminal's tty. Hook subprocesses are invoked with stdin as a
 * pipe and have no controlling terminal, so /dev/tty is unavailable — but
 * fs.accessSync('/dev/tty') still PASSES (it only checks the device node's
 * permission bits), while the actual openSync throws ENXIO. So probe by
 * opening, not accessSync. On failure, walk up the process tree to the
 * ancestor that owns the real PTY (hook → sh -c(no tty) → claude(pty)) —
 * the same approach ghostty-tab-title.sh uses.
 *
 * An ancestor counts only when /dev/<tty> is a real character device. Matching
 * against "no tty" marker strings instead is what broke this: `ps -o tty=`
 * spells it "??" on macOS but "?" on Linux, so a guard written against "??"
 * alone made the walk return the bogus path "/dev/?" and silently drop every
 * notification on Linux. Opening with O_WRONLY (not 'w', which adds O_CREAT)
 * keeps a future bad path from *creating* the file it names.
 *
 * The walk shares ONE deadline rather than giving each `ps` its own timeout.
 * Per-call timeouts multiply: 12 hops × 2 calls × 2 s is a 48 s worst case,
 * which blows past every hook timeout this file runs under and — since
 * ask-recommend-gate.js now calls run() inside its own budget — could get that
 * hook hard-killed instead of failing open. A healthy `ps` returns in
 * milliseconds, so a whole-walk budget costs nothing in the normal case and
 * caps the pathological one.
 */
const TTY_WALK_BUDGET_MS = 3000;

function findTTY() {
  try {
    fs.closeSync(fs.openSync('/dev/tty', DEVICE_FLAGS));
    return '/dev/tty';
  } catch {}

  const deadline = Date.now() + TTY_WALK_BUDGET_MS;
  const ps = args => {
    const left = deadline - Date.now();
    if (left <= 0) return null;
    return (spawnSync('ps', args, { encoding: 'utf8', timeout: left }).stdout || '').trim();
  };

  let pid = process.ppid;
  for (let i = 0; i < 12 && pid > 1; i++) {
    const tty = ps(['-o', 'tty=', '-p', String(pid)]);
    if (tty === null) break;
    if (tty && isCharDevice(`/dev/${tty}`)) return `/dev/${tty}`;
    const ppid = ps(['-o', 'ppid=', '-p', String(pid)]);
    if (ppid === null) break;
    pid = parseInt(ppid, 10) || 0;
  }
  return null;
}

/**
 * Build the OSC 9 sequence, optionally wrapped in tmux's passthrough DCS
 * (ESC P tmux; … ESC \) with every inner ESC doubled, which asks the tmux
 * server to unwrap it and forward the original to the outer terminal.
 */
function osc9(body, viaPassthrough) {
  const seq = `\x1b]9;${body}\x1b\\`;
  if (!viaPassthrough) return seq;
  return `\x1bPtmux;${seq.replace(/\x1b/g, '\x1b\x1b')}\x1b\\`;
}

/**
 * The ttys of every tmux client attached to THIS pane's session. Each is the
 * outer terminal's own stream (the ssh channel home, when remote), so an escape
 * written there reaches the terminal without tmux's involvement.
 *
 * Preferred over passthrough because passthrough is gated on pane visibility:
 * tmux renders a pane's output only to clients currently displaying it, so a
 * turn that ends while you are looking at another window is silently dropped —
 * precisely the notification you most wanted. (tmux 3.4 added
 * `allow-passthrough = all` to lift exactly this restriction.) Writing to the
 * client tty is unconditional. OSC 9 draws nothing and moves no cursor, so
 * bypassing tmux's screen model cannot desync the display — but keep each
 * escape a SINGLE writeSync: one small write to a pty is atomic, whereas
 * splitting it could interleave with tmux's own rendering and corrupt both.
 *
 * Scoped by session id rather than `display -p -t <pane> '#{client_tty}'`:
 * that form falls back to some OTHER session's client when this pane's session
 * is detached, which would deliver the notification — project name and message
 * summary — to an unrelated terminal. It also names just one client when
 * several are attached. `list-clients -t <session>` has neither flaw and is
 * empty exactly when the session is truly detached.
 *
 * Twin of tmux_client_ttys() in ghostty-tab-title.sh: same algorithm, same
 * load-bearing guard, both on the Notification path. Change one, change the other.
 */
function tmuxClientTTYs() {
  const pane = process.env.TMUX_PANE;
  if (!pane) return [];
  const tmuxOut = args => (spawnSync('tmux', args, { encoding: 'utf8', timeout: 2000 }).stdout || '');

  // Load-bearing, despite looking like a routine null check: `list-clients -t ''`
  // neither fails nor returns empty — it resolves to tmux's *current* session and
  // happily lists a different session's clients. Letting an empty id through
  // silently reinstates the cross-session leak this function exists to prevent.
  const session = tmuxOut(['display', '-p', '-t', pane, '#{session_id}']).trim();
  if (!session) return [];

  return tmuxOut(['list-clients', '-t', session, '-F', '#{client_tty}'])
    .split('\n')
    .map(line => line.trim())
    .filter(tty => tty && isCharDevice(tty));
}

/**
 * Pick where to write, and whether those targets need the DCS wrapper.
 *
 * SSH_TTY is only trustworthy outside tmux: inside a long-lived pane it names
 * whichever ssh session happened to create the pane, which may be attached to
 * a different session entirely (observed: SSH_TTY=/dev/pts/3 while this pane's
 * live client was /dev/pts/1).
 *
 * The pane-tty + passthrough branch is a fallback for tmuxClientTTYs() coming
 * up empty for a *mechanical* reason — tmux not on PATH, TMUX_PANE unset, the
 * query timing out. It cannot rescue a genuinely detached session: with no
 * client attached there is no terminal to render to, on any tmux version.
 */
function pickTargets() {
  if (isTmux()) {
    const clients = tmuxClientTTYs();
    if (clients.length) return { ttys: clients, viaPassthrough: false };
    const pane = findTTY();
    return pane ? { ttys: [pane], viaPassthrough: true } : null;
  }
  const ssh = process.env.SSH_TTY;
  const tty = ssh && isCharDevice(ssh) ? ssh : findTTY();
  return tty ? { ttys: [tty], viaPassthrough: false } : null;
}

/**
 * Ghostty-native notification via OSC 9. Clicking it focuses the originating
 * surface. Returns true on success so the caller can fall back on failure.
 */
function notifyGhostty(tty, body, viaPassthrough = false) {
  let fd = null;
  try {
    const seq = osc9(body, viaPassthrough);
    fd = fs.openSync(tty, DEVICE_FLAGS);
    // A nonblocking tty can short-write when its output queue is nearly full.
    // A truncated escape produces no notification, so anything less than the
    // full sequence is a delivery failure — the caller then falls back.
    const written = fs.writeSync(fd, seq);
    return written === Buffer.byteLength(seq);
  } catch (err) {
    log(`[DesktopNotify] OSC9 write failed: ${err.message}`);
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

/**
 * Fallback: terminal-notifier (argv-based, no escaping concerns). -activate
 * foregrounds Ghostty; -group replaces same-project notifications instead of
 * stacking them.
 */
function notifyTerminalNotifier(project, body, kind) {
  const result = spawnSync('terminal-notifier', [
    '-title', `Claude Code · ${project}`,
    '-message', body,
    '-sound', 'default',
    // Attention notices (🔐/❓ — someone is waiting) get their own group so a
    // later turn-end notification for the same project cannot evict them from
    // Notification Center; the relay applies the same split via `kind`.
    '-group', kind === 'attention' ? `claude-${project}-attn` : `claude-${project}`,
    '-activate', ACTIVATE_BUNDLE_ID,
    // 3 s, not 5: the local branch's worst case (relay 4.5 s + findTTY 3 s +
    // this) must stay inside the Notification hook's 12 s budget.
  ], { stdio: 'ignore', timeout: 3000 });

  if (result.error || result.status !== 0) {
    log(`[DesktopNotify] terminal-notifier failed: ${result.error ? result.error.message : `exit ${result.status}`}`);
  }
}

/**
 * Mosh is not a byte-transparent transport and drops OSC 9. Hand the turn-ended
 * payload to the agent-desktop-notify relay (installed by this repo's
 * agent-desktop-notify/; the SSH trust fabric stays in system-config), which
 * independently proves that the active tmux client descends from mosh-server
 * before contacting the MacBook.
 *
 * The relay's --claude mode prefers a caller-built `body` and falls back to
 * building one from `cwd` + `last_assistant_message`, so the caller passes the
 * exact body it rendered locally — question and permission notifications carry
 * content that exists nowhere in the relay's own inputs.
 *
 * Returns a short status string for the trace log; 'sent' means the relay
 * process accepted the payload, not that a banner was proven on screen.
 */
function notifyMoshRelay(payload) {
  const executable = path.join(process.env.HOME || '', '.local', 'bin', 'agent-desktop-notify');
  try {
    fs.accessSync(executable, fs.constants.X_OK);
  } catch {
    return 'no-relay-bin';
  }
  const result = spawnSync(executable, ['--claude'], {
    input: payload,
    encoding: 'utf8',
    stdio: ['pipe', 'ignore', 'pipe'],
    // Must undercut the Notification hook's total budget with room for the
    // caller's own fallback work; the relay's internal ssh ConnectTimeout is
    // 3 s so a healthy-or-dead answer arrives well inside this.
    timeout: 4500,
  });
  if (result.error || result.status !== 0) {
    log(`[DesktopNotify] Mosh relay failed: ${result.error ? result.error.message : `exit ${result.status}`}`);
    return `failed:${result.error ? result.error.message : result.status}`;
  }
  // Exact line match, not substring: stderr may carry unrelated runtime
  // warnings, and a future message like "not relayed" must not read as
  // success. The two verdict markers are a stable contract with notifyClaude.
  const lines = (result.stderr || '').split('\n').map(l => l.trim());
  if (lines.includes('relayed')) return 'relayed';
  if (lines.includes('skipped:not-mosh')) return 'skipped:not-mosh';
  return `sent:${lines.filter(Boolean).join(' ').slice(0, 120)}`;
}

// --- Pending-permission stash (read side) ----------------------------------
// Written by permission-gate.js on its passthrough path; contract (freshness,
// redaction, best-effort) documented at the write side. Consumed (unlinked)
// on read so a later unrelated permission_prompt cannot replay stale entries.
const PENDING_FRESH_MS = 60 * 1000;
// Naming a single target is a stronger claim than counting: a stale entry
// whose own prompt was answered can survive (its notification never fired),
// and if the CURRENT prompt's stash write failed, that survivor would be
// mis-named as the waiting one. The permission_prompt event fires 6.3–8.1s
// after the dialog (measured 6/6 against messageIdleNotifThresholdMs=8000),
// so a genuine match is ≤~10s old; beyond 15s we only claim the count.
const PENDING_NAME_MS = 15 * 1000;
const SESSION_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

function readPendingPermissions(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return [];
  const dir = path.join(
    process.env.HOME || '',
    '.claude', 'logs', 'pending-permission', sessionId
  );
  const entries = [];
  const now = Date.now();
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      try {
        const e = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (e && typeof e.ts === 'number' && now - e.ts < PENDING_FRESH_MS && typeof e.tool === 'string') {
          entries.push(e);
        }
      } catch {}
      // Consume fresh and stale alike so a later unrelated prompt cannot replay.
      try { fs.unlinkSync(file); } catch {}
    }
  } catch {
    return [];
  }
  // Deliberately NO rmdir here: it races a writer's mkdir→write window and a
  // lost race drops that writer's candidate. Empty per-session dirs are cheap
  // and bounded by session count; correctness beats tidiness.
  return entries;
}

const ATTENTION_MAX = 80;

/** Collapse whitespace and cap length for attention labels. */
function clip(s, n = ATTENTION_MAX) {
  if (!s || typeof s !== 'string') return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * Whether this payload means "the turn is over" — the signal the Mosh relay and
 * the summary body are both keyed on. Stop is still honoured for a payload that
 * arrives on that event (nothing in this repo registers it any more, but the
 * ECC hook id stop:desktop-notify can), so this stays a two-source predicate.
 *
 * That compatibility branch is also a footgun: re-registering this file on Stop
 * reinstates exactly the premature notification described in the header, since
 * Stop fires before stop-gate.js has ruled. Keep the registration on
 * Notification; the branch exists so an externally-driven Stop payload still
 * produces a sane body, not as an invitation to wire it back up.
 */
function isTurnEnd(input) {
  if (input.hook_event_name === 'Notification') return input.notification_type === 'idle_prompt';
  return input.tool_name !== 'AskUserQuestion';
}

/**
 * The agent's closing message. Stop hands it over inline; idle_prompt does not
 * (its `message` is the fixed string "Claude is waiting for your input"), so
 * there the transcript is the only source. Returns null when unavailable —
 * extractSummary degrades that to "Done" rather than suppressing the
 * notification, since a body-less "your turn ended" still beats silence.
 */
function turnEndText(input) {
  if (typeof input.last_assistant_message === 'string') return input.last_assistant_message;
  if (!input.transcript_path) return null;
  try {
    return lastAssistantMessage(input.transcript_path);
  } catch (err) {
    log(`[DesktopNotify] transcript read failed: ${err.message}`);
    return null;
  }
}

/**
 * Build the notification body for whichever event fired, or null to stay silent.
 *
 *   AskUserQuestion                 → "[project] ❓ 等你选择 · <header>"
 *   Notification/permission_prompt  → "[project] 🔐 <message>"
 *   Notification/idle_prompt        → "[project] <first-line summary>"
 *
 * Other Notification types (auth_success, elicitation_*) return null — not
 * attention-worthy. `turnEnd` is the already-resolved closing message, passed
 * in rather than read here so the transcript is touched once per invocation.
 */
function buildBody(input, project, turnEnd) {
  if (input.tool_name === 'AskUserQuestion') {
    const qs = input.tool_input && input.tool_input.questions;
    const first = Array.isArray(qs) && qs.length ? qs[0] : null;
    const label = first ? clip(first.header || first.question) : '';
    return `[${project}] ❓ 等你选择${label ? ` · ${label}` : ''}`;
  }

  if (input.hook_event_name === 'Notification' && input.notification_type === 'permission_prompt') {
    // Wording asserts only what the stash can prove. No hook event can prove
    // WHICH dialog is on screen (parallel PermissionRequests, failed writes,
    // cleaner races — every stronger claim fell to an interleaving in review),
    // but "a request record X exists from the last 15s" is true in all of
    // them: entries only come from real passthroughs of this session, and a
    // record can be missing but never fabricated — so counts are lower
    // bounds ("至少 N") and the named one is a record, not the newest.
    const pending = readPendingPermissions(input.session_id);
    if (pending.length === 1 && Date.now() - pending[0].ts <= PENDING_NAME_MS) {
      const p = pending[0];
      return `[${project}] 🔐 等你审批 · 近期请求记录: ${clip(`${p.tool} ${p.target || ''}`.trim(), 60)}`;
    }
    if (pending.length >= 1) {
      return `[${project}] 🔐 等你审批 · 近期至少 ${pending.length} 个请求`;
    }
    return `[${project}] 🔐 ${clip(input.message) || '等你授权'}`;
  }

  if (!isTurnEnd(input)) return null;
  return `[${project}] ${extractSummary(turnEnd)}`;
}

/**
 * Fast-path entry point. Returns the stdout to echo: the original payload on a
 * Stop event (preserving the passthrough chained hooks expect), or '' for the
 * Notification / AskUserQuestion paths so nothing is mistaken for a decision.
 */
function run(raw) {
  let echoPayload = true;
  const tr = {
    env: {
      tmux: !!process.env.TMUX,
      ssh_tty: !!process.env.SSH_TTY,
      ssh_conn: !!process.env.SSH_CONNECTION,
      term_program: process.env.TERM_PROGRAM || null,
    },
  };
  try {
    const input = raw.trim() ? JSON.parse(raw) : {};
    echoPayload = input.tool_name !== 'AskUserQuestion' &&
                  input.hook_event_name !== 'Notification';

    tr.event = input.hook_event_name || null;
    tr.type = input.notification_type || input.tool_name || null;

    const project = getProjectName(input.cwd || process.cwd());
    const turnEnd = isTurnEnd(input) ? turnEndText(input) : null;
    const body = buildBody(input, project, turnEnd);
    tr.body = body;
    if (body == null) {
      tr.branch = 'not-attention';
      return echoPayload ? raw : '';
    }

    // Ordering is deliberate: the OSC 9 escapes are small nonblocking tty
    // writes (bounded by the tmux/ps probe timeouts, not by any peer's
    // read-side behavior) and must never be starved by a slow relay — over
    // plain ssh they ARE the delivery, and a hung relay eating the hook
    // budget before them would regress the path that already worked. The relay
    // then runs UNCONDITIONALLY for every attention-worthy body — not just
    // turn-end, and not gated on isSSH()/isTmux(). Both former gates lost real
    // notifications: AskUserQuestion and permission_prompt had no relay at all
    // (OSC 9 is dropped by mosh, so over the user's standard mosh transport
    // every question notification vanished), and a Claude launched in a mosh
    // shell *without* tmux has neither SSH_TTY nor TMUX and was misclassified
    // as local — its notifications fired on the remote host's own Notification
    // Center. Whether the mosh hop actually exists is agent-desktop-notify's
    // isMoshTransport() call — one place, walking real process ancestry — so a
    // plain-ssh or truly-local session costs one short-lived subprocess and
    // relays nothing, and no duplicate ever reaches the MacBook. The verdict
    // gates only the local terminal-notifier fallback: once the MacBook got
    // the banner, a copy on the remote host's Notification Center is noise.
    const kind = (input.tool_name === 'AskUserQuestion' ||
      (input.hook_event_name === 'Notification' && input.notification_type === 'permission_prompt'))
      ? 'attention' : 'turn-end';
    tr.kind = kind;
    const relayPayload = JSON.stringify({
      cwd: input.cwd,
      body,
      kind,
      last_assistant_message: turnEnd,
    });
    if (isSSH() || isTmux()) {
      tr.branch = 'remote-osc9';
      const target = pickTargets();
      let oscDelivered = 0;
      if (target) {
        tr.targets = target.ttys;
        for (const tty of target.ttys) {
          if (notifyGhostty(tty, body, target.viaPassthrough)) oscDelivered += 1;
        }
      }
      tr.osc_delivered = oscDelivered;
      tr.relayed = notifyMoshRelay(relayPayload);
      // No further fallback exists in this corner: with every OSC 9 write
      // failed (wedged/backpressured client pty — typically a sleeping or
      // frozen remote viewer) and the relay judging the transport non-mosh,
      // a remote-host terminal-notifier banner would fire on the wrong
      // machine. The realistic trigger state means no channel reaches the
      // user anyway; the trace line turns a silent loss into an evidenced one.
      if (oscDelivered === 0 && tr.relayed !== 'relayed') tr.undelivered = true;
    } else {
      tr.relayed = notifyMoshRelay(relayPayload);
      const relayDelivered = tr.relayed === 'relayed';
      tr.branch = relayDelivered ? 'local-suppressed' : 'local';
      const tty = isGhostty() ? findTTY() : null;
      tr.targets = tty ? [tty] : [];
      if (!relayDelivered && (!tty || !notifyGhostty(tty, body))) {
        notifyTerminalNotifier(project, body, kind);
      }
    }
  } catch (err) {
    tr.error = err.message;
    log(`[DesktopNotify] Error: ${err.message}`);
  } finally {
    trace(tr);
  }

  return echoPayload ? raw : '';
}

module.exports = { run };

// Legacy stdin path (when invoked directly rather than via run-with-flags).
// Read the full payload so JSON.parse succeeds; cap at 1 MB to stay bounded.
if (require.main === module) {
  const MAX_STDIN = 1024 * 1024;
  let data = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (data.length < MAX_STDIN) data += chunk;
  });
  process.stdin.on('end', () => {
    const output = run(data);
    if (output) process.stdout.write(output);
  });
}
