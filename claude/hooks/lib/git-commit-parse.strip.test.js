#!/usr/bin/env node
'use strict';
// `stripNonCommandText` —— 把命令里不会被 shell 执行的部分剥掉，再交给分词。
//
// 两侧都必须覆盖：**文本里的字样不得误判成命令**、**真的会提交的命令一条都不能漏**。
// 只测前者的话，把函数改成"永远返回空串"也全绿——那时这道闸再也不拦任何东西，
// 而漏拦没有下游会发现（误报会被人当场骂，漏拦不会）。
//
// 用例来自实测：修 commit-discipline-gate 时，补丁脚本被它自己拦了三次。

const assert = require('assert');
const { test } = require('node:test');
const { isCommitCommand, stripNonCommandText, stripWithQuoted, dequote, commitCwds, envDeclared } = require('./git-commit-parse');

// 拆开拼，免得这个测试文件本身成为下一次误报的素材。
const G = 'git' + ' ' + 'commit';

test('heredoc 正文里的字样不算命令', () => {
  for (const cmd of [
    `cat > /tmp/p.py <<'EOF'\nprint("先 ${G} 再说")\nEOF\npython3 /tmp/p.py`,
    `cat > d.md <<EOF\n讲 ${G} 的一段\nEOF`,
    `cat > d.md <<-"EOF"\n\t缩进结束符也要认: ${G}\n\tEOF`,
  ]) {
    assert.strictEqual(isCommitCommand(cmd), false, cmd.split('\n')[0]);
  }
});

test('引号内的字样不算命令', () => {
  for (const cmd of [
    `echo "用 ${G} --only 提交"`,
    `echo '单引号里的 ${G}'`,
    `python3 -c 'print("${G}")'`,
    `grep -n "${G}" README.md`,
  ]) {
    assert.strictEqual(isCommitCommand(cmd), false, cmd);
  }
});

test('双引号里的命令替换必须保留（不能剥过头）', () => {
  // `"$(...)"` 里是会执行的命令。把它一并剥掉就是漏拦——而漏拦没有下游会发现。
  assert.strictEqual(isCommitCommand(`echo "$(${G} -m x)"`), true);
});

test('真的会提交的命令一条都不漏', () => {
  for (const cmd of [
    `${G} -m "x"`,
    `git -C /repo commit --amend`,
    `npm test && ${G} -m "x"`,
    `cat >> d.md <<'EOF'\n讲 ${G} 的段落\nEOF\n${G} -m 'x'`,   // 先写文档再真提交
    `/usr/bin/git commit -m "x"`,
    `${G} -m "$(cat <<'EOF'\nsubject\nEOF\n)"`,
    // 换行也是命令分隔符。漏掉它时首个 git 是 `add`，整条被判成"不是提交"——而这是
    // agent 写多步提交最自然的形态，实测两次静默漏拦。同行的 `&&` / `;` 一直是对的，
    // 所以只测同行的写法等于测不到这个洞。
    `git add a.md\n${G} -m "x"`,
    `git status\n${G} --only a.md -m "x"`,
    `git add a.md\n${G} --only a.md -m "$(cat <<'EOF'\nsubject\n\nbody\nEOF\n)"`,
    // 行继续符：换行成为分隔符后，不先接回来就会把一条命令切成两段而两段都不是提交。
    `git \\\n  commit -m "x"`,
    `git add a.md \\\n  b.md\n${G} -m "x"`,
  ]) {
    assert.strictEqual(isCommitCommand(cmd), true, cmd.split('\n')[0]);
  }
});

test('注释里的提交命令不算命令', () => {
  // 换行成为 segment 分隔符之前，注释与前面的命令同段、被 findIndex 越过；之后它
  // 自成一段。所以这两条**只在加了换行分隔之后**才会误报——把换行加进去而不剥注释，
  // 等于用一个漏拦换一个误报。前一版的负向用例（`git add` 换行 `git status`）新旧
  // 两版都返回 false，对这个洞零区分度。
  assert.strictEqual(isCommitCommand(`git add a.md\n# 之后再 ${G} -m "x"\ngit status`), false);
  assert.strictEqual(isCommitCommand(`git status\n# TODO: ${G} --amend`), false);
  // `#` 只在词首起注释作用，别把 URL fragment 和 `--sep=#` 一起剥了。
  assert.strictEqual(isCommitCommand(`curl http://x/y#frag\n${G} -m "x"`), true);
  assert.strictEqual(isCommitCommand('git add a.md\ngit status'), false);
});

test('引号内的路径不得连 token 位置一起消失', () => {
  // 挖成空格时 `git -C "/a/b" commit` 剥成 `git -C   commit`，`-C` 把 `commit` 当成
  // 自己的值吃掉 → 判 false → **整道闸对这条命令静默失效**。引号包路径是日常写法
  // （路径带空格、或只是顺手加的引号），所以这是个宽的漏拦面，不是边角情形。
  assert.strictEqual(isCommitCommand(`git -C "/a/b" commit -m "x"`), true);
  assert.strictEqual(isCommitCommand(`git -C '/a b/repo' commit --amend`), true);
  // 反向：占位符本身不得被认成命令 token。
  assert.strictEqual(isCommitCommand(`echo "用 ${G} --only 提交"`), false);
});

