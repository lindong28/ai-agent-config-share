"use strict";
/**
 * 守住这道闸**判不了时的可观测性**——打真实 hook 进程，断言调用方与事后复盘看得到的东西。
 *
 * 为什么单独一份：本 hook 的正常路径（开火 / 不开火）是显性的，而它的降级路径不是。
 * 实测事故：`noteUnusable` 被调用两次却从未定义，`ps` / `lsof` 任一不可用即抛 ReferenceError，
 * 被最外层 `try { main(); } catch { allow(); }` 的空 catch 吞掉。结果是**「崩了」与「无事可报」
 * 输出完全相同**——零退出码、零 stdout、零日志。这道闸因此可以永久失效而不产生任何信号；
 * 一次真实 session 里两个 headless Chrome 后台任务空转约 50 分钟，靠用户主动发现，
 * 事后想复盘它为什么没响时，日志里没有任何一条对应那段时间。
 *
 * 所以本文件断言的不是"它没崩"，而是**它崩的时候说得出来**：仍然放行（提醒型闸不该因自身
 * 出错卡住会话），但在 jsonl 留痕，crash 另走 stderr。
 *
 * **环境必须受控**（review 复核轮实跑指出）：早稿只伪造 `lsof`，于是成败取决于**执行者的祖先
 * 进程里有没有 `claude`/`codex`**——agent 会话里绿，普通终端 / CI 里 `sessionDescendants()`
 * 直接返回 `ps:no-agent-ancestor`，lsof 分支根本到不了，而"正常安静"那条反而会看到一条
 * `unusable`。两种环境下断言的不是同一件事。现在 `ps` / `lsof` / state 的 `renameSync`
 * 全部经 fixtures/preload.js 接管，测试不再继承执行者的进程树。
 *
 * **环境隔离**：独立 HOME（日志与 state 都按 HOME 解析），不污染真实
 * `~/.claude/logs/bg-shell-reclaim.jsonl` 与 `~/.claude/state/bg-shell-reclaim/`。
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const HOOK = path.join(__dirname, "bg-shell-reclaim-check.js");
const PRELOAD = path.join(__dirname, "bg-shell-reclaim-check.fixtures", "preload.js");
const SESSION = "degradation-test";

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bg-shell-degr-"));
}

function logEntries(home) {
  const p = path.join(home, ".claude", "logs", "bg-shell-reclaim.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// `{{PID}}` / `{{PPID}}` 由 preload 在 hook 自己的进程里填入——hook 是 spawn 出来的，
// 其 pid 在这里还不存在，而 `sessionDescendants()` 正是从它往上走祖先链。
// 树形：launchd(1) → claude({{PPID}}) → hook({{PID}}) → 候选(TARGET)。
const TARGET = 424242;
const PS_WITH_TARGET =
  "    1     0 launchd\n{{PPID}}     1 claude\n{{PID}}  {{PPID}} node\n" +
  `${TARGET}  {{PID}} sleep\n`;
const PS_NO_TARGET = "    1     0 launchd\n{{PPID}}     1 claude\n{{PID}}  {{PPID}} node\n";

/**
 * lsof 的 `-F pan` 输出：让 TARGET 以写模式持有一个形如 tasks/<id>.output 的路径。
 *
 * **该文件必须真的存在**：hook 用 `startedAt(info.file)` 读它的 birthtime 来算任务活了多久，
 * 文件不存在则 `aliveFor` 归零、永远达不到阈值，于是 `candidates=0`——用例会在"根本没检出候选"
 * 时假绿，而那正是本组用例要区分的另一种情形。故在临时目录里造一个真文件，并把它的时间戳
 * 往前推，使其稳定超龄，不依赖 `BG_SHELL_AGE_MS`。
 */
function fakeLsofOut(taskId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-shell-tasks-"));
  const nested = path.join(dir, "claude-501", "proj-slug", "runtime-id", "tasks");
  fs.mkdirSync(nested, { recursive: true });
  const file = path.join(nested, `${taskId}.output`);
  fs.writeFileSync(file, "");
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3 小时前，稳定超过 30 分钟默认阈值
  fs.utimesSync(file, old, old);
  return { out: `p${TARGET}\naw\nn${file}\n`, file };
}

