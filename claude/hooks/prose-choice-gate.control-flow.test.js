#!/usr/bin/env node
"use strict";
// prose-choice-gate 的**控制流**测试。`judge-gate-authoring.md` §8 要求的两层里的这一层：
// spawn 真实 hook，断言 `main()` 的早退路径；判官在给定文本上判得准不准由 `eval/prose-choice-gate/`
// 那套负责。两层打不到对方——从哪取文本、守卫放在哪一步、逃生口落没落痕，eval 一条都测不到。
//
// **本文件存在的直接原因是一次真实漏报**（2026-08-09）：一条把并列备选写成正文的收尾没被拦。
// 事后把同一段完整原文离线喂给这道闸的判官，7/7 全 flag——所以漏报不在判据上。查判官日志才看到
// 那一停的记录是 `skipped: stop_hook_active`：那一停已被**别的**闸拦过，而四道判官闸当时都把这个
// **全局**标志当成自己的私有标记，于是对改后的消息集体全盲。同一 session 里这样的跳过有 18 次。
//
// 修法是把守卫改成按闸计（见 lib/judge-log.js 的 lastVerdictOfGate）。**下面 B 组就是它的判别器**：
// 同样的 payload、同样的 stop_hook_active=true，只改"本闸上一条记录的 verdict"这一个变量——
// 旧实现两组都 skipped，新实现只有 A 组 skipped。没有 B 组的话，这次修复在测试里与没改过同形。
//
// **断言 verdict 而不只是 exit code**：本闸所有早退路径都 exit 0，与"判官判 ok"同形。经
// `CLAUDE_JUDGE_LOG_PATH` 把裁决引到本次调用独占的临时文件再断言它。

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const GATE = "prose-choice-gate";
const hook = path.join(__dirname, "prose-choice-gate.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prose-choice-cf-test-"));

// 一段确定会被判 flag 的正文选项（本闸的主力开火形态）。用它当载体：任何没被早退挡住的实现都会
// 走到判官，于是断言以可分辨的方式失败，而不是碰巧通过。
const FLAGGABLE =
  "两条路可选：A 直接改配置重跑，快但会丢现有缓存；B 先导出缓存再改，慢一轮但可回滚。你想走哪条？";

const SESSION = "cf-test-session-0001";

// 显式清掉判官递归护栏。父进程带着它跑测试是合法的，不清的话 NEST_GUARD 那条会以"正确的理由"
// 通过，其余各条则被它抢先短路、断言形同虚设。
const { NEST_GUARD } = require("./lib/llm-judge");
const cleanEnv = { ...process.env };
delete cleanEnv[NEST_GUARD];

let logSeq = 0;

/**
 * 跑一次 hook。`seed` 非空时先往本次独占日志里写一条本闸+本 session 的历史记录，
 * 用来驱动按闸计守卫的分支。返回本次调用**新追加**的那条记录。
 */
function run(payload, { seed = null, extraEnv = {} } = {}) {
  const logPath = path.join(tmp, `verdicts-${logSeq++}.jsonl`);
  if (seed) {
    fs.writeFileSync(
      logPath,
      JSON.stringify({
        ts: new Date(Date.now() - 60000).toISOString(),
        gate: seed.gate || GATE,
        event: "Stop",
        verdict: seed.verdict,
        session_id: seed.session_id || SESSION,
      }) + "\n"
    );
  }
  const before = seed ? 1 : 0;
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...cleanEnv, ...extraEnv, CLAUDE_JUDGE_LOG_PATH: logPath },
    timeout: 30000,
  });
  assert.notStrictEqual(r.status, null, `hook 未正常退出: ${r.stderr}`);
  let record = null;
  try {
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    if (lines.length > before) record = JSON.parse(lines[lines.length - 1]);
  } catch {
    /* 没写成日志 → record 保持 null，断言会报出来 */
  }
  return { status: r.status, record };
}

const base = {
  hook_event_name: "Stop",
  session_id: SESSION,
  transcript_path: "/nonexistent/transcript.jsonl",
  last_assistant_message: FLAGGABLE,
};

let pass = 0;
const fails = [];
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fails.push(name);
    console.log(`FAIL  ${name}\n        ${e.message}`);
  }
}

// ---- A：本闸自己上一停开的火 → 跳过。这是"原样再停一次即放行"的逃生口，语义必须不变。 ----
check("A 本闸上一停判 flag → 跳过（逃生口）", () => {
  const { record } = run({ ...base, stop_hook_active: true }, { seed: { verdict: "flag" } });
  assert.ok(record, "应当留痕，逃生口零记录会让误报率无法统计");
  assert.strictEqual(record.verdict, "skipped");
  assert.match(String(record.reason), /本闸拦的/, `理由应指明是逃生口，实得: ${record.reason}`);
});

