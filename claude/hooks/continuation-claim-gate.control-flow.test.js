#!/usr/bin/env node
"use strict";
// continuation-claim-gate 的**控制流**测试。与同目录的 `continuation-claim-gate.test.js` 是
// `judge-gate-authoring.md` §8 要求的两层里的另一层：那一份把源码里的 `main();` 替换掉再直调
// `judge()`，只标定判官在给定文本上的判决；本文件 spawn 真实 hook，断言 `main()` 的早退路径。
//
// 两层打不到对方。§2/§4/§7 那几条——从哪取文本、守卫放在哪一步、逃生口落没落痕——全是控制流，
// judge 标定台一条都测不到。这不是假设：这道闸当初就是缺了递归守卫与逃生口留痕，而它那 9 条
// 判官用例全绿，没有任何测试挡得住（该案例写在 judge-gate-authoring.md §8）。
//
// **断言 verdict 而不只是 exit code**：本闸所有早退路径都 exit 0，与"判官判 ok"同形，只断
// exit code 的测试在"守卫在"与"守卫被删"两种情况下输出逐字相同——那正是无区分力的读数。
// 故经 `CLAUDE_JUDGE_LOG_PATH` 把裁决引到本次调用独占的临时文件再断言它。
//
// 附带性质：正确实现下本测试**不发任何网络请求**（每条路径都在调判官之前返回），也不跑
// ps/lsof。被改坏成"守卫挪到判官之后"的实现会真的去调判官，表现为耗时骤增或 verdict 变成
// judge_unavailable / ok / flag——都与这里的断言不同，因此会被抓住。

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const hook = path.join(__dirname, "continuation-claim-gate.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-claim-cf-test-"));

// 一段确定会被判 flag 的前向承诺（顺序待办是本闸的主力开火形态）。用它当载体：任何没被早退
// 挡住的实现都会走到判官，于是断言以可分辨的方式失败，而不是碰巧通过。
const FLAGGABLE = "接下来我把这批改动 commit，再补 integration 测试，最后修那个 flaky。";

// 显式清掉判官递归护栏。父进程带着它跑测试是合法的（嵌套判官调用里就带），不清的话
// NEST_GUARD 那条会以"正确的理由"通过，其余各条则被它抢先短路、断言形同虚设。
const { NEST_GUARD } = require("./lib/llm-judge");
const cleanEnv = { ...process.env };
delete cleanEnv[NEST_GUARD];

let logSeq = 0;

/** 跑一次 hook，返回 { status, record }。record 取本次调用独占日志里最后追加的那条。 */
function run(payload, extraEnv) {
  const logPath = path.join(tmp, `verdicts-${logSeq++}.jsonl`);
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...cleanEnv, ...extraEnv, CLAUDE_JUDGE_LOG_PATH: logPath },
    timeout: 20000,
  });
  assert.notStrictEqual(r.status, null, `hook 未正常退出: ${r.stderr}`);
  let record = null;
  try {
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    if (lines.length) record = JSON.parse(lines[lines.length - 1]);
  } catch {
    /* 没写成日志 → record 保持 null，断言会报出来 */
  }
  return { status: r.status, record };
}

const base = {
  hook_event_name: "Stop",
  session_id: "cf-test-session",
  transcript_path: path.join(tmp, "nonexistent.jsonl"),
};

