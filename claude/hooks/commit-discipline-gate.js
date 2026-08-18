'use strict';

/**
 * create-commit 里**确定性可判**的那几条规则的闸门。
 *
 * 【为什么需要它】
 * user-scope CLAUDE.md 的 commit 节写着「**每一次** commit 前都按 create-commit skill，不是每个任务一次」，
 * 而"何时需要重新加载"的判据由其**前言**统一给出（该正文此刻在不在 context 里）——这条判据 2026-08-17 从
 * 本节上提到前言，因为它对全文二十余条「…前读取 X」条款一体适用。引用时别再当成 commit 节的私有规定。
 * 前言那条判据的四个"不算在 context 里"各有来由，为省常驻预算没写进 CLAUDE.md，记在这里以免日后被当冗余删掉：
 *  · "只有改述在"不可省——`~/.claude/references/` 各档刻意不给可自判的改述，正因**改述一旦在场就会被拿去自判**；
 *    而 skill catalog 的 description 每轮都注入，不排除它，最强的那几条（"要免审就得打开它"）都能被绕开。
 *  · "读入后可能已变"那支的落向不能留空——实测一个 subagent 手上的 user-scope CLAUDE.md 与磁盘差三处，
 *    其中一处是从未被 commit 过的中间稿，全程零信号。agent 对磁盘漂移没有观察面，故默认必须是"当作已变"。
 * **本闸实现的是那条判据的近似，不是判据本身**：它只能看 transcript，看不到 context，故用「最近 RECENT_WINDOW
 * 条 assistant 记录内有没有注入过 create-commit」代替。两者必然分岔——未 compaction 的长回合里，第 41 条之前
 * 调过的 skill 正文其实还在 context，规则说不必重开、本闸仍拦。这个方向（偏严）是刻意的，但别把闸的行为
 * 当成判据的定义去引用：下面 block 文案陈述的是 CLAUDE.md 的判据，本闸只是它够得着的那个代理。
 * （该措辞 2026-08-17 由「任何需要创建本地 commit 的**工作**」改来：旧句是 per-task 判据，而本闸判的是
 * 新鲜度，两者在长 session 必然分岔——模型按旧句自判"本任务已经按过了"，而指引其实早已滑出 context。
 * 实测一个长 session（2026-08-11T00:02Z 起，**截至写下本注释的那次提交 08-17T08:09:47Z**）：本闸开火 5 次，
 * 其中 2 次是下面 RECENT_WINDOW 那条新鲜度拦截，3 次 subject 超长。本闸不写任何日志（gate-stats 那套统计
 * 对它整类不可见，见 harness-issues 的 HARNESS-313），唯一取证路径是数该 session transcript 里
 * `type === "tool_result" && is_error === true` 且正文含本闸标记的块。
 * **两个坑都要记住，它们都在写这条注释时真实发生过**：
 *  (a) 判据必须这么严。只按"正文含 [COMMIT-DISCIPLINE]"数，会把讨论本闸时引用的文案、以及读改本源码时
 *      进入 transcript 的这几行注释一并数进去——同一份 transcript 上该宽判据先后给出 5 和 10。
 *  (b) **区间必须冻结**。写"该 session 共 N 次"是活的，会被后续开火自动作废：本注释初稿写 3，而为提交它
 *      本身连续触发了两次 subject 超长拦截，落盘那一刻数字已经是 5——写下证据的动作使证据失效。
 * "拦得对不对"无法由此判定，未作断言。
 * 归因写在这里而不是 CLAUDE.md：那是变更证据，不改变任何一次 commit 的动作，不该占常驻预算。）
 * 规则一直在 context 里，仍然反复失守——实测：一个 session 内 commit 十余次，其中两次用了
 * skill 明令禁止的 `git add -A`（把别的 agent 在写的文件扫进了描述别的事的 commit），
 * 一次 subject 74 字符，两个用户可感知的改动没有同步 CHANGELOG。
 *
 * 失守的成因不是不知道规则，是 **commit 是大任务里的小步骤**：深在"修某个 bug"里的时候，
 * `git commit` 读起来是一条 shell 命令，不是"一件需要先加载 skill 的任务"。CLAUDE.md 里
 * 其他 BINDING 规则多半有 hook 兜底，commit 纪律此前只有 `commit-message-language` 一条。
 * 同一份立论已经写在那个文件的头部：判据是纯确定性的，就该由机器判而不是靠记得。
 *
 * 【只判确定性的，不判需要判断的】
 * skill 里「staging 范围该含哪些文件」「这次改动算不算用户可感知」都需要判断，本闸不碰——
 * 除了最后一条，它不替你判断，只是不让你**静默**跳过那个判断（见 §user-doc）。
 *
 * 只拦不改：exit 2 + 理由，由模型自己改。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
// 解析住在共享模块：commit 相关的闸不止一道，两份实现迟早分歧（harness-issues H-006）。
const { extractMessages, isCommitCommand, commitCwds, envDeclared, envDeclaredPerCommit } = require('./lib/git-commit-parse');
const { knowledgeReadPaths, codexToolCommand } = require('./lib/codex-shell-read');

const SUBJECT_MAX = 72;
// 转录超过这个体积就不扫 —— 宁可不判，也不要在 hook 里读进一个几百 MB 的文件。
// 尾部读取的初始块与上限。整份 transcript 可以有几十 MB，但窗口只需要末尾几十条记录。
const TAIL_BYTES = 4 * 1024 * 1024;
const TAIL_BYTES_MAX = 64 * 1024 * 1024;
// 窗口大小：够覆盖「调 skill → 做几步 → 提交」，又不至于让 session 早期的一次调用
// 永久通行。40 是量级选择、不是精调值——实测漂移的间隔是数百步。
const RECENT_WINDOW = 40;

/**
 * `git add -A` / `git add .` —— skill 明令禁止，且**不限于**与 commit 同一条命令：
 * 它常常单独发一次，随后才 commit。所以这条按"任何 Bash 命令"判，不挂在 commit 上。
 *
 * 为什么它值得拦到这个程度：它把**别人正在写的文件**扫进本次提交，而 commit 会成功、
 * 测试会通过、message 描述的还是原来那件事——没有任何症状。实测发生过两次，第二次就在
 * 读完"另一个 agent 抱怨我干过这事"的记录之后。
 */
