#!/usr/bin/env node
'use strict';
/**
 * ADR-019 的判别器：判官路由的归属是否**逐调用**正确落进裁决日志。
 *
 * 为什么这份测试非有不可：`stop-gate` 一个进程里调两次判官（policy 判官经
 * commitDecisionParkedConcern 先跑，主判官后跑）。旧实现把路由放在模块级"最近一次"状态里，
 * 于是那条走 commitParked 的确定性 flag 会**继承 policy 判官的 backend**，尽管它自己没经过判官
 * ——HARNESS-314。修好之后它应当两键皆缺。
 *
 * **为什么不能靠"真实环境跑一次看看"**：docs/autopilot-phase1-remediation.md 记着，真实环境里
 * 两个判官通常拿到**相同**的 {backend, model}，此时"被覆盖"与"归因正确"输出完全相同、零区分力。
 * 所以下面刻意制造两个**不同**的路由。
 *
 * 零网络、零真实模型：入口 A 用一个假 `curl`（PATH 前置）冒充 HTTP 判官；入口 B 用
 * CLAUDE_CLI_PATH（llm-judge.resolveClaudeBin 本就支持）指向一个秒回的 stub。**不用真实
 * `claude -p`**：它 25s 的内部上限对 28s 的 hook 上限只剩约 3s，做不了稳定判别器。
 *
 * 入口 C 是**负向对照**，不是补充：没有它，"没测到漏传"在「检测器正常且无人漏传」与
 * 「检测器根本没接上」两种情况下读数完全相同。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, 'stop-gate.js');
const { NEST_GUARD } = require('./lib/llm-judge');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'route-attr-'));
const fakeHome = path.join(tmp, 'home');
fs.mkdirSync(fakeHome, { recursive: true });
let pass = 0;
const fails = [];
// `run-tests.sh` 把失败输出里出现 `judge_unavailable` 的整份测试判为"判官不可用"、**不计入 fail**
// （那条规则是为真判官掉线设计的）。本测试零网络、不可能真判官掉线，但它的断言天然要提到那个
// verdict 值——于是任何真回归（含 HARNESS-314 原错误重现）都会被套件吞掉、退出码仍为 0。
// 故所有面向 stdout 的文本一律脱敏该串；断言本身照常比对原值。
const SENTINEL = 'judge' + '_unavailable';
const scrub = (x) => String(x).split(SENTINEL).join('judge-unavail');
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`PASS  ${scrub(name)}`); }
  else { fails.push(scrub(name)); console.log(`FAIL  ${scrub(name)}${detail ? '\n        ' + scrub(detail) : ''}`); }
};

/** 假 curl：无视参数，吐一个 Anthropic 形状的应答，text 为 `answer`。 */
function fakeCurl(answer) {
  const p = path.join(tmp, `curlbin-${Buffer.from(answer).toString('hex').slice(0, 12)}`);
  fs.mkdirSync(p, { recursive: true });
  const f = path.join(p, 'curl');
  fs.writeFileSync(f, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify({ content: [{ type: 'text', text: answer }] })}\nJSON\n`);
  fs.chmodSync(f, 0o755);
  return p;
}

/** 秒回的 claude CLI stub —— 顶替 tier-3，避免 25s 冷启动。 */
function fakeCli(answer) {
  const f = path.join(tmp, 'claude-stub.sh');
  fs.writeFileSync(f, `#!/bin/sh\nprintf '%s' ${JSON.stringify(answer)}\n`);
  fs.chmodSync(f, 0o755);
  return f;
}