test('stripWithQuoted 把引号内容按序号交还', () => {
  // 序号即 hold 的调用次序（单引号先于双引号扫），断言不依赖它——依赖的是
  // "第 N 个 token 能换回它原来的文本"这件事。
  const { text, quoted } = stripWithQuoted(`cd "/a b" && ${G} -m 'msg'`);
  assert.ok(!/a b/.test(text), '内容不得留在命令文本里');
  const toks = text.trim().split(/\s+/);
  assert.strictEqual(dequote(toks[1], quoted), '/a b', 'cd 的目标路径要能取回');
  assert.strictEqual(dequote(toks[toks.length - 1], quoted), 'msg');
  assert.strictEqual(dequote('git', quoted), 'git', '非占位符原样返回');
});

test('原文自带占位符字符时不解析目录', () => {
  // 用户命令里真出现 U+0001 时，内部编码与用户文本不可分——硬解会把一段无关文本
  // 当成路径去查另一个仓。此时 commitCwds 必须返回 null（调用方据此不判）。
  const M = '\u0001';
  assert.strictEqual(commitCwds(`cd ${M}0${M} && ${G} -m "/tmp/elsewhere"`, '/cwd'), null);
  // 反向：不含该字符的同形命令照常解析，否则上一条对守卫零区分力。
  assert.deepStrictEqual(commitCwds(`cd /tmp/x && ${G} -m "y"`, '/cwd'), ['/tmp/x']);
});

// —— commitCwds / envDeclared 的控制流与作用域 ——
// 这里用纯函数读数，比经 hook 走一遍便宜，且两侧都断言：**该判的要给出目录**、
// **不该判的要给 null**。只测一侧的话，"恒 null"（永不判）或"恒回落 cwd"都能全绿，
// 而那正是本模块两次返工各自的退化形态。
test('commitCwds：控制流决定判不判', () => {
  for (const [cmd, want] of [
    // 目录确定 → 必须给出目录
    ['cd /g && git ' + 'commit -m "$(build_msg)"', ['/g']],       // `$()` 只生成 message
    ['git ' + 'commit -m "$(cd scripts && ./build)"', ['/cwd']],  // `$()` 里 cd 但不提交
    ['npm test && cd /g && git ' + 'commit -m x', ['/g']],        // 全 `&&`：cd 没跑则 commit 也不跑
    ['cd /g && git ' + 'commit -m x || echo failed', ['/g']],     // `||` 在 commit 之后
    // 目录不确定 → 必须 null（不判），否则就是凭空误拦或错仓
    ['test -f m && cd /g; git ' + 'commit -m x', null],           // cd 条件执行，commit 无条件
    ['(cd /g && git status); git ' + 'commit -m x', null],        // 子 shell 的 cd 不外泄
    ['cd /g || git ' + 'commit -m x', null],                      // cd 成功则 commit 不执行
    ['out="$(cd /g && git ' + 'commit -m x)"', null],             // 提交跑在子 shell 的另一个目录
    ['cd "$TARGET" && git ' + 'commit -m x', null],               // 变量路径
  ]) {
    assert.deepStrictEqual(commitCwds(cmd, '/cwd'), want, cmd);
  }
});

test('envDeclared：只认真正会传给 commit 的声明', () => {
  const N = 'COMMIT_NO_USER_DOC';
  for (const [cmd, want] of [
    [`${N}=1 git ` + 'commit -m x', true],
    [`FOO=x ${N}=1 git ` + 'commit -m x', true],
    [`env ${N}=1 git ` + 'commit -m x', true],
    [`env -i ${N}=1 git ` + 'commit -m x', true],
    [`/usr/bin/env ${N}=1 git ` + 'commit -m x', true],
    [`export ${N}=1; git ` + 'commit -m x', true],
    // 下面这些都不该算：作用于别的命令、根本不是赋值、条件段、被覆盖或撤销
    [`${N}=1 git status && git ` + 'commit -m x', false],
    [`echo ${N}=1 && git ` + 'commit -m x', false],
    ['git ' + `commit -m "docs: ${N}=1 的用法"`, false],
    // 条件段里的声明**按跑了处理**：本层判不了 `&&` 前一条成没成功，而误拦一条现实
    // 写法的代价高于少拦一次（取舍见 envDeclaredPerCommit 的注释）。
    [`false && export ${N}=1; git ` + 'commit -m x', true],
    [`cd /r && export ${N}=1; git ` + 'commit -m x', true],
    [`export ${N}=1\nexport ${N}=0\ngit ` + 'commit -m x', false],
    [`export ${N}=1\nunset ${N}\ngit ` + 'commit -m x', false],
    [`export ${N}=1\nenv -u ${N} git ` + 'commit -m x', false],
    [`${N}=1 ${N}=0 git ` + 'commit -m x', false],
  ]) {
    assert.strictEqual(envDeclared(cmd, N), want, cmd);
  }
});

test('剥不干净时宁可留着（保守方向）', () => {
  // 未闭合的 heredoc：剥不掉就原样留下，于是仍判 true。误报会被发现并绕过，
  // 漏拦不会——所以这个方向是有意选的，不是没考虑到。
  assert.strictEqual(isCommitCommand(`cat <<'EOF'\n${G}`), true);
});

test('stripNonCommandText 只做减法，不动命令部分', () => {
  const s = stripNonCommandText(`echo "文本" && ${G} -m 'x'`);
  assert.ok(/git/.test(s) && /commit/.test(s), '命令 token 必须留下');
  assert.ok(!/文本/.test(s), '引号内文本应被剥掉');
});
