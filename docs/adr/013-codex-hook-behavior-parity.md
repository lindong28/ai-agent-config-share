# Codex hook 对齐采用逐 handler 的证据状态机

- 状态：accepted（2026-08-12）
- 决策人：用户；评审：独立 Codex reviewer，一轮完整 gate + 一轮指名复核
- Refines：ADR-011 决策 6；继续坚持「只承诺本仓显式配置并验证过的跨 harness hooks」
- Component：`claude/settings.json`、`codex/hooks.json`、`codex/hook-parity.json`、Codex hook 兼容层与对应测试

## 背景

Codex CLI 0.147.0 已把 hooks 标为 stable，但它与 Claude Code 的 hook 表面不是直接同构：Codex 没有 `Notification` 与 `PostToolUseFailure` 事件，同事件的多个 handler 并发启动，`apply_patch`、MCP tool name 和 transcript schema 也不同。把 `claude/settings.json` 原样复制成 Codex 配置会制造一种危险的假对齐——handler 看似注册成功，实际可能静默 no-op、读取错误载荷，或在 Stop gates 尚未放行时提前通知。

本轮真实 Codex probe 已区分出几项关键边界：ask-user 工具在 hook payload 中的 canonical name 是 `mcp__ask_user__AskUserQuestion`；`apply_patch` 的 Pre/Post payload 使用 `tool_name=apply_patch` 且 patch 文本位于 `tool_input.command`；现有 `block-no-verify` 直接挂到 Codex `PreToolUse(Bash)` 后，能在命令执行前以同一条阻断理由拦下 `git commit --no-verify --dry-run`。这些读数证明复用既有 gate 可行，也证明必须显式适配而非复制配置。

## 决策

1. `claude/settings.json` 是 active user-policy hook 的迁移与盘点 authority，不是 Codex 已生效行为的运行时真相。配置漂移测试只负责暴露未分类的新 Claude handler，不能自动把它启用到 Codex。
2. 每个 Claude handler 必须在 Codex parity manifest 中有一条显式记录，并处于 `fixture-verified`、`live-verified` 或 `harness-specific-excluded` 之一。尚未实现或没有对应区分性证据的 handler 不得进入 manifest 的已验证集合，也不得获得 parity 承诺；实施目标可以是零 unsupported，但不得把目标写成既成事实。
3. Codex 侧用薄兼容与编排层复用 Claude hook scripts，不复制 gate 判断。兼容层只处理事件替代、tool name、payload、transcript 与 stdout/exit-code 差异；共享 helper 的跨 transcript 支持必须同时由 Claude 与 Codex fixture 锁定，Claude 默认路径不能被 Codex 适配改写。
4. Codex 缺失的事件按用户可观察语义映射：`PostToolUseFailure` 由 `PostToolUse` 的失败过滤器承接；`Notification` 的回合结束通知只能在同一 Stop 编排器确认所有阻断 gate 放行后发出，不能作为独立并发 Stop handler 提前发送。语义替代与同名映射遵循同一证据状态机，不享受自动放行。
5. Scope 只包含仓库管理、在 `claude/settings.json` 激活的 user-level policy 与 UX hooks。Claude enabled plugins 自己注册的 hooks 不在本决策内；例如 claude-mem 的生命周期 hooks保持 Claude-only，Codex继续使用内置 memories。
6. 高影响或低频 handler 除 fixture 测试外还要有 live smoke。分支阶段只声明隔离实现与契约验证；真实 `~/.codex/hooks.json` 的 trust、消费者入口与会话生命周期事件，必须在用户许可整合到本地 main 后才能升级为 live-verified。

## 被否决的备选

| 备选 | 否决理由 |
| --- | --- |
| 原样复制 Claude JSON 与命令 | 缺失事件、tool alias、payload、transcript 与并发顺序均不同，会产生静默 no-op 或错误通知 |
| 为 Codex 完全重写一套 native gates | 形成第二份判断真相，Claude 修复不会自然流入 Codex，长期必然漂移 |
| 把 enabled plugins 的 hooks 也纳入清单 | 插件生命周期与能力属于各自 harness；强行映射会重复功能并违背已有 Claude-only 边界 |
| 把 active Claude handlers 直接视为 Codex 已对齐行为 | 结论作用域超过证据作用域，并与 ADR-011 的已验证才承诺原则冲突 |

## 验证与回滚

验证分三层：manifest 对 active handler 做集合完备性检查；兼容层对两种 payload/transcript 做正反 fixture；真实 Codex smoke 证明关键 handler 确实触发、阻断或恢复。任一层未过时，对应 handler 不升级证据状态，也不获得 parity 承诺。

Codex runtime 配置集中在 `codex/hooks.json`，出现系统性问题时可以整体回退该文件；共享 helper 的变更由 Claude/Codex 双 fixture保护。回滚只恢复 Codex 注册面，不删除 Claude 原有 hooks。

## 已知未验证项

- `PermissionRequest`、`SessionEnd`、`SubagentStop` 与自动 compaction 尚未在本轮逐项真触发；实现前后必须保持明确的非 live 状态。
- Codex teammate/process-tree 语义可能只能做 Codex-native 等价替代，而不能做到 transcript 字节级一致；parity 的对象是用户可观察目标、阻断、恢复与通知语义。
- worktree 内无法证明 canonical `~/.codex` 的 trust 与消费者可见状态；该边界只在用户授权本地 main 整合后验证。

## 决策评审记录

首轮评审否决了“active 清单即已成立行为”的过宽表述，并要求补 AskUserQuestion、`apply_patch` 与非 compaction live consumer 证据。补测后，决定收窄为迁移 authority + 逐 handler 状态机；原 reviewer 复核认为修正成立、没有新 blocker，并特别要求继续把“零 unsupported”只当实施目标。

### 整合前 review 的补充决策（2026-08-12）

高档生成后 review 发现三条兼容层失败面后，决定：shell skill-read 识别先递归展开最外层受控 shell wrapper，再解析其内部命令；dispatcher 遇到超过输入上限的 payload 时必须响亮失败，可能阻断的事件不得把截断 JSON 交给下游后静默放行；`SessionStart:startup|resume` 作为 session 恢复边界，清掉该 session 遗留的 active-subagent ledger，不用 TTL 或进程树猜测活性。

该补充决策只覆盖 Codex dispatcher、共享 shell-read adapter 与对应回归，不承诺解析任意 shell 语言，也不把 session 恢复语义推广到其它 registry。每条先用反例取得 RED，再以同一测试取得 GREEN：多命令 wrapper 同时保留纯路径提及负例；超限 writer 必须 exit 2，超限生命周期事件必须非零失败；startup/resume 必须清 stale ledger，compact 不得误清。

尚未验证 Codex 是否另有官方 hook stdin 硬上限，也未做真实 crash-resume 全链路实测；因此这些边界仍按 fixture-verified，而不是 live-verified。独立决策 reviewer 首轮要求补齐“错了多久能发现”的检测契约；上述正反回归契约补入后，原 reviewer 复核放行，未发现新 blocker。
