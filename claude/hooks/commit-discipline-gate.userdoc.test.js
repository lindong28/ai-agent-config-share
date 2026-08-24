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

/**
 * 索引**为空**、但文件都已 tracked 且工作树有改动的 guarded 仓——这才是本闸真实面对的
 * 状态：它是 PreToolUse，而 `git add` 与 `git commit` 写在同一条命令里时，索引尚未被写。
 * 上面 `repo()` 预先 stage 了 `src.js`，那正是这条判据此前恒不被触及的原因。
 *
 * 基线 commit 不是摆设：没有它，`--only docs/a.md` 在真 git 里报
 * `did not match any file(s) known to git`，用例描述的是一个不存在的状态。而 hook 只解析
 * 命令字符串、从不跑 git，**所以它照样绿**——夹具坏掉与判据正确在读数上同形。
 */
function repoTrackedUnstaged(name) {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n\nuser-visible changes only.\n');
  fs.writeFileSync(path.join(root, 'src.js'), '// x\n');
  fs.writeFileSync(path.join(root, 'docs', 'a.md'), 'a\n');
  fs.writeFileSync(path.join(root, 'notes', 'b.txt'), 'b\n');
  fs.writeFileSync(path.join(root, 'NOTES.MD'), 'n\n');      // 扩展名大写的文档
  fs.symlinkSync('docs', path.join(root, 'link'));           // 指向目录的 tracked symlink
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'baseline'], { cwd: root });
  // 只改工作树，不碰索引 → 索引与 HEAD 一致，`git diff --cached` 为空。
  fs.appendFileSync(path.join(root, 'src.js'), '// y\n');
  fs.appendFileSync(path.join(root, 'docs', 'a.md'), 'b\n');
  fs.appendFileSync(path.join(root, 'notes', 'b.txt'), 'c\n');
  fs.appendFileSync(path.join(root, 'NOTES.MD'), 'm\n');
  fs.unlinkSync(path.join(root, 'link'));
  fs.symlinkSync('notes', path.join(root, 'link'));          // 改指向 = symlink 条目本身有改动
  fs.appendFileSync(path.join(root, 'CHANGELOG.md'), '- change\n');
  return root;
}

const guarded = repo('guarded', { withChangelog: true });   // 会开火的仓
const plain = repo('plain', { withChangelog: false });      // 不会开火的仓
const guardedEmpty = repoTrackedUnstaged('guarded-empty');

// 夹具自检：这三条一旦不成立，下面整组用例测的就不是它们声称的那个状态，而且会静默地绿。
// 第三条（工作树确有改动）不是多余的——少了它，把 `appendFileSync` 那几行删掉之后索引
// 仍为空、路径仍 tracked，前两条照样通过，而夹具描述的已经是另一个状态了。
{
  const g = (args) => execFileSync('git', args, { cwd: guardedEmpty, encoding: 'utf8' });
  const set = (s) => new Set(s.split('\n').filter(Boolean));
  assert.strictEqual(g(['diff', '--cached', '--name-only']).trim(), '', '夹具应索引为空');
  assert.deepStrictEqual(set(g(['ls-files'])), new Set(['CHANGELOG.md', 'NOTES.MD', 'docs/a.md', 'link', 'notes/b.txt', 'src.js']),
    '夹具应恰好 tracked 这六个路径');
  assert.deepStrictEqual(set(g(['diff', '--name-only'])), new Set(['CHANGELOG.md', 'NOTES.MD', 'docs/a.md', 'link', 'notes/b.txt', 'src.js']),
    '夹具应六个路径都有未 staged 的工作树改动');
}

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

test('索引为空时按命令点名的路径判——skill 规定的动作形态正是这一种', () => {
  // `create-commit` 第 5 步：「`git add <specific files>` 加 `git commit --only <同一组路径>`」。
  // 两句写在同一条 Bash 命令里时，PreToolUse 读到的索引是空的。只看索引 → 静默放行，
  // 而失守形态是"什么都没发生"：commit 成功、无输出、下游全绿。实测代价见 HARNESS 账本。
  assert.strictEqual(blocks(`git add src.js && git commit --only src.js -m x`, guardedEmpty), true);
  // `--only` 提交的是工作树内容，已跟踪文件根本不需要先 add——索引恒空的第二条路径。
  assert.strictEqual(blocks(`git commit --only src.js -m x`, guardedEmpty), true);
  // 反向三条：点名了 CHANGELOG、纯文档、以及压根没点名路径，都不该拦。
  assert.strictEqual(blocks(`git add CHANGELOG.md src.js && git commit --only CHANGELOG.md src.js -m x`, guardedEmpty), false);
  assert.strictEqual(blocks(`git commit --only docs/a.md -m x`, guardedEmpty), false);
  assert.strictEqual(blocks(`git commit -m x`, guardedEmpty), false);
});