/** 跑一次 hook，返回本次写进隔离日志的所有记录。 */
function runGate(payload, env, hookPath = HOOK) {
  const logPath = path.join(tmp, `log-${Math.abs(payload.__tag || 0)}-${env.__tag || ''}-${fs.readdirSync(tmp).length}.jsonl`);
  const base = { ...process.env };
  delete base[NEST_GUARD];
  delete base.ZHIPU_API_KEY;
  delete base.ANTHROPIC_API_KEY;
  // **仅删 env 不够**：`glmKey()` 在两个 env 变量都缺时会回落读 `$HOME/.claude/.glm-judge-key`。
  // 保留真实 HOME 时，装了文件型 key 的机器上入口 B 会实际选中 GLM 并发真网络请求，两条路由
  // 变成 glm/glm——而那正是 autopilot-phase1-remediation 说的"相同 route 时被覆盖与归因正确同形"。
  // 于是这个判别器会在别人的机器上静默失去判别力。改指向空 HOME，让回落必然落空。
  base.HOME = fakeHome;
  spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 30000,
    // HOME 用 base 里的 fakeHome（上面刚设的）。**别在这里覆盖回真实 HOME**——那会让
    // `glmKey()` 的文件回落重新生效，于是装了 `~/.claude/.glm-judge-key` 的机器上入口 B
    // 会静默改走 GLM，两条路由变成 glm/glm，判别器失去区分力而读数仍全绿。
    env: { ...base, ...env, CLAUDE_JUDGE_LOG_PATH: logPath },
  });
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// commitParked 那条路要求消息命中 COMMIT_ASK；这句是本仓自己 flag 文案里的同一类表述。
const COMMIT_ASK_MSG = '改动都已就绪，要我提交吗？';

// **policy 判官只在项目指令文件存在时才被调用**——「全都不存在」本身就是核实成功，不需要判官
// （见 stop-gate 的 projectInstructionsPermitCommitReminder）。空 cwd 会让整条 policy 路径静默跳过，
// 于是入口 A/B 测不到任何东西却"看起来只是没匹配上"。所以这里必须放一份。
// 还必须是一个 **git 仓**：collectProjectInstructions 先取 repoRoot()，拿不到就直接
// { verifiable:false }，policy 判官同样不会被调用（实测：不 git init 时该函数返回
// {"verifiable":false,"text":""}，整条 policy 路径静默跳过）。
const projDir = path.join(tmp, 'proj');
fs.mkdirSync(projDir, { recursive: true });
fs.writeFileSync(path.join(projDir, 'CLAUDE.md'), '# 项目指令\n\n本项目的构建命令是 `make build`。\n');
{
  const gi = spawnSync('git', ['init', '-q'], { cwd: projDir, encoding: 'utf8' });
  assert.strictEqual(gi.status, 0, `git init 失败，本测试的前置条件不成立: ${gi.stderr}`);
}

const payload = (msg) => ({
  hook_event_name: 'Stop',
  session_id: 'route-attr-test',
  transcript_path: path.join(tmp, 'nonexistent.jsonl'),
  last_assistant_message: msg,
  cwd: projDir,      // 含 CLAUDE.md，policy 判官才会被调用（见上）
  stop_hook_active: false,
});

// ───────────────────────── 入口 A：policy 判官答 silent → :610 那条确定性 flag ─────────────────────────
// 断言核心：policy 判官那条记录带它自己的 backend；**那条确定性 flag 两键皆缺**，且不带
// judge_attribution_missing（它显式声明了 judged:false）。旧实现下它会继承 policy 的 backend。
{
  const recs = runGate(payload(COMMIT_ASK_MSG), {
    ZHIPU_API_KEY: 'fake-key-entry-a',
    PATH: `${fakeCurl('silent')}:${process.env.PATH}`,
  });
  // **按顺序定位，不按 reason**：`logVerdict` 只在 flag / skipped 时写 reason，而 policy 判官答
  // silent 时落的是 verdict=ok、无 reason。控制流上 policy 判官必先于其它出口（它在
  // commitDecisionParkedConcern 内部），所以"第一条"就是它的语义位置。
  const policy = recs[0];
  const parked = recs.find((r) => String(r.reason || '').includes('把「要不要提交」交回用户'));

  check('A1 policy 判官落了自己的裁决记录', !!policy && recs.length >= 2,
    `实得记录: ${JSON.stringify(recs.map((r) => ({ v: r.verdict, b: r.backend })))}`);
  check('A2 policy 记录带自己的 backend', policy && policy.backend === 'glm', `实得 backend=${policy && policy.backend}`);
  check('A3 确定性 flag 落了记录', !!parked, `实得记录: ${JSON.stringify(recs.map((r) => r.verdict))}`);
  // ↓ 这一条就是 HARNESS-314 本身：旧实现下 parked.backend === 'glm'
  check('A4 确定性 flag 不带 backend（不继承 policy 判官）', parked && parked.backend === undefined,
    `实得 backend=${parked && parked.backend}`);
  check('A5 确定性 flag 不带 model', parked && parked.model === undefined, `实得 model=${parked && parked.model}`);
  check('A6 确定性 flag 未被误判为漏传归属', parked && parked.judge_attribution_missing === undefined,
    `实得 judge_attribution_missing=${parked && parked.judge_attribution_missing}`);
}

