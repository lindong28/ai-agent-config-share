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

// ── 伪造 `ps` / `lsof`：整个文件的运行态都由它们钉死，不依赖宿主环境 ────────────────────
//
// 为什么必须是全文件默认、而不只给运行态那一组用：本文件其余用例（口令语义、输入缺失…）都
// 隐含前提"此刻零运行态"，而它们此前之所以稳定，**是因为探测有 bug、恒返回 false**。缺陷修好后
// 真实环境里前台工具调用自己的 `tasks/<id>.output` 就会被看成活任务，那些用例便随宿主环境漂移
// （实测：修复后它们从 skipped 变成 ok_live_task）。所以把三态完全交给 shim 决定。
//
// shim 拿得到 hook 的 pid：`execFileSync("ps"|"lsof", …)` 不经 shell，故 shim 的 $PPID 就是
// hook 进程本身——这是把真 pid 接进伪造进程表的唯一一环。
const SHIM_OUT = "/tmp/claude-501/proj/run/tasks/abc123.output"; // 需匹配 hook 的 OUTPUT_RE
const F = { shell: 900001, claude: 900002, other: 900003, holder: 900004 };
const shimDir = path.join(tmp, "shims");
fs.mkdirSync(shimDir, { recursive: true });
fs.writeFileSync(
  path.join(shimDir, "ps"),
  `#!/bin/sh
H=$PPID
case "$SCEN" in
  b) printf '%s 1 node\\n' "$H" ;;                     # 链上无 claude → 上溯必须失败
  *) printf '%s ${F.shell} node\\n' "$H"
     printf '${F.shell} ${F.claude} bash\\n'
     printf '${F.claude} 1 claude\\n'
     printf '${F.other} ${F.claude} sleep\\n'          # 子树内的非 holder，保证 c ≠ b
     if [ "$SCEN" = a ]; then printf '${F.holder} ${F.claude} bash\\n'
     else printf '${F.holder} 1 bash\\n'; fi ;;        # 非 a：holder 在子树之外
esac
`,
  { mode: 0o755 }
);
// 只在被问到 holder 时才回答；hook 用 -p <逗号分隔 pid> 提问，故"问没问到"本身就是判据。
//
// 没问到 holder 时**成功退出 0 并列出一条不匹配的普通文件**，而不是 `exit 1`。真实 lsof 对活着的
// 进程本来就会列出它们的 fd（每个进程都有打开的文件），零活任务表现为"列了但没有匹配 OUTPUT_RE 的"，
// 不是"什么都没列"。用 `exit 1` 表达零任务会把**探测不完整**（lsof 部分可见 / 进程中途消失也退 1）
// 固化成"确定没有活任务"，于是这份 authority 测试反过来会把"退 1 应 fail-open"的修法判成错——
// 那条 `hasLiveTask` 的既有缺陷另行跟踪（harness-issues），本测试不得替它把错误语义钉死。
fs.writeFileSync(
  path.join(shimDir, "lsof"),
  `#!/bin/sh
for a in "$@"; do
  case ",$a," in *",${F.holder},"*) printf 'p${F.holder}\\naw\\nn${SHIM_OUT}\\n'; exit 0 ;; esac
  case "$a" in "${F.holder}") printf 'p${F.holder}\\naw\\nn${SHIM_OUT}\\n'; exit 0 ;; esac
done
printf 'p${F.other}\\nar\\nn/dev/null\\n'   # 活着但没有活任务：列得出 fd，只是没有匹配的
exit 0
`,
  { mode: 0o755 }
);
// 默认 c：有 claude 祖先、子树非空、但没有活任务 —— 即"零运行态"，其余用例的隐含前提。
const SHIM_ENV = { SCEN: "c", PATH: `${shimDir}:${process.env.PATH}` };

