#!/usr/bin/env node
/**
 * Desktop Notification Hook (Stop)
 *
 * Notifies when Claude finishes responding. Two backends, in priority order:
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
 * Inside tmux the escape is wrapped in tmux's passthrough DCS and written to the
 * pane tty, so the server unwraps it and forwards it to the outer terminal
 * (which may itself be SSH-forwarded home). Requires `allow-passthrough on`.
 *
 * Tab title and bell are intentionally NOT handled here — ghostty-tab-title.sh
 * owns the tab indicator. This hook only emits the desktop notification.
 *
 * Hook ID : stop:desktop-notify
 * Profiles: standard, strict
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { log } = require('./lib/utils');

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

/**
 * Locate the terminal's tty. Hook subprocesses are invoked with stdin as a
 * pipe and have no controlling terminal, so /dev/tty is unavailable — but
 * fs.accessSync('/dev/tty') still PASSES (it only checks the device node's
 * permission bits), while the actual openSync throws ENXIO. So probe by
 * opening, not accessSync. On failure, walk up the process tree to the
 * ancestor that owns the real PTY (hook → tool-bash(??) → node(ttysNNN)) —
 * the same approach ghostty-tab-title.sh uses.
 */
function findTTY() {
  try {
    fs.closeSync(fs.openSync('/dev/tty', 'w'));
    return '/dev/tty';
  } catch {}

  let pid = process.ppid;
  for (let i = 0; i < 12 && pid > 1; i++) {
    const tty = (spawnSync('ps', ['-o', 'tty=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).stdout || '').trim();
    if (tty && tty !== '??') return `/dev/${tty}`;
    const ppid = (spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).stdout || '').trim();
    pid = parseInt(ppid, 10) || 0;
  }
  return null;
}

/**
 * Build the OSC 9 sequence. Inside tmux, wrap it in the passthrough DCS
 * (ESC P tmux; … ESC \) with every inner ESC doubled, so the tmux server
 * unwraps it and forwards the original to the outer terminal. Needs
 * `allow-passthrough on`.
 */
function osc9(body) {
  const seq = `\x1b]9;${body}\x1b\\`;
  if (!isTmux()) return seq;
  return `\x1bPtmux;${seq.replace(/\x1b/g, '\x1b\x1b')}\x1b\\`;
}

/**
 * Ghostty-native notification via OSC 9. Clicking it focuses the originating
 * surface. Returns true on success so the caller can fall back on failure.
 */
function notifyGhostty(tty, body) {
  try {
    const fd = fs.openSync(tty, 'w');
    fs.writeSync(fd, osc9(body));
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
 * Fast-path entry point for run-with-flags.js.
 */
function run(raw) {
  try {
    const input = raw.trim() ? JSON.parse(raw) : {};
    const project = getProjectName(input.cwd || process.cwd());
    const summary = extractSummary(input.last_assistant_message);
    const body = `[${project}] ${summary}`;

    // OSC 9 is the only backend that reaches the user's *local* terminal when
    // the session isn't purely local: over SSH (terminal-notifier would fire on
    // the remote host) or inside tmux (notifyGhostty wraps the escape for
    // passthrough). In tmux, write to the pane tty so the server can unwrap and
    // forward — SSH_TTY is stale inside long-lived panes. Plain SSH: SSH_TTY.
    // No terminal-notifier fallback here; on the remote it's worse than nothing.
    if (isSSH() || isTmux()) {
      const tty = isTmux() ? findTTY() : (process.env.SSH_TTY || findTTY());
      if (tty) notifyGhostty(tty, body);
      return raw;
    }

    const tty = isGhostty() ? findTTY() : null;
    if (!tty || !notifyGhostty(tty, body)) {
      notifyTerminalNotifier(project, summary);
    }
  } catch (err) {
    log(`[DesktopNotify] Error: ${err.message}`);
  }

  return raw;
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