function findBroadAdd(command) {
  // 逐段判，避免把 `git add -- ./x` 这类合法写法误伤。
  for (const seg of String(command).split(/[;&|\n]+/)) {
    const toks = seg.trim().split(/\s+/).filter(Boolean);
    const gi = toks.findIndex((t) => t === 'git' || t.endsWith('/git'));
    if (gi < 0) continue;
    const ai = toks.indexOf('add', gi);
    if (ai < 0) continue;
    for (let k = ai + 1; k < toks.length; k++) {
      const t = toks[k];
      if (t === '--') break; // `--` 之后是路径，`.` 在那里是显式路径、不是通配
      if (t === '-A' || t === '--all' || t === '.' || t === '-Av' || t === '--no-ignore-removal') {
        return t;
      }
    }
  }
  return null;
}

/** 仓库根；拿不到返回 null（不下结论）。 */
function repoRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * 这个仓库是否有一份**自称只记用户可见变更**的 CHANGELOG。
 *
 * 作用域刻意窄：没有这种 CHANGELOG 的仓库，"该不该写变更日志"没有客观载体，拦下去就是
 * 拿一条不存在的约定当判据。实测三个在用的仓库里只有一个满足，因此本条只在那里开火。
 */
function userVisibleChangelog(root) {
  const p = path.join(root, 'CHANGELOG.md');
  try {
    const head = fs.readFileSync(p, 'utf8').slice(0, 400);
    return /user[- ]visible/i.test(head) ? p : null;
  } catch {
    return null;
  }
}

/** 已 staged 的路径（相对仓库根）。拿不到返回 null。 */
function stagedPaths(cwd) {
  try {
    return execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return null;
  }
}