// ---- B：别的闸拦的 → 本闸没判过这段新文本 → 必须照常判。**旧实现在这里是 skipped。** ----
check("B 本闸上一停判 ok（是别的闸拦的）→ 照常判，不跳过", () => {
  const { record } = run({ ...base, stop_hook_active: true }, { seed: { verdict: "ok" } });
  assert.ok(record, "应当留痕");
  assert.notStrictEqual(
    record.verdict,
    "skipped",
    "别的闸拦下后的重发，本闸从未判过这段新文本——跳过就是 2026-08-09 那次漏报的成因"
  );
});

// ---- B2：上一停本闸自己就是被跳过的（连锁场景）→ 同样不该再跳。 ----
check("B2 本闸上一停是 skipped → 照常判", () => {
  const { record } = run({ ...base, stop_hook_active: true }, { seed: { verdict: "skipped" } });
  assert.ok(record, "应当留痕");
  assert.notStrictEqual(record.verdict, "skipped");
});

// ---- C：查不到本闸历史 → 保守跳过，且理由与逃生口**不同形**（日志要分得开）。 ----
check("C 无历史记录 → 保守跳过，理由与逃生口可区分", () => {
  const { record } = run({ ...base, stop_hook_active: true });
  assert.ok(record, "应当留痕");
  assert.strictEqual(record.verdict, "skipped");
  assert.match(String(record.reason), /不可考/, `理由应标明历史不可考，实得: ${record.reason}`);
  assert.doesNotMatch(String(record.reason), /本闸拦的/, "两种跳过必须不同形，否则日志里分不开");
});

// ---- D：已知残余，钉住它而不是假装覆盖了。 ----
// 本闸在该 session 一条记录都没有、而 sibling 刚 flag 过：按闸计的判据只看"本闸上一条"，取不到就
// 保守跳过（C 组那条规则），于是这里仍然跳过——即使我们从 sibling 的记录能看出拦下本停的不是本闸。
// **不修**：现实路径走不到这里。sibling 开火的那一停 `stop_hook_active` 为假，四道闸都会跑，本闸
// 必留下一条 `ok`（那就是 B 组）。要落到本组，得是本闸从未运行而 sibling 运行过——崩溃或未注册。
// 代价是那种异常态下漏判一次；换取的是不必读别家记录、判据只依赖本闸自己的历史。
// 本组的作用是让这个取舍在测试里可见：哪天有人想改成"读 sibling 的 flag"，这条会告诉他改的是什么。
check("D 无本闸历史但 sibling 刚 flag → 仍保守跳过（已知残余，非缺陷）", () => {
  const { record } = run(
    { ...base, stop_hook_active: true },
    { seed: { gate: "reverse-assertion-gate", verdict: "flag" } }
  );
  assert.ok(record, "应当留痕");
  assert.strictEqual(record.verdict, "skipped");
  assert.match(String(record.reason), /不可考/, "应走 C 组那条保守分支，而不是逃生口分支");
});

// ---- E：递归守卫仍在（§4 跨闸不变量，本次改动不得碰坏）。 ----
check("E NEST_GUARD 在场 → 跳过（防判官递归）", () => {
  const { record } = run({ ...base }, { extraEnv: { [NEST_GUARD]: "1" } });
  assert.ok(record, "应当留痕");
  assert.strictEqual(record.verdict, "skipped");
  assert.match(String(record.reason), /嵌套|递归/);
});

// ---- F：stdin 不是合法 JSON → 早退留痕，不炸。 ----
check("F stdin 非法 JSON → 早退留痕", () => {
  const logPath = path.join(tmp, `verdicts-bad.jsonl`);
  const r = spawnSync(process.execPath, [hook], {
    input: "not json",
    encoding: "utf8",
    env: { ...cleanEnv, CLAUDE_JUDGE_LOG_PATH: logPath },
    timeout: 20000,
  });
  assert.strictEqual(r.status, 0, "解析失败必须 fail-open");
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  const rec = JSON.parse(lines[lines.length - 1]);
  assert.strictEqual(rec.verdict, "skipped");
});

// ---- G：阻断反馈先服从 ownership，再决定是否转 AskUserQuestion。 ----
// 这是确定性反馈契约，不依赖判官在某条语义样本上是否稳定开火；直接钉住实际 hook 发给 agent 的文字。
check("G 阻断反馈声明 stop-gate 的 ownership 优先级", () => {
  const source = fs.readFileSync(hook, "utf8");
  assert.ok(
    source.includes(
      "若 sibling `stop-gate` 同时判定这是 agent 自己的剩余工作（同一轮出现两条 hook feedback 即是信号），以它为准直接执行，不调用 `AskUserQuestion`"
    ),
    "反馈必须先处理 sibling stop-gate 的 agent-owned 裁决，再决定是否调用 AskUserQuestion"
  );
});

console.log(`\n${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  console.log(`失败: ${fails.join(", ")}`);
  process.exit(1);
}
