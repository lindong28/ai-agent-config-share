"use strict";

const path = require('path');

/**
 * `git commit` 命令行的解析——**唯一实现**，供全部 commit 相关闸门消费。
 *
 * 抽出来的理由是实测教训（harness-issues H-006）：同一份判断逻辑一旦有两处实现，
 * "修好了"这个状态就是每处独立的。那次两个 hook 各写了一遍进程树遍历，两份的根判定
 * 不同、各修对了对方的 bug，最终在同一次停止里互相矛盾。这里的正则同样踩过真实的坑
 * （见下面各自的注释），再复制一份只是把它们复制走。
 */

function extractMessages(command) {
  const messages = [];
  let m;

  // 1) `-m "$(cat <<'EOF' … EOF)"` —— create-commit 规定的形式。
  //
  // 必须锚在 `-m` 的参数位置上，不能全命令扫 heredoc：`cat >> doc.md <<'EOF' … EOF &&
  // git commit -m "…"` 是极常见的组合（写文档顺手提交），全扫会把**文档正文**当成
  // commit message 判，于是往中文文档里追加内容这件事本身会被拦下。
  const msgHeredoc =
    /(?:^|\s)(?:-m|--message)(?:=|\s+)["']?\$\(\s*cat\s+<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\r?\n([\s\S]*?)\r?\n\s*\1\b/g;
  while ((m = msgHeredoc.exec(command)) !== null) messages.push(m[2]);

  // 2) 常规 -m/--message 字面量。上面已吃掉的区间不再重复扫。
  const rest = command.replace(msgHeredoc, ' ');
  const flag = /(?:^|\s)(?:-m|--message)(?:=|\s+)("([^"]*)"|'([^']*)')/g;
  while ((m = flag.exec(rest)) !== null) {
    const body = m[2] !== undefined ? m[2] : m[3];
    // `-m "$(...)"` 是命令替换而非字面 message，抓到的是 shell 语法不是文本。
    if (body && !/^\s*\$\(/.test(body)) messages.push(body);
  }

  return messages;
}

// git 的全局选项里，这几个的值是**独立的下一个 token**（`git -C /repo commit`）。用正则
// 一把梭会漏掉它们——而 `git -C <path> commit` 是日常写法，漏掉就是漏拦。
const GLOBAL_OPTS_WITH_VALUE = /^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix)$/;

// 引号内文本的占位符：`\u0001<序号>\u0001`，内容旁路存进 quoted 数组。
//
// 为什么不是直接挖成空格（原实现）：挖掉的是**内容**，连 token 的位置也一起没了，
// 于是 `git -C "/a/b" commit` 剥成 `git -C   commit`——`-C` 把 `commit` 当成自己的值
// 吃掉，isCommitCommand 判 false，**整道闸对这条命令静默失效**。占位符保留"这里有一个
// 参数"，同时让需要真值的调用方（commitCwd 取路径）按序号取回，而不必把引号内容留在
// 命令文本里（留着就等于放弃 strip 要防的那件事）。
const QUOTE_MARK = '\u0001';

/**
 * token 里的占位符逐个换回原文；换不回（序号无对应项、或换完仍残留占位符字符）→ null。
 *
 * 必须支持**一个 token 里多段**：`cd "/a b"/sub` 是一个 token `<0>/sub`，shell 对它的
 * 解释完全确定；只认"整个 token 恰是一个占位符"会把这类确定路径判成不可解析，而不可
 * 解析在调用方那里等于**不判**——一个静默的漏拦面。
 */
function dequote(token, quoted) {
  if (!token || !quoted) return null;
  if (!token.includes(QUOTE_MARK)) return token;
  let ok = true;
  const out = token.replace(new RegExp(`${QUOTE_MARK}(\\d+)${QUOTE_MARK}`, 'g'), (_, i) => {
    const v = quoted[Number(i)];
    if (v === undefined) { ok = false; return ''; }
    return v;
  });
  return ok && !out.includes(QUOTE_MARK) ? out : null;
}

