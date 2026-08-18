/**
 * 逃生口放行时把「本 session 本闸已 flag N 次」报出来。
 *
 * 来源是一次实测：主线程 stop-gate 在同一 session flag 了 8 次（11:50→23:02），措辞高度重复
 * （4 次"把定序权甩给用户"、4 次"承认未完成但无正当理由"），而**每一次 flag 之后都紧跟一次**
 * `stop_hook_active` 静默放行（8/8）。累计量只存在于日志里，agent 与用户都看不到，于是每一次
 * 单看都像一次孤立的误拦。
 *
 * 本测试钉住三件事：放行判定不变（始终 exit 0）、n≥2 时读数可见、n<2 时不出声。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const hook = path.join(__dirname, 'stop-gate.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-repeat-'));
const logPath = path.join(tmp, 'judge.jsonl');
const SID = 'sess-under-test';

const env = {
  PATH: process.env.PATH,
  HOME: tmp,
  CLAUDE_JUDGE_LOG_PATH: logPath,
  // 判官必须打不通：本测试只驱动逃生口那一支，不该真发起裁决。
  STOP_GATE_JUDGE_CMD: 'false',
};

function seed(records) {
  fs.writeFileSync(logPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
function flagRec(agentId) {
  const r = { ts: new Date().toISOString(), gate: 'stop-gate', verdict: 'flag',
              reason: 'x', session_id: SID };
  if (agentId) r.agent_id = agentId;
  return r;
}
function run() {
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({
      session_id: SID, stop_hook_active: true, hook_event_name: 'Stop',
      last_assistant_message: '还剩两项没做，你想先做哪个？',
    }),
    encoding: 'utf8', env, timeout: 15000,
  });
  assert.notStrictEqual(r.status, null, `hook 未正常退出: ${r.stderr}`);
  return r;
}

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

// 1) 重复被拦：读数必须出现，且仍然放行
check('flag 到第 8 次时，放行仍是放行，但读数可见', () => {
  seed(Array.from({ length: 8 }, () => flagRec()));
  const r = run();
  assert.strictEqual(r.status, 0, '这条出口必须放行，不得阻断');
  const out = JSON.parse(r.stdout);
  // 断言 systemMessage **自身**含 N：只查整段 stdout 含 N，会放过"N 在别的字段里"的坏实现。
  assert.match(String(out.systemMessage), /至少已 flag 8 次/, `用户侧读不到累计数：${r.stdout}`);
  // **这条是本改动最要命的契约**：Stop 的 additionalContext 按契约是"继续对话"，会强行多给一个
  // 回合。而这里是逃生口——它存在的意义就是让一次误拦能被"原样再停一次"清掉。一旦在这里续轮，
  // 越是被误拦越停不下来。初版正是这么写的，且注释里把 teammate-reclaim-check.js 引成了支持它的
  // 先例，而那个文件说的恰好相反（它因此刻意不挂 Stop）。
  assert.ok(!('hookSpecificOutput' in out),
    `逃生口不得输出 hookSpecificOutput（additionalContext 会续轮、把逃生口焊死）：${r.stdout}`);
  assert.ok(!/additionalContext/.test(r.stdout), `stdout 不得含 additionalContext：${r.stdout}`);
});

// 2) 阴性对照：第一次被拦（n=1）不该出声——否则每次误拦都会多一段噪声
check('只被拦过 1 次时不出声（阴性对照）', () => {
  seed([flagRec()]);
  const r = run();
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '', `n=1 不该有输出，实得：${r.stdout}`);
});

// 3) 计数按 agent_id 分开：子代理的 flag 不得计进主线程
check('子代理的 flag 不计入主线程读数', () => {
  seed([flagRec(), flagRec(), flagRec('a-sub-1'), flagRec('a-sub-2'), flagRec('a-sub-3')]);
  const r = run();
  assert.match(r.stdout, /至少已 flag 2 次/, `应只数主线程那 2 条，实得：${r.stdout}`);
});


// 4) 轮转对照：跨分片的累计必须仍然数得到——否则 N 变成"当前分片内次数"，
//    而一个长 session 恰好会在这里被静默掉（真实 8、分片内 1、n<2 于是不出声）。
check('日志轮转后，归档分片里的 flag 仍计入', () => {
  // 名字必须与 tidy() 生成的一致：toISOString().replace(/[:.]/g,"") 只去掉 : 与 .，
  // 日期里的连字符是保留的。写成 20260818T… 会被归档正则正确地拒绝（本测试抓到过一次）。
  const archived = logPath + '.2026-08-18T000000000Z-999';
  fs.writeFileSync(archived, Array.from({ length: 6 }, () => JSON.stringify(flagRec())).join('\n') + '\n');
  seed([flagRec(), flagRec()]);              // 活分片只剩 2 条
  const r = run();
  fs.rmSync(archived, { force: true });
  assert.match(r.stdout, /至少已 flag 8 次/, `应为 6(归档)+2(活)=8，实得：${r.stdout}`);
});

// 5) 归档识别必须**只认本实现生成的名字**：同前缀的人手文件（.legacy-* / .backup）不得计入。
//    真实日志目录里就有 judge-gate.jsonl.legacy-20260808 与 .legacy-20260817 两个这样的文件，
//    而 tidy() 上方的注释早就警告过 startsWith 会吞掉它们——初版计数正是用的 startsWith。
check('同前缀的人手文件不计入（.legacy / .backup）', () => {
  const legit = logPath + '.2026-08-18T000000000Z-777';
  const legacy = logPath + '.legacy-20260808';
  const backup = logPath + '.backup';
  fs.writeFileSync(legit, JSON.stringify(flagRec()) + '\n');                       // 合法归档 1 条
  fs.writeFileSync(legacy, Array.from({length:5},()=>JSON.stringify(flagRec())).join('\n')+'\n');
  fs.writeFileSync(backup, Array.from({length:9},()=>JSON.stringify(flagRec())).join('\n')+'\n');
  seed([flagRec(), flagRec()]);                                                   // 活分片 2 条
  const r = run();
  for (const f of [legit, legacy, backup]) fs.rmSync(f, { force: true });
  assert.match(r.stdout, /至少已 flag 3 次/,
    `应为 2(活)+1(合法归档)=3，legacy/backup 的 14 条不得计入，实得：${r.stdout}`);
});

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) { console.log(`\n${failed} 失败`); process.exit(1); }
console.log('\n5 通过');
