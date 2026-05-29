---
argument-hint: <spec-path> [max-principle-per-subagent=3]
description: 审查指定 spec 文件（create-spec 产出的 spec.md）并按原则修复。
---

# review-spec

输入 (`$ARGUMENTS`)：待审 spec 文件路径（通常是 `./plans/<date>-<name>/spec.md`），可附加 `max-principle-per-subagent=N` 覆盖默认值。

## 参数

| 参数 | 必需 | 默认 | 说明 |
|---|---|---|---|
| max-principle-per-subagent | ✗ | 3 | 每个 subagent 至多分配的 principle 数量；值越小，每条原则获得越多注意力 |

## 工作流

循环 3 阶段：**审查 → 决策 → 落地**。任一阶段产生改动后回到第 1 步重跑，直到无新发现。展示与提问风格遵循 `~/.claude/references/deep-discuss-style.md`——subagent 输出报告与主 session 提问都适用。

### 1. 审查（分组并行 subagent）

将 principles 按 `max-principle-per-subagent` 均匀分组，每组 spawn 一个 general-purpose subagent **并行**审查。值越小，每条原则获得越多注意力。

每个 subagent 的输入：
- `~/.claude/references/spec-review-principles.md`（传完整文件——相邻原则提供边界上下文，帮助 subagent 避免报告属于其他组的发现；明确告知只应用分配给该 subagent 的那几条 principle）
- `~/.claude/references/deep-discuss-style.md`
- 目标 spec 文件

每个 subagent 只输出其负责的 principle 维度下的违反/borderline 发现。subagent 不修改文件、不发 AskUserQuestion。

所有 subagent 完成后，主 session 汇总全部报告：去重、标注每条发现来自哪个 principle、按优先级排序（编号小者胜）。

### 2. 决策

基于 subagent 报告 + 主 session 判断，整理为 `AskUserQuestion` 让用户决策。注意 bias：主 session 看过自己写的内容，对 subagent 发现做反驳前先自检"我是在反驳还是在辩护"。不预设修复让用户照单全收。

### 3. 落地

按用户选择 Edit。若有改动，回到第 1 步——按 Phase 1 完整流程重跑；无改动则循环终止。

若审查发现现有原则未覆盖某类问题，提议改进 `~/.claude/references/spec-review-principles.md`（用户决定）。

---

## 反模式

- **减少 subagent 数量**：不要因 diff 小而超出 max-principle-per-subagent 分组上限——分组参数保证每条原则获得充分注意力，不因工作量看似少就放宽。
- **跳过重跑**：不要因改动小或"显然安全"而跳过 Phase 3 的重跑循环——编辑者对自己改动有 confirmation bias，重跑的价值恰恰在于独立于编辑者的判断。