/** 打真实 hook 进程；ps / lsof / rename 的行为经 preload 由环境变量控制。 */
function runHook(home, { psOut, lsofOut, failRename, hookFile, stopHookActive, transcriptPath } = {}) {
  const env = { ...process.env, HOME: home, NODE_OPTIONS: `--require ${PRELOAD}` };
  if (psOut !== undefined) env.BGT_FAKE_PS_OUT = psOut;
  if (lsofOut !== undefined) env.BGT_FAKE_LSOF_OUT = lsofOut;
  if (failRename) env.BGT_FAIL_RENAME = "1";
  return spawnSync(process.execPath, [hookFile || HOOK], {
    input: JSON.stringify({
      session_id: SESSION,
      stop_hook_active: stopHookActive === true,
      transcript_path: transcriptPath || "",
    }),
    env,
    encoding: "utf8",
  });
}

function transcriptWith(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-shell-transcript-"));
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  }) + "\n");
  return file;
}

// ── 降级路径 1：lsof 不可用 ────────────────────────────────────────────────
{
  const home = makeHome();
  const r = runHook(home, { psOut: PS_WITH_TARGET, lsofOut: "__FAIL__" });

  assert.strictEqual(r.status, 0, "lsof 不可用时必须仍然放行（提醒型闸不阻塞会话）");
  const unusable = logEntries(home).filter((e) => e.unusable);
  assert.ok(
    unusable.length >= 1,
    "lsof 不可用必须在 jsonl 留下 unusable 条目——否则与「无事可报」不可区分",
  );
  assert.match(
    String(unusable[unusable.length - 1].unusable),
    /^lsof:/,
    "unusable 条目要写明是哪条通道不可用，否则复盘时定位不到",
  );
}

// ── 降级路径 2：hook 自身抛异常 ────────────────────────────────────────────
{
  const home = makeHome();
  // 副本必须留在 hooks 目录内：放到别处会让 `require("./lib/...")` 在加载阶段失败，
  // 那是模块解析错误，不是本用例要测的运行期异常。
  const broken = path.join(__dirname, `.bg-shell-crash-${process.pid}.js`);
  fs.writeFileSync(
    broken,
    fs
      .readFileSync(HOOK, "utf8")
      .replace("const disc = sessionDescendants();", "const disc = deliberatelyUndefinedForTest();"),
  );
  try {
    const r = runHook(home, { psOut: PS_NO_TARGET, hookFile: broken });

    assert.strictEqual(r.status, 0, "hook 自身出错时必须仍然放行（fail-open 是有意的）");
    assert.match(r.stderr || "", /\[bg-shell\].*未清点/, "崩溃必须走 stderr 当场可见——日志没人主动看");

    const crashed = logEntries(home).filter((e) => e.crashed);
    assert.ok(crashed.length >= 1, "崩溃必须在 jsonl 留痕，供事后复盘");
    assert.match(
      String(crashed[crashed.length - 1].crashed),
      /deliberatelyUndefinedForTest/,
      "crashed 条目要带上原始异常，只记「崩了」定位不到是哪一处",
    );
    // 多个会话共享同一份 jsonl。crash 条目不带 session，观察者就分不出哪个会话的
    // "零任务"是正常清点、哪个是根本没清点成——本文件要达到的效果恰好在此被击穿。
    assert.strictEqual(
      crashed[crashed.length - 1].session,
      SESSION,
      "crashed 条目必须带 session，否则跨会话共享日志里无法归属",
    );
  } finally {
    fs.rmSync(broken, { force: true });
  }
}

