# docs/ 索引

> 当你在 docs/ 下工作时 Claude Code 自动加载本文件。维护规则见 `~/.claude/references/docs-organization-protocol.md`。

## 文档索引

| 文档 | 性质 | 何时读 |
|---|---|---|
| [architecture.md](architecture.md) | Mutable snapshot | 需要理解项目模块结构、分层方式、关键抽象时 |
| [philosophy.md](philosophy.md) | 设计哲学 | 需要理解 commands 的设计取舍和人机协作原则时 |
| [command-guide.md](command-guide.md) | 使用指南 | 需要查阅 command 用法和工作流组合时 |
| [issues/](issues/README.md) | [Agent] issue 跟踪器（按 domain 分文件） | 规划"接下来做什么" / 评估项目健康、或发现 harness 自身问题需记录时 |

## 写入规则

- append-only 类型（adr / experiences / changelog）不删改已有条目
- 新增、重命名或删除文档时同步更新本索引
- 详细的读写触发规则见 `~/.claude/references/docs-organization-protocol.md` §4