/**
 * 剥离结果 + 被挖走的引号内文本（按占位符序号索引）。
 *
 * 原文里本就含占位符字符时 `quoted` 为 null：那时用户文本与内部编码无法区分，硬解会
 * 把一段无关文本当成路径去查另一个仓。调用方据此**不判**。
 */
function stripWithQuoted(command) {
  if (String(command).includes(QUOTE_MARK)) {
    return { text: stripNonCommandText(command), quoted: null };
  }
  const quoted = [];
  return { text: stripNonCommandText(command, quoted), quoted };
}

/**
 * 去掉命令里**不会被 shell 当成命令**的部分：heredoc 正文与引号内文本。
 *
 * 为什么需要：`isCommitCommand` 按空白分词找 `git` `commit` 两个相邻 token，而
 * heredoc 正文与字符串字面量里同样会出现这两个词——写文档、写脚本、写这个模块自己的
 * 注释都会。实测误报两例：`cat > p.py <<'EOF' … 先 git commit 再说 … EOF` 与
 * `echo "用 git commit --only 提交"`。**修这个 hook 时，补丁脚本被它自己拦了三次。**
 *
 * 这一层只做减法（heredoc 正文与注释替换成空格、引号内文本替换成等宽为一个 token 的
 * 占位符），不改变分词与 `-C` 处理，所以既有的真·提交用例逐条不受影响。剥不干净时
 * **宁可留着**——留着最多是误报（会被发现），剥过头则是漏拦（不会被发现）。
 *
 * `quoted` 传入时收集被挖走的引号内文本，供 `dequote` 按占位符序号取回。
 */
function stripNonCommandText(command, quoted = []) {
  let s = String(command);
  const hold = (body) => {
    quoted.push(body);
    return `${QUOTE_MARK}${quoted.length - 1}${QUOTE_MARK}`;
  };

  // ⓪ 行继续符：`\` + 换行在 shell 里是同一条命令。必须先接回来，否则下游把换行
  //    当分隔符时 `git \`+换行+`commit` 会被切成两段，两段各自都不是提交——与本轮
  //    修掉的那个漏拦同类。
  s = s.replace(/\\\r?\n/g, ' ');

  // ① heredoc 正文：`<<EOF` / `<<-'EOF'` / `<<"EOF"` 到行首（或允许缩进的）同名结束符。
  //    分隔符带引号时 shell 不做替换，不带引号时做——对本函数无差别，都不是命令。
  s = s.replace(
    /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2(?=\s|$)/g,
    ' ');

  // ② 引号内文本。单引号在 shell 里绝不含可执行命令；双引号内可以有 `$(...)`，
  //    所以**只挖掉双引号里不含 `$(` 的那些**，保守留下命令替换。
  s = s.replace(/'([^']*)'/g, (_, body) => hold(body));
  s = s.replace(/"(([^"\\]|\\.)*)"/g, (m, body) => (m.includes('$(') ? m : hold(body)));

  // ③ `#` 注释到行尾。必须在换行成为 segment 分隔符之后才谈得上必要：在那以前
  //    注释与前面的命令同段、被 findIndex 越过；之后它自成一段，于是"注释里写着
  //    的提交命令"会被当成真提交。bash 只在词首把 `#` 当注释，所以要求它前面是
  //    行首或空白——`--flag=#x`、URL fragment 里的 `#` 不受影响。
  s = s.replace(/(^|\s)#[^\n]*/g, '$1 ');

  return s;
}

/**
 * 按 shell 的命令分隔符切段，**保留每段前面的分隔符**（`||` 与 `&&` 语义不同，见
 * commitCwds 的守卫）。换行和 `;&|` 一样是分隔符——漏掉它时 `git add x\ngit commit …`
 * 是**一个** segment，取到的第一个 git 是 `add`，整条被判成"不是提交"，而这正是 agent
 * 写多步提交最自然的形态（实测两次静默漏拦）。
 */
