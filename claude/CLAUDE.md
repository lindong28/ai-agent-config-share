# User-Level CLAUDE.md / AGENTS.md

本文件是**跨 harness 的**单一政策源——一份文件同时服务 Claude Code 与 Codex（`codex/AGENTS.md` 是它的 symlink），政策不在两侧分叉。下表把文中出现的能力名映射到你所在的 harness；标注"仅 Claude Code"的条目在 Codex 侧忽略，其余规则两侧同等 BINDING。

## Harness 适配 (BINDING)

| 能力 | Claude Code | Codex |
|---|---|---|
| `AskUserQuestion` | 内置工具 | `ask-user` MCP server 的 AskUserQuestion 工具（本仓 `ask-user-mcp/`，装到 `~/.codex/ask-user-mcp`；以当前 tool catalog 为准）。该工具不可用时降级：正文列编号选项并标注推荐项，停轮等待用户回复，不得替用户选 |
| `/custom:*` slash command | 原生（`~/.claude/commands/custom/`） | **无对应入口**——本仓不给 Codex 安装 command wrapper。文中出现 `/custom:<x>` 的强制路由，在 Codex 侧的处置是：读 `~/.claude/commands/custom/<x>.md` 这份文件并按它描述的流程亲自执行；确实无法达成时明确告知用户该步依赖 Claude Code，不得臆造完成或静默跳过 |
| 子代理委派（Task / Agent / subagent / spawn） | 内置 Task / Agent 工具 | 内置 collaboration multi-agent 工具；按调用方语义保持角色、上下文隔离、并行与返回契约 |
| skill 调用 | Skill tool | 本仓的 skill 全部装到 `~/.codex/skills/`，用 `$skill-name` 提及或按 description 隐式触发。例外：`disable-model-invocation` 是 Claude 专属 frontmatter，Codex 不认——标了它的 skill（`game-release-loop`）在 Codex 侧只在用户显式点名时进入，不因 description 匹配自动跑 |
| hooks 强制层 | 自动执行（`~/.claude/hooks/` + settings.json 接线） | 仅 Claude Code；Codex 忽略 hook mechanics。两侧都必须遵守的 invariant 由本文件或双方可达的 reference 明确承载，不从 hook 实现反推 |
| 任务清单 | TaskCreate / TodoWrite | `update_plan`——内置任务清单工具，与「自带 plan 模式」行的 Plan Mode 是两回事（Plan Mode 内调用它会被 harness 报错拒绝） |
| 自带 plan 模式 | `EnterPlanMode` 进入、`ExitPlanMode` 退出 | Plan Mode：产对话内 `<proposed_plan>` 块、不落盘；不因用户意图而解除，只能由用户结束（模式内允许只读探索与不改 repo-tracked 文件的验证） |
| 上表未列出的 Claude 专属工具 | 原生 | 无直接对应——用 Codex 原生机制达成同一目的；确实无法达成时明确告知用户该步依赖 Claude Code |

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

发现 **Agent Harness 自身**（agent 运行其上的配置/工具/行为，区别于 agent 在构建的产品代码——如 hooks、适配层、agent/skill 行为、settings/权限）值得优化、但本次不就地修的问题时，按 `~/.claude/references/docs-organization-protocol.md` §4.8 追加到 `docs/issues/harness-issues.md`——写哪个仓由该节「harness-issues.md 的写入路由」定。别让问题只活在本次 context 里。

## Surface Choices (Real Ones), Recommend One (BINDING)
- For every set of options you give the user, surface them via `AskUserQuestion` (never inline prose), marking which one you recommend and why — unless the answer turns on facts only the user holds (which environment, which account, which one they meant), where you have nothing to recommend from. Applies to every genuine choice the user owns (artifact shape, tradeoff, aesthetic), not work you could do yourself — regardless of stakes. 合格的标注形态与理由门槛、以及用户给出**条件式回答**时哪些义务不能替他消解，见 `~/.claude/references/surface-choices-rubric.md`。你自己能做、却包装成"你来做 X"/等用户执行的，是转嫁不是 choice → Plan Execution Principles §0 Stop Gate。
- Before any choice whose reversal would cost meaningful rework downstream, read `~/.claude/references/deep-discuss-style.md` and follow it.

## Present Multimodal Content for User Review (BINDING)

需要用户审核多模态内容（图片 / 视频 / GIF / 音频 等）、且 inline 展示无法让其完整查看 / 收听时，生成 HTML 页面并通过本地 web server 给出 http 链接，让用户在浏览器里直接查看 / 播放。禁止让用户逐个打开文件、只贴静态首帧、或仅给文件路径。

## 非交互 Shell 里执行命令 (BINDING)

`ssh host '<cmd>'`、cron、launchd、git hook 拿到的是**非交互** shell，而用户的环境几乎都装在 rc 里「非交互立即 return」那道守卫之后：`SSH_AUTH_SOCK`、PATH 段、shell 函数、代理变量因此都不在——用户手动登录跑同一条命令却会成功。