// ───────────────────────── 入口 B：两个判官拿到**不同**路由 ─────────────────────────
// 无 HTTP key → policy 判官（httpOnly）得 {backend:'none'}、返回 null → 视为"禁止自主 commit"
// → commitParked 为假 → 主判官继续跑，经 CLAUDE_CLI_PATH stub 得 {backend:'claude-cli'}。
// 两个取值不同，故"被覆盖"与"归因正确"读数**不同**——这正是 autopilot-phase1-remediation 要求的。
{
  const recs = runGate(payload(COMMIT_ASK_MSG), { CLAUDE_CLI_PATH: fakeCli('ok') });
  const policy = recs[0];              // policy 判官（httpOnly，先跑）
  const main = recs[recs.length - 1];  // 主判官（commitParked 为假后继续跑）

  check('B1 policy 判官记录 backend=none', policy && policy.backend === 'none',
    `实得 ${JSON.stringify(policy)}`);
  check('B2 policy 判官 verdict 为判官不可用', policy && policy.verdict === SENTINEL,
    `实得 verdict=${policy && policy.verdict}`);
  check('B3 主判官记录 backend=claude-cli（未被 policy 的 none 覆盖）',
    main && main.backend === 'claude-cli', `实得 ${JSON.stringify(main)}`);
  check('B4 两条记录的 backend 确实不同（判别器有区分力）',
    policy && main && policy !== main && policy.backend !== main.backend,
    `policy=${policy && policy.backend} main=${main && main.backend}`);
}

// ───────────────────────── 入口 C：负向对照 —— 证明检测器报得出失败 ─────────────────────────
// 把那唯一一处 `{ judged: false }` 从 stop-gate 的副本里切掉，重跑入口 A 的场景。
// 检测器若真的接上了，这里必须出现 judge_attribution_missing: true。
// 它若不出现，说明上面 A6 的"通过"什么也没证明。
{
  const src = fs.readFileSync(HOOK, 'utf8');
  const MARK = ', { judged: false }';
  const mutantOk = src.includes(MARK);
  // **变异体必须落在 hooks 目录内**：它 `require('./lib/llm-judge')` 是相对自身解析的，
  // 放进临时目录会让进程在 require 阶段就崩掉、一条记录都不写——那样 C1 会"因为别的原因"失败，
  // 而不是因为检测器没接上，等于这条对照什么也没测（首次实现即踩中）。
  // 文件名刻意不带 `.test.js`，免得被 run-tests.sh 的 glob 捡去当成一份独立测试。
  const mutantPath = path.join(__dirname, '.route-attr-mutant.js');
  fs.writeFileSync(mutantPath, src.replace(MARK, ''));

  check('C0 变异体确实切掉了目标声明（否则本对照无意义）', mutantOk,
    '在 stop-gate.js 里找不到 `, { judged: false }`——若该处写法改过，请同步本测试');

  // **清理必须在 finally 里**：变异体落在 live hooks 目录，中途抛异常或被打断就会永久留下，
  // 而 `gate-stats` 的 `installedGates()` 把任何 require 了 `lib/judge-log` 的非 `.test.js`
  // 文件识别成一道已安装的闸——仓里会凭空多出一道不存在的 gate（实测该文件确会被 listed）。
  let recs;
  try {
    recs = runGate(payload(COMMIT_ASK_MSG), {
      ZHIPU_API_KEY: 'fake-key-entry-c',
      PATH: `${fakeCurl('silent')}:${process.env.PATH}`,
    }, mutantPath);
  } finally {
    fs.rmSync(mutantPath, { force: true });
  }
  const parked = recs.find((r) => String(r.reason || '').includes('把「要不要提交」交回用户'));

  check('C1 切掉声明后，检测器报出 judge_attribution_missing',
    parked && parked.judge_attribution_missing === true,
    `实得 ${JSON.stringify(parked)}（本次共 ${recs.length} 条记录）—— 若为 undefined，说明检测器没接上，A6 的通过不构成证据`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(scrub(`\n${pass} 通过${fails.length ? `，${fails.length} 失败：${fails.join('、')}` : ''}`));
process.exit(fails.length ? 1 : 0);
