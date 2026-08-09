#!/usr/bin/env node
// capability-claim-gate 的 eval 运行器。结构承自 ../prose-choice-gate/run.mjs（隔离裁决日志、
// 只认新追加的那条 verdict、no-verdict 与 ok 分开报），差别只有一处但是本质的：
//
// **本 gate 是两段式**，判官抽取只是前半段，定生死的是"转录里有没有那次调用"。所以场景不能只给
// 一段消息文本——必须同时给出「这个 session 实际调过哪些工具」，否则第②段永远走同一条分支，
// eval 就只在验判官、验不到判别器本身。场景头因此多一个 `# attempted:`，本运行器据它合成一份
// 最小 JSONL 转录，走 transcript_path 喂给真实 hook。
//
// 需 GLM judge key（ZHIPU_API_KEY 或 ~/.claude/.glm-judge-key）：无 key 时 hook fail-open（恒 exit 0），
// eval 会假性全绿，故先检查、缺则报错退出。
// 用法：node run.mjs        （EVAL_N=采样次数  EVAL_THRESHOLD=通过率阈值  可覆盖）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(DIR, "../../capability-claim-gate.js");
const SCEN_DIR = path.join(DIR, "scenarios");
const N = Number(process.env.EVAL_N || 5);
const THRESHOLD = Number(process.env.EVAL_THRESHOLD || 0.8);

const hasKey =
  !!process.env.ZHIPU_API_KEY ||
  fs.existsSync(path.join(os.homedir(), ".claude", ".glm-judge-key"));
if (!hasKey) {
  console.error(
    "✗ 缺 GLM judge key（ZHIPU_API_KEY 或 ~/.claude/.glm-judge-key）。无 key 时 capability-claim-gate 会 fail-open（恒放行），eval 结果无意义。",
  );
  process.exit(2);
}

// 场景文件格式：`# expect:` / `# attempted:` / `# note:` 头 + 其余行即 agent 那条收尾消息的原文。
// `# attempted:` 缺省 = 本 session 一次工具都没调过（最常见的 flag 前提）。
function loadScenario(file) {
  const raw = fs.readFileSync(path.join(SCEN_DIR, file), "utf8");
  let expect = null;
  let note = "";
  let attempted = [];
  let corrupt = false;
  const body = [];
  for (const ln of raw.split("\n")) {
    const m = ln.match(/^#\s*(expect|note|attempted|corrupt):\s*(.*)$/);
    if (m) {
      if (m[1] === "expect") expect = m[2].trim();
      else if (m[1] === "note") note = m[2].trim();
      else if (m[1] === "corrupt") corrupt = /^true$/i.test(m[2].trim());
      else attempted = m[2].split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    } else {
      body.push(ln);
    }
  }
  return { name: file.replace(/\.txt$/, ""), expect, note, attempted, corrupt, message: body.join("\n").trim() };
}

const EVAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "capability-claim-eval-"));
const EVAL_LOG = path.join(EVAL_DIR, "verdicts.jsonl");
process.on("exit", () => {
  try {
    fs.rmSync(EVAL_DIR, { recursive: true, force: true });
  } catch {
    /* 清理失败不该在 eval 结论旁边多印一段 stderr */
  }
});

// 合成一份最小 JSONL 转录：每个 attempted 工具一条 tool_use 记录，末尾一条 assistant 文本。
// 形状必须与真实转录同构（message.content 数组内 type/name），因为 hook 的第②段就是照它解析的——
// 这里图省事写成扁平结构，eval 会全绿而生产恒判"未调用"，正是本 gate 自己在拦的那类假读数。
function writeTranscript(scenario, idx) {
  const p = path.join(EVAL_DIR, `transcript-${idx}.jsonl`);
  const lines = scenario.attempted.map((name) =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input: {} }] } }),
  );
  lines.push(
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: scenario.message }] } }),
  );
  // `# corrupt: true`：追加一条**承载 tool_use 却解析不了**的半行，模拟并发写入 / 截断。
  // 必须含 `"tool_use"` 子串——hook 用它做候选行预筛，不含的坏行按设计就该被无视。
  // 期望结果是可观察的 `skipped`（放行），而不是把"没看清"静默算成"没调过"去误拦。
  if (scenario.corrupt) {
    lines.push('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"EnterPlan');
  }
  fs.writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

function logSize() {
  try {
    return fs.statSync(EVAL_LOG).size;
  } catch {
    return 0;
  }
}

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

// 只认 0 与 2 两个约定退出码，且必须伴随一个真实判定；其余一律回一个不等于任何期望值的字符串，
// 从而必然判 FAIL 而不是静默算作 ok。`skipped` 也算 no-verdict：本 gate 的取证不足路径（转录读不全、
// 无 transcript_path）都走 skipped，把它读成 ok 会让"取证失败"伪装成"判定合规"。
function runHook(scenario, idx) {
  const before = logSize();
  const transcriptPath = writeTranscript(scenario, idx);
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({
      hook_event_name: "Stop",
      session_id: `eval-${scenario.name}`,
      transcript_path: transcriptPath,
      last_assistant_message: scenario.message,
    }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_JUDGE_LOG_PATH: EVAL_LOG },
  });
  const v = newVerdict(before);
  if (v === null) return "no-verdict(no-log-record)";
  if (v === "judge_unavailable" || v === "skipped") return `no-verdict(${v})`;
  if (r.status === 2) return "flag";
  if (r.status === 0) return "ok";
  return `harness-error(status=${r.status}${r.signal ? `,signal=${r.signal}` : ""})`;
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

console.log(`capability-claim-gate eval — ${scenarios.length} 场景 × ${N} 次，通过阈值 ${Math.round(THRESHOLD * 100)}%\n`);
let allPass = true;
let idx = 0;
for (const s of scenarios) {
  const got = [];
  let pass = 0;
  for (let i = 0; i < N; i++) {
    const v = runHook(s, idx++);
    got.push(v);
    if (v === s.expect) pass++;
  }
  const ok = pass / N >= THRESHOLD;
  if (!ok) allPass = false;
  console.log(`${ok ? "PASS" : "FAIL"}  ${s.name.padEnd(20)} 期望 ${String(s.expect).padEnd(4)} ${pass}/${N}  [${got.join(" ")}]`);
  if (s.note) console.log(`        ↳ ${s.note}`);
}
console.log(
  allPass
    ? "\n✅ 全部场景达标"
    : "\n❌ 有场景未达标——改 capability-claim-gate.js 的 judge prompt 后重跑；或确认这是否是一类需要新增场景的新行为。",
);
process.exit(allPass ? 0 : 1);