/** 跑一次 hook，返回 { status, record }。record 取本次调用独占日志里最后追加的那条。 */
function run(payload, extraEnv) {
  const logPath = path.join(tmp, `verdicts-${logSeq++}.jsonl`);
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...cleanEnv, ...SHIM_ENV, ...extraEnv, CLAUDE_JUDGE_LOG_PATH: logPath },
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

  // ── 运行态探测的三态：ok_live_task / detect_unavailable / false 后续分支 ──────────────
  //
  // 用 **PATH shim 伪造 `ps` 与 `lsof`**，而不是造真进程。理由是这组断言要守的不变量是
  // "子树的根取在哪里"：真进程版只能在**恰好有 claude 祖先**的环境（如从 Claude Code 里跑）
  // 成立，换到 CI 或普通终端就会滑向 detect_unavailable 而**静默通过**（那也是放行），
  // 于是它想守的东西在最需要它的环境里恰好失效。shim 版把拓扑完全钉死，与宿主环境无关。
  //
  // shim 拿得到 hook 的 pid：`execFileSync("ps"|"lsof", …)` 不经 shell，故 shim 的 $PPID
  // 就是 hook 进程本身——这是能把真 pid 接进伪造进程表的唯一一环。
  //
  // 三场景的期望 verdict 两两不同，故本组在探测返回 true / null / false 三种情况下读数不同：
  //   a 有 claude 祖先 + holder 在其子树   → true  → ok_live_task
  //   b 链上无 claude 祖先                 → null  → detect_unavailable（fail-open）
  //   c 有 claude 祖先 + holder 在子树外   → false → ok_override（口令分支，判官不被调用）
  // c 的伪造表里**必须留一个子树内的非 holder 进程**：否则 descendants() 交出空集，
  // hasLiveTask 首行 `pids.size === 0` 会返回 null，c 就塌成 b——两者同为放行，测试会
  // **碰巧通过**而不变量根本没被守住。若拓扑写错，c 实得 detect_unavailable，下面的断言会报出来。
  {
    const withShims = (scen) => ({ SCEN: scen });

    // a：有活任务时即便声明 INTENT-CONTINUE 也必须放行——那时"我接着做"是**真的**，拦它才是误报。
    // 口令格式没写对时更不该拦：拦一个正在干活的 agent 比漏一次格式检查糟得多。
    // 这条同时守住位序：探测必须在逃生口之前，否则口令分支拿不到"零运行态"这个判据。
    for (const tail of ["CONTINUATION-OK: 真要后台跑 INTENT-CONTINUE", "CONTINUATION-OK: 忘了写标记"]) {
      const { status, record } = run(
        { ...base, last_assistant_message: `${FLAGGABLE}\n\n${tail}` },
        withShims("a")
      );
      assert.strictEqual(status, 0, `有活任务时必须放行：${tail}`);
      assert.strictEqual(
        record && record.verdict,
        "ok_live_task",
        `有活任务时应记 ok_live_task（证明探测在一切口令判定之前就短路了），实得 ${record && record.verdict}`
      );
    }

    // b：上溯找不到 claude 祖先 → 不下结论。**不得回落到 process.ppid**——那正是本次修的缺陷，
    // 悄悄回落会让修复在"上溯失败"时静默恢复旧行为，且日志上与修好了同形。
    {
      const { status, record } = run(
        { ...base, last_assistant_message: FLAGGABLE },
        withShims("b")
      );
      assert.strictEqual(status, 0, "上溯失败必须 fail-open");
      assert.strictEqual(
        record && record.verdict,
        "detect_unavailable",
        `无 claude 祖先应记 detect_unavailable，实得 ${record && record.verdict}`
      );
    }

    // c：确实零运行态。走口令 + HANDOFF 分支落 ok_override 并放行，**判官不被调用**
    // （judge() 位于该分支之后）——这正是本组能保持确定性、不依赖判官与网络的原因。
    {
      const { status, record } = run(
        { ...base, last_assistant_message: `${FLAGGABLE}\n\nCONTINUATION-OK: 真的到此为止 INTENT-HANDOFF` },
        withShims("c")
      );
      assert.strictEqual(status, 0, "零运行态 + HANDOFF 必须放行");
      assert.strictEqual(
        record && record.verdict,
        "ok_override",
        `零运行态 + HANDOFF 应记 ok_override；实得 ${record && record.verdict}` +
          "（若为 detect_unavailable，说明伪造子树成了空集、c 塌回 b，拓扑要修）"
      );
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

  // ── in-process subagent 的活性信号（2026-08-10 加）─────────────────────────
  // 背景：lsof 探测只看"子孙进程持有 tasks/*.output"，对 `Agent` 工具起的 in-process
  // teammate **间歇性**失效——它跑 Bash 时被测到、思考/读文件时测不到，于是这道闸拦过一个
  // 正在正确工作的 agent。补的信号是 subagents/agent-*.jsonl 的 mtime 新鲜度。
  //
  // 三条一起测，缺一条都测不出回归：只测(2)的话，把窗口改成无穷大也全绿，而那等于废掉整道闸。
  {
    const sessDir = path.join(tmp, "livesess");
    const transcript = `${sessDir}.jsonl`;
    fs.writeFileSync(transcript, "");
    const subs = path.join(sessDir, "subagents");
    fs.mkdirSync(subs, { recursive: true });

    // (1) 零运行态 + 无 subagent 目录内容 → 必须照常落到判官并开火
    const noAgent = run({ ...base, transcript_path: transcript, last_assistant_message: FLAGGABLE });
    assert.strictEqual(noAgent.record && noAgent.record.verdict, "flag",
      "没有 subagent 活动时必须照常开火，新信号不得把闸放宽");

    // (2) subagent 刚写过 → 放行，且 verdict 与 lsof 那条**分得开**
    const live = path.join(subs, "agent-live.jsonl");
    fs.writeFileSync(live, "{}");
    const fresh = run({ ...base, transcript_path: transcript, last_assistant_message: FLAGGABLE });
    assert.strictEqual(fresh.status, 0, "subagent 在跑时必须放行");
    assert.strictEqual(fresh.record && fresh.record.verdict, "ok_live_subagent",
      "须用独立 verdict：与 ok_live_task 混在一起就分不出这个新信号是否在误报");

    // (3) 超出窗口 → 回落到判官。样本取**刚好超窗**(25s)而非一小时前：用一小时前的样本时，
    // 窗口被误改成 200s / 30min 测试照样全绿，等于只钉住了"窗口 < 1h"这个无用的下界。
    const stale = Date.now() / 1000 - 25;
    fs.utimesSync(live, stale, stale);
    const old = run({ ...base, transcript_path: transcript, last_assistant_message: FLAGGABLE });
    assert.strictEqual(old.record && old.record.verdict, "flag",
      "陈旧的 subagent 转录不得再算作活任务");

    // (3b) 未来时间戳(时钟回拨)不得被当成新鲜——`now - mtime` 为负会恒满足上界，
    // 实际窗口变成"未来偏移量 + WINDOW"。
    const future = Date.now() / 1000 + 3600;
    fs.utimesSync(live, future, future);
    const ahead = run({ ...base, transcript_path: transcript, last_assistant_message: FLAGGABLE });
    assert.strictEqual(ahead.record && ahead.record.verdict, "flag",
      "未来 mtime 不得被当成活任务");
    // 且不能只是"暂时不算"：取绝对值的写法会让未来时间戳在时钟走近其 mtime 时**无写入地**
    // 重新落回窗口而复活。用一个刚进入窗口的未来时间戳（+10s）钉住这一点。
    const nearFuture = Date.now() / 1000 + 10;
    fs.utimesSync(live, nearFuture, nearFuture);
    const soon = run({ ...base, transcript_path: transcript, last_assistant_message: FLAGGABLE });
    assert.strictEqual(soon.record && soon.record.verdict, "flag",
      "未来 mtime 即使落在窗口宽度内也不得算活任务（否则会定时复活）");
    fs.utimesSync(live, stale, stale);

    // (3c) 补充探测自己失败时必须 fail-open（detect_unavailable），不得拿不完整的 false 开火。
    // 造法用 ENOTDIR（把 subagents 位置放一个普通文件）而不是 chmod 000：后者在 root 下不生效，
    // 断言会被整段跳过而空转；ENOTDIR 与权限无关，任何用户下都稳定触发。
    {
      const brokenSess = path.join(tmp, "brokensess");
      const brokenTranscript = `${brokenSess}.jsonl`;
      fs.writeFileSync(brokenTranscript, "");
      fs.mkdirSync(brokenSess, { recursive: true });
      fs.writeFileSync(path.join(brokenSess, "subagents"), "not a directory");
      const broken = run({ ...base, transcript_path: brokenTranscript, last_assistant_message: FLAGGABLE });
      assert.strictEqual(broken.record && broken.record.verdict, "detect_unavailable",
        "subagent 探测失败时必须 fail-open，而不是按不完整的 false 开火");
      // 不断言 reason：`logVerdict` 当前只对 flag / skipped 持久化 reason，故
      // detect_unavailable 的 `probe.reason` 到不了日志——这是本改动之前就存在的缺口
      // （该 gate 有整段注释要求 fail-open 可归因），修法在 lib/judge-log.js。
      // 那个文件此刻有另一个 session 的在途改动，故本轮不动，已记入 harness-issues。
    }

    // (3d) 单个候选文件 stat 失败时，"没有活任务"这个结论不再可信——失败的那个可能正是
    // 新鲜的那一个。必须 fail-open 而不是返回 false。造法：悬空 symlink（statSync 抛 ENOENT）。
    // 注意此时目录里的另一个候选是陈旧的，若实现直接返回 false 就会开火，测试即抓住。
    {
      const dangling = path.join(subs, "agent-dangling.jsonl");
      fs.symlinkSync(path.join(subs, "does-not-exist.jsonl"), dangling);
      const partial = run({ ...base, transcript_path: transcript, last_assistant_message: FLAGGABLE });
      fs.unlinkSync(dangling);
      assert.strictEqual(partial.record && partial.record.verdict, "detect_unavailable",
        "有候选文件 stat 失败时，不得拿一个可能不完整的 false 去开火");
    }

    // (4) 目录里的非 agent-*.jsonl 文件不参与判定
    fs.writeFileSync(path.join(subs, "notes.txt"), "x");
    const noise = run({ ...base, transcript_path: transcript, last_assistant_message: FLAGGABLE });
    assert.strictEqual(noise.record && noise.record.verdict, "flag",
      "subagents 目录里的其它文件不得被当成 subagent 活动");
  }

  console.log("continuation-claim-gate.control-flow.test.js: ok");
} finally {
  // finally 而非顺序执行：断言失败也要清掉临时目录，否则失败路径每跑一次泄漏一个。
  fs.rmSync(tmp, { recursive: true, force: true });
}
