# Issues

> [Agent] agent 驱动的轻量 issue tracker，按 domain 分文件（见 `~/.claude/references/docs-organization-protocol.md` §4.8）。domain 文件只存 **open** 条目；判定 `resolved` / `wontfix` 的同一步把整条移入 [`archive/closed.md`](archive/closed.md)（单一扁文件、只 grep 查史，不通读）。

## Domain 文件

| 文件 | Scope | 写入驱动 |
|---|---|---|
| [harness-issues.md](harness-issues.md) | Agent Harness 自身问题——hooks（含 Stop Gate）、适配层、agent / skill 行为、settings / 权限。**不含**产品代码 bug（走各 project 自己的 issue 跟踪）。 | `~/.claude/CLAUDE.md`「Harness Issue Capture」 |
| [general.md](general.md) | 上一行不覆盖的其余问题——本仓自身的产品代码 / 安装器缺陷，以及 wrapped-agent 行为问题与工具缺口。 | `/custom:supervise` 等流程；审计与 review 流程发现但本次不就地修的本仓缺陷 |

条目格式见 `~/.claude/references/docs-format-templates.md` §4.8。新增 domain 时按「一类 issues 有独立 consumer 或明显不同优先级时给它单独文件」的 lens 判断。
