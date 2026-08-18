'use strict';

const os = require('os');
const path = require('path');

const READ_COMMAND = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:command\s+)?(?:[^\s/]+\/)*(?:cat|sed|head|tail|less|more|bat|awk|grep|rg)\b/;
const WRAPPED_SHELL = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:command\s+)?(?:[^\s/]+\/)*(?:bash|sh|zsh)\s+-(?:lc|cl|c)\s+(['"])([\s\S]*)\1$/;
const KNOWLEDGE_PATH = /(?:\$HOME|~|\/|\.\.?\/)[^\s'"]*(?:\/skills\/|\/agents\/)[^\s'"]+\.md\b/g;

function knowledgeReadPaths(command, cwd = process.cwd(), home = os.homedir()) {
  const out = new Set();
  const source = String(command || '').replace(/\\\n/g, ' ').trim();
  const outerWrapper = source.match(WRAPPED_SHELL);
  if (outerWrapper) return knowledgeReadPaths(outerWrapper[2], cwd, home);
  const segments = source.split(/(?:&&|\|\||;|\n)/);
  for (const raw of segments) {
    const segment = raw.trim();
    const wrapped = segment.match(WRAPPED_SHELL);
    if (wrapped) {
      for (const nested of knowledgeReadPaths(wrapped[2], cwd, home)) out.add(nested);
      continue;
    }
    if (!READ_COMMAND.test(segment)) continue;
    for (const value of segment.match(KNOWLEDGE_PATH) || []) {
      if (value.startsWith('$HOME/')) out.add(path.join(home, value.slice(6)));
      else if (value.startsWith('~/')) out.add(path.join(home, value.slice(2)));
      else out.add(path.resolve(cwd, value));
    }
  }
  return [...out];
}

// Deliberately do not infer reads performed by arbitrary interpreters such as
// `python -c`: without parsing or executing that language, a path mention and a
// real read are indistinguishable. The native shell readers above are the
// observed Codex skill-loading surface.

function codexToolCommand(payload) {
  if (!payload || !['custom_tool_call', 'function_call'].includes(payload.type)) return '';
  if (typeof payload.input === 'string') return payload.input;
  if (typeof payload.arguments === 'string') {
    try {
      const args = JSON.parse(payload.arguments);
      return typeof args.cmd === 'string' ? args.cmd : typeof args.command === 'string' ? args.command : '';
    } catch {
      return '';
    }
  }
  const args = payload.input || payload.arguments;
  if (!args || typeof args !== 'object') return '';
  return typeof args.cmd === 'string' ? args.cmd : typeof args.command === 'string' ? args.command : '';
}

module.exports = { knowledgeReadPaths, codexToolCommand };
