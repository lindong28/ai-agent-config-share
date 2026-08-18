#!/usr/bin/env node
'use strict';
// commit-discipline-gate §4（[User] 档同步）的**逃生口可达性**与**仓库归属**。
//
// 两条都来自实测（harness-issues HARNESS-192）：
//   - 逃生口只认 process.env，而提示教的是命令行前缀 `COMMIT_NO_USER_DOC=1 <cmd>`。
//     hook 是独立进程，前缀设的是被执行命令的环境——于是这个出口 agent 侧恒不可达，
//     提示教了一条必然无效的写法（当场连试四种形态全部失败）。
//   - 仓库取 session cwd 而非命令实际操作的仓，于是 `git -C <B仓> commit` 被拿 A 仓的
//     CHANGELOG 约定卡下，报出的"暂存文件"还是 A 仓里别的 session 暂存的东西。
//
// 每组都成对断言（该拦的拦、该放的放）：只测一侧的话，「恒放行」或「commitCwd 恒返回
// null」都能全绿，而那正是本次要修的两个 bug 的退化形态。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { test } = require('node:test');
const { evaluate } = require('./commit-discipline-gate');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdg-userdoc-'));
// 进程入口就把逃生口环境变量清掉：调用者的 shell 里若设着它，第一条"基线应拦"就会
// 放行——测试结果成了跑测试的人的环境的函数，而那正是本文件要验的东西之一。
const ENV_ENTRY = process.env.COMMIT_NO_USER_DOC;
delete process.env.COMMIT_NO_USER_DOC;
process.on('exit', () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (ENV_ENTRY !== undefined) process.env.COMMIT_NO_USER_DOC = ENV_ENTRY;
});

/** 建一个仓；withChangelog 决定它有没有那份"自称只记 user-visible"的 CHANGELOG。 */
function repo(name, { withChangelog }) {
  const root = path.join(tmp, name);
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  if (withChangelog) {
    fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n\nuser-visible changes only.\n');
  }
  // 暂存一个**非文档**文件：onlyDocs 豁免不得吃掉本条判据。
  fs.writeFileSync(path.join(root, 'src.js'), '// x\n');
  execFileSync('git', ['add', 'src.js'], { cwd: root });
  return root;
}

const guarded = repo('guarded', { withChangelog: true });   // 会开火的仓
const plain = repo('plain', { withChangelog: false });      // 不会开火的仓

/** 返回 hook 是否拦下。transcript_path 缺席 → §2 不参与，本文件只测 §4。 */
function blocks(command, cwd) {
  const r = evaluate(JSON.stringify({
    tool_name: 'Bash', cwd, tool_input: { command },
  }));
  return r.exitCode === 2;
}

const COMMIT = 'git commit -m "chore: x"';

test('基线：在有 user-visible CHANGELOG 的仓里提交非文档改动 → 拦', () => {
  assert.strictEqual(blocks(COMMIT, guarded), true);
});

test('基线反向：没有那种 CHANGELOG 的仓 → 放行', () => {
  assert.strictEqual(blocks(COMMIT, plain), false);
});

test('逃生口：命令行前缀形态（提示里教的那种）必须生效', () => {
  assert.strictEqual(blocks(`COMMIT_NO_USER_DOC=1 ${COMMIT}`, guarded), false);
  assert.strictEqual(blocks(`cd ${guarded} && COMMIT_NO_USER_DOC=1 ${COMMIT}`, guarded), false);
});

test('逃生口：process.env 形态（用户在 settings.json 里设）仍然生效', () => {
  const saved = Object.prototype.hasOwnProperty.call(process.env, 'COMMIT_NO_USER_DOC')
    ? process.env.COMMIT_NO_USER_DOC : undefined;
  process.env.COMMIT_NO_USER_DOC = '1';
  try {
    assert.strictEqual(blocks(COMMIT, guarded), false);
  } finally {
    if (saved === undefined) delete process.env.COMMIT_NO_USER_DOC;
    else process.env.COMMIT_NO_USER_DOC = saved;
  }
});

