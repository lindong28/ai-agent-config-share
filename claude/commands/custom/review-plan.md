---
argument-hint: <plan-path> [max-principle-per-subagent=5]
description: 审查一份实现 plan.md，逐条对照 plan-review principle 修复。用于你在开始实施前，想审查该 plan 的完整性、可执行性与取舍是否站得住时。
---

# review-plan

输入 (`$ARGUMENTS`)：待审 plan 文件路径（默认 `.claude/plans/` 最新一份），可附加 `max-principle-per-subagent=N` 覆盖默认值。

## 参数

| 参数 | 必需 | 默认 | 说明 |
|---|---|---|---|
| max-principle-per-subagent | ✗ | 5 | 每个 subagent 至多分配的 principle 数量；值越小，每条 principle 获得越多注意力 |

## 工作流

循环 3 阶段：**审查 → 决策 → 落地**。任一阶段产生改动后回到第 1 阶段重跑，直到无新发现。展示与提问风格遵循 `~/.claude/references/deep-discuss-style.md`——subagent 输出报告与主 session 提问都适用。

### 1. 审查（分组并行 subagent）

将 principles 按 `max-principle-per-subagent` 均匀分组，每组 spawn 一个 general-purpose subagent 并行审查。

每个 subagent 的输入：
- `~/.claude/references/plan-review-principles.md`（传完整文件——相邻 principle 提供边界上下文，帮助 subagent 避免报告属于其他组的发现；明确告知只应用分配给该 subagent 的那几条 principle。conditional principle 仅在适用范围内生效）
- `~/.claude/references/deep-discuss-style.md`
- 目标文件

每个 subagent 只输出其负责的 principle 下的违反/borderline 发现。subagent 不修改文件、不发 AskUserQuestion。

所有 subagent 完成后，主 session 汇总全部报告：去重、标注每条发现来自哪个 principle、按优先级排序（编号小者胜）。

### 2. 决策

基于 subagent 报告 + 主 session 判断，整理为 `AskUserQuestion` 让用户决策；不预设修复让用户照单全收。裁决时防以下 bias——主 session 看过自己写的内容，易替自己辩护：

- 对 subagent 发现做反驳前先自检"我是在反驳还是在辩护"。
- 当一个 subagent 的发现或反驳要否决另一个时，先核实它依赖的事实主张（"某条目存在/缺失""同类条目都如此"）再裁决——subagent 会臆造存在性事实，未核实的错误前提会击败正确发现。

### 3. 落地

按用户选择 Edit。若有改动，回到第 1 阶段按完整流程重跑；无改动则循环终止。

若审查发现现有 principle 未覆盖某类问题，用 AskUserQuestion 把「是否改进 `~/.claude/references/plan-review-principles.md`」作为一项决策交用户拍板——principles 缺口是高杠杆发现，只在 prose 里附带提及会被略过、用户遗忘后同类坑复发。改完后执行 `/custom:review-principles plan-review-principles.md` 循环审查改动——principles 文件本身也要过 meta-principle。

---

## 反模式

- **减少 subagent 数量**：不要因 diff 小而超出 max-principle-per-subagent 分组上限——分组参数保证每条 principle 获得充分注意力，不因工作量看似少就放宽。
- **跳过重跑**：不要因改动小或"显然安全"而跳过第 3 阶段的重跑循环——编辑者对自己改动有 confirmation bias，重跑的价值恰恰在于独立于编辑者的判断。
- **重跑 prompt 不中立**：重跑时给 subagent 的 prompt 必须中立，禁止把「上一轮 fix 想达成什么 / 去确认它生效」当成功判据喂给 subagent。确认式框架（"verify 这个 fix 解决了 X" / "确认没 reintroduce Y"）把 subagent 推向印证编辑者的修复而非独立挖洞，让编辑者自伤引入的 over-correction 撑过多轮。
