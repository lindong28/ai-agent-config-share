# Issues

> [Agent] agent 驱动的轻量 issue tracker，按 domain 分文件（见 `~/.claude/references/docs-organization-protocol.md` §4.8）。每个文件内 mutable（条目有 lifecycle：`open` / `resolved` / `wontfix`）。

## Domain 文件

| 文件 | Scope | 写入驱动 |
|---|---|---|
| [harness-issues.md](harness-issues.md) | Agent Harness 自身问题——hooks（含 Stop Gate）、适配层、agent / skill 行为、settings / 权限。**不含**产品代码 bug（走各 project 自己的 issue 跟踪）。 | `~/.claude/CLAUDE.md`「Harness Issue Capture」 |

条目格式见 `~/.claude/references/docs-format-templates.md` §4.8。新增 domain 时按「一类 issues 有独立 consumer 或明显不同优先级时给它单独文件」的 lens 判断。
