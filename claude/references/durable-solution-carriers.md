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

写入记忆前先判断这条经验是否适用于其他项目：适用时写入 `ai-agent-config` 的 owning artifact，记忆至多保留指针。`ai-agent-config` 经符号链即时成为运行时入口，但只有 commit 后才是持久、可迁移的方案。

记忆的**正生态位**（何时它是对的载体）：承载同时满足三条的信息——(a) 不是规则 / 协议（否则进 `CLAUDE.md` / `references/`）、(b) 不宜 git-shared 的项目知识（否则进 `docs/`）、(c) repo 推导不出。典型：个人工作偏好、跨 session 的 debug 直觉、不属任何单一 artifact 的运维 / 环境拓扑事实。

**不该进记忆**：

- **transient 工作状态**（待办、待实施 plan 等）——由其 git-tracked 产物自描述（plan.md 的 long-task banner + state.md 的 pending 状态，可被扫 `plans/` 发现），实现即随产物归档；尚无 git 产物时，要留就落一份 plan.md，而非以记忆代偿。
- **git 载体的内容副本**——载体已 self-describing 时不另建记忆摘要；"指针"只给薄 locator（路径 + 一句状态），复述其数字 / 方案 / 历史即制造第二真相。

短期 session 便签是显式例外：用完即弃的临时记录，不受上述持久性约束。
