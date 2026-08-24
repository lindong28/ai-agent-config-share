# 这个仓收什么、不收什么

本仓是维护者私有配置仓（下称**上游**）的精选公开子集。哪些内容会被同步过来、哪些刻意停在早期版本，由本文件定；`/routine:sync-from-upstream` 每次同步前先整份读它。

## 两类读者，两种收录方式

| 读者 | 他要什么 | 本仓给什么 |
|---|---|---|
| **用 harness 开发产品的人**（绝大多数） | 一套装上就能用于日常开发的 agent harness | **跟进上游最新** |
| **自己造 harness 的人** | 看别人怎么开发和迭代一套 agent harness | **只给框架样本、冻结不跟进** |

## 判据：它是 harness 的**零件**，还是**改造 harness 的工具**

| 问 | 归属 |
|---|---|
| 这份东西装上之后，是 harness 跑起来的一部分吗？（hook、工作流命令、skill、它们消费的 reference、安装与验证脚本、可观测性、探针） | **消费者向**，跟进最新 |
| 这份东西是用来**改造 harness 本身**的吗？（审查 / 复盘 / 评测 harness artifact 与 session 行为的命令，它们依据的 meta-原则，判官闸的调优场景集，harness 的决策与踩坑记录） | **框架层**，只留冻结样本 |
| 两边都说得通 | `AskUserQuestion`，不自行归类 |

**不要用"它的作用对象是不是产品"当判据**——那会判反：`stop-gate.js` 约束的是 agent 自己的收尾发言、不是任何产品代码，但它是 harness 的零件，属消费者向。同理 `writer-registry-gate`、`commit-discipline-gate` 全是这一类。零件不因为"它管的是 agent 行为"就变成框架层。

三个已实测的判例，照着套：

| 文件 | 归属 | 为什么 |
|---|---|---|
| `claude/hooks/stop-gate.js` | 消费者向 | 装上就在每个回合跑，是 harness 的零件 |
| `claude/commands/custom/review-schema.md` | 消费者向 | 它审的是消费者产品的数据契约 |
| `claude/commands/custom/review-skill.md` | 框架层 | 它是用来改 harness 自己的指令 artifact 的工具 |

## 框架层：本仓收录的样本

这些文件**此后不跟进上游最新**（个别条目本轮刚以上游当前版纳入，那一版就是它冻结的起点）。它们展示机制，不代表维护者当前的迭代水平：

| 路径 | 展示的是什么 |
|---|---|
| `claude/commands/custom/review-agent-harness.md` | 拿一整段 session 的运行时证据复盘 harness、并把发现路由到三种处置 |
| `claude/commands/custom/fix-harness-from-session.md` | 单个 harness 问题从"用户口述"到 source-level 修复的定位路径 |
| `claude/commands/custom/review-skill.md` / `review-claude-md.md` / `review-agent-rules.md` / `review-session-skills.md` | 指令 artifact（skill / command / CLAUDE.md / 规则栈）自身怎么被审 |
| `claude/commands/custom/absorb-skill.md` / `create-skill-from-workflow.md` / `review-memory.md` | 怎么把外部 skill 吸收进来、把跑过的工作流提炼成 skill、审自己的跨 session 记忆 |
| `claude/references/skill-review-principles.md` | 审 skill 的原则集——本仓收 7 条，上游更多 |
| `claude/references/judge-gate-authoring.md` | 判官闸的 rubric 怎么写 |

`docs/adr/` 单列，因为它的收录判据是**逐条**的：只收决策所涉组件在本仓实际存在的那些（当前 19 条，见 [adr/README.md](adr/README.md)）。已收录条目不因上游修订而更新；上游新写的 ADR 按下面「同步时怎么用本文件」的新增分支处理。

## 明确不收的

- **判官闸的 eval 场景集**（上游的 `hooks/eval/<gate>/`）——正反例场景是打磨判官的过程产物，一条条都带着实测判别力读数。本仓收判官闸本体，不收它们的调优面。
- **harness 开发过程记录**——上游在自己那个仓上踩坑的 experiences、meta-原则的 meta-原则、审 harness 判定逻辑的专项判据。
- **按本政策不收录的功能，其全部配套**——该功能的 ADR、reference、探针、测试一并不收。判据是那个功能自己的归属，不是"本仓现在有没有它"。
- **任何只在维护者机器上解析得了的东西**——指向私有仓路径的校准档、绑定维护者自有服务的清单。

## 读框架样本时要知道的两件事

1. **它们可能引用本仓没有的东西。** 样本是从一套更大的配置里切出来的，正文里可能提到上游才有的文件或命令。这是刻意保留的（改写会让样本失真）；按引用去找却找不到，多半就是这一类。**这条豁免只覆盖框架层**——消费者向的文件（hook、工作流命令、install/verify）里的断裂引用是缺陷，要修。
2. **它们不是维护者当前在用的版本。** 上游这一层一直在改，本仓不跟。想看机制怎么演化，看 `docs/adr/`。

## 同步时怎么用本文件

`/routine:sync-from-upstream` 的 scope gate 按此执行，四种情形各有动作：

| 情形 | 动作 |
|---|---|
| 路径在上面的框架层清单里 | **不同步**。只有当样本自身坏掉（与本仓其余部分自相矛盾、内部指代悬空）时才修，且修自洽性、不跟进内容 |
| 上游**新出现**的内容，按判据属框架层 | **默认不纳入**。要纳入须 `AskUserQuestion`，并让维护者说清收哪一版、随后加进上面的清单 |
| **已在本仓、不在清单**、但按判据属框架层 | 不擅自冻结也不擅自跟进：`AskUserQuestion` 问是否补进清单，得到答复前按现状处理 |
| 判不准 | `AskUserQuestion`，不自行归类 |

**与 sync 命令里「不维护持久排除列表、每次重新询问」那条的关系**：那条管**逐次偏好**（这次不想要某个消费者向的新功能，下次重新问）；本文件管**结构性 scope**，清单刻意持久。两者在同一个文件上都套得上时——例如一个框架层新增被拒过一次、下次同步又被枚举进来——**以本文件为准**：框架层的默认动作是不纳入，不必每次重问。逐次重问只适用于消费者向的新功能。
