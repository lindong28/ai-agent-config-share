# Docs Format Templates

各文档的建议格式模板——仅在创建新文档时参考。协议正文见 `docs-organization-protocol.md`。编号沿用协议 §4.x 体系，无模板的 section 跳过。

---

## 4.2 CHANGELOG.md

```markdown
# Changelog

> Append-only (newest first). User-visible changes only.

## YYYY-MM-DD <version or title>
- Added: <新功能>
- Changed: <现有功能的修改>
- Fixed: <修复的 bug>
- Removed: <移除的功能>
```

---

## 4.3 architecture.md

```markdown
# Architecture

> Mutable snapshot. Update when structure changes.

## Overview
<1-2 段系统描述：做什么、核心技术栈>

## Modules
<模块列表：名称、职责、关键文件 / 目录、依赖>

## Layers
<分层方式、模块间的调用关系、边界规则>

## Key Abstractions
<核心概念、数据模型、接口>
```

---

## 4.4 adr/

### README.md 索引

```markdown
# Architecture Decision Records

> 每条决策独立文件，编号递增。Status: accepted / superseded / deprecated.

| # | Title | Status | Date |
|---|---|---|---|
| [001](./001-chose-x-over-y.md) | 选择 X 而非 Y | accepted | 2026-05-21 |
| [002](./002-auth-middleware.md) | Auth middleware 重写 | accepted | 2026-05-22 |
| [003](./003-new-approach.md) | 新方案 | supersedes 001 | 2026-06-01 |
```

### 单条 ADR

```markdown
# ADR-NNN: <title>

- Status: accepted | superseded by ADR-NNN | deprecated
- Date: YYYY-MM-DD
- Supersedes: ADR-NNN（如适用）

## Context
<为什么需要做这个决策>

## Options Considered
### Option A: ...
- Pros: ...
- Cons: ...

### Option B: ...
- Pros: ...
- Cons: ...

## Decision
<选了什么 + 为什么>

## Consequences
<对项目的影响——正面和负面>
```

---

## 4.6 contracts/

### ux-contract.md

```markdown
# UX Contract

> Mutable. User-visible features and test coverage — hard spec.

## Features
<按领域分组的功能清单：名称、入口、核心行为>

## User Journeys
<关键用户路径：从入口到目标的步骤>

## Test Surface
<测试应覆盖的面：按 feature 或 journey 组织；包含如何 verify>
```

### ux-test-patterns.md

```markdown
# UX Test Patterns

> Soft heuristics. Things to watch for when testing — not mandatory every run.

## <feature / journey 名>
- Pattern: <什么情况下容易出问题>
- Watch for: <测试时留意什么>
- Edge cases: <边界情况>
```

---

## 4.7 experiences/

```markdown
## <YYYY-MM-DD> <title>
- Problem: <遇到了什么>
- Solution: <怎么解决 / 绕过的>
- Applies when: <什么情况下会再遇到>
```

---

## 4.8 issues/

```markdown
## [<status>] <title>
- Type: <见各 domain 枚举>
- Priority: critical | high | medium | low
- Discovered: <when/where — 触发场景>
- Description: <现象 + 为什么是问题>
- Notes: <按 status 和场景补充，见下方 lens>
```

**Status**：`open` / `resolved` / `wontfix`。

**归档**：判定 `resolved` / `wontfix` 后，按 `docs-organization-protocol.md` §4.8 把整条移入 `docs/issues/archive/closed.md`（同一条目格式，不改写）；open 条目留在 domain 文件。

**Type 枚举**（各 domain 按需扩展）：

| 文件 | 参考枚举 |
|---|---|
| general.md | `bug` / `improvement` / `feature` |
| ux-issues.md | 开放枚举——按产品的观察维度或失败模式分类 |
| ux-contract-issues.md | `drift`（contract 与实际不符）/ `expansion`（未覆盖的扩展候选）/ `redesign`（contract 结构改进建议） |

**Notes lens**——按 status 和 domain 判断该补什么：

| 场景 | Notes 应包含 |
|---|---|
| resolved | 日期、修复方式 / 验证证据 |
| wontfix | 为什么不修 |
| ux-contract-issues | 修改建议（Recommendation） |
| 其他 | 有助于验证和解决 issue 的上下文信息 |