// —— 最近有没有过 create-commit 的指引 ——
//
// 判据问的是**skill 指引还在不在 context 里**，界只有一个：最近 RECENT_WINDOW 条
// assistant 记录。
//
// 不按 session：实测失守形态是早期调过一次、之后十几个 commit 全部漂移（18 个里只有
// 2 个符合 skill 的 subject 格式）。按 session 判的话那次调用会让后面每个 commit 通行
// ——判据在它最该拦的场景下恒为真。窗口步数挡的就是这件事。
//
// **曾经还有第二个界"真实用户轮是硬边界"，已撤除。** 它与窗口步数挡的是同一件事
// （永久通行），却在上线后连续两次拦住本该放行的提交：一次是 agent 调 skill 后用户
// 插话，一次是用户直接敲 `/create-commit` 后又追加一句。用户说话不等于 context 被
// 清空——那是把"谁在说话"当成"指引还在不在"的代理，而两者在长会话里频繁分岔。
// **频繁误报会训练出"拦了就加环境变量绕过"，那等于废掉整道闸。**
//
// 证据取自**注入正文**而非 Skill 的 tool_use：用户直接敲 slash command 时转录里
// 没有 tool_use，只有注入。注入正文是更直接的证据——它就是指引本身进入 context 的
// 那条记录，无论谁发起的。
//
// 为什么读 transcript 而不是让 skill 写哨兵文件：transcript 是权威记录；哨兵是第二个
// 真相源，会与它漂移，而漂移时两边都不报错。
// 只读文件尾部。**这个函数只需要末尾 RECENT_WINDOW 条 assistant 记录**，此前却
// readFileSync 整个 transcript，因而不得不加一道体积上限自保——而上限一旦触发就
// `return null`（不判），于是**长 session 里这道闸静默失效**。实测：一个 80.0 MB
// 的 transcript 撞上 64 MB 上限，从那一刻起「有没有调过 create-commit」再没判过，
// 而它退化的时机恰恰是最需要它的时候（长 session 才会积累几十个 commit 与规则漂移）。
// 读尾巴之后那道上限就不必要了：内存占用与文件总长无关。
//
// 尾部块要够大到装得下窗口。转录里单条记录可以很大（工具结果、长回复），所以按
// 「不够就翻倍重读」而不是赌一个固定值；到顶仍不够才放弃并**照旧返回 null**。
function readTail(p, bytes) {
  const size = fs.statSync(p).size;
  const start = Math.max(0, size - bytes);
  const fd = fs.openSync(p, 'r');
  try {
    const want = size - start;
    const buf = Buffer.allocUnsafe(want);
    // **必须用实际读到的字节数**：短读时 allocUnsafe 未写满的尾部是脏内存，
    // 直接 toString 会解出垃圾并污染最后一行。
    const got = fs.readSync(fd, buf, 0, want, start);
    const text = buf.subarray(0, got).toString('utf8');
    // 从偏移量切进来多半会截断第一行（也可能切在多字节字符中间）；丢掉到首个 LF
    // 为止的部分，后续 JSONL 不受影响。
    return { text: start === 0 ? text : text.slice(text.indexOf('\n') + 1),
             coversWholeFile: start === 0 };
  } finally {
    fs.closeSync(fd);
  }
}

function codexAssistantPayload(rec) {
  const payload = rec && rec.type === 'response_item' && rec.payload;
  if (!payload) return null;
  if (payload.type === 'message' && payload.role === 'assistant') return payload;
  if (payload.type === 'custom_tool_call' || payload.type === 'function_call') return payload;
  return null;
}

