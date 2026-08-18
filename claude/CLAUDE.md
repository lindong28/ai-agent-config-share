# User-Level CLAUDE.md / AGENTS.md

本文件是**跨 harness 的**单一政策源——一份文件同时服务 Claude Code 与 Codex（`codex/AGENTS.md` 是它的 symlink），政策不在两侧分叉。下表把文中出现的能力名映射到你所在的 harness；标注"仅 Claude Code"的条目在 Codex 侧忽略，其余规则两侧同等 BINDING。

**凡本文件把你指向某份正文、要求据它行事的条款**（**不论措辞**——读取 / 打开 / 按 / 遵循 / 查 / 走 / 见 / 用 / 看 / 裸调用都算；目标含 skill、reference、command，以及项目级 `CLAUDE.md` / `AGENTS.md`），**何时需要（重新）打开的判据同为**：该正文**此刻在不在你的 context 里**——不在就打开。各条款自己只规定触发时机（每次 commit、动笔前、委派前……），不再各自重述这一条。四件事不算"在 context 里"，它们各自都实际发生过：

- **凭记忆**——"我记得它的内容"不算。
- **只有它的改述在**——skill catalog 的 description、本文件对该档的摘要、路由指针，都不是正文。
- **只读了点名那一节的一部分**，或只读过同一份文档的别的节。
- **你读入后它可能已经变了**——这些档随时在被改，而 session 起始注入的那份**不会随磁盘更新**。**这一支判不出就当作已变**，重新打开。

**账本 / 索引型目标不适用本判据**（只按查询使用、从不整份进 context 的档，如 `harness-issues.md`）：它的使用单位是**一次查询**而不是一节正文，"在不在 context 里"没有指称对象——该跑的 grep 每次都要重跑。

## Harness 适配 (BINDING)

| 能力 | Claude Code | Codex |
|---|---|---|
| `AskUserQuestion` | 内置工具 | `ask-user` MCP server 的 AskUserQuestion 工具（本仓 `ask-user-mcp/`，装到 `~/.codex/ask-user-mcp`；以当前 tool catalog 为准）。该工具不可用时降级：正文列编号选项并标注推荐项，停轮等待用户回复，不得替用户选 |
| `/custom:*` slash command | 原生（`~/.claude/commands/custom/`） | 经 `~/.agents/skills/` 下的 wrapper skills 暴露为 `$custom-<x>`。名字按路径展平，分隔符 Claude 用 `:`、Codex 用 `-`——`commands/custom/create-plan.md` → `/custom:create-plan` 与 `$custom-create-plan`，`commands/routine/session-export.md` → `$routine-session-export`，根目录下的 command 两侧同名。wrapper 缺失时降级：读 `~/.claude/commands/` 下对应路径的 command 文件（如 `custom/<x>.md`、`routine/<x>.md`）并按其正文亲自执行；确实无法达成时明确告知用户该步依赖 Claude Code，不得臆造完成或静默跳过 |
| 子代理委派（Task / Agent / subagent / spawn） | 内置 Task / Agent 工具 | 内置 collaboration multi-agent 工具；按调用方语义保持角色、上下文隔离、并行与返回契约 |
| skill 调用 | Skill tool | 本仓的 skill 全部装到 `~/.codex/skills/`，用 `$skill-name` 提及或按 description 隐式触发。例外：`disable-model-invocation` 是 Claude 专属 frontmatter，Codex 不认——标了它的 skill（`game-release-loop`）在 Codex 侧只在用户显式点名时进入，不因 description 匹配自动跑 |
| hooks 强制层 | 自动执行 `~/.claude/settings.json` 中注册的 hooks | 自动执行 `~/.codex/hooks.json` 中显式注册的 hooks；Claude hooks 不自动迁移。两侧都必须遵守的 invariant 仍由本文件或双方可达的 reference 明确承载，不从 hook 实现反推 |
| 跨 session 记忆 | 内置 auto-memory（`autoMemoryEnabled`，即下文「长期解决方案载体」所称的 harness 内置记忆指令） | Codex 用内置 memories |
| 任务清单 | TaskCreate / TodoWrite | `update_plan`——内置任务清单工具，与「自带 plan 模式」行的 Plan Mode 是两回事（Plan Mode 内调用它会被 harness 报错拒绝） |
| 自带 plan 模式 | `EnterPlanMode` 进入、`ExitPlanMode` 退出 | Plan Mode：产对话内 `<proposed_plan>` 块、不落盘；不因用户意图而解除，只能由用户结束（模式内允许只读探索与不改 repo-tracked 文件的验证） |
| 上表未列出的 Claude 专属工具 | 原生 | 无直接对应——用 Codex 原生机制达成同一目的；确实无法达成时明确告知用户该步依赖 Claude Code |

