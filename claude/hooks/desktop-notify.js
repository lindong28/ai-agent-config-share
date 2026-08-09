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
 * matching one event all run in PARALLEL, so a Stop-registered notifier fires
 * before its siblings have ruled: stop-gate.js can exit 2 and force the turn to
 * continue, and ECC's stop-format-typecheck can keep the terminal busy for
 * minutes afterwards. Both produce the same defect — a notification that pulls
 * the user to a tab still visibly working. idle_prompt is emitted by the CLI
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
 * Two backends, in priority order:
 *
 *   1. Ghostty (primary): an OSC 9 escape written to the terminal's tty.
 *      Clicking the notification focuses the Ghostty surface that emitted it —
 *      i.e. jumps straight to the tab this session lives in. terminal-notifier
 *      cannot do this (it only foregrounds the app on whatever tab is current).
 *   2. terminal-notifier (fallback): for non-Ghostty terminals, or when the
 *      tty can't be located. Guaranteed present by install.sh.
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

const DEVICE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_NOCTTY;

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
  try {
    const fd = fs.openSync(tty, DEVICE_FLAGS);
    fs.writeSync(fd, osc9(body, viaPassthrough));
    fs.closeSync(fd);
    return true;
  } catch (err) {
    log(`[DesktopNotify] OSC9 write failed: ${err.message}`);
    return false;
  }
}

/**
 * Fallback: terminal-notifier (argv-based, no escaping concerns). -activate
 * foregrounds Ghostty; -group replaces same-project notifications instead of
 * stacking them.
 */
function notifyTerminalNotifier(project, body) {
  const result = spawnSync('terminal-notifier', [
    '-title', `Claude Code · ${project}`,
    '-message', body,
    '-sound', 'default',
    '-group', `claude-${project}`,
    '-activate', ACTIVATE_BUNDLE_ID,
  ], { stdio: 'ignore', timeout: 5000 });

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
 * The relay's --claude mode builds its own title/body from `cwd` and
 * `last_assistant_message`, so the caller normalizes idle_prompt's payload into
 * that shape rather than forwarding it verbatim — idle_prompt carries neither
 * field's content, and an un-normalized forward would relay an empty body.
 */
function notifyMoshRelay(payload) {
  const executable = path.join(process.env.HOME || '', '.local', 'bin', 'agent-desktop-notify');
  try {
    fs.accessSync(executable, fs.constants.X_OK);
  } catch {
    return;
  }
  const result = spawnSync(executable, ['--claude'], {
    input: payload,
    encoding: 'utf8',
    stdio: ['pipe', 'ignore', 'pipe'],
    timeout: 8000,
  });
  if (result.error || result.status !== 0) {
    log(`[DesktopNotify] Mosh relay failed: ${result.error ? result.error.message : `exit ${result.status}`}`);
  }
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
  try {
    const input = raw.trim() ? JSON.parse(raw) : {};
    echoPayload = input.tool_name !== 'AskUserQuestion' &&
                  input.hook_event_name !== 'Notification';

    const project = getProjectName(input.cwd || process.cwd());
    const turnEnd = isTurnEnd(input) ? turnEndText(input) : null;
    const body = buildBody(input, project, turnEnd);
    if (body == null) return echoPayload ? raw : '';

    // OSC 9 is the only backend that reaches the user's *local* terminal when
    // the session isn't purely local: over SSH terminal-notifier would fire on
    // the remote host, invisible to whoever is sitting at the terminal. So no
    // terminal-notifier fallback here — on the remote it's worse than nothing.
    // pickTargets() decides which ttys carry the escape home.
    if (isSSH() || isTmux()) {
      const target = pickTargets();
      if (target) {
        for (const tty of target.ttys) notifyGhostty(tty, body, target.viaPassthrough);
      }
    } else {
      const tty = isGhostty() ? findTTY() : null;
      if (!tty || !notifyGhostty(tty, body)) notifyTerminalNotifier(project, body);
    }
    if (isTurnEnd(input) && (isSSH() || isTmux())) {
      notifyMoshRelay(JSON.stringify({ cwd: input.cwd, last_assistant_message: turnEnd }));
    }
  } catch (err) {
    log(`[DesktopNotify] Error: ${err.message}`);
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