function skillInvokedRecently(transcriptPath, window = RECENT_WINDOW) {
  let lines = null;
  try {
    for (let bytes = TAIL_BYTES; ; bytes *= 4) {
      const { text, coversWholeFile } = readTail(transcriptPath, bytes);
      const ls = text.split('\n').filter((l) => l.trim());
      let n = 0;
      for (const l of ls) {
        try {
          const rec = JSON.parse(l);
          if (rec?.message?.role === 'assistant' || codexAssistantPayload(rec)) n++;
        } catch { /* 截断行 */ }
      }
      if (n >= window || coversWholeFile) { lines = ls; break; }
      // **到了上限但没覆盖全文件、窗口又不完整 → 返回 null，不是 false。**
      // 拿不完整窗口判 false 等于说"没调过 skill"，会误拦合法提交；而单条记录可以
      // 很大（一条 >64MB 的工具结果就够），这不是理论情形。误报会训练出"拦了就
      // 加环境变量绕过"，那等于废掉整道闸——宁可不判。
      if (bytes >= TAIL_BYTES_MAX) return null;
    }
  } catch {
    return null;   // 读不到、读到一半被轮转 —— 都**不判**，不能当成"没调用"
  }
  if (!lines) return null;
  let seen = 0;
  for (let i = lines.length - 1; i >= 0 && seen < window; i--) {
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      return null;   // 解析不全 → 窗口可能不完整 → 不判
    }
    const codex = codexAssistantPayload(rec);
    if (codex && (codex.type === 'custom_tool_call' || codex.type === 'function_call')) {
      if (knowledgeReadPaths(codexToolCommand(codex)).some((p) => /\/skills\/create-commit\/SKILL\.md$/.test(p))) return true;
    }
    if (codex) {
      seen++;
      continue;
    }

    const msg = rec && rec.message;
    if (!msg) continue;

    // 真实用户轮是硬边界。**skill 注入的正文也以 role:"user" 落盘**，把它当边界的话，
    // 它恰好会盖住紧挨着的那次 Skill 调用——即这道闸要找的东西被它自己触发的注入藏住。
    // **注入正文即证据**：它就是 skill 指引进入 context 的那条记录。用户直接敲
    // `/create-commit` 时转录里根本没有 Skill 的 tool_use（那次调用不是 agent 发起
    // 的），只有两条 role:"user" 消息——只认 tool_use 的话，指引明明在场却判"没调过"。
    // 判据要问的是"指引在不在 context 里"，不是"谁调的"。
    if (msg.role === 'user') {
      if (isCreateCommitInjection(msg)) return true;
      continue;   // 其余 user 消息（真实发言、工具结果、别的 skill 注入）都不占窗口
    }
    if (msg.role !== 'assistant') continue;
    seen++;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b && b.type === 'tool_use' && String(b.name).toLowerCase() === 'skill') {
        const sk = b.input && (b.input.skill || b.input.name);
        if (typeof sk === 'string' && sk.replace(/^.*:/, '') === 'create-commit') return true;
      }
    }
  }
  return false;
}

// 注入的是不是 create-commit。**必须判到具体是哪个 skill**——任何 skill 的注入都放行
// 的话，这道闸会被无关的 skill 调用顺手打开，而那正是它要拦的那类"没走流程"。
function isCreateCommitInjection(msg) {
  const c = msg.content;
  const text = typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n')
      : '';
  return /skills\/create-commit/.test(text) ||
         /Re-invocation of \/create-commit/.test(text) ||
         /<command-name>\/create-commit<\/command-name>/.test(text);
}

