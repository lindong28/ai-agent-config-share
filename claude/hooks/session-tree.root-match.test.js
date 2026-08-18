#!/usr/bin/env node
"use strict";
// 共享的**根进程判定**测试（lib/session-tree.js），两个 hook 都依赖它，是 judge-gate-authoring.md §8 那两层之外的第三块。
//
// 为什么单独一份：这条判定决定整道闸开不开火，却两层都测不到——judge 标定台只喂文本，
// 控制流测试跑真实 `ps`（于是断言的是**这台机器此刻**的进程形态，换台机器就换结论）。
// 2026-08-09 它正是这样静默失效的：精确匹配漏掉 npm 装出的 `claude.exe`，祖先上溯返回
// no-claude-ancestor，`hasLiveTask` 返回 null，闸门 fail-open **恒不工作**，而日志里
// 只留一个无 reason 的 `detect_unavailable`，与"探测正常但没活任务"不可分辨。
//
// 所以这里把判定抽出来直接喂字符串：既覆盖真实形态，也覆盖当初引入精确匹配所要挡的
// 反例（`claude-mem`）。少任何一侧都会让下一次"顺手放宽/收紧"无声地打破另一侧。

const assert = require("assert");
const { isClaudeRoot, isAgentRoot } = require("./lib/session-tree");

assert.strictEqual(typeof isClaudeRoot, "function", "isClaudeRoot 未从 lib/session-tree 导出");
assert.strictEqual(typeof isAgentRoot, "function", "isAgentRoot 未从 lib/session-tree 导出");

const CASES = [
  // —— 必须认得的真实形态 ——
  ["/opt/homebrew/bin/claude", true, "homebrew shim"],
  ["/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe", true,
    "npm 装出的真二进制；漏掉它 = 整道闸恒不工作"],
  ["claude.exe", true, "裸 .exe"],
  ["claude", true, "裸名"],
  ["claude bg-pty-host", true, "带标题的 claude 子进程"],
  ["claude bg-spare", true, "同上"],

  // —— 必须挡住的同前缀进程 ——
  // 认错这些会以 helper 为根、漏掉真正的后台任务并返回 false，即**错误开火**，
  // 而误报是本闸最不能犯的错。精确匹配当初就是为这个引入的。
  ["claude-mem", false, "同前缀 helper"],
  ["/usr/local/bin/claude-mem", false, "带路径的同前缀 helper"],
  ["claude-code-helper", false, "同前缀 helper"],
  ["claude-mem.exe", false, "同前缀 helper 的 .exe 形态"],

  // —— 无关与退化输入 ——
  ["node", false, "无关进程"],
  ["python3", false, "无关进程"],
  ["", false, "空 comm"],
  [null, false, "comm 缺失（ps 行解析不出时）"],
  [undefined, false, "comm 缺失"],
];

let failed = 0;
for (const [input, want, why] of CASES) {
  const got = isClaudeRoot(input);
  if (got !== want) {
    failed++;
    console.error(`FAIL isClaudeRoot(${JSON.stringify(input)}) = ${got}，期望 ${want} —— ${why}`);
  }
}
assert.strictEqual(failed, 0, `${failed} 条根进程判定不符`);

for (const input of ["codex", "/opt/homebrew/bin/codex", "codex exec"]) {
  assert.strictEqual(isAgentRoot(input), true, `isAgentRoot(${JSON.stringify(input)}) 应识别 Codex 根进程`);
}
assert.strictEqual(isAgentRoot("codex-mcp-server"), false, "不得把 Codex helper 当作 session 根进程");

console.log(`session-tree.root-match.test.js: ok (${CASES.length} 条)`);