**字段使用 lens**：让下一个 reviewer（人或 LLM）只看这条 entry 就能回答核心问题。缺哪个字段就补哪个；上面字段不够用时自由追加字段。无实质答案的字段应省略，不做填空式冗充。

---

## 4.11 operations/

operations/ 是目录而非单一格式——文件类型多样（services / monitoring / incidents / runbooks）。各文件按内容选合适格式。下面是最常见的 `services.md` 模板。

### services.md

每行让读者一眼回答一个服务的：是什么 / 谁守护 / 现状 / 怎么做生命周期操作 / 细节在哪。下表是这组问题的常见列化，字段按项目增减。

```markdown
# 服务清单

> Mutable snapshot. 项目长期运行的服务 + Supervisor + Instructions 位置。

## 服务

| 服务 | Supervisor | 当前状态 | 运维入口 | Instructions |
|---|---|---|---|---|
| <name> | <launchd / cron / docker / systemd / manual> | <已加载 / 待 load / 已停用> | <repo own：install/uninstall/status 子集；vendored：原生接口> | <文件路径 + 章节> |

## 隐含依赖

按需列出"不在 repo 内但影响服务运行"的依赖：

| 依赖 | 必须的设置 | 验证方式 |
|---|---|---|
| <依赖，如 Docker daemon> | <必须的设置，如 "Start at login"> | <验证，如 `docker info`> |

## 验证

一次性把所有服务跑通的命令清单——新机器部署或大改动后跑一遍。

## 卸载 / 切换

服务从自启切回手动、或换 supervisor 时的步骤。
```

### 其它 operations/ 文件

`monitoring.md` / `incidents.md` / `runbooks/<scenario>.md` 等没有强制模板——按内容写成 Mutable snapshot 或时间序列条目。incidents.md 内部可参考 experiences/ 的条目格式（按日期 append-only）。

---

## 4.13 data/

### sources.md

每个外部源让读者一眼回答：能取什么 / 可不可信 / 怎么调 / 何时该换。能力随权限与源改版变化，结论带实测日期。

```markdown
# 数据源

> Mutable snapshot. 外部数据源的能力 / 可信度分级 / 用法。能力会变，结论带日期。

## <源名>

- **角色 / 覆盖**：提供哪些数据（实体 / 字段 / 粒度 / 覆盖范围）
- **实测能力（YYYY-MM-DD）**：逐能力 / 逐接口探测结果——能取什么、**不能取什么**
- **可信度分级**：A 可信（官方 + 守护 → 可作结论底座）/ B 脆弱（抓取 / 短史 / 无守护 → 标"存疑"、优先交叉校验）/ C 不可信（已知缺陷 / 过时 → 勿用；列出仅为警示，防 agent 重新发现误用）+ 理由
- **用法 / 限制 / 认证**：入口、限频、token / 权限、已知坑
- **扩展触发点**：什么时候需要升级权限 / 换源
```

### inventory.md

回答"现在到底有什么数据、多新、哪份权威"。

```markdown
# 物化数据盘点

> Mutable snapshot + 权威清单。项目实际物化 / 缓存了哪些数据、覆盖、新鲜度、source-of-truth、治理。
> store 大 / 活时：权威清单由 `<regen 命令>` 生成，本文件是 curated 概览；store 小 / 静态 bundled 时：下表自身即权威，可省 regen。快照日期 <YYYY-MM-DD>。

## Source-of-truth

- source-of-truth：`<路径 / store>`（如 SQLite cache / parquet 目录）——数据真源
- 权威清单生成命令：`<command>`（store 大 / 活时跑它再生成下表概览；静态 bundled 时下表自身即权威，无此命令）

## 概览（<YYYY-MM-DD> 快照）

可信度分级 A/B/C 定义见 sources.md；无外部源（inventory-only）时本列只标来源、省 A/B/C。

| 数据集 / 表 | 数据源（可信度分级） | 覆盖（实体 / 范围 / 字段） | 新鲜度 | 规模 | 备注 |
|---|---|---|---|---|---|
| <name> | <数据源（A/B/C）> | <...> | <最近刷新 / as-of> | <rows / size> | <...> |

## 治理

- **弃用 / 不可信数据**：明确标出哪些勿用（避免 agent 误读为可用）
- **清理 / 迁移注意**：<...>
```