function evaluate(rawInput) {
  let input;
  try {
    input = JSON.parse(rawInput);
  } catch {
    return { exitCode: 0 }; // 畸形 stdin 不阻断
  }
  if (!input || input.tool_name !== 'Bash') return { exitCode: 0 };
  const command = input.tool_input && input.tool_input.command;
  if (typeof command !== 'string') return { exitCode: 0 };
  const cwd = input.cwd || process.cwd();

  // —— 1. git add -A / . （任何命令，不限 commit 场合）——
  const broad = findBroadAdd(command);
  if (broad) {
    return {
      exitCode: 2,
      message:
        `[COMMIT-DISCIPLINE] \`git add ${broad}\` 被 create-commit skill 明令禁止。\n` +
        `它会把**别的 agent 正在写的文件**、以及与本次任务无关的改动一起 stage，` +
        `而 commit 照样成功、message 照样描述原来那件事——没有任何症状。\n` +
        `改用显式路径：git add <file1> <file2> …\n` +
        `确实要提交全部改动时，也请逐个列出（\`git status --short\` 先看清有什么）。`,
    };
  }

  if (!isCommitCommand(command)) return { exitCode: 0 };

  // —— 2. 本轮有没有过 create-commit skill ——
  //
  // 下面第 3、4 条只判 skill 里**确定性可判**的那几条（长度、Co-Authored-By）。
  // 而 skill 还规定了 subject 的 `<type>(scope):` 形态、staging 范围、文档同步
  // checkpoint —— 那些要么需要判断、要么正则判起来会误伤合法的多改动形态。
  // 与其逐条补判据（补漏一条就漏一整类），不如要求先把 skill 读进来。
  // 逃生口同时认两种形态。**只认 process.env 不够**：hook 是独立进程，命令行前缀
  // `COMMIT_SKIP_SKILL_CHECK=1 <提交命令>` 设的是那条命令的环境，hook 看不到——
  // 而提示里教的正是这种写法，于是逃生口写了等于没写（上线当场撞到）。
  const skipDeclared =
    String(process.env.COMMIT_SKIP_SKILL_CHECK || '') === '1' ||
    envDeclared(command, 'COMMIT_SKIP_SKILL_CHECK');
  if (skipDeclared) {
    // 声明式跳过是显式动作，静默漂移不是。
  } else if (input.transcript_path) {
    const invoked = skillInvokedRecently(input.transcript_path);
    if (invoked === false) {
      return {
        exitCode: 2,
        message:
          '[COMMIT-DISCIPLINE] 最近没有调用 create-commit skill。\n' +
          'user-scope CLAUDE.md：**每一次** commit 前都按该 skill，不是每个任务一次；\n' +
          '判据是它的正文此刻在不在你的 context 里——本任务早先调用过、或你记得内容，都不算。\n' +
          '规则一直在 context 里仍反复失守——实测一个 session 里 18 个 commit，' +
          '只有 2 个符合 skill 规定的 subject 格式。成因不是不知道，是 `git commit` ' +
          '读起来像一条 shell 命令、不像一件要先加载 skill 的任务。\n' +
          '先 Skill(create-commit)，按它的 staging 与 message 规则来。\n' +
          '确有理由不走（如 rebase 中途、脚本化批量提交）：' +
          'COMMIT_SKIP_SKILL_CHECK=1 声明式跳过。',
      };
    }
    // invoked === null：转录读不到或不完整 —— **不判**。把"没证据"当成"没调用"
    // 会在转录轮转、体积超限时误拦，而误报会训练出"拦了就加环境变量绕过"。
  }

  // —— 3. message 格式（只有能读到文本时才判；-F/编辑器路径本闸看不到）——
  const messages = extractMessages(command);
  for (const msg of messages) {
    const lines = String(msg).split('\n');
    const subject = (lines[0] || '').trim();
    if ([...subject].length > SUBJECT_MAX) {
      return {
        exitCode: 2,
        message:
          `[COMMIT-DISCIPLINE] subject ${[...subject].length} 字符，超过 ${SUBJECT_MAX}。\n` +
          `理由（skill 原文）：\`git log\` 左缩进 4 空格后仍要在 80 列内。\n` +
          `当前：${subject}`,
      };
    }
    const co = lines.find((l) => /^\s*Co-Authored-By:/i.test(l));
    if (co) {
      return {
        exitCode: 2,
        message: `[COMMIT-DISCIPLINE] create-commit 规定 commit 不附 Co-Authored-By。\n删掉这一行：${co.trim()}`,
      };
    }
  }

  // —— 4. 用户可感知变更的 [User] 档同步 ——
  //
  // 这一条**需要判断**（这次改动算不算用户可感知），本闸不替你判。它只是不让你静默跳过：
  // 命中时要么把 CHANGELOG 一并 stage，要么显式声明这次不可感知。声明留痕，静默不留痕。
  //
  // 逃生口两种形态都认，理由与 §2 的 COMMIT_SKIP_SKILL_CHECK 同：hook 是独立进程，
  // 命令行前缀 `COMMIT_NO_USER_DOC=1 <提交命令>` 设的是**那条命令**的环境，hook 的
  // process.env 里没有它——而下面提示里教的正是这种写法。只认 process.env 的话，
  // 这个逃生口**只有用户**能启用（settings.json 的 env），agent 侧恒不可达，于是
  // 提示教了一条必然无效的出路（实测连试四种形态全部无效，HARNESS-192）。
  if (String(process.env.COMMIT_NO_USER_DOC || '') === '1') return { exitCode: 0 };

  // 判的必须是**这条命令实际提交的那些仓**，不是 session cwd：`cd <别的仓> && git commit`
  // 时两者不同，拿 cwd 判会用 A 仓的 CHANGELOG 约定卡 B 仓、并报出 A 仓里别人暂存的
  // 文件。一条命令里可以有多个提交（仓与声明都可能各不相同），**逐个配对**判：
  // `COMMIT_NO_USER_DOC=1 git -C A commit && git -C B commit` 里那句声明只作用于 A。
  // 解析不出确定结果时 commitCwds 返回 null —— **不判**，不回落到 cwd。
  const dirs = commitCwds(command, cwd);
  const declared = envDeclaredPerCommit(command, 'COMMIT_NO_USER_DOC');
  // 两处分词若给出不同的提交数，配对就是错的——宁可不判，也不要按错位的下标放行。
  if (!dirs || dirs.length !== declared.length) return { exitCode: 0 };
  const seen = new Set();
  for (let i = 0; i < dirs.length; i++) {
    if (declared[i] || seen.has(dirs[i])) continue;
    seen.add(dirs[i]);
    const blocked = missingUserDoc(dirs[i]);
    if (blocked) return blocked;
  }
  return { exitCode: 0 };
}