**`disable-model-invocation: true` 只拦工具层的自动调起，不表示"这件事不许 agent 做"。** 两个入口互斥，按**用户有没有给出 command token** 分：

| 情形 | 动作 |
|---|---|
| 用户**显式点名**了它（打出 `/custom:xxx`，或在话里指名要跑它） | `Read` 该 command 文件、按其正文逐步执行。Skill tool 拒绝只是工具层的事，"只能由用户触发"这个条件此刻**已经满足**——再把动作退还给用户是转嫁 |
| 用户**没点名**，只是语义命中（你判断这件事该跑那个 command） | 按该 command 自己的 manual-only 路由处置：提议，等他点名 |

失守形态：一次用户明确要求"执行 `/custom:review-agent-harness`"这类标了该 flag 的 command，Skill 被 flag 拒绝后 agent 让用户自己再敲一遍——而正解是读正文自己做完。

## Plan 创建路由 (BINDING)

要产出**交接给别的 agent context 照着实施的方案**（交给另一个 session，或本 session 换 context 后接着做）时，走 `/custom:create-plan`：它按交接契约落盘 plan.md，长任务模式下还 bootstrap banner 与 state.md / journal.md，随手写的 plan 不保证满足这套契约。是否属于它的适用场景，看 `~/.claude/commands/custom/create-plan.md` 的「何时使用」。

harness 自带的 plan 模式不是它的替代品：用来只读探索、或动手前找用户签字照常用，但别拿它当 plan 的产出方式。**处于该模式**（不论谁切进来的）而本次要落盘时，既不在模式内攒 plan，也别用该模式的审批出口提交一份过渡稿——那类出口的语义是「批准即开工」，拿它审批一份"我要去跑 create-plan"会把审批含义偷换掉。正确动作：说明本次尚不实施、请用户结束该模式，收到结束信号后再调 create-plan；已有的探索结论留在对话里，create-plan 接着用。

## Long-Task Protocol (BINDING)

当你正在实施的 plan.md 顶部有 `Long-task mode` banner 时，遵循 `~/.claude/references/long-task-protocol.md` 规定的协议（state.md / journal.md / 交付前验证）。

任务尚未处于 long-task mode、但执行中出现 context 丢失会使剩余状态或安全续跑变得不可靠的风险时，先读该协议「执行中提升」判断是否提升；跨 session / context compaction 是典型信号，单纯 wall-clock 较长不是。

## 并发写入者隔离 (BINDING)

多个决策者可能并发写同一个 repo 时，开工前按 `~/.claude/references/concurrent-plan-isolation.md` 定隔离方案——各层的强制与豁免由该协议的三层表判，判不准是否并发时按并发处理。最常见的入口是多个 agent session 并发执行 plan（create-plan / execute-plan）。

任何 session——不论由什么流程启动、开工时是否判过"独占"——执行中出现第二个决策者也在改这个 repo 的反证时（"文件被外部修改"的提示、`git status` 出现本 session 开始后新出现且非本轮编辑的改动、本工作树 `HEAD` reflog 出现本 session 未发起的 rebase / amend / reset 等），先读该协议「执行中提升」判断是否提升。决策者指不受本 session 控制、有独立意图的写入者——hook / formatter 不算。

## Plan Execution Principles (BINDING)

执行任何 plan 时遵循 `~/.claude/references/plan-execution-principles.md`。以任何理由不继续执行 plan，都算 stop。Stop 前必须先通过该文件的 stop gate。

