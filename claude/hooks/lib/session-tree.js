"use strict";
/**
 * 本 session 的进程树：找到 claude 根进程，枚举它的全部子孙。
 *
 * ## 为什么是共享模块，而不是各 hook 自己写一份
 *
 * 2026-08-09 实测到的失效：`bg-shell-reclaim-check` 与 `continuation-claim-gate`
 * 各实现了一遍同一个遍历，两份的根进程判定不同，而且**各修对了对方的 bug**——
 *
 *   bg-shell           `includes("claude")`  认得 `claude.exe`，但会在 `claude-mem` 上误停
 *   continuation-gate  精确匹配              挡住了 `claude-mem`，但漏掉 `claude.exe`
 *
 * 后果不是"偶尔不一致"，是同一次停止里两个 hook 在生产上直接矛盾：前者点名枚举出两个
 * 持写句柄的 pid，后者同时宣布探测不可用、fail-open 放行了一条虚假的前向承诺。
 *
 * 所以判定只能有一份。改这里就同时改到全部消费者；再各写一份，下一次分歧只是时间问题。
 */

const { execFileSync } = require("child_process");

/**
 * 这个 comm 值是不是 claude 根进程？
 *
 * 两侧都要顾到，少一侧就会复发上面那两个 bug 之一：
 *
 * 1. **先剥 `.exe`**。npm 装出来的真二进制叫 `claude.exe`
 *    （`…/@anthropic-ai/claude-code/bin/claude.exe`），`/opt/homebrew/bin/claude` 只是 shim，
 *    同一台机器上两种形态会同时存在。漏掉 `.exe` 的一侧会判 `no-claude-ancestor`，
 *    调用方拿到 null 后 fail-open，**整道闸恒不工作**。
 *
 * 2. **剥完仍走精确判定**，不用 `includes("claude")`。后者会在 `claude-mem` 这类同前缀的
 *    中间进程上提前停住，以那个 helper 为根、漏掉真正的后台任务，于是"没有活任务"为假阴性
 *    ——对 continuation-gate 是**错误开火**（误报），对 bg-shell 是漏报待回收进程。
 */
function isClaudeRoot(commValue) {
  const base = String(commValue || "").trim().split("/").pop().replace(/\.exe$/, "");
  return base === "claude" || base.startsWith("claude ");
}

function isCodexRoot(commValue) {
  const base = String(commValue || "").trim().split("/").pop().replace(/\.exe$/, "");
  return base === "codex" || base.startsWith("codex ");
}

function isAgentRoot(commValue) {
  return isClaudeRoot(commValue) || isCodexRoot(commValue);
}

/** `ps` 全表 → {parent, comm, children} 三张索引。异常由调用方接。 */
function psTable() {
  const out = execFileSync("ps", ["-eo", "pid=,ppid=,comm="], {
    encoding: "utf8",
    timeout: 3000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parent = new Map();
  const comm = new Map();
  const children = new Map();
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = +m[1];
    const ppid = +m[2];
    parent.set(pid, ppid);
    comm.set(pid, m[3].trim());
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  return { parent, comm, children };
}

/**
 * 本 session 全部子孙 pid（**不含 claude 自身，也不含调用者自己**）。
 *
 * 返回 `{ ok, pids, reason }`。`ok=false` 时 `reason` 必须能区分故障类型——
 * 调用方多半会 fail-open，而一个 fail-open 的守门员若不记录**为什么**开了门，
 * 它每次失效都不可归因（这正是 2026-08-09 那次排查只能靠猜的原因）。
 *
 * 上溯取**最内层**的 claude 祖先：`claude -p` 探针会产生 claude 套 claude 的链，
 * 取最外层会把外层 session 的后台任务算作本 session 的。
 * 找不到就 `ok=false`，**不回落到 `process.ppid`**——hook 经 shell 启动，以 ppid 为根的
 * 子树只含 `{shell, hook}`，永远看不见后台任务，且日志上与"探测正常"同形。
 */
function sessionDescendants(selfPid = process.pid) {
  let t;
  try {
    t = psTable();
  } catch (e) {
    return { ok: false, pids: null, reason: (e && e.code) || "ps-failed" };
  }
  const { parent, comm, children } = t;
  let p = selfPid;
  let claude = null;
  for (let i = 0; i < 16 && p > 1; i++) {
    if (isAgentRoot(comm.get(p))) {
      claude = p;
      break;
    }
    p = parent.get(p) || 1;
  }
  if (claude === null) return { ok: false, pids: null, reason: "no-agent-ancestor" };

  const seen = new Set();
  const stack = [claude];
  while (stack.length) {
    for (const k of children.get(stack.pop()) || []) {
      if (!seen.has(k)) {
        seen.add(k);
        stack.push(k);
      }
    }
  }
  seen.delete(selfPid);
  return { ok: true, pids: seen, reason: null };
}

module.exports = { isClaudeRoot, isCodexRoot, isAgentRoot, psTable, sessionDescendants };
