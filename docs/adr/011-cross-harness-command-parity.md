# Claude command 与 Codex skill 的完整能力对齐

- 状态：accepted（2026-08-12）
- 决策人：用户；评审：独立 Codex reviewer，三轮完整 gate + 三轮指名复核
- Supersedes：ADR-004 决策 9 中「仅 Claude Code、无 Codex wrapper」与 invocation log 固定四键的边界；ADR-004 的其余 program 设计继续成立
- Component：`codex/bin/gen-agents-skills.py`、`codex/hooks.json`、`claude/bin/active-plan`、`claude/commands/custom/run-program.md`、跨 harness 政策与对应测试

## 背景

Claude commands 默认由 `codex/bin/gen-agents-skills.py` 生成 Codex wrapper skill，但 `custom/run-program.md` 曾因 ADR-004 的 Claude-only 试点边界被刻意排除。与此同时，`orchestrate.md` 仍指向已经移入 `deprecated/` 的 canonical skills，且 Codex 侧另留一份旧 prompt；这两处共同造成 Codex 能力面比 Claude 小，或暴露一个名字存在但契约已坏的入口。

当前 Codex CLI 0.147.0 已把 hooks 标为 stable，并支持 `PreCompact` 与 `SessionStart(source=compact)`。因此 `run-program` 所需的 program ledger 恢复不再是 Claude 独有能力；仅生成 wrapper 而不接通 compaction 连续性，会制造“入口可见但完整运行契约不成立”的假对齐。

## 决策

1. Claude command 默认必须进入 Codex wrapper farm。唯一 Claude-only exclusion 是 `routine/allow.md`；`tdd.md` 作为 legacy alias 可以不生成 wrapper，但其 canonical `tdd-workflow` skill 必须在当前 skill source inventory 中存在。测试以固定的获准 exclusion 为 authority，再与当前 command inventory 做完整集合比较，禁止从被测 denylist 自导 expected set。
2. `custom/run-program.md` 解除 exclusion，继续保持 explicit-only，但在 Claude Code 与 Codex 两侧提供同一份 command 契约。invocation log 的新记录键集合改为 `{ts, project, harness, verdict, reason}`，其中 `harness` 只能是 `claude` 或 `codex`；历史四键记录按 `legacy-claude` 解释，不原地迁移 append-only 日志。
3. Codex user-level hooks 复用现有 `pre-compact.js` 与 `post-compact-restore.js`，接通 `PreCompact(manual|auto)` 与 `SessionStart(compact)`。hook 命令显式补齐 macOS Homebrew 与 Linux user-local Node 路径，不能依赖调用方已经把 Node 放进 PATH。该能力有意同时恢复 `type=program` 的 ledger 和 `type=plan` 的 long-task state，不仅服务 run-program。
4. `active-plan` 的 session owner 解析规则为：显式 `--session` 最高；Claude candidate 取 `CLAUDE_CODE_SESSION_ID || CLAUDE_SESSION_ID`，Codex candidate 取 `CODEX_THREAD_ID`；没有 candidate 时失败，只有一个时使用，两者同值时使用，两者不同时 fail closed 并要求显式 `--session`。不得猜父子 harness 中谁拥有 marker。
5. `/orchestrate` 在两侧一起退役：删除 Claude command、Codex 旧 prompt 及 manifest 条目，不恢复 deprecated skills，也不把语义不同的 `multi-workflow` 冒充为替代品。残留扫描是回归契约的一部分。
6. Harness 适配表明确区分“默认桥接”“Claude-only exclusion”“有当前 canonical skill 的 legacy alias”，并更新 Codex hooks 的真实能力边界：只承诺本仓显式配置和验证过的跨 harness hooks，未移植的 Claude hooks 不得据此推断为生效。

## 被否决的备选

| 备选 | 否决理由 |
|---|---|
| 只给 `run-program` 生成 wrapper | 只能证明入口可见，不能兑现 compaction 后继续监督 program 的核心契约 |
| 维护一份 Codex-native `run-program` | 复制约 19000 字协议，形成必然漂移的第二真相 |
| 清空整个 denylist | 会向 Codex 暴露 Claude permission-gate 管理入口，并给 `tdd` 制造重复入口 |
| 手工补 live `~/.agents/skills/custom-run-program` | 不受 Git 管理，下次 farm rebuild 即丢失 |
| 把 `/orchestrate` 改指 `multi-workflow` | 两者语义不同：前者是 tmux/worktree 与自定义 agent 编排，后者是固定六阶段、多模型开发流程 |
| 恢复 deprecated orchestration skills | 为一个坏兼容入口复活过时资产与全局 context 成本 |
| 重写一个自包含 `/orchestrate` | 能保兼容，但用户选择彻底退役，避免继续维护一个与现行 program/workflow 入口重叠的第四套编排面 |

## 验证与作用域

合入前必须用隔离 HOME/CODEX_HOME 验证：完整 wrapper 集合；`run-program` explicit guard；fixed exclusions 与 canonical alias；真实 `active-plan set` producer 到 PreCompact snapshot、再到 SessionStart(compact) briefing 的 plan/program 两条链；双 harness session ID 冲突与 producer/hook mismatch 阴性对照；删除 hook、改 matcher、恢复配置的 mutation probes；`orchestrate` 三处资产无残留。

本 ADR 的 worktree 阶段不声称 consumer-visible full parity。真实 `$custom-run-program`、Codex hook trust、manual/auto compaction，以及 live farm 的发现面，只能在用户许可把分支整合到本地 main、从 canonical main 重建 farm 后验证；整合前保持“实现与隔离契约已验证，真实 live 入口未验证”的状态。

## 已知未验证项

- 本机 Codex hook event 的 `session_id` 是否在所有启动表面都等于 `CODEX_THREAD_ID`，须由真实 producer→hook chain 与合入后的 live smoke 共同验证。
- 自动 compaction 可能需要实际 context 压力才能触发；合入后的 smoke 若只能稳定触发 manual compaction，auto 保持明确未验证，不用配置存在代替运行证据。
- 非 0.147.0 Codex 版本的 hook schema 兼容性不在本次实证作用域；安装/升级后的配置识别必须 fail loudly。