这类缺失从不报「环境缺失」，它报 `Permission denied (publickey)`、`command not found`、网络或授权错误，把人指向加 key、装包、查网络这些昂贵且方向错的处置。**把这类原因当成结论、或据其动手之前**（它们都是反向断言，说出口就删掉了后续检查的对象），按 `~/.claude/references/remote-command-execution.md` 换一种 shell 形态重跑一次比对——该文档给出可用的调用形态与引号写法、比对在哪些情形下会给假阴性（此时如实报未核实，而不是结案），以及误判已发出后的更正要求。

## 生成后 Review Gate (BINDING)

完成一轮代码/脚本/常驻配置（hooks、zshrc、skill 等 artifact）的生成或修改后、宣告完成或 commit 前，按 `~/.claude/skills/review-gate/SKILL.md` 执行 review gate——gate 未过不得宣告完成或 commit；trivial 可声明式免审（细则见 skill）。

## 决策评审 Gate (BINDING)

**可陈述成"在 A 与 B 之间选了 A"的非平凡决策**，在按它采取任何行动之前，按 `~/.claude/skills/decision-review/SKILL.md` 过决策评审——gate 未过不得动手。触发看决定了什么，**不看它会不会产出 artifact**；"还没想清楚、先写个原型试试"不豁免，那个原型就是行动。两类不触发：**陈述不出备选**的动作（读文件顺序、措辞——但**给对外符号改名不算**，旧名/新名/第三个名都陈述得出来，它是决策），以及纯执行一个**已过本 gate**的决策（过了别的 gate、或用户口头批准过，都不算）。

这两类都别与免审混掉：备选**陈述得出来**、只是都严格更差，那仍是**决策**——它或许能免审，但那由不止这一条的判据说了算。免审的判据与声明形态由该 skill 单一维护——**这里不给可据以自判的改述**，要免审就得打开它。

与「生成后 Review Gate」的分工：那个审产物是否正确实现了决策，本 gate 审**决策本身是否成立**。两者都要过，过了一个不抵另一个。

## AIGC 视觉效果设计先行 (BINDING)

实现任何合成/编辑/后处理/多来源接合/多步生成、失败模式为视觉工程痕迹（断层/鬼影/孔洞/残渣/可见重复/漂移/涂抹）的效果或机制前，先 `/custom:create-aigc-design` 写设计 + `/custom:review-aigc-design` 循环审查、过 blocker gate 再实现。**触发判据是改动的性质（有无这类失败模式），不是大小/重要性/时机**——单个效果、实现或调试中途新增、看似"小 tweak"、反应式修 bug 时照样触发（这些恰是最易漏、失败模式最隐蔽的场景）。单步纯生成（文生图/一次性图生图等无接合）不在此列，除非明确有漂移/重复风险。判据/rubric/接合类型学见 `~/.claude/references/aigc-design-review.md`。

## 跨仓库写入 (BINDING)

本轮写入落在当前工作目录所属仓库之外的仓库时，开工前先读该仓库根的 `CLAUDE.md` / `AGENTS.md` 并遵循——harness 只按 cwd 加载项目级规则，目标仓库那份不在 context 里。

## 网页界面的观察与对比 (BINDING)

判断网页的视觉效果、排版、对齐或响应式是否达标——尤其**以另一个在跑的产品为参照做复刻或对比**时——读取 `~/.claude/references/web-ui-observation.md`。它规定：观察必须覆盖「值 / 关系 / 结构」三层（只查值层会让用户第一眼就看到的对齐与留白问题全部漏过）、字形盒 vs 元素盒的测量差异、缩放轴取点密度，以及有参照时的**同条件成对测量**与**反向完备性**（参照里有而抄录清单漏掉的规则，在所有基于该清单的检查里都不可见）。

宣称"视觉/体验已对齐"前，必须至少完整做一次用户会做的那个对比（两边同开、同一缩放档逐屏看过、对点名元素做关系测量）——逐值审计、行为测试、截图矩阵、rubric 判定都不能替代它。消费方：`/custom:test-ux`、ux-contract 系列、`design-critique` skill。

页面**没有视觉系统、或系统不自洽**时——新建界面、整体改版、以某产品为参照复刻、或被判"像拼装出来的"——在动手写 CSS 前用 `web-visual-system` skill 定参数，而不是等事后审。上述观察与评判档能指认"这个不好"，给不出"好长什么样"；缺参数的页面可以通过全部功能测试与 rubric 评分，仍然一眼看出不是设计过的。已有设计系统内的改动、以及修某个具体布局/样式 bug，照既有系统走，不适用本条。

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

跑取证命令前先读 `~/.claude/references/evidence-sufficiency.md`：阳性 / 阴性对照怎么做、哪几类读数天然骗得过它、以及自己写的机制怎样才不会把失败与成功报成同一个样子。无论是否成功路由，都保留以下硬规则：

- 回显配置、环境或远端状态的读取先假定它带值输出（`env | grep`、`ps eww`、`${VAR:-…}`）；只需要存在性时用只产出布尔或计数的写法。落盘副本能事后清除，已进入对话的凭据不能撤回、只能轮换。
- 证据在结论宣称成立的环境里取得；当前 shell / venv 等既存状态是结论的隐藏前提，不是"干净环境 / 全新安装"的证据。
