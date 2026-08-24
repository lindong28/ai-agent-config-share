# ADR-026: tt-web 账号记忆作为 generation admission 之后的 server-side persistent derivation

- 状态：accepted（2026-08-21）
- Component：`tt-web/server.py`、`tt-web/state/account_memory.json`、`tt-web/web/`
- 关系：建立于 [ADR-002](./002-tt-web-open-requests-fresh-generation.md) 的 generation-only admission 边界；与 [ADR-024](./024-tt-web-quota-account-attribution.md) 的账号归属假设直接相关，但不 supersede、refine 或 amend 它

## 背景

ADR-002 把 admitted generations 定为额度值进入 tt-web 的唯一消费边界。ADR-024 又把这些值按账号分组，但 server 每次只从当前 admitted snapshots 派生页面结果：账号一旦从所有机器登出，它就从 Overview 消失，系统没有任何跨请求、跨重启的账号历史。

用户需要在账号登出后继续看到最后一次观测到的额度与 reset 原值，以便决定是否切回该账号。这个需求不能靠现有 rollup 回填：rollup 没有账号或 quota 字段，generation 只保留有限的 current / previous；因此记忆只能从功能上线后、系统实际见过的 admitted snapshots 开始积累。

这里还有一条必须继承的风险。ADR-024 的归属规则是“某台机器的最新读数属于该机器当前登录账号”，该假设已由 owner 明确 waive 其不可验证的错配窗口。持久记忆会把原本只存在于 transient view 的错误归属延长为永久记录；本 ADR 不修复、改写或重新证明该假设。

## 备选

| 方案 | 收益 | 被否原因 |
|---|---|---|
| A. 在 server 侧持久保存 admitted、具名账号的最后观测值 | 浏览器与服务重启后仍一致；不要求 exporter 锁步升级 | 选择；引入首个不可由当前快照完整再生的 server-side persistent memory |
| B. 只在浏览器 `localStorage` 记忆 | 无 server 状态文件 | 记忆按浏览器分叉，无法给 API、其他浏览器或服务端删除守卫提供统一事实源 |
| C. 扩展 generation wire schema 或 exporter | 可让远端直接携带历史 | 破坏 ADR-002/024 刻意保留的兼容边界；需要 exporter、schema 与旧 generation 的锁步迁移，且仍无法回填上线前历史 |
| D. 写入 `rollup.db` | 复用已有数据库 | 该库会由 rollup 重建，不适合承载不可再生的账号记忆；删除和生命周期也会与成本聚合耦合 |
| E. 给记录加 TTL 或条数上限 | 自动控制增长 | 与“记住所有已观测账号”相悖；当前预期规模是个人使用过的账号数，没有证据支持自行设定清理阈值 |
| F. 保持纯派生、不记忆 | 零新增状态 | 无法满足账号登出后仍可查看最后观测值的目标 |

## 决策

采用方案 A。tt-web 引入首个 server-side persistent memory：`state/account_memory.json` 保存每个 `(provider, account_id)` 最后一次被 admitted snapshot 观测为 `known` 时的账号标签、plan、两档 quota 原值、reset 原值与 `observed_at`。它是 server 派生状态，不进入 generation wire，不改 exporter / parsers，不新增顶层 generation 字段，也不提升 `schema_version`。

记录只在 generation admission 之后产生。`unstamped` 与 `signed_out` 没有可持久化的账号身份，不进入记忆；同一账号只有严格更新的 `observed_at` 可以覆盖旧值。Overview 读取和 sync 成功发布后的读取共用这一边界，使只经 Explore 发布、随后又被覆盖的 admitted 账号也有机会被记住。

记忆没有 TTL、自动过期或条数上限，只能由用户发起 per-account hard delete。删除没有回收站；账号以后再次出现在新的 admitted snapshot 中时，会作为新的在用记录重新出现。并发删除与旧快照的完整语义及当前已接受缺口见 [ADR-027](./027-account-memory-record-time-invariant.md)。

损坏或版本不受支持的记忆文件不能被当作空文件覆盖：该轮只返回 live derivation，并保留原字节供人工恢复。相反，普通 upsert 写入失败只是旁路增强失败，不应使 Overview 整体不可用。

## 作用域与关系

- ADR-002 仍是值进入系统的消费边界；本 ADR 只把已经 admitted 的具名账号值从瞬时派生延长为持久记忆。
- ADR-024 的账号归属规则与 waiver 原样保留。本 ADR 不改变归属算法，只延长其结果的存续时间。
- 持久化与删除只发生在 server 侧；generation wire、exporter、parsers、真实账号凭据和机器登录状态均不改变。
- 页面展示的是“最后观测值”，不是当前额度推算；reset 已过也不把记录自动归零或删除。

## 后果

- 账号从所有机器登出后仍可跨页面刷新、服务重启与 uninstall 保留最后观测值；上线前已登出的账号、以及两次 export 之间短暂登录又登出的账号不会出现。
- `account_memory.json` 成为不可再生的用户状态，而不是缓存。手工删除文件会永久丢失已经无法从任何机器重新导出的历史账号。
- ADR-024 的错配可被永久保存：换号后、新账号首条真实读数出现前的旧值可能挂在新账号名下，之后一直存在到手动删除。手动删除是纠正出口，不是归属正确性的证明。
- 当前协调模型是单 server 进程内的锁与原子替换；若未来同一 state root 由多 worker 或多进程共同写入，需要重新评审进程间协调。

## Waiver 与已知未验证

- owner 已在 ADR-024 明确接受归属假设的不可验证窗口；本 ADR 明知其可见时长从 transient view 延伸为持久记录仍选择落地，不把这一继承风险描述为已解决。
- 无 TTL 的规模判断只基于当前单人账号量级，未验证未来多人或大量账号形态。
- 没有历史数据源可回填上线前账号，也无法证明两次导出之间发生过的短暂登录。
- 五个实施 commit `2855170`、`9927ca1`、`078c4a8`、`00e7e96`、`d1fbd23` 已完成；但长任务的 `TASK-009` / V8 owner 人读仍 pending，因此不得把全 plan 验收写成 complete。

## Review

原产品 plan 经五轮 plan review，终止判据始终未满足，用户在第五轮后选择熔断并定稿；因此历史方案不能描述为 “review clean”。实施单元各自经过 review gate 与修复闭环，其中删除并发仍保留 ADR-027 记录的 owner waiver。本 ADR 的“应提升为独立决策、与 ADR-002/024 的关系及上述状态表述”另经本轮 decision-review 放行；这次提升 gate 不倒推历史产品决定已经通过。