test('命令里的参数值不得被当成路径', () => {
  // `-m` 的值、以及**成簇短参**里的 `-sm wip`：把 `wip` 当路径就会误拦。后者被既有
  // broad 套件的阴性语料抓到过一次（那条用的是 `-am`），写在这里免得下次重犯。
  // 这里刻意用 `-sm` 而不是 `-am`：`-a` 会被同一 hook 的 broad 检查独立拦下，
  // 于是 `-am` 那条用例在本判据坏掉时**照样是 exit 2**，对它零区分力。
  assert.strictEqual(blocks(`git commit --only docs/a.md -m src.js`, guardedEmpty), false);
  assert.strictEqual(blocks(`git commit --only docs/a.md -sm wip`, guardedEmpty), false);
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

// ── 白名单形状的边界 ───────────────────────────────────────────────────────
// `commitScope` 只认 `[git add <paths> &&] git commit … --only <同一组> …` 这一种形状。
// 下面每一条都落在形状之外 → `{known:false}` → 退回按索引判；索引为空 → 不判 → 放行。
// 它们全部来自对"尽量解析"版的两轮对抗评审：每一条在那一版里都是一次**误拦或漏放**，
// 而误拦比漏放更坏——它会训练出绕过行为，等于废掉整道闸。
test('形状之外一律不判：这些都不得因为解析猜错而误拦', () => {
  const outside = {
    '--pathspec-from-file 被通用 --k=v 分支吞掉': 'git commit --pathspec-from-file=paths.txt -m x',
    '目录 pathspec 会递归展开，展开结果静态看不见': 'git commit --only notes -m x',
    '段间 cd 改变路径解析基准': 'git add src.js && cd docs && git commit --only src.js -m x',
    '|| 让前一段可能根本不执行': 'true || git add src.js; git commit --only src.js -m x',
    'git 不在命令位，这只是 echo': 'echo /usr/bin/git commit --only src.js',
    '反斜杠转义分词不支持': 'git commit --only docs/a\\ b.txt -m x',
    '--amend 不按 pathspec 提交索引': 'git add src.js && git commit --amend --only --no-edit',
    '--dry-run 根本不产生 commit': 'git add src.js && git commit --dry-run --only src.js -m x',
    '取值型 flag 的值缺失': 'git commit --only src.js -m',
    'add 与 --only 点名的不是同一组': 'git add src.js && git commit --only docs/a.md -m x',
    '裸 pathspec 不在白名单形状里': 'git commit src.js -m x',
  };
  for (const [why, cmd] of Object.entries(outside)) {
    assert.strictEqual(blocks(cmd, guardedEmpty), false, `不该拦（${why}）：${cmd}`);
  }
});

test('形状之内仍照拦：白名单收窄不得把要防的那一种也放掉', () => {
  assert.strictEqual(blocks('git add src.js && git commit --only src.js -m x', guardedEmpty), true);
  assert.strictEqual(blocks('git commit --only src.js -m x', guardedEmpty), true);
  assert.strictEqual(blocks('git commit -q --only src.js --signoff -m x', guardedEmpty), true);
});

// 第三轮对抗评审的四条：每一条在修之前都有一个具体的漏放或误拦，且**都由本轮白名单新引入**
// ——白名单之前这些命令都落在"索引为空就不判"里，读数一律是放行。
test('集合相等要按集合判，不按长度判', () => {
  // 长度这个读数在两组真相等与真不等时都可能取同一个值，于是两个方向各错一次。
  // 漏放：两边语义都是 {src.js}，长度却是 2 vs 1。
  assert.strictEqual(blocks('git add src.js src.js && git commit --only src.js src.js -m x', guardedEmpty), true);
  // 误拦：长度都是 2，且 add 的每个元素都在 want 里，但两组并不相同。
  assert.strictEqual(blocks('git add src.js src.js && git commit --only src.js docs/a.md -m x', guardedEmpty), false);
});

test('只认裸 git：带路径的可执行文件可能是改写参数的包装器', () => {
  // `/tmp/fake/git` 同样以 `/git` 结尾。它是不是真 git、`--only` 在它那里是不是同一个
  // 语义，静态判不了；猜错的后果是 known 的范围与实际提交的完全不同。
  assert.strictEqual(blocks('/usr/bin/git commit --only src.js -m x', guardedEmpty), false);
});

test('文档判据不得大小写敏感', () => {
  // `NOTES.MD` 是文档。扩展名的大小写不由任何规范约束——`endsWith('.md')` 会把它判成
  // 代码而误拦，而白名单之前这条命令走的是"索引为空"分支，根本不会拦。
  assert.strictEqual(blocks('git add NOTES.MD && git commit --only NOTES.MD -m x', guardedEmpty), false);
});

test('symlink 是一个条目，不是它指向的东西', () => {
  // `link` 指向目录。`statSync` 会跟随它、判成目录 → bail → 漏放；git 眼里它就是一个
  // 非文档条目，该拦。
  assert.strictEqual(blocks('git add link && git commit --only link -m x', guardedEmpty), true);
});
