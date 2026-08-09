#!/usr/bin/env node
// reverse-assertion-gate 判官 prompt 的 eval 运行器。
// 给【真实】reverse-assertion-gate.js 喂带标签的 agent 收尾消息，统计每个场景 N 次采样的通过率。
//
// 结构承自 ../prose-choice-gate/run.mjs（隔离裁决日志、只认新追加的那条 verdict、no-verdict 与 ok
// 分开报）。不承 ../capability-claim-gate/ 那套合成 JSONL 的做法：那道闸是两段式，第②段要读转录里的
// tool_use；本 gate 是**单段式**，判定完全由判官对一段文本作出，喂内联消息即已覆盖全部判定路径。
//
// - 打真实 artifact（不另抄 prompt）——避免「offline prompt 与部署漂移 → 漏报」。
// - 经 payload 的 `last_assistant_message` 内联字段喂入，这是生产路径的**唯一**取法：hook 不读转录
//   （尾窗无新鲜度契约，会拿上一条消息阻断这一回合）。因此本套件天然覆盖不到"没有内联字段"那条
//   分支——它由 ../../reverse-assertion-gate.test.js 的确定性断言守着，别指望这里会发现回落被加回来。
// - GLM 判官走 temp=0，近确定性；通过率保留为残余非确定性的安全余量。
// - 需 GLM judge key（ZHIPU_API_KEY 或 ~/.claude/.glm-judge-key）：无 key 时 hook fail-open（恒 exit 0），
//   eval 会假性全绿，故先检查、缺则报错退出。
//
// 本 gate 的误报代价不对称（见 README「阈值为什么分两档」），故 must-pass 场景的达标线高于 must-fire。
// 用法：node run.mjs   （EVAL_N=采样次数  EVAL_THRESHOLD=flag 场景阈值  EVAL_THRESHOLD_OK=ok 场景阈值）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
// EVAL_HOOK 覆盖被测 hook 的路径。用途只有一个、但不可省：**变异测试**——把 judge prompt 故意改坏，
// 确认本套件会因此变红。一套从没红过的 eval，其全绿在"prompt 有区分力"和"场景离边界太远、任何 prompt
// 都能过"两种情况下长得一样，正是本 gate 拦的那类无区分力读数。做法见 README「怎么证明这套 eval 有效」。
const HOOK = process.env.EVAL_HOOK || path.resolve(DIR, "../../reverse-assertion-gate.js");
const SCEN_DIR = path.join(DIR, "scenarios");
const N = Number(process.env.EVAL_N || 5);
const THRESHOLD = Number(process.env.EVAL_THRESHOLD || 0.8);
// 误报守卫的达标线单列且更高：这道闸挂在每一次 Stop 上，正常收尾占绝大多数，误报直接换算成
// 用户被无谓打断的频率——它是 gate 被关掉的主因，而漏报只是回到没有本 gate 时的状态。
const THRESHOLD_OK = Number(process.env.EVAL_THRESHOLD_OK || 1.0);

const hasKey =
  !!process.env.ZHIPU_API_KEY ||
  fs.existsSync(path.join(os.homedir(), ".claude", ".glm-judge-key"));
if (!hasKey) {
  console.error(
    "✗ 缺 GLM judge key（ZHIPU_API_KEY 或 ~/.claude/.glm-judge-key）。无 key 时 reverse-assertion-gate 会 fail-open（恒放行），eval 结果无意义。",
  );
  process.exit(2);
}

// 场景文件格式：`# expect:` / `# note:` 头 + 其余行即 agent 那条收尾消息的原文。
function loadScenario(file) {
  const raw = fs.readFileSync(path.join(SCEN_DIR, file), "utf8");
  let expect = null;
  let note = "";
  const body = [];
  for (const ln of raw.split("\n")) {
    const m = ln.match(/^#\s*(expect|note):\s*(.*)$/);
    if (m) {
      if (m[1] === "expect") expect = m[2].trim();
      else note = m[2].trim();
    } else {
      body.push(ln);
    }
  }
  return { name: file.replace(/\.txt$/, ""), expect, note, message: body.join("\n").trim() };
}

// 裁决日志改指临时文件。打的是【真实】hook，而它会落盘裁决——不隔离就会把每轮上百条合成记录灌进
// ~/.claude/logs/judge-gate.jsonl，把那份日志的审计用途冲掉。明确可再生、可随时被删，故用系统临时目录。
const EVAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "reverse-assertion-eval-"));
const EVAL_LOG = path.join(EVAL_DIR, "verdicts.jsonl");
// 挂 exit 而不是在主流程末尾删：缺 key 的 process.exit(2)、无场景、读场景抛错等路径都绕过末尾那行。
process.on("exit", () => {
  try {
    fs.rmSync(EVAL_DIR, { recursive: true, force: true });
  } catch {
    /* 清理失败不该在 eval 结论旁边多印一段 stderr */
  }
});

