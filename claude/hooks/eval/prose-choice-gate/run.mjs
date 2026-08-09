#!/usr/bin/env node
// prose-choice-gate 判官 prompt 的 eval 运行器。
// 给【真实】prose-choice-gate.js 喂带标签的 agent 收尾消息，统计每个场景 N 次采样的通过率。
// - 打真实 artifact（不另抄 prompt）——避免「offline prompt 与部署漂移 → 漏报」。
// - 经 payload 的 `last_assistant_message` 内联字段喂入，这正是生产路径的主取法（转录扫描是回落），
//   所以场景文件就是一段纯消息文本，不必合成 JSONL。
// - GLM 判官走 temp=0，近确定性；通过率保留为残余非确定性的安全余量。
// - 需 GLM judge key（ZHIPU_API_KEY 或 ~/.claude/.glm-judge-key）：无 key 时 hook fail-open（恒 exit 0），
//   eval 会假性全绿，故先检查、缺则报错退出。
// 用法：node run.mjs        （EVAL_N=采样次数  EVAL_THRESHOLD=通过率阈值  可覆盖）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(DIR, "../../prose-choice-gate.js");
const SCEN_DIR = path.join(DIR, "scenarios");
const N = Number(process.env.EVAL_N || 5);
const THRESHOLD = Number(process.env.EVAL_THRESHOLD || 0.8);

const hasKey =
  !!process.env.ZHIPU_API_KEY ||
  fs.existsSync(path.join(os.homedir(), ".claude", ".glm-judge-key"));
if (!hasKey) {
  console.error(
    "✗ 缺 GLM judge key（ZHIPU_API_KEY 或 ~/.claude/.glm-judge-key）。无 key 时 prose-choice-gate 会 fail-open（恒放行），eval 结果无意义。",
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

// 裁决日志改指临时文件。打的是【真实】hook，而它现在会落盘裁决——不隔离就会把每轮上百条合成记录
// 灌进 ~/.claude/logs/judge-gate.jsonl，把那份日志的审计用途冲掉（实测一轮 220 行里 164 行来自 eval）。
// 这是明确可再生、可随时被删的一次性诊断输出，故用系统临时目录。
// mkdtemp 而非 pid 命名：pid 会被系统回收，届时新一轮会接着上一轮的残留文件追加，
// 「本轮应有 N 条裁决」这条诊断读数就不再成立。跑完即删。
const EVAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "judge-gate-eval-"));
const EVAL_LOG = path.join(EVAL_DIR, "verdicts.jsonl");
// 挂 exit 而不是在主流程末尾删：缺 key 的 process.exit(2)、无场景、读场景抛错等路径都绕过末尾那行，
// "跑完即删"的契约会在这些路径上悄悄不成立。
process.on("exit", () => {
  try {
    fs.rmSync(EVAL_DIR, { recursive: true, force: true });
  } catch {
    /* 清理失败不该在 eval 结论旁边多印一段 stderr */
  }
});

/**
 * 这一次调用里 hook 自己记下的 verdict。**exit code 不足以判定**：判官不可用时 hook 按设计 fail-open、
 * exit 0，与"判官判了 ok"在退出码上完全同形。实测被这一点咬过——判官侧限流后，期望 flag 的场景整片翻绿，
 * 读上去像 rubric 退化，实则判官从未作答。裁决日志是唯一能把这两件事分开的读数。
 */
function logSize() {
  try {
    return fs.statSync(EVAL_LOG).size;
  } catch {
    return 0;
  }
}

// 只解析【本次调用新追加的那一段】。读"文件最后一行"会在本次根本没写成记录时（磁盘满、权限异常、
// 未覆盖到的早退路径）读到上一次的裁决，把别人的 ok 当成本次的判定——正是这套机制要消除的那种混淆。
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

// 按真实 Stop hook 协议喂 stdin。只认 0 与 2 两个约定退出码，且必须伴随一个真实判定：
// 其余情形一律回一个不等于任何期望值的字符串，从而必然判 FAIL 而不是静默算作 ok。
function runHook(message) {
  const before = logSize();
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({ last_assistant_message: message }),
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

console.log(`prose-choice-gate eval — ${scenarios.length} 场景 × ${N} 次，通过阈值 ${Math.round(THRESHOLD * 100)}%\n`);
let allPass = true;
for (const s of scenarios) {
  const got = [];
  let pass = 0;
  for (let i = 0; i < N; i++) {
    const v = runHook(s.message);
    got.push(v);
    if (v === s.expect) pass++;
  }
  const ok = pass / N >= THRESHOLD;
  if (!ok) allPass = false;
  console.log(`${ok ? "PASS" : "FAIL"}  ${s.name.padEnd(18)} 期望 ${String(s.expect).padEnd(4)} ${pass}/${N}  [${got.join(" ")}]`);
  if (s.note) console.log(`        ↳ ${s.note}`);
}
console.log(
  allPass
    ? "\n✅ 全部场景达标"
    : "\n❌ 有场景未达标——改 prose-choice-gate.js 的 judge prompt 后重跑；或确认这是否是一类需要新增场景的新行为。",
);
process.exit(allPass ? 0 : 1);
