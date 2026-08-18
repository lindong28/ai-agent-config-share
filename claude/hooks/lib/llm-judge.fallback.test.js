#!/usr/bin/env node
"use strict";
/**
 * 火山 Ark 兜底层的确定性测试。**不向任何外部端点发请求**——失败路径靠"让 curl 不存在"与
 * "让 ARK key 缺席"制造，成功路径打一个本地 stub。故离线、无凭据的环境下读数也不变。
 * （这句话曾经是假的：D2 初版给了 `ZHIPU_API_KEY`，于是 `callJudge` 会打真实智谱端点——
 * 由复核轮指出。改动这个文件时先确认新用例没有把它变回假的。）
 *
 * 四组，各自钉住一件不同的事：
 *   A. **接线**（谁带 fallback）——纯文本枚举两个入口的全部调用点。它防的是 `permission-gate`
 *      静默获得兜底：那道闸的失败方向与其余六道相反（判官不可用 → 落回问用户；判官答 safe →
 *      自动放行工具调用），给它接未经校准的兜底是把保守方向翻过来。HARNESS-315 将来会让它改用
 *      `judgeWithRoute` 以便写日志——**本组断言不禁止那次迁移**，只禁止它带上 fallback。
 *   B. **行为**（带了 fallback 会怎样、不带会怎样）——直接调 `judgeWithRoute` 读它返回的 route。
 *   C. **落盘**（字段真的进了 jsonl 没有）——B 组只看得到 route 对象，看不到记录构造那一层。
 *   D. **成功路径与请求契约**（本地 stub）——B 组全是失败路径，把 `curlArk` 的成功出口改成恒返回
 *      null 也不会红；D 组补上它，并让 stub 校验 method / 路径 / 认证头 / `reasoning_effort` 等，
 *      使"改坏了请求本身"同样变红（那些改动在真实 Ark 上是拒绝或退回 49 秒级延迟）。
 *
 * 每条主张都配一次反向变异（注释里写明改哪一处会让它变红）。A、B 两组尤其需要：它们是
 * "没发生什么"型断言，而那类断言在被测机制根本没接上时同样是绿的。
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const HOOKS_DIR = path.join(__dirname, "..");
const LIB = path.join(__dirname, "llm-judge.js");

// 这六个是**唯一**允许带 fallback 的调用点：六道写裁决日志的闸的主判官调用。
// 改这个集合前先读 llm-judge.js 里 judgeWithRoute 的注释（排除项与其理由都在那儿）。
const EXPECTED_FALLBACK_FILES = [
  "ask-recommend-gate.js",
  "capability-claim-gate.js",
  "continuation-claim-gate.js",
  "prose-choice-gate.js",
  "reverse-assertion-gate.js",
  "stop-gate.js",
];

/** 扫出每个 hook 文件里带 `fallback` 的判官调用点数量。两个入口都看——只看一个挡不住另一个。 */
function fallbackCallSites() {
  const out = {};
  for (const f of fs.readdirSync(HOOKS_DIR)) {
    if (!f.endsWith(".js") || f.includes(".test.")) continue;
    const src = fs.readFileSync(path.join(HOOKS_DIR, f), "utf8");
    // 逐个调用点扫，而不是整文件 includes("fallback")——后者会被文件里任何一处无关的
    // "fallback" 字样（注释、变量名）点亮，那正是模式匹配在这类对象上的失败形态：伪装成成功。
    const calls = src.match(/(?:judgeWithRoute|callJudge)\s*\([\s\S]*?\)\s*;/g) || [];
    const withFb = calls.filter((c) => /\bfallback\s*:\s*true\b/.test(c));
    if (withFb.length) out[f] = withFb.length;
  }
  return out;
}