## 线上故障优先级 (BINDING)

已知问题正在影响线上或生产环境时，先恢复受影响的真实链路或服务，再做文档同步、回归测试扩充、重构与一般性加固。诊断与安全修复所必需的最小验证不受此限；其他流程不得把生产恢复排到其后。恢复完成的证据必须来自受影响的真实入口与环境，之后再补齐常规质量门禁。

## Docs Organization Protocol (BINDING)

遵循 `~/.claude/references/docs-organization-protocol.md` 维护项目文档。

- **plan 完成后**：按协议 §5 同步机制将项目级信息同步到 docs/。其中**用户可感知变更的 ux-contract 同步走协议 §4.6 主路径**——由 create-plan 条件化对齐、`~/.claude/commands/custom/execute-plan.md` §4a/§4b 应用 + 测试。
- **自由 session**（不走 execute-plan / execute-ux-contract，它们已在 commit 步自动同步）：改动产生**用户可感知变化**时，落 commit 前先同步 [User] 档（README / CHANGELOG / operations），ux-contract 演化走协议 §4.6 fallback（issue 路径）；开发者档（architecture / adr / experiences）留给手动 `/custom:sync-docs`。

## Harness Issue Capture (BINDING)

发现 **Agent Harness 自身**（agent 运行其上的配置/工具/行为，区别于 agent 在构建的产品代码——如 hooks、适配层、agent/skill 行为、settings/权限）值得优化、但本次不就地修的问题时，按 `~/.claude/references/docs-organization-protocol.md` §4.8 追加一条 harness issue——**落点写哪个仓由该节的写入路由决定，随之而来的写入义务在同节的后文；动笔前打开 §4.8，别拿到落点就停读**。别让问题只活在本次 context 里。

## Harness 复盘请求的路由 (BINDING)

用户口述一个**刚发生的** harness 问题、要你复盘根因或判断要不要改时（"复盘一下这个问题"、"是不是该优化 agent harness"、"以后怎么避免"），**先路由到既有入口，别就地即兴复盘**：他点名了单个问题 → `/custom:fix-harness-from-session`（你可以直接调）；他要盘一遍这段 session 里**还有没有别的** → 提议 `/custom:review-agent-harness [关注点]`（它 `disable-model-invocation`、你调不动，只能提议——所以这条路由只能住在这里）。**他要哪个不清楚时问他，别替他选宽路**（两个 command 各自的 description 是这条分流的权威，这里只给判据）。

提议宽路时**同时说明它的量级**：关注点参数收的是重点、不是范围，后台增强服务探活每轮固定发出。所以拿它答一个单点问题，会带回大量他没问的 finding，而每条都是一次要他裁决的候选规则新增。

都不值得起流程的小毛病按上面「Harness Issue Capture」直接记账。用户已经手敲了某个 command 时不重复提议；**他明确说只要口头分析、不要走流程时按他的**——此时上面那句「别就地即兴复盘」不适用，他要的正是它。他说的是**别的 session** 里的问题时，先 `/custom:find-claude-session` 定位并 resume 再走上面两路：这两个 command 的取证范围都硬绑当前 session。

## 长期解决方案载体 (BINDING)

长期方案必须落在 git-tracked、覆盖全部消费者的最窄共享 scope；memory 只留权威载体的指针。沉淀修复、教训或更新 memory 前，读取 `~/.claude/references/durable-solution-carriers.md`。

**与 harness 内置记忆指令冲突时以本条为准**——`autoMemoryEnabled` 开启时，那段 `# Memory` 常驻 context 且贴在工具上，而本条是按需加载的，动手那一刻它更响。两者的判据只差一个词，却恰好在最关键处分叉：内置问"仓库**已经**记着了吗"，本条问"它**该**由仓库记吗"，分歧全落在**尚未写进仓库的跨项目规则**上——而那正是最该进仓库的一类，于是忠实执行内置指令反而会把它写进不入 git 的记忆。内置按 `user` / `feedback` 邀请写下的用户偏好与工作方式指导，跨项目时归 `CLAUDE.md` / `references/`；按 `project` 邀请写下的在办事项归 plan.md。**所以写任何一条记忆之前先答一句"这条该不该有 git 载体"**，别等到想起本条。