function segmentsOf(text) {
  const parts = String(text).split(/(\|\||&&|[;&|\n\r]+)/);
  const segs = [];
  let sep = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2) { sep = parts[i]; continue; }
    // 剥掉 token 头部的 shell 包裹：`"$(git`、`$(git`、`(git`、`` `git `` 都是真调用。
    // 不剥的话 findIndex 认不出它们，命令替换里的真提交会漏拦。
    const toks = parts[i].trim().split(/\s+/).filter(Boolean)
      .map((t) => t.replace(/^["'`]*\$?\(*/, ''));
    segs.push({ toks, sep });
    sep = '';
  }
  return segs;
}

/** 这一段是不是 `git … commit`，以及它带的 `-C` 值（可重复）。不是 git 调用返回 null。 */
function parseGitSeg(toks) {
  const gi = toks.findIndex((t) => t === 'git' || t.endsWith('/git'));
  if (gi < 0) return null;
  let j = gi + 1;
  const dashC = [];
  while (j < toks.length && toks[j].startsWith('-')) {
    const takesValue = GLOBAL_OPTS_WITH_VALUE.test(toks[j]) && !toks[j].includes('=');
    if (toks[j] === '-C' && takesValue) dashC.push(toks[j + 1]);
    j += takesValue ? 2 : 1;
  }
  return { isCommit: toks[j] === 'commit', dashC };
}

/** 是不是一条会产生 commit 的命令（`git commit`，含 --amend、`git -C x commit`）。 */
function isCommitCommand(command) {
  return segmentsOf(stripNonCommandText(command))
    .some(({ toks }) => parseGitSeg(toks)?.isCommit);
}

const ASSIGN_TOK = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * 这一段的**命令前缀**把 `name` 赋成了什么：`undefined` = 没提到它，`null` = 显式撤销
 * （`env -u NAME`）。两者必须分开——"没提到"要退回上文的 sticky 声明，"撤销了"不能。
 *
 * 覆盖 `A=1 A=0 cmd` 取后者（shell 语义）。`env` 的各种真实形态都要认——`env`、
 * `/usr/bin/env`、`env -i`、`env -u NAME`、赋值与 env 混排——它们都真把变量传给命令，
 * 只认"首 token 恰好是它"会把这些写法误拦，而误拦会训练出绕过。
 */
function prefixAssignment(toks, name) {
  let val;
  let i = 0;
  for (;;) {
    while (i < toks.length && ASSIGN_TOK.test(toks[i])) {
      const eq = toks[i].indexOf('=');
      if (toks[i].slice(0, eq) === name) val = toks[i].slice(eq + 1);
      i++;
    }
    const t = toks[i];
    if (t !== 'env' && !(t && t.endsWith('/env'))) return val;
    i++;
    while (i < toks.length && toks[i].startsWith('-')) {
      if (toks[i] === '-u' || toks[i] === '--unset') {
        if (toks[i + 1] === name) val = null;
        i += 2;
      } else {
        if (toks[i] === `--unset=${name}`) val = null;
        if (toks[i] === '--') { i++; break; }
        i++;
      }
    }
  }
}

/**
 * 这条命令里的**每个** `git commit`，各自跑的时候 `NAME=1` 声明成不成立。
 *
 * 逐个而不是整条一个布尔：`NAME=1 git -C A commit && git -C B commit` 里那个前缀只作用
 * 于 A 那次提交，B 没有声明、该照常受检；整条一个布尔会让 A 的声明顺手放行 B。
 *
 * 三处收窄，各自堵一种误认：
 * - 判**命令文本**而非原串：`git commit -m "…NAME=1…"` 里的字样在引号内、不是声明，
 *   拿原串匹配会让一句 message 顺手打开逃生口，且不留痕。
 * - 判**作用域**：`NAME=1 git status && git commit` 里的赋值只作用于 `git status`。
 * **不判"这段声明到底跑没跑"**：`cd /r && export NAME=1; git commit` 里那句 export 只在
 * cd 成功时才执行，而本层不碰文件系统、无从知道。两侧只能选一个方向：按"没跑"处理会
 * 误拦这条现实写法（导航、声明、提交分行写），按"跑了"处理则会在 `false && export
 * NAME=1; git commit` 这类**刻意构造**里少拦一次。选后者——这个逃生口本就是给 agent
 * 自己声明用的、没有对手，少拦一次的代价只是漏掉一次文档提醒；而误拦会训练出"拦了就
 * 想办法绕过"，那等于废掉整道闸。
 */
function envDeclaredPerCommit(command, name) {
  const out = [];
  let sticky = false;
  for (const { toks } of segmentsOf(stripNonCommandText(command))) {
    if (!toks.length) continue;
    if (toks[0] === 'unset' && toks.includes(name)) {
      sticky = false;
      continue;
    }
    // 独立一段的 `NAME=…` 或 `export NAME=…`：作用于此后的命令，可被覆盖 / unset 撤销。
    const decl = toks[0] === 'export' ? toks.slice(1) : (toks.length === 1 ? toks : null);
    if (decl) {
      const v = prefixAssignment(decl, name);
      if (v !== undefined) { sticky = v === '1'; continue; }
    }
    if (!parseGitSeg(toks)?.isCommit) continue;
    const v = prefixAssignment(toks, name);
    out.push(v !== undefined ? v === '1' : sticky);
  }
  return out;
}

/** 整条命令的每次提交都带了声明吗（无提交则 false）。 */
function envDeclared(command, name) {
  const per = envDeclaredPerCommit(command, name);
  return per.length > 0 && per.every(Boolean);
}

/**
 * `cd` / `git -C` 的目标目录，解析不出**确定**路径时返回 null。
 *
 * 为什么不回落到 base：回落等于"看不懂就当没换过目录"，而那正是 commitCwds 要消灭的
 * 错仓判定——判错的一侧比不判贵得多（拿 A 仓的约定去卡 B 仓的提交）。
 */
function resolveDir(base, token, quoted) {
  const target = dequote(token, quoted);
  if (!target || target.startsWith('-')) return null;   // 裸 `cd`（回 HOME）、`cd -`
  if (/[$*?~`]/.test(target)) return null;              // 变量替换 / 通配 / ~ 展开
  return path.resolve(base, target);
}

/**
 * 目录追踪不可靠的两种控制流，各自的判据都要**只在它真的能改变答案时**成立——
 * 守宽了就是把常见提交形态整片放行，而放行是静默的。
 *
 * 1. 括号组里的 `cd`：作用域不外泄（`(cd B && …); git commit` 在原目录提交）。
 *    `$(...)` 不是控制流分组，先摘掉——`git commit -m "$(build_msg)"` 正是
 *    create-commit 规定的 message 写法，把它算成分组会让**最常见的那条提交命令**
 *    永远不判。同理 `cd X && (npm test) && git commit` 里的括号与 cd 无关。
 * 2. `||` 之后还有 commit、且命令里有 cd：那个 cd 是否执行、或该 commit 是否执行，
 *    都取决于前一条的退出码（`cd /missing || git commit`）。反过来
 *    `cd X && git commit || echo failed` 的 `||` 在 commit **之后**，与目录无关。
 */
function unreliableDirFlow(text) {
  // 摘 `$(...)`（含嵌套：反复摘最内层）后再数括号。
  // 摘掉的部分要**回头看一眼有没有 cd**：`out="$(cd /b && git commit …)"` 里的 commit
  // 会被后面的分词照常认出（那是有意的），可它跑在命令替换的子 shell 里、目录是 /b。
  // 只摘不看，就会拿 session cwd 去判那次提交——摘除本身制造了一个错仓面。
  let struct = String(text);
  let cut = '';
  for (let i = 0; i < 8 && /\$\([^()]*\)/.test(struct); i++) {
    struct = struct.replace(/\$\([^()]*\)/g, (m) => { cut += ` ${m} `; return ' '; });
  }
  // 摘掉的部分**同时**含 cd 与 commit 才算不可靠：那时提交跑在子 shell 的另一个目录里。
  // 只看 cd 会把 `git commit -m "$(cd scripts && ./build-message)"` 整条判成不可判——
  // 那里的 cd 只服务于生成 message，提交本身在当前仓，目录完全确定。
  if (/(^|[;&|(){}\s])cd(\s|$)/.test(cut) &&
      segmentsOf(cut).some(({ toks }) => parseGitSeg(toks)?.isCommit)) return true;

  let depth = 0;
  for (const seg of struct.split(/(?=[()])|(?<=[()])/)) {
    if (seg === '(') { depth++; continue; }
    if (seg === ')') { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0 && /(^|[;&|{}\s])cd(\s|$)/.test(seg)) return true;
  }

  const segs = segmentsOf(struct);
  const hasCd = segs.some(({ toks }) => toks[0] === 'cd');
  if (!hasCd) return false;

  const lastOr = segs.map(({ sep }) => sep).lastIndexOf('||');
  if (lastOr >= 0 && segs.slice(lastOr).some(({ toks }) => parseGitSeg(toks)?.isCommit)) return true;

  // 3. 条件执行的 `cd`（`A && cd B`），后面又有一段**无条件**继续（`;` / 换行）跑了
  //    commit：`test -f m && cd B; git commit` 在 m 不存在时提交于原目录，按 B 判就是
  //    凭空误拦。全 `&&` 串（`npm test && cd B && git commit`）不在此列——cd 没执行时
  //    commit 也不会执行，判 B 与实际意图一致。
  let condCd = false;
  let unconditionalAfter = false;
  for (const { toks, sep } of segs) {
    if (condCd && /^[;\n\r]+$/.test(sep)) unconditionalAfter = true;
    if (toks[0] === 'cd' && (sep === '&&' || sep === '||')) condCd = true;
    if (unconditionalAfter && parseGitSeg(toks)?.isCommit) return true;
  }
  return false;
}

/**
 * 这条命令里的每个 `git commit` **各自操作哪个仓**（去重后的目录列表）。
 *
 * 存在的理由是一次实测误拦（harness-issues HARNESS-192）：消费方直接拿 session cwd
 * 当仓库，于是 `cd <另一个仓> && git commit` 被拿**当前仓**的约定卡下，报出来的"本次
 * 暂存文件"还是当前仓里**别的 session** 暂存的东西。它是间歇性的——成败取决于另一个
 * 仓的索引此刻长什么样，因而极难归因。
 *
 * 返回**列表**而不是首个命中：`git -C B commit && git commit` 是两次提交、两个仓，
 * 只判第一个等于给第二个开了后门。
 *
 * 返回 null = 解析不出确定结果 → 调用方应当**不判**，而不是回落到 cwd。判据见
 * unreliableDirFlow 与 resolveDir。
 *
 * **已知限制**（有意不修）：`cd /不存在; git commit` 里 cd 会失败、commit 其实在原
 * 目录跑，本函数仍报 cd 的目标。判它需要让这个纯解析层去碰文件系统，而它的失败方向
 * 是"目标目录不是仓 → 调用方不判"，与本模块既定取舍（宁可不判，不误拦）同向；触发
 * 形态（cd 到不存在的目录后用 `;` 而非 `&&` 继续提交）也不是常见写法。
 */
function commitCwds(command, cwd) {
  const { text, quoted } = stripWithQuoted(command);
  if (!quoted) return null;              // 原文含占位符字符：内部编码与用户文本不可分
  if (unreliableDirFlow(text)) return null;

  let dir = cwd;
  const dirs = [];
  for (const { toks } of segmentsOf(text)) {
    if (!toks.length) continue;
    if (toks[0] === 'cd') {
      const next = resolveDir(dir, toks[1], quoted);
      if (!next) return null;
      dir = next;
      continue;
    }
    const git = parseGitSeg(toks);
    if (!git) continue;
    // `-C` 可以重复出现，后一个相对前一个解析（git 原生语义）。
    let at = dir;
    for (const c of git.dashC) {
      const next = resolveDir(at, c, quoted);
      if (!next) return null;
      at = next;
    }
    // 不去重：下标要与 envDeclaredPerCommit 一一对齐（同一个仓也可能一次带声明、
    // 一次不带）。去重由调用方在配对之后自己做。
    if (git.isCommit) dirs.push(at);
  }
  // isCommitCommand 判 true 却一个都找不出 = 两处分词出现分歧，同样不判。
  return dirs.length ? dirs : null;
}

module.exports = {
  extractMessages, isCommitCommand, stripNonCommandText, stripWithQuoted, dequote,
  envDeclared, envDeclaredPerCommit, commitCwds, GLOBAL_OPTS_WITH_VALUE,
};