function testCallSites() {
  const sites = fallbackCallSites();

  // A1：带 fallback 的文件集合恰好是那六个。多一个少一个都红。
  // 变异对照：把任一 gate 的 `{ fallback: true }` 删掉 → 该文件从 sites 消失 → 本断言红。
  assert.deepStrictEqual(
    Object.keys(sites).sort(),
    [...EXPECTED_FALLBACK_FILES].sort(),
    `带 fallback 的调用点集合与预期不符：实际 ${JSON.stringify(sites)}`,
  );

  // A2：permission-gate 一处都不带。**它与 A1 不重复**——A1 只说"集合等于这六个"，
  // 而本条把最危险的那一个单独钉出来，让失败信息直接指名它，而不是让读者去 diff 两个数组。
  // 变异对照：给 permission-gate.js 的 callJudge 加 `{ fallback: true }` → 本断言红。
  assert.ok(
    !sites["permission-gate.js"],
    "permission-gate 不得启用兜底：它判官不可用时落回问用户（保守），判官答 safe 则自动放行工具调用——" +
      "接一个未经校准的兜底会把这个方向翻过来。理由见 llm-judge.js 的 judgeWithRoute。",
  );

  // A3：stop-gate 恰好只有一处带 fallback。它有两次判官调用，policy 那次（httpOnly + 8s）不得带——
  // 一个进程里两次调用各叠 15s 兜底会顶穿 hook 预算。
  // 变异对照：给 stop-gate.js 的 policy 判官那次调用加 fallback → 计数变 2 → 本断言红。
  assert.strictEqual(
    sites["stop-gate.js"],
    1,
    `stop-gate 应恰有 1 处带 fallback（主判官），policy 判官那次不得带；实际 ${sites["stop-gate.js"]}`,
  );
}

/** 制造"主判官必然失败"：把 curl 从 PATH 里拿掉，spawnSync 直接 ENOENT。不需要网络也不需要坏 key。 */
function withBrokenCurl(env, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, env, { PATH: "/nonexistent" });
  // 每次重新 require：judgeWithRoute 读的是 process.env 的当次值，而 key 的读取在函数内，
  // 故其实不需要清 cache；这里清掉是为了让本测试不依赖那个实现细节。
  delete require.cache[require.resolve(LIB)];
  try {
    return fn(require(LIB));
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
    delete require.cache[require.resolve(LIB)];
  }
}