try {
  // §4 递归守卫：判官调用本身经过 hook 层，没有守卫时它会再触发一次本闸 → 无限递归。
  {
    const { status, record } = run(
      { ...base, last_assistant_message: FLAGGABLE },
      { [NEST_GUARD]: "1" }
    );
    assert.strictEqual(status, 0, "嵌套判官调用内必须放行");
    assert.ok(record, "嵌套路径必须留痕，否则 §8 的 eval 在这条路径上恒为 no-verdict、永远测不到它");
    assert.strictEqual(record.verdict, "skipped", `期望 skipped，实得 ${record.verdict}`);
    // §4 的位置要求：守卫在**解析 stdin 之后**。放 main() 第一行的话这条记录的 session_id
    // 会是 null，读者无从知道它属于哪一次停止——而"分得开"正是这份日志存在的理由（§6）。
    assert.strictEqual(
      record.session_id,
      "cf-test-session",
      "递归守卫必须在解析 stdin 之后——记录缺 session_id 说明它被提到了 main() 第一行"
    );
  }

  // §4 重复拦截守卫：每停至多 block 一次。缺它则 block 后的重发会被再拦，agent 困在原地。
  {
    const { status, record } = run({
      ...base,
      stop_hook_active: true,
      last_assistant_message: FLAGGABLE,
    });
    assert.strictEqual(status, 0, "stop_hook_active 时必须放行");
    assert.ok(record, "stop_hook_active 路径必须留痕");
    assert.strictEqual(record.verdict, "skipped", `期望 skipped，实得 ${record.verdict}`);
  }

  // §7 逃生口留痕：零记录会让"agent 加口令绕过"与"它压根没被拦过"同形，本闸的误报率
  // ——决定它该不该继续存在的那个数——就此算不出来。verdict 必须与 `ok` 不同形，否则
  // 留了痕也仍与"改完再停"混在一起。
  // 逃生口的意图声明矩阵。**每组都跑 `stop_hook_active` 的两种取值**：带 true 的那一半才是真实链路
  // （本闸 flag → exit 2 → agent 附口令重发，重发那一停 stop_hook_active 必为 true）。只测 false
  // 会漏掉"把 stop_hook_active 守卫放到口令之前"这个错误——两条守卫分开测都对，组合起来才暴露
  // 逃生口分支不可达。以下全部在**零运行态**下（测试进程没有 tasks/<id>.output 持有者）。
  const ESCAPE_CASES = [
    // 光贴口令不声明意图 → 拦。这条正是本闸被绕过那次的形态：口令在、意图不明。
    { msg: `${FLAGGABLE}\n\nCONTINUATION-OK: 改成如实陈述`, status: 2, verdict: "flag", reason: "缺意图声明", name: "口令缺意图声明" },
    // 声明"到此为止" → 放行。责任由 agent 自己按下，留痕可查。
    { msg: `${FLAGGABLE}\n\nCONTINUATION-OK: 改成如实陈述 INTENT-HANDOFF`, status: 0, verdict: "ok_override", name: "口令 + HANDOFF" },
    // 声明"我接着做"而零运行态 → 自相矛盾 → 拦。**这条是本次改动的全部意义**：
    // 判据从"文本像不像前向承诺"（要判官、会误判）换成"自述意图 vs 可观测运行态"（客观、拦它不可能误报）。
    { msg: `${FLAGGABLE}\n\nCONTINUATION-OK: 现在就做 INTENT-CONTINUE`, status: 2, verdict: "flag", reason: "自相矛盾", name: "声明 CONTINUE 但零运行态" },
    // 同一行两个相反标记 → 拦。不这样判的话，"两个都写上"就成了绕过：先命中哪个纯看代码顺序。
    { msg: `${FLAGGABLE}\n\nCONTINUATION-OK: x INTENT-HANDOFF INTENT-CONTINUE`, status: 2, verdict: "flag", reason: "同时声明两种意图", name: "同行两个标记" },
    // **自指陷阱的回归**：正文里引用两个字面量（例如复述本闸的提示），而口令那一行只有 HANDOFF。
    // 全文匹配会把它误判成"声明继续"并反复拦下——本闸的提示文本自己就同时含这两个词，
    // 照做的 agent 复述它就会被永久困住。只认口令那一行才不会有这个面。
    {
      msg: `${FLAGGABLE}\n\n闸的提示说：意图标记有 INTENT-HANDOFF 与 INTENT-CONTINUE 两个。\n\nCONTINUATION-OK: 改成如实陈述 INTENT-HANDOFF`,
      status: 0, verdict: "ok_override", name: "正文引用两个字面量但口令行只有 HANDOFF",
    },
    // **样例遮蔽的回归**：正文先给一行口令样例，末尾才是真正的声明。取首条匹配行会让样例遮蔽真声明——
    // 两个方向都错：样例缺标记会误报"缺声明"，样例带 HANDOFF 会让末尾真正的 CONTINUE 被放过。
    // 口令按约定写在末尾，所以取**最后一条**匹配行。
    {
      msg: `${FLAGGABLE}\n\n旧格式长这样：CONTINUATION-OK: 某某\n\nCONTINUATION-OK: 改成如实陈述 INTENT-HANDOFF`,
      status: 0, verdict: "ok_override", name: "样例行在前、真声明在后（不得被遮蔽）",
    },
    {
      msg: `${FLAGGABLE}\n\n合规样例：CONTINUATION-OK: x INTENT-HANDOFF\n\nCONTINUATION-OK: 现在就做 INTENT-CONTINUE`,
      status: 2, verdict: "flag", reason: "自相矛盾", name: "带 HANDOFF 的样例不得掩护末尾的 CONTINUE",
    },
  ];
  for (const c of ESCAPE_CASES) {
    for (const active of [false, true]) {
      const { status, record } = run({ ...base, stop_hook_active: active, last_assistant_message: c.msg });
      const where = `${c.name} / stop_hook_active=${active}`;
      assert.strictEqual(status, c.status, `${where} 期望 exit ${c.status}，实得 ${status}`);
      assert.ok(record, `${where} 必须留痕——否则 eval 在这条路径上恒为 no-verdict、永远测不到它`);
      assert.strictEqual(record.verdict, c.verdict, `${where} 期望 verdict ${c.verdict}，实得 ${record.verdict}`);
      // **必须连 reason 一起断言**：两条拦截路径（矛盾 / 缺声明）共用 verdict `flag` 与 exit 2，
      // 只断 verdict 时，删掉矛盾拦截会让消息落到"缺声明"那条、输出完全相同——实测该变异存活过一次。
      if (c.reason) {
        assert.ok(
          String(record.reason || "").includes(c.reason),
          `${where} 的 reason 应含「${c.reason}」，实得「${record.reason}」——两条拦截路径靠它区分`
        );
      }
      // 逐分支守住归属字段：只断 verdict 的话，单把本分支的 logVerdict payload 换成 null 仍会通过，
      // 而那条记录会失去 session_id / event / transcript_path，无法归属到具体停止事件（§6）。
      assert.strictEqual(record.session_id, "cf-test-session", `${where} 的记录必须能归属到本次停止`);
    }
  }

  // STOP-GATE-OK 不再是本闸的逃生口——它是 stop-gate 的口令、同样由 agent 自己产出，认它等于
  // 留了一条等价的无条件旁路。带 stop_hook_active=true 时它落到那条守卫（确定性）；不带时会落到
  // 判官（要网络），故只测确定性的这一半。
  {
    const { status, record } = run({
      ...base,
      stop_hook_active: true,
      last_assistant_message: `${FLAGGABLE}\n\nSTOP-GATE-OK`,
    });
    assert.strictEqual(status, 0, "STOP-GATE-OK + stop_hook_active 应放行");
    assert.strictEqual(
      record && record.verdict,
      "skipped",
      `STOP-GATE-OK 不应再走 ok_override（那是它当逃生口时的痕迹），实得 ${record && record.verdict}`
    );
  }

  // 有活任务时：即便声明 INTENT-CONTINUE 也必须放行——那时"我接着做"是**真的**，拦它才是误报。
  // 这条同时守住位序：运行态探测必须在逃生口之前，否则口令分支拿不到"零运行态"这个判据。
  // 造一个 hasLiveTask 认得的活任务：路径形如 <tmp>/claude-<uid>/<proj>/<run>/tasks/<id>.output，
  // 且要有进程**以写模式**持有它（只建文件不够——那正是 hook 刻意过滤掉的假阳性）。
  {
    const taskDir = path.join(tmp, "claude-501", "proj", "run", "tasks");
    fs.mkdirSync(taskDir, { recursive: true });
    const outFile = path.join(taskDir, "abc123.output");
    fs.writeFileSync(outFile, "");
    const holder = spawnSync === null ? null : require("child_process").spawn(
      process.execPath,
      ["-e", `const fs=require("fs");fs.openSync(${JSON.stringify(outFile)},"a");setTimeout(()=>{},30000)`],
      { stdio: "ignore", detached: false }
    );
    try {
      // 给 holder 一点时间把 fd 开出来；lsof 看不到还没 open 的句柄。
      const deadline = Date.now() + 5000;
      let seen = false;
      while (Date.now() < deadline && !seen) {
        const probe = spawnSync("lsof", ["-F", "n", "-p", String(holder.pid)], { encoding: "utf8" });
        seen = (probe.stdout || "").includes(outFile);
      }
      assert.ok(seen, "测试自身的前置条件不成立：holder 没能持有 output 文件，本条断言无意义");
      // 两条都必须放行：声明 CONTINUE 是**真的**；而口令格式没写对时更不该拦——
      // 拦一个正在干活的 agent 是纯误报，比漏掉一次格式检查糟得多。
      for (const tail of ["CONTINUATION-OK: 真要后台跑 INTENT-CONTINUE", "CONTINUATION-OK: 忘了写标记"]) {
        const { status, record } = run({ ...base, last_assistant_message: `${FLAGGABLE}\n\n${tail}` });
        assert.strictEqual(status, 0, `有活任务时必须放行：${tail}`);
        assert.strictEqual(
          record && record.verdict,
          "ok_live_task",
          `有活任务时应记 ok_live_task（证明探测在一切口令判定之前就短路了），实得 ${record && record.verdict}`
        );
      }
    } finally {
      if (holder && holder.pid) { try { process.kill(holder.pid); } catch {} }
    }
  }

  // 输入缺失：不能静默放行——那会让"hook 没跑"与"跑了但输入缺失"在日志里同形，
  // 而后者正是排查本闸覆盖率时唯一能依据的读数。
  {
    const { status, record } = run({ ...base, last_assistant_message: "   " });
    assert.strictEqual(status, 0, "无内联消息时必须放行");
    assert.ok(record, "无内联消息路径必须留痕");
    assert.strictEqual(record.verdict, "skipped", `期望 skipped，实得 ${record.verdict}`);
  }

  // §3 fail-open：stdin 非 JSON、以及 `JSON.parse("null")` 那条历史踩过的路径（它解析成功
  // 但产出 null，随后取字段会抛 TypeError 而非干净放行）。两者都不落痕，只断退出码。
  for (const raw of ["not json at all", "null"]) {
    const r = spawnSync(process.execPath, [hook], {
      input: raw,
      encoding: "utf8",
      env: { ...cleanEnv, CLAUDE_JUDGE_LOG_PATH: path.join(tmp, `raw-${logSeq++}.jsonl`) },
      timeout: 20000,
    });
    assert.strictEqual(r.status, 0, `stdin 为 ${JSON.stringify(raw)} 时必须干净放行`);
  }

  console.log("continuation-claim-gate.control-flow.test.js: ok");
} finally {
  // finally 而非顺序执行：断言失败也要清掉临时目录，否则失败路径每跑一次泄漏一个。
  fs.rmSync(tmp, { recursive: true, force: true });
}