/** 该仓这次提交缺 [User] 档同步吗？缺 → 返回拦截结果；否则 null。 */
function missingUserDoc(cwd) {
  const root = repoRoot(cwd);
  if (!root) return null;
  const changelog = userVisibleChangelog(root);
  if (!changelog) return null;
  const staged = stagedPaths(cwd);
  if (!staged || staged.length === 0) return null;

  const rel = path.relative(root, changelog) || 'CHANGELOG.md';
  if (staged.includes(rel)) return null;
  // 纯文档改动不触发：它们本身就是文档同步的产物，再要求一次会变成永远拦。
  const onlyDocs = staged.every((f) => /(^|\/)(docs|README\.md|CHANGELOG\.md)($|\/)/i.test(f) || f.endsWith('.md'));
  if (onlyDocs) return null;

  return {
    exitCode: 2,
    message:
      `[COMMIT-DISCIPLINE] ${root} 的 ${rel} 自称只记「user-visible changes」，而它不在本次 staging 里。\n` +
      `create-commit §3 要求：改动产生**用户可感知变化**时，[User] 档必须与代码进同一个 commit。\n` +
      `暂存的文件：${staged.slice(0, 8).join(', ')}${staged.length > 8 ? ` …共 ${staged.length} 个` : ''}\n\n` +
      `二选一：\n` +
      `  • 可感知 → 写 ${rel} 并 \`git add\` 它，重新提交；\n` +
      `  • 不可感知（纯内部重构 / 测试 / 注释）→ 本条命令前加 COMMIT_NO_USER_DOC=1 显式声明。\n` +
      `本闸不替你判断是不是可感知，只是不让这个判断被静默跳过——实测漏过两次，` +
      `而漏了之后 commit 一切正常，没有任何症状。`,
  };
}

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    process.exit(0);
  }
  const { exitCode, message } = evaluate(raw);
  if (message) process.stderr.write(message + '\n');
  process.exit(exitCode);
}

if (require.main === module) main();

module.exports = { evaluate, findBroadAdd, skillInvokedRecently, RECENT_WINDOW, SUBJECT_MAX };
