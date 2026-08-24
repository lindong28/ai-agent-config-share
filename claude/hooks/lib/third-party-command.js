'use strict';
/**
 * "这一回合的交付物是一份关于**另一个执行体**的报告吗？"——一个确定性读数，供
 * Stop 系判官闸在判 owner 之前拿到手。
 *
 * 为什么是确定性读数而不是让判官自己推：`HARNESS-20260823-022b` 实测过，
 * 「报告里描述别人的未完成项」与「agent 自陈甩活」在 prose 层面同形，换 opus 对同一段
 * 仍判错——缺的不是判别力，是判官凭 prose 推不出来的**事实**。所以这里只回答身份问题，
 * 判官照常逐项定 owner。
 *
 * **为什么住在 lib/ 而不是 stop-gate.js**：022b 落地时它是 stop-gate 的私有函数，于是
 * 同一停里的 sibling 闸（continuation-claim-gate、prose-choice-gate）拿不到同一个事实，
 * 各自按 prose 猜主语——实测一个 session 里这两个闸合计误拦 9 次，其中 4 次发生在
 * stop-gate 已正确豁免的同一回合上。跨闸共享的机制要住在共享 scope，这是
 * `durable-solution-carriers.md` 的「最窄共享 scope」在这里的取值。
 * 不靠 `require('./stop-gate')` 复用：那两个闸在顶层无条件跑 `main()`，peer 之间互 require
 * 会把加载顺序变成契约的一部分。
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { activeCommandName } = require('./transcript');


// 收 hook 的整份 input 而不是一个路径：SubagentStop 的判定要看 `agent_id` /
// `agent_transcript_path`，把它留在各闸的 main() 里就没有任何单测够得着——而那正是
// 本机制最容易错发豁免的一条路径。
function thirdPartyReportCommand(input) {
  const i = input || {};
  // SubagentStop 上不注入。**实测（`settings.json`）：`SubagentStop` 上只注册了 `stop-gate`，
  // `continuation-claim-gate` / `prose-choice-gate` 只在 `Stop` 上**——所以这道守卫当前只对
  // stop-gate 实际生效，对另两个是"将来它们也注册时不会踩坑"的前置防护，不是现在在挡什么。
  // （本注释初版原样搬了 stop-gate 的措辞"这几个闸同时注册于两个事件"，那句在泛化到共享模块
  // 之后就不再成立；由 review 抓出。搬运断言要随作用域重核，这是一次实例。）
  // 之所以仍保留：两份 transcript 在 SubagentStop 上是分开的——`last_assistant_message` 是子代理说的话，
  // `transcript_path` 仍指父 session，子代理那份在 `agent_transcript_path`。实测本机裁决日志
  // （stop-gate 口径）：3481 条 SubagentStop 记录**全部**同时带 `agent_id` 与
  // `agent_transcript_path`，3538 条普通 Stop **全部**两个都不带（`lib/judge-log.js` 本身不按
  // event 分流这三个键，它只是"输入里有就照抄"——所以这是一条关于**输入契约**的观察，
  // 不是那个文件的逻辑保证）。照父 session 的 command 身份去判子代理的末条消息，等于把
  // 父命令的第三方豁免发给一个根本没跑那个 command 的执行体。
  // 不改成"读 agent_transcript_path"：subagent 不由 slash command 调起，且实测 1132 份当前
  // 可读的子代理 transcript 上跑 `activeCommandName` **非 null 为 0**。查它只会得到 null。
  // 这两组数都是**当前语料的观察**，不是契约保证——输入形态变了要重取。
  if (i.agent_id || i.agent_transcript_path) return null;
  const transcriptPath = i.transcript_path;
  if (!transcriptPath) return null;
  let name;
  try { name = activeCommandName(transcriptPath); } catch { return null; }
  if (!name) return null;
  // `custom:review-session-progress` → commands/custom/review-session-progress.md。
  // 只放行 [A-Za-z0-9._:-]，把路径分隔与 `..` 挡在外面：name 虽来自 harness，但它最终会拼进
  // 一个文件路径，而"输入可信"不是省掉路径校验的理由。
  if (!/^[A-Za-z0-9._:-]+$/.test(name) || name.includes('..')) return null;
  const rel = name.split(':').join('/');
  // 根可注入，理由与 STOP_GATE_TASK_ROOT 同：上面那条路径校验若只拿真命令树测，穿越输入
  // 会因为"目标文件本来就不存在"而返回 null——把守卫整条删掉读数也不变，于是变异测试
  // 放行一条从未被握住的守卫（022b 实测过：删掉它，测试仍 10/10 通过）。
  // 变量名保留 `STOP_GATE_` 前缀：既有测试与文档按这个名字写，改名只会制造一次无收益的迁移。
  const root = process.env.STOP_GATE_COMMANDS_ROOT
    || path.join(os.homedir(), '.claude', 'commands');
  const file = path.join(root, rel + '.md');
  let head;
  try { head = fs.readFileSync(file, 'utf8').slice(0, 4096); } catch { return null; }
  // 只认前置 `---` frontmatter 块里的声明；正文里出现同一串字（比如某个命令在讲这个机制）不算。
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
  if (!fm) return null;
  if (!/^analysis-target:\s*third-party\s*$/m.test(fm[1])) return null;
  return name;
}

/**
 * 注入给判官的那段事实。`variant` 只切最后一段——各闸要判的东西不同，但前半段
 * （这是一份关于别人的报告 / 契约禁止代它动手 / 本 agent 对它没有直接通道）是同一个事实，
 * 写一份避免各处漂移。
 *
 * **stop-gate 不用这个函数**，它保留自己那段内联文本：那段经 42 场景 eval 标定过
 * （022b），把它搬过来等于让一批已立住的读数失效，而收益只是消掉一处重复。
 * 本函数服务的是 022b 当时没接进来的那两个闸。
 *
 * **每个 variant 都必须自带反向守卫**：把「本 agent 自己在这份报告上欠的活照常判」钉住。
 * 少了它，这段注入就从"补一个事实"变成"按命令名发的一张通行证"——那是比原误报更坏的方向。
 */