function testBehavior() {
  // B1：**不带 fallback** 时，主判官失败就到此为止——route 仍指向主判官，且不带 fallback_from。
  // 这是"没有回落"这条既有不变量在默认路径上仍然成立的证据。
  // 变异对照：把 judgeWithRoute 里的 `!wantFallback` 去掉（即无条件回落）→ backend 变 "ark" → 本断言红。
  withBrokenCurl({ ZHIPU_API_KEY: "test-key", ARK_API_KEY: "test-ark" }, (m) => {
    const { text, route } = m.judgeWithRoute("x", 0);
    assert.strictEqual(text, null, "主判官失败应返回 null");
    assert.strictEqual(route.backend, "glm", "不带 fallback 时 route 应仍指向主判官");
    assert.ok(!route.fallback_from, "不带 fallback 时不得出现 fallback_from——它的语义是'兜底试过了'");
  });

  // B2：**带 fallback** 时接手，且 route 记下被接替者。这里 Ark 也会失败（curl 仍不在），
  // 于是同时覆盖**双失败**：text 为 null，但 fallback_from 在场——这正是"主判官挂了没试兜底"
  // 与"两个都试了都挂"的区分点，缺了它这条最要紧的路径不可观测。
  // 变异对照：把 toArk 里的 `fallback_from: from` 删掉 → 本断言红。
  withBrokenCurl({ ZHIPU_API_KEY: "test-key", ARK_API_KEY: "test-ark" }, (m) => {
    const { text, route } = m.judgeWithRoute("x", 0, { fallback: true });
    assert.strictEqual(text, null, "双失败时仍应 fail-open（返回 null），绝不阻断");
    assert.strictEqual(route.backend, "ark", "兜底接手后 route 应指向 ark");
    assert.strictEqual(route.fallback_from, "glm", "应记下被接替的主判官");
    assert.ok(route.failure, "兜底失败时应带 failure，让它与'没试过兜底'分得开");
  });

  // B3：没有 ARK key 时兜底整层不尝试，失败成因是 no_key 而不是超时或报错。
  // 它保证"没配 key"退化成加这层之前的行为，而不是每次多付一次超时。
  // 变异对照：把 curlArk 开头的 `if (!key)` 早退删掉 → failure 变成 spawn_error → 本断言红。
  withBrokenCurl({ ZHIPU_API_KEY: "test-key", ARK_API_KEY: "" }, (m) => {
    const { route } = m.judgeWithRoute("x", 0, { fallback: true });
    assert.strictEqual(route.failure, "no_key", "无 ARK key 时应立即以 no_key 收场，不发请求");
  });

  // B4：校准旁路把主判官整个换掉——**但只对已 opt-in 的调用点生效**。
  // 变异对照：把 JUDGE_FORCE_BACKEND 那一行删掉 → backend 变 "glm" → 本断言红。
  withBrokenCurl({ ZHIPU_API_KEY: "test-key", ARK_API_KEY: "", JUDGE_FORCE_BACKEND: "ark" }, (m) => {
    const { route } = m.judgeWithRoute("x", 0, { fallback: true });
    assert.strictEqual(route.backend, "ark", "JUDGE_FORCE_BACKEND=ark 应直接走兜底后端");
    assert.strictEqual(route.fallback_from, null, "旁路不是'接替'，故 fallback_from 应为 null");
  });

  // B5：**校准旁路不得成为绕过 opt-in 的第二通路**。这是 2026-08-17 review gate 抓到的
  // blocker：初版把 JUDGE_FORCE_BACKEND 判断放在 wantFallback 之前，于是只要该环境变量在，
  // 走 `callJudge`（不传 opts）的 `permission-gate` 判官也会变成 Ark——而那道闸判官答 `safe`
  // 即**自动放行工具调用**，正是整个 opt-in 要挡的事。
  // A 组的调用点枚举**结构上挡不住它**：那道防线本身完好，洞在它旁边。所以本条必须是行为断言。
  // 变异对照：把该判断的 `wantFallback &&` 去掉 → backend 变回 "ark" → 本断言红。
  withBrokenCurl({ ZHIPU_API_KEY: "test-key", ARK_API_KEY: "", JUDGE_FORCE_BACKEND: "ark" }, (m) => {
    const { route } = m.judgeWithRoute("x", 0);
    assert.strictEqual(
      route.backend,
      "glm",
      "未 opt-in 的调用点即便设了 JUDGE_FORCE_BACKEND 也不得走 Ark（permission-gate 走的正是这条路）",
    );
    // 下面这条只是 callJudge 的冒烟检查，**不要当成"它没走 Ark"的证据**：callJudge 丢掉 route、
    // 只回文本，而"走了失败的 GLM"与"错走到 Ark 但 Ark 也失败"都返回 null——零区分力。
    // 真正钉住"未 opt-in 就一个请求都不许发出去"的是 D 组的命中计数（testArkSuccessPath 的 D2）。
    assert.strictEqual(m.callJudge("x", 0), null, "callJudge 在主判官失败时应返回 null");
  });
}

/**
 * C 组：**字段真的写进了文件**。B 组只证明 route 上带着这些值，那与"日志里读得到"是两件事——
 * judge-log 的记录构造是一串条件展开，任何一处条件写错都会让字段静默消失，而 B 组读不到那一层。
 */