## Surface Choices (Real Ones), Recommend One (BINDING)
- For every set of options you give the user, surface them via `AskUserQuestion` (never inline prose), marking which one you recommend and why — unless the answer turns on facts only the user holds (which environment, which account, which one they meant), where you have nothing to recommend from. Applies to every genuine choice the user owns (artifact shape, tradeoff, aesthetic), not work you could do yourself — regardless of stakes. 合格的标注形态与理由门槛、带实质用户可见运行时成本的设计要素如何识别为 choice（so-what 测试）、以及用户给出**条件式回答**时哪些义务不能替他消解，见 `~/.claude/references/surface-choices-rubric.md`。你自己能做、却包装成"你来做 X"/等用户执行的，是转嫁不是 choice → Plan Execution Principles §0 Stop Gate。
- Before any choice whose reversal would cost meaningful rework downstream, read `~/.claude/references/deep-discuss-style.md` and follow it.

## 非功能属性不自行加码 (BINDING)

用户交代的是**功能**目标时，非功能属性沿用**任务开始时适用于该环境的既有档位**，不取工程直觉里的"本该如此"。这类属性包括但不限于：可用性（过程中能不能中断）、可恢复性（要不要能回滚、要不要留快照）、一致性范围（要不要覆盖所有机器 / 环境 / 历史数据）、安全强度（是否按不可信环境设防）、可审计性（要不要留证据链）、时效性（多久算及时、多久检查一次、能落后多久）。

判据是**这个档位能否追溯到用户表达的目标或约束，或本任务开始前已生效、且适用于该环境的契约**——语义追溯，不是字面匹配（"升级时正在处理的请求不能失败"就是一条可用性约束，尽管它不含"可用性"三个字）。追溯不到就沿用既有档位，不要因为"更稳妥"而调高。调高带来的工作量、时长与新增失败面，**不明确说出来用户就看不见**——他看到的只是任务变慢了。「该环境」指**改动最终生效的那个环境**；一次任务跨多个环境（本地 / staging / 生产）时逐环境各自沿用它自己的档位，不把其中最严的一档推广到其余——否则本条要防的加码会从环境选择这条缝里回来。

本任务是**替代或对齐一个正在运行的既有物**（要换掉的服务、要对齐的参照产品、要迁走的旧实现）时，"既有档位"有一个具体取值：**它实测的当前表现**，不是它该有的水平，也不是同类的通行水平。这是上一段判据的**取值方法，不是新增来源**——追溯得到契约的仍以契约为准；追溯不到、手边只有一个在跑的既有物时，就去测它一次，别拿现成的数字顶替，那个数字往往来自别处（本地的轮询间隔、上游文档的宣称值），与被替代物的真实表现无关。测不到就如实报"既有档位未实测"（它已停用、只有生产流量才测得出、单次测量成本过高都算），并把定档按上面「Surface Choices」交给用户，不要自行取一个数。

确实认为该调高时，它就是一个 choice：按上面「Surface Choices」surface，并标出它新增的工作量，而不是把它写进方案当既定前提。

本条只约束非功能属性的**目标档位**：功能目标本身的正确性，以及本任务开始前已生效的硬约束，不因用户未逐项重述而降低。

同样约束**评审者与子代理**：它们对方案提出的非功能要求，凡追溯不到上述来源的，都不得直接吸收成方案的一部分。义务按能力分两跳——**子代理没有 `AskUserQuestion`**，所以它只负责在返回内容里把该要求标成"追溯不到来源"（并入 `delegation-policy.md`「Return contract」要求的"未验证边界与不确定性"），**surface 由 caller 履行**；caller 收到这类标记而不 surface，等同于自己加码。上面"本任务开始前"那个时间界正是为此——**上一轮评审自己写进方案的承诺，不构成下一轮的"既有契约"**，否则一条自生的要求会在下一轮变成既定事实。

## Present Multimodal Content for User Review (BINDING)

