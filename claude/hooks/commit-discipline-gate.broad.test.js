'use strict';

/**
 * `findBroadAdd` / `findBroadCommit` 的语料回归。
 *
 * 这两个函数此前无任何测试覆盖，而它们各自被独立 review 打出过两个方向的错：
 *  · 漏拦——自己 `split` 分词时，`git add \`+换行+`-A` 的换行被当成段分隔符；
 *    pathspec 只认字面量时，`:(top)` 与 `:/` 是同义词却一拦一放。
 *  · 误拦——commit message 正文里出现 `-A` / `-all` / `-abc` 被当成参数。
 *    这一类最贵：写文档、写 CHANGELOG、写这份闸自己都会撞上，而闸不留日志，
 *    被拦者最省事的反应是把字符串拆开骗过去，于是整道闸静默失效。
 *
 * 所以阴性语料与阳性语料同等承重，别只加"应该拦"的那半边。
 */

const assert = require('assert');
const { findBroadAdd, findBroadCommit, evaluate } = require('./commit-discipline-gate');

const NL = '\\\n'; // shell 行继续符：反斜杠 + 换行

const BLOCK_ADD = [
  'git add -A', 'git add .', 'git add --all', 'git add -vA', 'git add -Ap',
  'git add --no-ignore-removal', 'git add -u', 'git add --update',
  'git add "-A"', 'git add "."', "git add '.'",           // 引号形态与裸形态等效
  'git add -- .', 'git add ./', 'git add :/', 'git add :/.', 'git add *',
  'git add ":(top)"', 'git add ":/*"', 'git add ..', 'git add ../',
  'git add ":(glob)**"', 'git add "**"',                   // pathspec magic 前缀
  'git add --pathspec-from-file=all.txt',                  // 宽度静态判不出 → 按宽处理
  'git -C /x add -A', 'cd x && git add .',
  `git add${NL}-A`, `git add${NL}.`,                       // 行继续符
];

const BLOCK_COMMIT = [
  'git commit -a', 'git commit -am "x"', 'git commit --all', 'git commit -avm "x"',
  'git commit -i .', 'git commit --include .',             // --include 等同 -a 的后果
  'git commit -o . -m x', 'git commit --only . -m x',      // 字面满足 skill，实为整仓
  'git commit --only :/ -m x',
  `git commit${NL}-a -m x`,
];

const PASS_ADD = [
  'git add src/a.py', 'git add .gitignore', 'git add ./src/x.py',
  'git add "path with space.txt"', 'git add a', 'git add A', 'git add a.py',
  'git add docs/a.md docs/b.md', 'git add -p', 'git add -n src/x',
  'git add --dry-run src/x', 'git add -f ig.log', 'git add -i',
  'git add --intent-to-add new.txt', 'git add --renormalize f.txt', 'git add -N f',
  'git add --chmod=+x f',
  'git add -- -A',                                          // 一个真的叫 `-A` 的文件
  'git status --short', 'echo hello',
];

const PASS_COMMIT = [
  'git commit -m "x"', 'git commit --only a.txt -m x', 'git commit --amend --no-edit',
  'git commit --allow-empty -m x', 'git commit --author="A <a@b>" -m x',
  'git commit -qm init', 'git commit -S -m x', 'git commit --fixup=HEAD',
  'git commit -F msg.txt', 'git commit --no-verify -m x',
  // message / prose 里提到规则本身——历史上整类被误拦，包括本文件自己的补丁
  'git commit -m "docs: explain git add -A pitfalls"',
  'git commit -m "docs: mention -all option"',
  'git commit -m "fix: handle -a and -b flags"',
  'git commit -m "feat: -abc parsing"',
  'git commit -m "test: cover add --all path"',
  'git status && echo "use git add -A instead"',
  'git checkout add', 'git branch add',                     // `add` 作分支名
];

for (const c of BLOCK_ADD) assert.ok(findBroadAdd(c), `应拦但放行：${JSON.stringify(c)}`);
for (const c of BLOCK_COMMIT) assert.ok(findBroadCommit(c), `应拦但放行：${JSON.stringify(c)}`);

// 两个函数都要对全部阴性语料放行：findBroadAdd 见到 commit 语料、findBroadCommit 见到
// add 语料，都不该开火——闸是按整条命令跑的，任一函数误报都会拦下整条。
for (const c of [...PASS_ADD, ...PASS_COMMIT]) {
  assert.strictEqual(findBroadAdd(c), null, `误报 (add lens)：${JSON.stringify(c)}`);
  assert.strictEqual(findBroadCommit(c), null, `误报 (commit lens)：${JSON.stringify(c)}`);
}

// 逃生口：两种声明形态都要生效，否则 block 文案教的写法是假的。
const ev = (c) => evaluate(JSON.stringify({ tool_name: 'Bash', tool_input: { command: c } })).exitCode;
delete process.env.COMMIT_SKIP_SKILL_CHECK;
assert.strictEqual(ev('git add -A'), 2, '无声明时应拦');
assert.strictEqual(ev('git commit -am wip'), 2, '无声明时应拦');
assert.strictEqual(ev('COMMIT_SKIP_SKILL_CHECK=1 git add -A'), 0, '命令行前缀形态应放行');
assert.strictEqual(ev('export COMMIT_SKIP_SKILL_CHECK=1; git add -A'), 0, 'export 形态应放行');
assert.strictEqual(ev('COMMIT_SKIP_SKILL_CHECK=1 git commit -am wip'), 0, '命令行前缀形态应放行');

console.log(
  `commit-discipline-gate.broad: ${BLOCK_ADD.length + BLOCK_COMMIT.length} 阳性全拦, ` +
  `${(PASS_ADD.length + PASS_COMMIT.length) * 2} 次阴性判定全放行, 逃生口 5 项 — PASS`);
