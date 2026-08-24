# Durable Solution Carriers

长期修复或教训必须满足：

- 系统性：以后系统能自己发现或避免同类问题。
- 可泛化：解决一类问题，而不是堆叠个例或黑名单。
- 可持续维护：存在明确 owning artifact，不制造第二真相。

方案必须落在 git-tracked、覆盖其全部消费者的最窄共享 scope。运行时入口 `~/.claude/` 与 `~/.codex/` 的 owning artifact 位于 `~/research/ai-agent-config/`。

| 载体 | 适用 | 性质 |
|---|---|---|
| `~/research/ai-agent-config/claude/hooks/` | 需要在动作点强制执行 | 强制；声明式规则被反复漏掉时的升级项 |
| `~/research/ai-agent-config/claude/CLAUDE.md`、`rules/`、`references/` | 跨项目行为准则、协议、原则 | 声明式、git-tracked |
| canonical `skills/` / `commands/` owning artifact | 可复用、可触发且需要执行流程的工作 | 可执行 workflow；一次性事实不升级为 skill 或 command |
| 目标项目 `docs/`（experiences / ADR / issues） | 仅该项目适用的教训 | 项目级、git-tracked |
| 项目记忆 | 以上权威载体的**薄指针**（路径 + 一句状态，不复述内容）或天然易失的 session 便签 | 非方案载体；不入 git，不单独承载跨项目教训 |


**一条知识只占这张表的一行。** 上面每一行都在说"什么该住这里"，没有一行说"它不能同时住在别处"——
而两个 git 载体都合法、都 self-describing 时，重复不会触发上面任何一条（那条「不该进记忆」的
副本条款只管 git↔记忆这一个方向）。约束是：同一条通用判据或方法只有一个 owning artifact；
项目层只保留项目特有的取值、证据、约束与决策，并指回 owner，不改述通用方法。少了项目层那部分，
owner 的要求往往无法执行（"用同类同量级的已知正例校准"须有本地的已知正例才落得了地）；
多了项目层的方法副本，两份必然各自漂移。账本已有三例：HARNESS-341「发现候选的检索」及其 2026-08-19 occurrence，与 HARNESS-057。

**动笔前先确认 owner 不存在**：按核心概念及其同义表达检索表中另一层的全部 owning artifact
（`CLAUDE.md`、`rules/`、`references/`、canonical `skills/` 与 `commands/`、`hooks/`，以及目标
项目 `docs/`），产出二者之一——命中的那个唯一 owner，或用过的检索式加具名的无命中。
拿不到有区分力的读数就标为未核实，别把"我搜了一下没看到"当成 owner 不存在。

**落定之后再问一次：谁会读到它？** 上面三条要求与「确认 owner 不存在」都只管**该住哪**，
没有一条管**住进去之后够不够得着读者**——一个 git-tracked、scope 最窄、owner 唯一的位置，
可以同时是没有任何东西指向的位置。判据是**走一遍**：从一个**运行时入口**出发，沿指针一跳
一跳走到它。运行时入口不止自动加载的那几份——`CLAUDE.md` / `rules/` / 项目的 `AGENTS.md`
是一类；**model 只凭 description 就能选中的 skill 与 command** 是一类（它们不需要任何文本
链指向自己）；**已注册的 hook** 是一类（Claude 在 `settings.json`、Codex 在 `~/.codex/hooks.json`；由动作触发，同样不需要文本链）。
量词是**存在**、不是全称：能举出**一类**"会真的做这件事的任务"、其执行者从某个运行时入口
走得到它，就算可达；不必对所有任务成立。举不出那一类任务，才是不可达。
**别用「数入链」代替走一遍**——入链 > 0 与可达是两回事：指向它的那份文件自己可能从不被
加载（`references/` 里的档要有人转指才会打开），那句指针也可能挂在一个先要测量才知道成不
成立的条件上，或埋在一个没有任务会进的分支里。数出来的那个正数，在真能走到与走不到两种
情况下取值相同。
不可达时要么把入口接上（在会被读到的那份 artifact 的**使用现场**加指针），要么改选载体——
"知识已经保存了"与"下一个 session 会读到它"是两个独立的问题，只解决前一个就收工是最常见的失守。

实测：一个新探针连同 31 条夹具落进 `docs/drafts/`，作者判定"知识保存了"；而它**三类运行时
入口一个都不占**——没有规则文件指向该目录（0 个），它不是 skill 也不是 command（没有
description 可供选中），更没在 `settings.json` 注册。同族工具在同一份 reference 里各被提及
3 次与 2 次。同一次失守还带出一个
更普遍的诱因——**把"这东西还不够好"当成"该藏起来"**：不完美恰恰是入口处要写明它错在哪的
理由，而不是不给入口的理由；替代方案往往不是"不用它"，而是读者手搓一个更差的。

写入记忆前先判断这条经验是否适用于其他项目：适用时写入 `ai-agent-config` 的 owning artifact，记忆至多保留指针。`ai-agent-config` 经符号链即时成为运行时入口，但只有 commit 后才是持久、可迁移的方案。

记忆的**正生态位**（何时它是对的载体）：承载同时满足三条的信息——(a) 不是规则 / 协议（否则进 `CLAUDE.md` / `references/`）、(b) 不宜 git-shared 的项目知识（否则进 `docs/`）、(c) repo 推导不出。典型：个人工作偏好、跨 session 的 debug 直觉、不属任何单一 artifact 的运维 / 环境拓扑事实。

**不该进记忆**：

- **transient 工作状态**（待办、待实施 plan 等）——由其 git-tracked 产物自描述（plan.md 的 long-task banner + state.md 的 pending 状态，可被扫 `plans/` 发现），实现即随产物归档；尚无 git 产物时，要留就落一份 plan.md，而非以记忆代偿。
- **git 载体的内容副本**——载体已 self-describing 时不另建记忆摘要；"指针"只给薄 locator（路径 + 一句状态），复述其数字 / 方案 / 历史即制造第二真相。

短期 session 便签是显式例外：用完即弃的临时记录，不受上述持久性约束。
