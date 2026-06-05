# Harness Issues

> [Agent] Agent Harness 自身问题的 domain 跟踪文件——hooks（含 Stop Gate）、适配层、agent / skill 行为、settings / 权限等。产品代码 bug 不进此文件（走各 project 自己的 issue 跟踪）。

由 `~/.claude/CLAUDE.md`「Harness Issue Capture」规则驱动：发现 harness 自身值得优化、但本次不就地修的问题，按 `~/.claude/references/docs-organization-protocol.md` §4.8 追加一条。

**格式**：遵循 §4.8（`## [<status>] <title>` / Type / Priority / Discovered / Description / Notes）。Status：`open` / `resolved` / `wontfix`（后两者写明原因）。Type 枚举：`bug` / `improvement` / `note`。除 §4.8 标准字段外，本 domain 保留 `Component` / `Root cause` / `影响` / `候选优化` 等富字段（§4.8 允许按需追加）。`HARNESS-NNN` id 保留在标题中——条目间互相引用。

---