function testLogging() {
  const os = require("os");
  const tmp = path.join(os.tmpdir(), `judge-log-fallback-test-${process.pid}.jsonl`);
  const saved = process.env.CLAUDE_JUDGE_LOG_PATH;
  process.env.CLAUDE_JUDGE_LOG_PATH = tmp;
  delete require.cache[require.resolve(path.join(__dirname, "judge-log.js"))];
  try {
    fs.rmSync(tmp, { force: true });
    const { logVerdict } = require(path.join(__dirname, "judge-log.js"));
    logVerdict("stop-gate", "judge_unavailable", null, { hook_event_name: "Stop", session_id: "s1" }, {
      route: { backend: "ark", model: "glm-5.3", fallback_from: "glm", failure: "empty_completion" },
    });
    const rec = JSON.parse(fs.readFileSync(tmp, "utf8").trim().split("\n").pop());

    // C1：兜底两键落盘。变异对照：删掉 judge-log 里 fallback_from 那条展开 → 本断言红。
    assert.strictEqual(rec.backend, "ark", "backend 应落盘为 ark");
    assert.strictEqual(rec.fallback_from, "glm", "fallback_from 应落盘");
    assert.strictEqual(rec.judge_failure, "empty_completion", "judge_failure 应落盘");

    // C2：**双失败在日志里与"没试兜底"分得开**——这是本改动最要紧的可观测性主张，
    // 而它只有在字段落盘之后才成立。判据按 llm-judge 的注释：看 backend，不看 fallback_from。
    assert.strictEqual(rec.verdict, "judge_unavailable", "双失败仍应 fail-open");
    assert.ok(
      rec.backend === "ark" && rec.verdict === "judge_unavailable",
      "「两个都试了都挂」的形状应是 backend=ark + judge_unavailable",
    );

    // C3：主判官成功那条**不得**带兜底两键——缺席是常态，在场才有信息。
    // 变异对照：把那两条展开改成无条件写入 → 本断言红。
    logVerdict("stop-gate", "ok", null, { hook_event_name: "Stop", session_id: "s2" }, {
      route: { backend: "glm", model: "glm-4.6" },
    });
    const ok = JSON.parse(fs.readFileSync(tmp, "utf8").trim().split("\n").pop());
    assert.ok(!("fallback_from" in ok), "主判官作答时不得写 fallback_from");
    assert.ok(!("judge_failure" in ok), "主判官作答时不得写 judge_failure");
  } finally {
    fs.rmSync(tmp, { force: true });
    if (saved === undefined) delete process.env.CLAUDE_JUDGE_LOG_PATH;
    else process.env.CLAUDE_JUDGE_LOG_PATH = saved;
    delete require.cache[require.resolve(path.join(__dirname, "judge-log.js"))];
  }
}

/**
 * 起一个本地 HTTP stub 当 Ark 端点，返回它真实的应答形状。**离线、确定**。
 *
 * 它同时给出一个 B 组拿不到的判据：**命中计数**。`callJudge` 丢掉 route、只返回文本，于是
 * "走了失败的 GLM" 与 "错走到无 key 的 Ark" 在它的返回值上都是 null——用返回值断言零区分力
 * （复核轮正是这么指出 B5 那条 callJudge 断言证明不了它声称的事）。而 stub 收没收到请求，
 * 在这两种世界里不同。
 *
 * **stub 必须在独立进程里**：被测路径内部是 `spawnSync`，它阻塞本进程的事件循环；stub 若同进程，
 * curl 发出的请求永远等不到处理，只会超时——初版就是这么写的，读数是"成功路径返回 null"，
 * 与真的解析失败完全同形。
 */