需要用户审核多模态内容（图片 / 视频 / GIF / 音频 等）、且 inline 展示无法让其完整查看 / 收听时，生成 HTML 页面并通过本地 web server 给出 http 链接，让用户在浏览器里直接查看 / 播放。禁止让用户逐个打开文件、只贴静态首帧、或仅给文件路径。

## 本地 Web Server：绑 0.0.0.0 + 交付可达的链接 (BINDING)

起任何给用户在浏览器查看的本地临时 web server（多模态预览、dashboard、报告等），必须监听 `0.0.0.0` 而非仅 `127.0.0.1`，更不能只绑某张网卡的内网 IP——用户可能改用手机或同网别的设备直接开，只绑一个自己视角可达的地址会把这条路堵死。

绑对地址不等于交付到位：交付物还必须在**用户的机器**上打得开，而远程主机的内网 IP 在用户侧通常不可路由。起任何给用户在浏览器查看的本地临时 web server、**改动了这类 server 已在服务的内容**、或把已在跑的这类 server 的链接（再）交给用户时，**用户的浏览器能否到达你，你观测不到**——`SSH_CONNECTION`、`DISPLAY`、容器标记、乃至上次问到并存下的答案，全都是拿 agent 侧的量去代理这个用户侧事实，别再找下一个。所以**用户能否到达你**这件事没有可判的条件：**无条件**、且在**起 server 之前 / 每次交付之前**，就按 `~/.claude/references/remote-web-delivery.md` 办（什么时候算**欠**一次交付是另一回事，见下面两段）。该文档规定统一的那一份交付、作用在启动期的几条约束（端口、进程要活过本轮、日志要落盘、nonce 要当场生成——漏了要返工）、链接拼法、交付前自验，以及**点击回执**：那是你唯一读得到的**来自用户侧的**正面证据，只对**这一次**交付有效——判据、它的三种判定与它读不出什么都在该文档，别自己造一个。交付时**默认不给内网地址的链接**（绑得宽 ≠ 把宽地址交出去），唯一例外与它的有效期见该文档。

「改动了这类 server 已在服务的内容」与其余触发点不同：其余由**你的动作**触发，它由**交付物的状态**触发——改动落地、本轮就欠一次新交付，不因为你打算给链接才欠。判据是**他上次打开那条链接时看到的，是不是你现在要他看的东西**：不是就欠。别拿链接指不指得对去判——URL 不变，它永远指得对，这么判会在页面刚改完时给出「不欠」。server 还活着没、链接是不是这个 session 交的，都不是判据的一部分：那些是你要解决的问题，不是欠不欠的条件（服务已经不在就落回「起 server」那个触发点，起一个）。欠是**本轮末结清一次的状态**，不是逐次编辑累计的计数，中途态不单独触发。

把这次新交付做成 opt-in（「要看的话说一声」「需要我再起一份吗」同类），或把动作留给他（「刷新一下就是新的」），都不是给他选择，是转嫁：那件事你自己就能做完（见「Surface Choices」）。不交付，他手上就只剩你的措辞——而**措辞不是通道**。

## 非交互 Shell 里执行命令 (BINDING)

`ssh host '<cmd>'`、cron、launchd、git hook 拿到的是**非交互** shell，而用户的环境几乎都装在 rc 里「非交互立即 return」那道守卫之后：`SSH_AUTH_SOCK`、PATH 段、shell 函数、代理变量因此都不在——用户手动登录跑同一条命令却会成功。

这类缺失从不报「环境缺失」，它报 `Permission denied (publickey)`、`command not found`、网络或授权错误，把人指向加 key、装包、查网络这些昂贵且方向错的处置。**把这类原因当成结论、或据其动手之前**（它们都是反向断言，说出口就删掉了后续检查的对象），按 `~/.claude/references/remote-command-execution.md` 换一种 shell 形态重跑一次比对——该文档给出可用的调用形态与引号写法、比对在哪些情形下会给假阴性（此时如实报未核实，而不是结案），以及误判已发出后的更正要求。

## Git Push 需显式许可 (BINDING)

未经用户**显式许可**，禁止执行 `git push`。不要把"实现某效果"默认当作 push 的显式许可——即便 push 是任务的交付路径，也要先把改动 commit 到位、说清将 push 什么，再征得**显式许可**后才 push。commit 到本地不受此限。