function thirdPartyContext(cmd, variant) {
  if (!cmd) return '';
  const head =
    '**本轮的执行上下文（确定性读数——由 harness 与仓库文件给出，不是 agent 自己说的，也不是你要判的东西）**：' +
    '这一回合跑的是 `' + cmd + '`，该命令的 frontmatter 声明 `analysis-target: third-party`——' +
    '**它的交付物就是一份关于另一个执行体的报告**（另一个 session、另一台机器上的作业、另一个人的队列），' +
    '且该命令的契约**禁止**本 agent 代那个执行体动手；本 agent 对它**没有直接通道**，' +
    '只读边界明写「给那个对象的一切动作都经用户之手」。\n';
  const tail = {
    continuation:
      '所以这条消息里「X 在跑 / 在飞 / 正在做 Y / 下一步会 Z」这类话，**主语默认是被报告的那个对象**，' +
      '它们是本 agent 用只读手段取到的**状态读数**，不是它对自己后续动作的承诺——' +
      '报告别人手上在跑什么**正是**这次委派要它交的东西。运行态探测查不到本 agent 名下的后台任务，' +
      '对这类回合是**预期**结果，不构成"承诺落空"。\n' +
      '  **但这不是整条豁免**：凡有一句是本 agent 承诺**自己**接下来要做什么（"我这就去改""下一轮我补上"），' +
      '那仍照常判——那种话需要一个真在跑的任务兜底。\n\n',
    prose:
      '所以这条消息里成组出现的步骤 / 待办 / 阶段，**默认是写给被报告对象的**，不是摆给用户挑的备选。' +
      '这类命令通常还**强制要求**一个「可直接粘贴给目标的指令草稿」输出槽——草稿里的**先后步骤**是顺序，' +
      '不是并列选项；草稿里按该命令约定用 `【】` 标出并已填好推荐默认值的位置，也已经是"给了推荐"，' +
      '不是把选择权甩回给用户。\n' +
      '  **但这不是整条豁免**：凡本 agent 就**自己**要怎么做摆出两个以上做法、让用户选，' +
      '那仍是该走 AskUserQuestion 的真取舍，照常判。\n\n',
  }[variant];
  if (!tail) throw new Error('unknown thirdPartyContext variant: ' + variant);
  return head + tail;
}

module.exports = { thirdPartyReportCommand, thirdPartyContext };
