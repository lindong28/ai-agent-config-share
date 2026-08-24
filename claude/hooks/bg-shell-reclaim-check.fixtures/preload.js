"use strict";
/**
 * 测试预载：把这道闸对外部世界的三个依赖全部接管，使降级路径可被稳定构造。
 *
 * 为什么必须接管 `ps`：早稿只伪造 `lsof`，结果测试的成败取决于**执行者的祖先进程里有没有
 * `claude`/`codex`**——在 agent 会话里跑是绿的，在普通终端或 CI 里 `sessionDescendants()`
 * 直接返回 `ps:no-agent-ancestor`，lsof 分支根本到不了，而"正常安静"那条用例反而会看到一条
 * `unusable`。测试因此在两种环境下断言的不是同一件事，这是 review 复核轮实跑指出的。
 *
 * 为什么必须接管 `renameSync` 而不是把 state 目录设为不可写：目录不可写会让 `updateState()`
 * 在**执行 callback 之前**就失败，于是 `candidates` 恒为 0——用例会在"根本没检出候选"时假绿，
 * 与"留痕代码被删掉"取值相同。要覆盖 `!committed && candidates.length` 这一支，失败必须发生在
 * callback **之后**，即写 tmp 成功、rename 失败。
 *
 * 三个开关都从环境变量读，默认全关，所以本文件对不设开关的调用是透明的。
 */

const cp = require("child_process");
const fs = require("fs");

const FAKE_PS = process.env.BGT_FAKE_PS_OUT; // 有值则 ps 返回它
const FAKE_LSOF = process.env.BGT_FAKE_LSOF_OUT; // 有值则 lsof 返回它
const FAIL_RENAME = process.env.BGT_FAIL_RENAME === "1";

/**
 * `{{PID}}` / `{{PPID}}` 由 preload 在 **hook 自己的进程里**填入。
 *
 * 不能由测试进程预先写死：`sessionDescendants()` 是从 hook 自身的 pid 往上走祖先链，而 hook 是
 * spawn 出来的，其 pid 在构造 ps 表时还不存在。早稿把测试进程的 pid 当成 claude 写进表里，
 * hook 的 pid 却不在表中，于是祖先链断在第一跳、判 `ps:no-agent-ancestor`——用例读到的
 * 是这个，而不是它以为在测的 lsof 分支。
 */
function fillPids(tpl) {
  return tpl.split("{{PID}}").join(String(process.pid)).split("{{PPID}}").join(String(process.ppid));
}

const realExecFileSync = cp.execFileSync;
cp.execFileSync = function (file, args, opts) {
  const base = String(file).split("/").pop();
  if (base === "ps" && FAKE_PS !== undefined) return fillPids(FAKE_PS);
  if (base === "lsof" && FAKE_LSOF !== undefined) {
    if (FAKE_LSOF === "__FAIL__") {
      const e = new Error("lsof failed");
      e.status = 2; // 非 1 → runLsof 判 usable=false（1 是"没找到"，属正常）
      throw e;
    }
    return FAKE_LSOF;
  }
  return realExecFileSync.apply(this, arguments);
};

if (FAIL_RENAME) {
  const realRename = fs.renameSync;
  fs.renameSync = function (from, to) {
    // 只拦 state 的落盘，不影响日志——两个观察面要能分开，否则这条用例证明不了
    // "state 写不进去时 jsonl 仍说得出话"。
    if (String(to).includes("bg-shell-reclaim")) throw new Error("EIO: simulated rename failure");
    return realRename.apply(this, arguments);
  };
}