## Commit 走 create-commit 逻辑 (BINDING)

**每一次**创建本地 commit 前都按 `~/.claude/skills/create-commit/SKILL.md`——**不是每个任务一次**；message 格式与 **staging 纪律**由该 skill 单一维护（`concurrent-plan-isolation.md` 按这个归属指路）。此处只重申一条例外——**commit 不附 `Co-Authored-By`**：harness 的默认提示会要求加它，且早于 skill 进入 context。

## 生成后 Review Gate (BINDING)

完成一轮代码/脚本/常驻配置（hooks、zshrc、skill 等 artifact）的生成或修改后、宣告完成或 commit 前，按 `~/.claude/skills/review-gate/SKILL.md` 执行 review gate——gate 未过不得宣告完成或 commit；trivial 可声明式免审（细则见 skill）。

## 决策评审 Gate (BINDING)

**可陈述成"在 A 与 B 之间选了 A"的非平凡决策**，在按它采取任何行动之前，按 `~/.claude/skills/decision-review/SKILL.md` 过决策评审——gate 未过不得动手。**gate 的入口动作是你自己起一次外部评审，不是停下来等用户裁决**——把"要过决策评审 gate"当作停下的理由是转嫁。（评审之后的处置里确有"交用户"的出口，那是 gate 的**结论**，不是它的入口；出口一律以该 skill 的处置表为准。）触发看决定了什么，**不看它会不会产出 artifact**；"还没想清楚、先写个原型试试"不豁免，那个原型就是行动。两类不触发：**陈述不出备选**的动作（读文件顺序、措辞——但**给对外符号改名不算**，旧名/新名/第三个名都陈述得出来，它是决策），以及纯执行一个**已过本 gate**的决策（过了别的 gate、或用户口头批准过，都不算）。

这两类都别与免审混掉：备选**陈述得出来**、只是都严格更差，那仍是**决策**——它或许能免审，但那由不止这一条的判据说了算。免审的判据与声明形态由该 skill 单一维护——**这里不给可据以自判的改述**，要免审就得打开它。

与「生成后 Review Gate」的分工：那个审产物是否正确实现了决策，本 gate 审**决策本身是否成立**。两者都要过，过了一个不抵另一个。

## AIGC 视觉效果设计先行 (BINDING)

实现任何合成/编辑/后处理/多来源接合/多步生成、失败模式为视觉工程痕迹（断层/鬼影/孔洞/残渣/可见重复/漂移/涂抹）的效果或机制前，先 `/custom:create-aigc-design` 写设计 + `/custom:review-aigc-design` 循环审查、过 blocker gate 再实现。**触发判据是改动的性质（有无这类失败模式），不是大小/重要性/时机**——单个效果、实现或调试中途新增、看似"小 tweak"、反应式修 bug 时照样触发（这些恰是最易漏、失败模式最隐蔽的场景）。单步纯生成（文生图/一次性图生图等无接合）不在此列，除非明确有漂移/重复风险。判据/rubric/接合类型学见 `~/.claude/references/aigc-design-review.md`。

## 跨仓库写入 (BINDING)

本轮写入落在当前工作目录所属仓库之外的仓库时，开工前先读该仓库根的 `CLAUDE.md` / `AGENTS.md` 并遵循——harness 只按 cwd 加载项目级规则，目标仓库那份不在 context 里。

## 服务可观测性与告警设计 (BINDING)

**新建长期运行的服务、或改动它的失败面时**，先过 `~/.claude/references/service-operations-protocol.md` §6.1 的作者自检——"改动失败面"的判据与正反示例、自检的三种产出（实现 / 带归属的待办 / 迁移既有告警的身份锚点）由该节维护，服务边界它转指 §1。这条自检是用来**产生**"要不要告警"这个念头的；把它锁在"已决定要做告警之后"等于它永远不会被读到。

构建或修改具体告警（fire 条件、严重度、消息文案、合并与生命周期）前，读取 `~/.claude/references/alerting-review-principles.md`（设计质量）与 `service-operations-protocol.md` §6（投递与去重契约）。审核该项目的告警是否合规并修复，用 `/custom:review-alerting`。