test('逃生口不得被无关文本打开：值不是 1、或只是 message 里提了一嘴', () => {
  assert.strictEqual(blocks(`COMMIT_NO_USER_DOC=0 ${COMMIT}`, guarded), true);
  // 声明必须是**命令**里的前缀。message / echo 文本里的同名字样不是声明——拿原串
  // 匹配的话，一句解释这个逃生口的 commit message 就顺手把它打开了，且不留痕。
  assert.strictEqual(blocks('git commit -m "docs: 说明 COMMIT_NO_USER_DOC=1 的用法"', guarded), true);
  assert.strictEqual(blocks(`echo COMMIT_NO_USER_DOC=1 && ${COMMIT}`, guarded), true);
});

test('逃生口要绑在提交那一段上', () => {
  // `VAR=1 cmd` 只作用于 cmd。挂在 `git status` 上的声明不该放行后面的 commit。
  assert.strictEqual(blocks(`COMMIT_NO_USER_DOC=1 git status && ${COMMIT}`, guarded), true);
  // 而独立声明 / export 会留到后面的命令，算数。
  assert.strictEqual(blocks(`export COMMIT_NO_USER_DOC=1; ${COMMIT}`, guarded), false);
});

test('逃生口要认全真实生效的前缀形态', () => {
  // 这两种都真把变量传给 commit。只认"首 token 恰好是它"会误拦——而误拦会训练出
  // "拦了就想办法绕过"，等于废掉整道闸。
  assert.strictEqual(blocks(`FOO=x COMMIT_NO_USER_DOC=1 ${COMMIT}`, guarded), false);
  assert.strictEqual(blocks(`env COMMIT_NO_USER_DOC=1 ${COMMIT}`, guarded), false);
});

test('不判：命令替换子 shell 里换了目录', () => {
  // `out="$(cd B && git commit …)"` 的 commit 跑在 B。分词照常认得出这次提交（有意
  // 如此），但目录是 B 不是 cwd——不看一眼被摘掉的 `$(...)`，就会拿 cwd 去判它。
  // cwd 取 guarded、子 shell 进 plain：漏掉这一眼就会拿 guarded 的约定去卡一次实际
  // 发生在 plain 的提交（误拦）。反过来写（cwd=plain）两种实现都放行，对它零区分力。
  assert.strictEqual(blocks(`out="$(cd ${plain} && git commit -m x)"`, guarded), false);
  // 反向：`$(...)` 里没有 cd 时不受影响（否则这条守卫会吃掉最常见的 message 写法）。
  assert.strictEqual(blocks(`cd ${guarded} && git commit -m "$(build_msg)"`, plain), true);
});

test('仓库归属：git -C / cd 指向别的仓时，按那个仓判', () => {
  // 命令去 plain 仓提交，session 却在 guarded 仓 → 不该拿 guarded 的约定卡它。
  assert.strictEqual(blocks(`git -C ${plain} commit -m "chore: x"`, guarded), false);
  assert.strictEqual(blocks(`cd ${plain} && ${COMMIT}`, guarded), false);
});

test('仓库归属反向：cwd 无 CHANGELOG、命令去 guarded 仓 → 仍要拦', () => {
  // 缺这条的话，「commitCwds 恒返回 null」（永远不判）也能让上一条全绿。
  assert.strictEqual(blocks(`git -C ${guarded} commit -m "chore: x"`, plain), true);
  assert.strictEqual(blocks(`cd ${guarded} && ${COMMIT}`, plain), true);
});

test('仓库归属：带引号的确定路径同样要判到', () => {
  // 引号内文本被 strip 挖走，若挖成空格则路径连同 token 位置一起消失 → 静默不判。
  assert.strictEqual(blocks(`cd "${guarded}" && ${COMMIT}`, plain), true);
  assert.strictEqual(blocks(`git -C '${guarded}' commit -m "chore: x"`, plain), true);
  // 相对路径同样是确定路径。
  assert.strictEqual(blocks(`cd "${path.basename(guarded)}" && ${COMMIT}`, tmp), true);
});

