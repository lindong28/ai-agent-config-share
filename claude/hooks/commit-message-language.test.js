'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const hook = require('./commit-message-language.js');

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** 建一个真仓：仓库惯例这条例外要读 git log，mock 掉它等于不测它。 */
function makeRepo(subjects) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cml-')));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@t']);
  git(repo, ['config', 'user.name', 't']);
  subjects.forEach((s, i) => {
    fs.writeFileSync(path.join(repo, `f${i}.txt`), `${i}\n`);
    git(repo, ['add', '-A']);
    execFileSync('git', ['commit', '-qm', s], { cwd: repo, stdio: 'ignore' });
  });
  return repo;
}

function payload(command, cwd) {
  return JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } });
}

const HEREDOC = (body) => `git commit -m "$(cat <<'EOF'\n${body}\nEOF\n)"`;

// ── 提取：heredoc 是 create-commit 规定的形式，抓不到它这个 hook 就是摆设 ──

test('heredoc 里的 message 能被完整取出', () => {
  const body = 'feat(x): do a thing\n\nA body line.';
  assert.deepStrictEqual(hook.extractMessages(HEREDOC(body)), [body]);
});

test('写中文文档 + 提交的组合命令里，只取 -m 的那个 heredoc', () => {
  // 真实误报：`cat >> 中文文档 <<EOF … EOF && git commit -m "English"`。全命令扫 heredoc
  // 会把文档正文当成 commit message，于是往中文文档追加内容这件事本身被拦下。
  const cmd = [
    "cat >> docs/issues/harness-issues.md <<'EOF'",
    '- Impact: medium——当前无害因为它没跑，风险是有人日后启用它',
    'EOF',
    `git commit -q -m "docs(issues): file HARNESS-133"`,
  ].join('\n');
  assert.deepStrictEqual(hook.extractMessages(cmd), ['docs(issues): file HARNESS-133']);
});

test('同一条命令里写中文文档并提交英文 message —— 放行', () => {
  const repo = makeRepo(['add a thing', 'fix another']);
  const cmd = [
    "cat >> notes.md <<'EOF'",
    '这一段是中文文档正文，它本来就该是中文。',
    'EOF',
    `git commit -q -m "docs: add a note"`,
  ].join('\n');
  assert.strictEqual(hook.evaluate(payload(cmd, repo)).exitCode, 0);
});

test('常规 -m 也能取出', () => {
  assert.deepStrictEqual(hook.extractMessages('git commit -m "fix(x): y"'), ['fix(x): y']);
  assert.deepStrictEqual(hook.extractMessages("git commit --message='fix(x): y'"), ['fix(x): y']);
});

test('命令替换不被当成字面 message', () => {
  // 这正是旧正则的失效点：它会把 `$(cat <<` 当作 message 拿去检查。
  assert.deepStrictEqual(hook.extractMessages('git commit -m "$(build_msg)"'), []);
});

test('非 commit 命令一律不管', () => {
  for (const c of ['git log -m "中文"', 'echo "中文"', 'git rebase -i HEAD~2']) {
    assert.strictEqual(hook.isCommitCommand(c), false, c);
  }
  assert.strictEqual(hook.isCommitCommand('git commit --amend -m "x"'), true);
  assert.strictEqual(hook.isCommitCommand('cd /x && git -C /y commit -m "z"'), true);
});

// ── 判定：英文仓 ──

test('英文仓 + 中文 body（heredoc）—— 拦', () => {
  const repo = makeRepo(['add a thing', 'fix another', 'refactor it']);
  const out = hook.evaluate(payload(HEREDOC('Subject in English\n\n一次跨仓故障排查里同一失败形态出现 5 次'), repo));
  assert.strictEqual(out.exitCode, 2);
  assert.match(out.stderr, /含中文/);
});

// 下面两条用的是真实样本：本轮真的犯过的那条中文 message，和它修正后保留了一个中文
// 段名的英文版。单测全绿而端到端误报，就是从这一对上发现的。

test('英文行里嵌一个保留的专有名词 —— 放行（规则第三条例外）', () => {
  const repo = makeRepo(['add a thing', 'fix another']);
  const body = [
    'Send the evidence procedure to the phase that keeps losing it',
    '',
    'One cross-repo investigation hit the same failure shape five times.',
    '',
    '- docs(claude-md): point 取证的充分性 at that file, and spend the inline',
    '  fallback slot on credential echo',
  ].join('\n');
  const out = hook.evaluate(payload(HEREDOC(body), repo));
  assert.strictEqual(out.exitCode, 0, '拦掉合规的专有名词保留会训练出「拦了就绕过」');
});

