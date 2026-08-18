'use strict';

/**
 * commit message 的语言闸门。
 *
 * `create-commit` 规定「整条 message（subject + body）默认英文」，例外只有三条：用户明确
 * 要求、仓库近期 commit 多为中文、某专有概念无准确英文对应（末者只该词保留中文）。这条
 * 规则清晰且一直在 context 里，却仍然失守过一次——写 message 的那一轮之前在连续编辑中文
 * 文档，body 就顺着中文写下去了。维护一套中文 harness 文档时这个触发条件反复出现，而判据
 * 本身是纯确定性的（扫字符 + 读 git log），所以它该由机器判而不是靠记得。
 *
 * 三条例外里只有后两条可观察。第一条（用户明确要求）发生在对话里，这个 hook 读不到；
 * 它的载体是 `COMMIT_MSG_LANG_OK=1`——需要中文时随那一条 commit 命令显式带上。不给载体
 * 就只能照拦并宣称该例外不成立，那是无据断言，会把一次合法的用户要求判成违规。
 *
 * 只拦不改：命中时给出 exit 2 与理由，由模型重写 message。
 */

const { execFileSync } = require('child_process');
// 解析住在共享模块：commit 相关的闸不止一道，两份实现迟早分歧（H-006）。
const { extractMessages, isCommitCommand } = require('./lib/git-commit-parse');

// CJK 统一表意文字（含扩展 A）。不含日文假名——那不是这条规则的对象。判仓库惯例用它。
const HAN = /[㐀-䶿一-鿿豈-﫿]/;
// 汉字 + CJK 专用标点（、。「」《》与全角符号），逐行判密度用。不含 em dash 等通用
// 标点：英文里它们合法，拦下去就是误报。
const CJK_ALL_G = /[㐀-䶿一-鿿豈-﫿　-〿！-＠]/g;

// 一行里 CJK 字符占比超过它，就认为这行是用中文写的。
//
// 判据不能是"含不含中文字符"：规则的第三条例外明确允许「某专有概念无准确英文对应」时
// 保留该词，于是一行英文里嵌一个中文段名（`point 取证的充分性 at that file`）是合规的，
// 拦它就是误报——而误报会训练出"拦了就绕过"，等于废掉这道闸门。按行判也比按全文占比判
// 稳：全文占比会被长 body 稀释，一整段中文混在几十行英文里能被摊到阈值以下。
const CJK_LINE_RATIO = 0.35;

/** 这一行是不是用中文写的（而非英文行里嵌了个专有名词）。 */
function isChineseLine(line) {
  const compact = line.replace(/\s/g, '');
  if (!compact) return false;
  const cjk = (compact.match(CJK_ALL_G) || []).length;
  if (!cjk) return false;
  // 中文字信息密度高：一行里中文字数超过 compact 长度的 35% 就已经是中文句子了。
  return cjk / compact.length > CJK_LINE_RATIO;
}

/** 仓库近期是不是以中文 commit 为主——规则的第二条例外。 */
function repoPrefersChinese(cwd, sample = 40) {
  let out;
  try {
    out = execFileSync('git', ['log', `-${sample}`, '--format=%s%x00%b%x1e'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // 空仓、不是仓、git 不可用——问不出来就不放宽：默认英文本来就是 fallback。
    return false;
  }
  const rows = out.split('\x1e').map((r) => r.trim()).filter(Boolean);
  if (!rows.length) return false;
  const zh = rows.filter((r) => HAN.test(r)).length;
  return zh * 2 > rows.length; // 过半才算「多为中文」
}

/**
 * 从 `git commit` 命令里取出真正的 message。
 *
 * heredoc 必须单独处理：`create-commit` 明文要求用它传 body，而
 * `/(?:-m|--message)[=\s]+["']?([^"']+)["']?/` 这种写法在 `git commit -m "$(cat <<'EOF' …`
 * 上只会抓到 `$(cat <<`——检查照跑，作用在垃圾串上，看起来还挺正常。
 */
function evaluate(rawInput) {
  let input;
  try {
    input = JSON.parse(rawInput);
  } catch {
    return { exitCode: 0 }; // 畸形 stdin 不阻断编辑
  }
  if (!input || input.tool_name !== 'Bash') return { exitCode: 0 };
  const command = (input.tool_input || {}).command;
  if (typeof command !== 'string' || !isCommitCommand(command)) return { exitCode: 0 };

  const messages = extractMessages(command);
  if (!messages.length) return { exitCode: 0 }; // -F/-C/编辑器路径，本 hook 看不到文本

  const offendingLines = messages
    .flatMap((t) => t.split(/\r?\n/))
    .filter(isChineseLine);
  if (!offendingLines.length) return { exitCode: 0 };

  const cwd = input.cwd || process.cwd();
  if (repoPrefersChinese(cwd)) return { exitCode: 0 }; // 例外二成立

  // 例外一（用户明确要求中文）发生在对话里，而这个 hook 只看得见 Bash 命令、cwd 与
  // git log——它没有 transcript，永远观察不到那次要求。此前的处置是照拦，并在文案里
  // 断言"前两条都不成立"：对例外二成立，对例外一是无据断言，且把一次合法的用户要求
  // 说成了违规。既然判据不可观察，就给它一个可观察的载体：需要中文时显式带上这个
  // 环境变量跑该次 commit。它只对那一条命令生效，不改变默认，也留下了痕迹。
  if (String(process.env.COMMIT_MSG_LANG_OK || '') === '1') return { exitCode: 0 };

  const sample = offendingLines.slice(0, 3).map((l) => `    ${l.trim().slice(0, 60)}`);

  return {
    exitCode: 2,
    stderr: [
      'BLOCKED: commit message 含中文，而本仓库近期 commit 以英文为主。',
      '',
      ...sample,
      '',
      'create-commit 的规则：整条 message（subject + body）默认英文。三条例外——',
      '用户明确要求 / 仓库近期 commit 多为中文 / 某专有概念无准确英文对应（这条只保留',
      '该词本身，不是整段）。已核实：本仓近期 commit 以英文为主，例外二不成立。',
      '',
      '**例外一这道闸看不见**——它只读得到 Bash 命令、cwd 与 git log，读不到你和用户',
      '的对话。所以这次拦截不代表用户没要求过中文。用户确实明确要求了中文时，就地重跑：',
      '',
      '    COMMIT_MSG_LANG_OK=1 git commit ...',
      '',
      '否则用英文重写后再提交；确需保留的专有名词（如某个 BINDING 段名）单独留着即可。',
    ].join('\n'),
  };
}

// 只返回、不打印：run-with-flags 负责把 stderr 写出去（见其 writeStderr），自己再写一遍
// 用户就会看到同一段拦截理由重复两次。与 block-no-verify 等既有 hook 同约定。
function run(rawInput) {
  return evaluate(rawInput);
}

module.exports = { run, evaluate, extractMessages, isCommitCommand, repoPrefersChinese };

// 直接 `node commit-message-language.js` 跑时没有 wrapper，这里自己打印。
if (require.main === module) {
  let buf = '';
  process.stdin.on('data', (d) => (buf += d));
  process.stdin.on('end', () => {
    const r = run(buf);
    if (r.stderr) process.stderr.write(`${r.stderr}\n`);
    process.exit(r.exitCode);
  });
}