test('逃生口逐个 commit 绑定，不是整条命令一个开关', () => {
  // 前缀只作用于 A 那次提交；B 没声明，仍要按 B 的仓受检。整条一个布尔会让 A 的
  // 声明顺手放行 B——而 B 恰好是那个有 CHANGELOG 约定的仓。
  assert.strictEqual(
    blocks(`COMMIT_NO_USER_DOC=1 git -C ${plain} commit -m a && git -C ${guarded} commit -m b`, plain),
    true);
  // 反向：两次提交都带声明就该全放行，否则上一条也可能只是"恒拦"。
  assert.strictEqual(
    blocks(`COMMIT_NO_USER_DOC=1 git -C ${plain} commit -m a && COMMIT_NO_USER_DOC=1 git -C ${guarded} commit -m b`, plain),
    false);
});

test('逃生口：前置的 export 对后面的提交算数，不论怎么串起来', () => {
  // 这几种写法在 shell 里都会（在前一条成功时）把变量带给 commit。本层判不了前一条
  // 成没成功，取「按跑了处理」——理由见 envDeclaredPerCommit 的取舍说明。
  assert.strictEqual(blocks(`cd ${guarded} && export COMMIT_NO_USER_DOC=1 && ${COMMIT}`, plain), false);
  assert.strictEqual(blocks(`cd ${guarded} && export COMMIT_NO_USER_DOC=1;\n${COMMIT}`, plain), false);
  assert.strictEqual(blocks(`export COMMIT_NO_USER_DOC=1; cd ${guarded} && ${COMMIT}`, plain), false);
  // 反向：`unset` 之后就不算数——否则上面三条也可能只是"恒放行"。
  assert.strictEqual(
    blocks(`export COMMIT_NO_USER_DOC=1; unset COMMIT_NO_USER_DOC; cd ${guarded} && ${COMMIT}`, plain),
    true);
});

test('一条命令里多个 commit → 每个仓各判一次', () => {
  // 只判第一个命中的话，后面那个仓完全漏检。
  assert.strictEqual(blocks(`git -C ${plain} commit -m "a" && git -C ${guarded} commit -m "b"`, plain), true);
  assert.strictEqual(blocks(`git -C ${guarded} commit -m "a" && git -C ${plain} commit -m "b"`, plain), true);
});

test('要判：常见形态不得被"不确定"守卫整片放行', () => {
  // 这三条的提交目录完全确定，守卫守宽了就是把它们静默放行。第一条尤其要命——
  // `-m "$(…)"` 正是 create-commit 规定的 message 写法，即最常见的那条提交命令。
  assert.strictEqual(blocks(`cd ${guarded} && git commit -m "$(build_msg)"`, plain), true);
  assert.strictEqual(blocks(`cd ${guarded} && ${COMMIT} || echo failed`, plain), true);
  assert.strictEqual(blocks(`cd ${guarded} && (npm test) && ${COMMIT}`, plain), true);
  // 引号与非引号拼接出的确定路径同样要判到。
  assert.strictEqual(blocks(`cd "${path.dirname(guarded)}"/${path.basename(guarded)} && ${COMMIT}`, plain), true);
});

test('不判：目录解析不确定（变量 / 子 shell / ||）', () => {
  // 共同点是 cd 的作用域或是否执行无法静态还原。三条都取"漏掉守卫会**误拦**"的形态
  // ——反过来写（漏掉守卫也放行）对守卫零区分力，那正是这道闸自己要防的读数。
  assert.strictEqual(blocks(`cd "$TARGET" && ${COMMIT}`, guarded), false);
  // 子 shell 里的 cd 不外泄：commit 实际在 plain 仓跑。当成外泄就会拿 guarded 卡它。
  assert.strictEqual(blocks(`(cd ${guarded} && git status); ${COMMIT}`, plain), false);
  // `||`：cd 成功则 commit 根本不执行。把 cd 的目标当成提交仓同样是凭空误拦。
  assert.strictEqual(blocks(`cd ${guarded} || ${COMMIT}`, plain), false);
});
