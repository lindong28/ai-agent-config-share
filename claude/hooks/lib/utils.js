/**
 * Utilities for user-scope Claude Code hooks.
 *
 * Ported from ECC's scripts/lib/utils.js — only the subset needed by
 * hooks in ~/.claude/hooks/ (package-manager.js, resolve-formatter.js, etc.).
 *
 * Keep consistent with ECC unless optimization brings significant improvement.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const isWindows = process.platform === 'win32';
const isMacOS = process.platform === 'darwin';

function getHomeDir() {
  return os.homedir();
}

function getClaudeDir() {
  return path.join(getHomeDir(), '.claude');
}

/**
 * Ensure a directory exists (create if not).
 */
function ensureDir(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  } catch (err) {
    if (err.code !== 'EEXIST') {
      throw new Error(`Failed to create directory '${dirPath}': ${err.message}`);
    }
  }
  return dirPath;
}

/**
 * Read a text file safely. Returns null on any error.
 */
function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Write a text file, creating parent directories as needed.
 */
function writeFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}

/**
 * Check if a command exists in PATH.
 *
 * WARNING: Spawns a child process (which/where). Do NOT call in hot paths
 * like session startup hooks — use file-based detection instead.
 */
function commandExists(cmd) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(cmd)) {
    return false;
  }

  try {
    if (isWindows) {
      const result = spawnSync('where', [cmd], { stdio: 'pipe' });
      return result.status === 0;
    } else {
      const result = spawnSync('which', [cmd], { stdio: 'pipe' });
      return result.status === 0;
    }
  } catch {
    return false;
  }
}

function log(message) {
  console.error(message);
}

module.exports = {
  isWindows,
  isMacOS,
  getHomeDir,
  getClaudeDir,
  ensureDir,
  readFile,
  writeFile,
  commandExists,
  log
};
