'use strict';
/**
 * 钉住第三方豁免的**生命周期**与**注入文本的反向守卫**。
 *
 * 判官的裁决不在这里测（那归 eval/），这里测的是纯函数部分——而它正是本轮修复的承重面：
 * 豁免续期多一格就是"按 id 发的通行证"，少一格就回到 HARNESS-20260823-022b 修好、
 * 却在用户改用自然语言追问时整个失效的那个状态（实测 4/4 误拦）。
 *
 * **这里没有跨回合锚点的用例，那是有意的**：本轮曾加过一个 `~/.claude/state/` 下的锚点去
 * 延长豁免的可达性，两轮对抗复核在它上面开出 7 条 finding（窗口 / 单调性 / 创建期权限 /
 * 迁移期权限 / 异常边界 / 删除失败 / 清除事件的身份识别），修复轮预算触发后经用户裁决整块
 * 回退。若要重做，先读 `docs/issues/archive/closed.md` 的 `HARNESS-20260824-7c31`——
 * 那七个面是一份现成的失效域清单，尤其最后一面：task notification 带
 * `promptSource: 'system'`（实测 167/192），会被任何"最后一条真人 prompt"的取法当成真人输入。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { activeCommandName } = require('./transcript');
const { thirdPartyContext, thirdPartyReportCommand } = require('./third-party-command');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpc-'));
let n = 0;
const user = (text, extra = {}) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, ...extra });
const transcript = (...lines) => {
  const p = path.join(dir, `t${n++}.jsonl`);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
};
// 真实形态：三个标签，args 里带被分析对象的 session id 前缀。
const call = (name, args) =>
  user(`<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`);
const human = (text) => user(text, { promptSource: 'user' });

const CMD = 'custom:review-session-progress';
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

// ——— 豁免续期：命中面 ———
test('追问仍点名同一目标 id → 豁免续期', () => {
  const p = transcript(call(CMD, '53e93100'), human('再看一下 session 53e93100 的最新进展'));
  assert.strictEqual(activeCommandName(p), CMD);
});

test('args 是整句话时也能取出 id（用户常这么敲）', () => {
  const p = transcript(call(CMD, '现在再分析一下 session 53e93100 的进展'), human('53e93100 还差多少工作？'));
  assert.strictEqual(activeCommandName(p), CMD);
});

test('连续多轮追问都点名 → 一路续期', () => {
  const p = transcript(
    call(CMD, '53e93100'),
    human('再看一下 53e93100'),
    human('53e93100 还差多少'),
    human('53e93100 预计多久'),
  );
  assert.strictEqual(activeCommandName(p), CMD);
});

// ——— 豁免过期：反向守卫（这几条比上面更承重） ———
test('追问不点名 → 豁免过期（换了话题）', () => {
  const p = transcript(call(CMD, '53e93100'), human('分析最近几轮的 stop hook error'));
  assert.strictEqual(activeCommandName(p), null);
});

test('追问点名的是**别的** id → 不续期', () => {
  const p = transcript(call(CMD, '53e93100'), human('看下 b5c7a175 那个 session'));
  assert.strictEqual(activeCommandName(p), null);
});

test('调用没带 args → 没有锚，追问一律不续期', () => {
  const p = transcript(
    user(`<command-message>${CMD}</command-message>\n<command-name>/${CMD}</command-name>`),
    human('再看一下 53e93100'),
  );
  assert.strictEqual(activeCommandName(p), null);
});

test('续期一次后再换话题 → 仍会过期（不是一次续期就永久豁免）', () => {
  const p = transcript(call(CMD, '53e93100'), human('再看一下 53e93100'), human('说说别的事'));
  assert.strictEqual(activeCommandName(p), null);
});

test('从没有过命令块、只是随口提了个 hex 串 → null（不凭 id 形状发豁免）', () => {
  const p = transcript(human('看下 deadbeef12 这个 sha 怎么回事'));
  assert.strictEqual(activeCommandName(p), null);
});

// ——— 跨窗口：命令块落在首个探测窗之外 ———
// 这一条不是补全性用例，它守的是**生产路径**：真实回合里命令块与末尾之间隔着整轮输出
// （transcript.js 注释记的实测值是 1.4 MB），而首个探测窗只有 256 KB。没有延迟判定，
// 小窗口里只看得见追问、看不见它点的是谁，于是直接清除——修复在真实尺寸上恒不生效。
// 靠 `chars` 参数把窗口缩小来复现，比造一个 MB 级 fixture 便宜且等价。
test('命令块在首个窗口之外时，续期判定会等窗口翻倍（守跨窗口延迟）', () => {
  const filler = Array.from({ length: 60 }, () =>
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(200) }] } }),
  );
  const p = transcript(call(CMD, '53e93100'), ...filler, human('再看一下 53e93100 的进展'));
  // 窗口小到只装得下末尾那条追问 → 必须翻倍去把命令块捞回来
  assert.strictEqual(activeCommandName(p, 256), CMD);
});

test('跨窗口时若追问不点名，仍应过期（延迟判定不是无条件续期）', () => {
  const filler = Array.from({ length: 60 }, () =>
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(200) }] } }),
  );
  const p = transcript(call(CMD, '53e93100'), ...filler, human('说点别的'));
  assert.strictEqual(activeCommandName(p, 256), null);
});

// ——— 注入文本 ———
test('无命令时注入空串（prompt 逐字节不变）', () => {
  assert.strictEqual(thirdPartyContext(null, 'continuation'), '');
  assert.strictEqual(thirdPartyContext('', 'prose'), '');
});

test('两个 variant 都必须带反向守卫（否则就是一张通行证）', () => {
  for (const v of ['continuation', 'prose']) {
    const t = thirdPartyContext(CMD, v);
    assert.ok(t.includes('但这不是整条豁免'), `${v} 缺反向守卫`);
    assert.ok(t.includes(CMD), `${v} 没带上命令名`);
  }
});

test('continuation variant 要点明"探测查不到是预期"', () => {
  assert.ok(thirdPartyContext(CMD, 'continuation').includes('预期'));
});

test('prose variant 要点明指令草稿的步骤是顺序不是备选', () => {
  const t = thirdPartyContext(CMD, 'prose');
  assert.ok(t.includes('顺序'));
  assert.ok(t.includes('指令草稿'));
});

test('未知 variant 抛错，不静默返回空串', () => {
  assert.throws(() => thirdPartyContext(CMD, 'nope'), /unknown thirdPartyContext variant/);
});

// 这一条是「既有 eval 场景不受影响」那句话的**机器可核形态**，别删。
// 两个 gate 的 eval runner 只喂 `{last_assistant_message}`（见各自 run.mjs 的 runHook），
// 不带 transcript_path → 身份判定必然返回 null → 注入贡献空串 → 判官 prompt 逐字节不变。
// 没有它，"其余场景不受影响"就只是一句推理，而推理在真假两种情况下读起来相同。
test('runner 的输入形状（无 transcript_path）必然拿不到豁免', () => {
  assert.strictEqual(thirdPartyReportCommand({ last_assistant_message: 'x' }), null);
  assert.strictEqual(thirdPartyContext(thirdPartyReportCommand({ last_assistant_message: 'x' }), 'prose'), '');
});

test('SubagentStop 不发豁免（父命令的身份不能发给子代理）', () => {
  const p = transcript(call(CMD, '53e93100'));
  assert.strictEqual(thirdPartyReportCommand({ transcript_path: p }), CMD);
  assert.strictEqual(thirdPartyReportCommand({ transcript_path: p, agent_id: 'a1' }), null);
  assert.strictEqual(thirdPartyReportCommand({ transcript_path: p, agent_transcript_path: '/x' }), null);
});

let pass = 0;
for (const [name, fn] of cases) {
  try { fn(); console.log('✓ ' + name); pass++; }
  catch (e) { console.log('✗ ' + name + '\n    ' + e.message); }
}
console.log(`\n${pass}/${cases.length} 通过`);
if (pass !== cases.length) process.exit(1);