// ── 降级路径 3：检出了活任务，但台账写不进去 ──────────────────────────────
// 本 hook 唯一一处"已经知道有活任务、却对外沉默"的路径。不阻断是有意的（否则形成解除不掉的
// 死拦），但沉默不该无声——对调用方而言它与"没有活任务"完全同形。
//
// 失败时机是关键：把 state 目录整个设为不可写会让 `updateState()` 在**执行 callback 之前**
// 就失败，于是 candidates 恒为 0，用例在"根本没检出候选"时假绿。故只让 `renameSync` 失败——
// 写 tmp 成功、rename 失败，callback 已经跑过、候选已经收集。
{
  const home = makeHome();
  const lsof = fakeLsofOut("fakelive");
  const r = runHook(home, { psOut: PS_WITH_TARGET, lsofOut: lsof.out, failRename: true });

  assert.strictEqual(r.status, 0, "台账写不进去时不阻断（避免解除不掉的死拦）");
  assert.match(
    r.stderr || "",
    /检出 \d+ 个待回收后台任务，但台账写入失败/,
    "检出了候选却写不进台账时，必须当场说出来——否则与「没有活任务」同形",
  );
  const noted = logEntries(home).filter((e) =>
    String(e.unusable || "").startsWith("state-uncommitted"),
  );
  assert.ok(noted.length >= 1, "该路径必须在 jsonl 留痕，供事后复盘");
}

// ── 正常路径：无可报任务时必须保持安静 ────────────────────────────────────
// 没有这一条，上面几条可以被"无条件写一条日志"骗过——那样 unusable/crashed 就又失去判别力了。
{
  const home = makeHome();
  const r = runHook(home, { psOut: PS_NO_TARGET, lsofOut: "" });
  assert.strictEqual(r.status, 0, "无可报任务时放行");
  const noisy = logEntries(home).filter((e) => e.unusable || e.crashed);
  assert.strictEqual(
    noisy.length,
    0,
    "正常路径不得写 unusable/crashed——否则这两个标记无法把降级与正常分开",
  );
}

// ── 正常路径：普通 Stop 里出现的具名 ack 也必须持久生效 ───────────────────
// 真实误报先在一次普通 Stop 中写出 BG-SHELL-OK；因为当轮没有 sibling gate 阻断，下一轮仍是
// stop_hook_active=false。旧实现只在 active retry 收 ack，于是同一 task 被重复提醒。
{
  const home = makeHome();
  const lsof = fakeLsofOut("acknormal");
  const first = runHook(home, { psOut: PS_WITH_TARGET, lsofOut: lsof.out });
  assert.strictEqual(first.status, 2, "阳性对照：超龄且未 ack 的任务必须先提醒");

  const ackTranscript = transcriptWith("交付照常继续。\n\nBG-SHELL-OK: acknormal — 仍需要，等待完成回调");
  const acked = runHook(home, {
    psOut: PS_WITH_TARGET,
    lsofOut: lsof.out,
    transcriptPath: ackTranscript,
  });
  assert.strictEqual(acked.status, 0, "普通 Stop 中的具名 ack 必须解除重复提醒");

  const later = runHook(home, { psOut: PS_WITH_TARGET, lsofOut: lsof.out });
  assert.strictEqual(later.status, 0, "普通 Stop 收到的 ack 必须持久化，后续轮次不得再次提醒");
}

console.log("bg-shell-reclaim-check.degradation.test.js: ok");

/**
 * 反向变异读数（逐条实跑，记的是**实际先红的那一条**断言，不是预期的那一条）：
 *
 * 1. 清空 `noteUnusable` 函数体 → 红 `lsof 不可用必须在 jsonl 留下 unusable 条目`
 * 2. catch 改回 `catch { allow(); }` → 红 `崩溃必须走 stderr 当场可见`
 * 3. `logFire` 每次混入 `{unusable:"x"}` → 红 `unusable 条目要写明是哪条通道不可用`
 *    （**与预期不符**：原以为红在"正常路径"那条，实测被更靠前的形态断言先拦下。记下这个偏差
 *    是因为它说明预期的红点与实际的红点不是一回事，只写预期等于没做变异。）
 * 4. 正常路径插一条形态合法的 `{unusable:"lsof:bogus"}` → 红 `正常路径不得写 unusable/crashed`
 * 5. crash 记录去掉 `session` 字段 → 红 `crashed 条目必须带 session`
 * 6. 删掉 `!committed && candidates.length` 下的留痕分支 → 红 `检出了候选却写不进台账时，必须当场说出来`
 *
 * 每条断言都有一次专属的变红读数，没有哪条是靠别人顺带证明的。
 */
