# docs/ 索引

> 当你在 docs/ 下工作时 Claude Code 自动加载本文件。维护规则见 `~/.claude/references/docs-organization-protocol.md`。

## 文档索引

| 文档 | 性质 | 消费者 | 何时读 |
|---|---|---|---|
| [architecture.md](architecture.md) | Mutable snapshot | [Developer] | 需要理解项目模块结构、分层方式、关键抽象时 |
| [philosophy.md](philosophy.md) | Mutable snapshot | [Developer] | 需要理解 commands 的设计取舍和人机协作原则时 |
| [command-guide.md](command-guide.md) | Mutable snapshot | [User] | 需要查阅 command 用法和工作流组合时 |
| [adr/](adr/README.md) | Append-only（每条一文件） | [Developer] | 需要理解某组件为何长成这样、或要推翻/修订一个架构决策时；三种形态（supersession / 修订记录 / refines）与条目必含项见 [adr/README.md](adr/README.md) |
| [scope-policy.md](scope-policy.md) | Mutable snapshot | [User] + [Agent] | 判断某份内容该不该从上游同步进本仓时；读框架样本前想知道它为什么停在旧版本时 |
| [issues/](issues/README.md) | Mutable（lifecycle，按 domain 分文件） | [Agent] | 规划"接下来做什么" / 评估项目健康、或发现 harness 自身问题需记录时 |

根目录另有 [README.md](../README.md)（[User] 入口）与 [CHANGELOG.md](../CHANGELOG.md)（[User] append-only），同属本协议管辖。

**子项目文档**：`tt-web/` 自带一套——[tt-web/README.md](../tt-web/README.md)、[tt-web/docs/operations/services.md](../tt-web/docs/operations/services.md)（服务清单与运维入口）、`tt-web/docs/contracts/ux-contract.md`、`tt-web/NETWORK-REMEDIATION.md`、`tt-web/ip_check/README.md`，以及 `tt-web/docs/issues/` 下的 `general.md` / `ux-contract-issues.md`（该目录尚无 domain 索引与 archive，按协议 §4.8 需要时再补）。tt-web 的服务、契约与 issue 都归它自己那套，不往上并。

## 写入规则

- append-only 类型不删改已有条目——本仓现有 `CHANGELOG.md` 与 `adr/` 属此类（本仓未建 `plans/`；按协议 §4 需要时再建，建后更新本索引）
- issue 判定 `resolved` / `wontfix` 的同一步整条移入 [issues/archive/closed.md](issues/archive/closed.md)，不留在 domain 文件、不删除
- 新增、重命名或删除文档时同步更新本索引
- 详细的读写触发规则见 `~/.claude/references/docs-organization-protocol.md` §4