function withArkStub(env, fn) {
  const { spawn, spawnSync } = require("child_process");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ark-stub-"));
  const portFile = path.join(dir, "port");
  const hitFile = path.join(dir, "hits");
  const script = path.join(dir, "stub.js");
  fs.writeFileSync(
    script,
    // stub **校验真实请求契约**再放行。不校验的话，删掉 reasoning_effort、写错路径、丢掉认证头
    // 都不会让测试变红，而真实 Ark 会拒绝或退回 49 秒级延迟——那正是本层存在的理由。
    `const http=require("http"),fs=require("fs");let h=0;
const s=http.createServer((q,r)=>{h++;fs.writeFileSync(${JSON.stringify(hitFile)},String(h));
 let b="";q.on("data",c=>b+=c);q.on("end",()=>{
  let j={};try{j=JSON.parse(b)}catch{}
  const bad=[];
  if(q.method!=="POST")bad.push("method="+q.method);
  if(q.url!=="/chat/completions")bad.push("path="+q.url);
  if(!/^Bearer .+/.test(q.headers.authorization||""))bad.push("auth");
  if(j.model!=="glm-5.3")bad.push("model="+j.model);
  if(j.reasoning_effort!=="low")bad.push("reasoning_effort="+j.reasoning_effort);
  if(!(j.max_tokens>=512))bad.push("max_tokens="+j.max_tokens);
  if("thinking" in j)bad.push("thinking 不该传（Ark 拒绝 disabled）");
  if(bad.length){r.writeHead(400,{"content-type":"application/json"});
   r.end(JSON.stringify({error:{message:"契约不符: "+bad.join(", ")}}));return;}
  r.writeHead(200,{"content-type":"application/json"});
  r.end(JSON.stringify({model:"glm-5.3",choices:[{finish_reason:"stop",message:{content:"flag: stub 判定"}}],usage:{completion_tokens:7}}));});});
s.listen(0,"127.0.0.1",()=>fs.writeFileSync(${JSON.stringify(portFile)},String(s.address().port)));`,
  );
  fs.writeFileSync(hitFile, "0");
  const child = spawn(process.execPath, [script], { stdio: "ignore", detached: false });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(portFile) && Date.now() < deadline) spawnSync("sleep", ["0.02"]);
  assert.ok(fs.existsSync(portFile), "stub 端口未就绪");
  const port = fs.readFileSync(portFile, "utf8").trim();
  const saved = { ...process.env };
  Object.assign(process.env, env, { ARK_BASE_URL: `http://127.0.0.1:${port}` });
  delete require.cache[require.resolve(LIB)];
  try {
    return fn(require(LIB), () => Number(fs.readFileSync(hitFile, "utf8").trim()));
  } finally {
    child.kill();
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
    delete require.cache[require.resolve(LIB)];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testArkSuccessPath() {
  // D1：**成功路径有回归保护**。复核轮的判据是"把 curlArk 的成功出口改成永久返回 null，
  // 离线测试仍全绿"——本条正是为堵它而加：断言真的拿到了文本、且 failure 缺席。
  // 变异对照：把 curlArk 末尾的 `return { text, failure: null }` 改成 `return { text: null, ... }` → 本条红。
  withArkStub({ ARK_API_KEY: "stub-key", JUDGE_FORCE_BACKEND: "ark" }, (m, hits) => {
    const { text, route } = m.judgeWithRoute("x", 0, { fallback: true });
    assert.strictEqual(text, "flag: stub 判定", "应返回 Ark 解析出的文本");
    assert.strictEqual(route.backend, "ark");
    assert.ok(!route.failure, "成功时不得带 failure");
    assert.strictEqual(hits(), 1, "应恰好发出一次请求");
  });

  // D2：**未 opt-in 的调用点一次请求都不许发出去**。这才是 B5 那条 callJudge 断言想说、
  // 但用返回值说不出来的事——命中计数在"被旁路救走"与"没被救走"两种世界里不同。
  // 变异对照：去掉 JUDGE_FORCE_BACKEND 判断上的 `wantFallback &&` → 计数变 1 → 本条红。
  // **刻意不配主判官 key + httpOnly**：这样本条一个外部请求都不发（复核轮指出初版给了
  // ZHIPU_API_KEY，于是 callJudge 会打真实智谱端点——文件头"不联网"那句当时是假的）。
  // 判别力不受影响：旁路判断在主判官选路**之前**，去掉 `wantFallback &&` 它照样会先命中 stub。
  withArkStub(
    { ZHIPU_API_KEY: "", ANTHROPIC_API_KEY: "", ARK_API_KEY: "stub-key", JUDGE_FORCE_BACKEND: "ark" },
    (m, hits) => {
      m.callJudge("x", 0, { httpOnly: true }); // permission-gate 走的正是 callJudge 这个入口
      assert.strictEqual(hits(), 0, "未 opt-in 的调用点不得向 Ark 发出任何请求");
    },
  );
}

const tests = [testCallSites, testBehavior, testLogging, testArkSuccessPath];
let failed = 0;
(async () => {
for (const t of tests) {
  try {
    await t();
    console.log(`ok  ${t.name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${t.name}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
})();