test('整段中文 body —— 拦（即使 subject 是英文）', () => {
  const repo = makeRepo(['add a thing', 'fix another']);
  const body = [
    'Send the evidence procedure to the phase that keeps losing it',
    '',
    '一次跨仓故障排查里同一失败形态出现 5 次：拿 lsof 断言端口无监听、拿 bash -i',
    '验证一份 bash -i 不加载的 rc、把退化注入到已被 mock 掉的函数上。',
  ].join('\n');
  const out = hook.evaluate(payload(HEREDOC(body), repo));
  assert.strictEqual(out.exitCode, 2);
});

test('长英文 body 里混入一整段中文 —— 拦（不被长度稀释）', () => {
  const repo = makeRepo(['add a thing', 'fix another']);
  const body = [
    'fix(x): a subject',
    '',
    ...Array(30).fill('A perfectly ordinary English line of explanation here.'),
    '这一行是中文写的，它不该因为上面有三十行英文就被摊薄到阈值以下。',
  ].join('\n');
  assert.strictEqual(hook.evaluate(payload(HEREDOC(body), repo)).exitCode, 2);
});

test('英文行里零星的全角标点 —— 放行（本 hook 管语言，不管标点风格）', () => {
  // 引用一个中文文件名或段名时带出全角标点是常事。按"这一行是不是中文写的"判，它不是。
  const repo = makeRepo(['add a thing', 'fix another']);
  const out = hook.evaluate(payload(HEREDOC('fix(x): stop the leak\n\nSee the note「here」for why.'), repo));
  assert.strictEqual(out.exitCode, 0);
});

test('纯 CJK 标点写成的一行 —— 拦', () => {
  const repo = makeRepo(['add a thing', 'fix another']);
  const out = hook.evaluate(payload(HEREDOC('fix(x): a subject\n\n「」、。《》！？'), repo));
  assert.strictEqual(out.exitCode, 2);
});

test('em dash 不算 —— 英文里它是合法标点', () => {
  // U+2014 通用标点，不在 CJK 区间。拦它就是误报，而误报会训练出"拦了就绕过"。
  const repo = makeRepo(['add a thing', 'fix another']);
  const out = hook.evaluate(payload(HEREDOC('fix(x): stop the leak\n\nSee the note — it matters.'), repo));
  assert.strictEqual(out.exitCode, 0);
});

test('英文仓 + 纯英文 —— 放行', () => {
  const repo = makeRepo(['add a thing', 'fix another']);
  const out = hook.evaluate(payload(HEREDOC('fix(x): stop the leak\n\nA plain English body.'), repo));
  assert.strictEqual(out.exitCode, 0);
});

// ── 判定：例外二（仓库近期以中文为主）──

test('中文仓 + 中文 message —— 放行（例外二成立）', () => {
  const repo = makeRepo(['修复代理线路', '重构发布逻辑', '补充测试']);
  const out = hook.evaluate(payload(HEREDOC('修复代理线路\n\n因为端口固定'), repo));
  assert.strictEqual(out.exitCode, 0, '仓库惯例是中文时不该拦');
});

test('中英各半不算「多为中文」—— 拦', () => {
  const repo = makeRepo(['修复一处', 'fix another', '再修一处', 'refactor it']);
  const out = hook.evaluate(payload(HEREDOC('Subject\n\n中文正文'), repo));
  assert.strictEqual(out.exitCode, 2, '过半才算，恰好各半不放宽');
});

test('空仓 / 非仓问不出惯例时不放宽', () => {
  const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cml-')));
  assert.strictEqual(hook.repoPrefersChinese(empty), false);
});

// ── 不阻断的路径 ──

test('畸形 stdin 与非 Bash 工具不阻断', () => {
  assert.strictEqual(hook.evaluate('not json').exitCode, 0);
  assert.strictEqual(hook.evaluate(JSON.stringify({ tool_name: 'Edit' })).exitCode, 0);
});

test('-F / 编辑器路径看不到文本时放行，而不是瞎猜', () => {
  const repo = makeRepo(['add a thing']);
  assert.strictEqual(hook.evaluate(payload('git commit -F /tmp/msg.txt', repo)).exitCode, 0);
  assert.strictEqual(hook.evaluate(payload('git commit --amend --no-edit', repo)).exitCode, 0);
});