function logSize() {
  try {
    return fs.statSync(EVAL_LOG).size;
  } catch {
    return 0;
  }
}

// 只解析【本次调用新追加的那一段】。读"文件最后一行"会在本次根本没写成记录时读到上一次的裁决。
function newVerdict(sizeBefore) {
  try {
    const buf = fs.readFileSync(EVAL_LOG);
    if (buf.length <= sizeBefore) return null;
    const lines = buf.subarray(sizeBefore).toString("utf8").trim().split("\n");
    return JSON.parse(lines[lines.length - 1]).verdict;
  } catch {
    return null;
  }
}

// 按真实 Stop hook 协议喂 stdin。**exit code 不足以判定**：判官不可用时 hook 按设计 fail-open、exit 0，
// 与"判官判了 ok"在退出码上完全同形。裁决日志是唯一能把这两件事分开的读数。只认 0 与 2 两个约定退出码，
// 且必须伴随一个真实判定；其余一律回一个不等于任何期望值的字符串，从而必然判 FAIL 而不是静默算作 ok。
function runHook(message) {
  const before = logSize();
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({ hook_event_name: "Stop", last_assistant_message: message }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_JUDGE_LOG_PATH: EVAL_LOG },
  });
  const v = newVerdict(before);
  if (v === null) return "no-verdict(no-log-record)";
  if (v === "judge_unavailable" || v === "skipped") return `no-verdict(${v})`;
  // **裁决与退出码必须成对**，只认 (ok,0) 与 (flag,2)。只按退出码分类会让"日志记 ok、进程退 2"这类
  // 分裂状态照常计入通过率——而变异测试正是靠 EVAL_HOOK 换进一个改了控制流的 hook，那恰恰是最可能
  // 出现分裂的场合，全绿会把它掩盖过去。未知 verdict 同理，一律报 harness error 而不是猜。
  if (v === "ok" && r.status === 0) return "ok";
  if (v === "flag" && r.status === 2) return "flag";
  return `harness-error(verdict=${v},status=${r.status}${r.signal ? `,signal=${r.signal}` : ""})`;
}

const scenarios = fs
  .readdirSync(SCEN_DIR)
  .filter((f) => f.endsWith(".txt"))
  .sort()
  .map(loadScenario);
if (!scenarios.length) {
  console.error(`✗ ${SCEN_DIR} 下没有 .txt 场景`);
  process.exit(2);
}

const nFlag = scenarios.filter((s) => s.expect === "flag").length;
console.log(
  `reverse-assertion-gate eval — ${scenarios.length} 场景（${nFlag} 漏报守卫 / ${scenarios.length - nFlag} 误报守卫）× ${N} 次\n` +
    `阈值：flag 场景 ${Math.round(THRESHOLD * 100)}% · ok 场景 ${Math.round(THRESHOLD_OK * 100)}%（误报代价更高，见 README）\n`,
);
let allPass = true;
const failed = [];
for (const s of scenarios) {
  const got = [];
  let pass = 0;
  for (let i = 0; i < N; i++) {
    const v = runHook(s.message);
    got.push(v);
    if (v === s.expect) pass++;
  }
  const bar = s.expect === "ok" ? THRESHOLD_OK : THRESHOLD;
  const ok = pass / N >= bar;
  if (!ok) {
    allPass = false;
    failed.push(s.name);
  }
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${s.name.padEnd(24)} 期望 ${String(s.expect).padEnd(4)} ${pass}/${N}  [${got.join(" ")}]`,
  );
  if (s.note) console.log(`        ↳ ${s.note}`);
}
console.log(
  allPass
    ? "\n✅ 全部场景达标"
    : `\n❌ 未达标：${failed.join("、")}——改 reverse-assertion-gate.js 的 judge prompt 后重跑；` +
        "或确认这是否是一类需要新增场景的新行为。",
);
process.exit(allPass ? 0 : 1);
