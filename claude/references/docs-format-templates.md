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