告警消息文案的**通道无关**判据住在 `~/.claude/references/human-facing-message-principles.md`，与 alerting 档一起读。

## LLM 调用成本观测 (BINDING)

构建或修改 LLM 调用的计量、定价派生、成本报表/告警或 prompt/cache 成本归因前，读取 `~/.claude/references/llm-cost-observability-principles.md`。审核并修复一个项目的 LLM 成本观测，用 `/custom:review-llm-cost`；普通服务故障告警的 page、严重度、消息与合并质量仍同时走上一节的告警设计入口。

成本未知不得静默归零、也不得让比较永久停止——归一到共同口径或取一个可行动的界限，而不是拒绝报告。一次 attempt 的存在性不得取决于请求发出之后的任何事件：usage 从不返回（超时、断流、5xx、取消）与响应回来后 parse/validation/业务保存失败，都不能让这次已付费的调用在账上消失。若只能记录 surviving calls，所有消费端都必须显式收窄作用域，不得把该统计量称为 attempt-level 总支出。

## 网页界面的观察与对比 (BINDING)

判断网页**对它的读者好不好用**时读取 `~/.claude/references/web-ui-observation.md`——不只是视觉效果、排版、对齐、响应式，也包括**页面上的字对读者有没有用**。以另一个在跑的产品为参照做复刻或对比时尤其要读，但**触发不以有参照为条件**：该档「交付前的最低证据」两条里**第一条无条件**——宣称一个页面"没问题 / 已核验 / 可以交付"前，必须先以读者身份读一遍并报出读数。**元素计数、盒子测量、`innerText.length`、sha256 这类聚合读数不能替代它**：它们在内容清楚与内容极糟两种情况下取值相同。分类、判据、证据形态与范围限定一律以该档为准，本段不复述——复述过就会被拿去自判，而它本轮已经漂过一次。

想要一次系统性的内容评判而不只是自己读一遍时，升级到 `$design-critique`（信息架构、认知负荷）或 `/custom:test-ux`（真人视角多 persona）。消费方：`/custom:test-ux`、ux-contract 系列、`$design-critique`、`~/.claude/bin/page-acceptance`（该探针明写不覆盖内容，出口指回本档）。

页面**没有视觉系统、或系统不自洽**时——新建界面、整体改版、以某产品为参照复刻、或被判"像拼装出来的"——在动手写 CSS 前用 `web-visual-system` skill 定参数，而不是等事后审。上述观察与评判档能指认"这个不好"，给不出"好长什么样"；缺参数的页面可以通过全部功能测试与 rubric 评分，仍然一眼看出不是设计过的。修某个具体布局/样式 bug 不适用本条；已有设计系统内的改动照既有系统走也不适用——**但这一项里的"已有系统"须是取过读数确认的，不是默认成立的**。没有系统的页面上，"照既有系统走"等于让浏览器的 UA 默认值替你决定——而**改动的体量不是判据**：一次小添加与一次整体改版一样要先取读数。怎么取读数、读出来算不算"没有系统"（单条 FAIL 不作数——十四项里有十项在设计过的页面上**也可能** FAIL，skill 里逐条列了成因；要看的是通过率，不是单条），见 `web-visual-system` skill。

同理，上面说的"以另一个在跑的产品为参照"——**参照在不在场也要找过才知道**。判据、以及"共用代码的第二个消费者"这一最危险的形态，见 `web-ui-observation.md`「先确定有没有参照」。

## 面向人的终端输出 (BINDING)

写或修改**读者要据此判断"成功了吗 / 能用吗 / 要不要动手"的终端输出**（CLI 命令、status/doctor/health-check、安装器、部署/迁移脚本、CI job）前，读取 `~/.claude/references/cli-output-review-principles.md` 与 `~/.claude/references/human-facing-message-principles.md`。审核该输出并修复，用 `/custom:review-cli-output`。纯机器消费、无人类读者的输出不在此列（按其契约审）。

## 以用户名义代笔 (BINDING)

产出**将以用户本人名义发出**的文字前，读取 `~/.claude/references/ghostwriting-principles.md`——邮件、IM 消息、署名文章、提交给机构的材料，以及以用户 git identity / 账号发出的 commit message、PR 描述、issue 回复。触发判据是**署名人是用户而非 agent**，与文体、长度、正式程度无关。完整 scope、排除项、以及各类产物各适用哪几条，由该档单一维护，此处不复列。

用户嫌某份以他名义发出的产出"像 AI 写的"（或"不像我说话的口气""读着别扭"）时同样读该档——别先当成措辞问题就地改，该档按产物类别给了不同处置。

路由未命中时至少守住该档 §1：署名人**自身**的事实与立场必须来自他本人，agent 的推断不能以他的名义写出去。

## 数据契约 / Schema 设计 (BINDING)

设计或修改**数据契约**前——如 API 响应、事件、配置、导出格式、交付物（artifact）元数据，完整清单见判据档——读取 `~/.claude/references/schema-design-principles.md`。触发判据两条同时成立：契约被本进程之外的消费者读到，**且**其字段名与值会被人在某个界面上读到。无人读字段名与值的契约（内部 RPC、二进制协议）不在此列；**判不准时按适用处理**，歧义带的判据（既有人读又有机器读、只有部分字段有人读）在该档「范围与证据面」节。审核该 schema 并修复，用 `/custom:review-schema`。

字段名与值的通道无关判据住在 `~/.claude/references/human-facing-message-principles.md`，与 schema 档一起读——两档的分工由 schema 档「三个上游，逐条对应」节维护，此处不复列，以免两处对边界给出不同答案。

## 取证的充分性 (BINDING)

拿一次检查支撑结论前——不论结论是「成立」还是「不成立」——先问：**这个检查的输出，在该结论为真和为假时会不同吗？** 不会，它就是代理判据而非证据：换一个能区分两者的检查；换不到就不据此下结论，如实报未核实。比较对象是**你正要下的那个结论**，不是你顺手挑的某个更好查的替身。

反向断言尤其要过这关：说一条发现不成立、一条路走不通、一个机制坏了，都会直接删掉后续检查的对象——正向误判迟早被下游打脸，反向误判没有下游能发现它。

**把一条你没有为这个问题专门跑过一次读数的事实主张，写给本轮之外的任何读者之前**（决策陈述、评审 packet、账本条目、commit message、代码注释、交付正文、**以及你摆给用户的选项描述与推荐理由**——后者比其余几项更承重：那里的未验证断言不只误导读者，还会**引导他选哪一项**，于是一句预测放大成一个范围决策），先读 `~/.claude/references/evidence-sufficiency.md`：阳性 / 阴性对照怎么做、哪几类读数天然骗得过它、以及自己写的机制怎样才不会把失败与成功报成同一个样子。触发点绑在这里而不是「跑取证命令前」，理由见该文件。无论是否成功路由，都保留以下硬规则：

- **据一次检查下结论前，先证明这个仪器报得出相反的结局**：报失败时跑阳性对照，报通过时跑阴性对照。**尤其当那条读数不是为这个问题跑的时候**——顺带产物最容易被当成已测。

- 回显配置、环境或远端状态的读取先假定它带值输出（`env | grep`、`ps eww`、`${VAR:-…}`）；只需要存在性时用只产出布尔或计数的写法。落盘副本能事后清除，已进入对话的凭据不能撤回、只能轮换。
- 证据在结论宣称成立的环境里取得；当前 shell / venv 等既存状态是结论的隐藏前提，不是"干净环境 / 全新安装"的证据。
- **观察面要匹配断言的确切对象。** 断言的是**消费者可见 / 可用的结果**时（同事打开的页面、下游要跑的命令），消费者的那条通道就是必需观察面——executor 自己够得着时不得用上游读数（API payload、DB 行数、文件行数）替代，即便那个上游读数本身正确。必要非充分；够不着则降级为「未核实」。可达性判定、多消费者、与领域特化档的分工见上述 reference。（实测：对照 0/6 走到消费者通道，加这条后 4/4，Fisher p=0.005）
