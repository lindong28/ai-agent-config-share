---
argument-hint: <claude-or-agents-md-path> [max-principle-per-subagent=2]
description: 审查并修复单个项目级或 user-level CLAUDE.md / AGENTS.md 指令文件的写作质量与结构。规则栈加载关系、跨文件冲突与 workspace 实践合规走 review-agent-rules。
---

# review-claude-md

输入 (`$ARGUMENTS`)：待审 CLAUDE.md / AGENTS.md 文件路径，可附加 `max-principle-per-subagent=N` 覆盖默认值。输入是 symlink 时审查其实际 source，同时保留原入口、symlink 链路与 consumer scope，避免同源文件被重复修改或按错误 scope 审查。

## 参数

| 参数 | 必需 | 默认 | 说明 |
|---|---|---|---|
| max-principle-per-subagent | ✗ | 2 | 每个 subagent 至多分配的 principle 数量；值越小，每条原则获得越多注意力。默认 2 使 principle 集合分成多组并行审查；设为 ≥ principle 总数会退化为单 subagent 审全部 + 全文件，注意力稀释且失去分组独立冗余，只在明确要省开销时才调大 |

## 工作流

控制骨架：**解析 source 与 consumer scope → unresolved 则报告并停止；否则审查 → 决策 → 落地 → 任一 edit（含 principles edit）后回到审查（首轮完整、remediation 轮 scope-locked 闭合）；无 edit 则输出**。展示与提问风格遵循 `~/.claude/references/deep-discuss-style.md`——subagent 输出报告与主 session 提问都适用。

### 1. 审查（分组并行 subagent）

先确定 source 的实际 consumer 集合及 project / user loading scope，并保留入口与链路作为 scope evidence；同一 source 有多个加载入口时合并其 consumer。无法确认 scope 时报告 `unresolved`，不要猜测或进入修复。

将 principles 按 `max-principle-per-subagent` 均匀分组，每组 spawn 一个 `general-purpose-readonly` subagent **并行**审查。值越小，每条原则获得越多注意力。spawn 时**不传 `name`**——判据见 `~/.claude/references/delegation-policy.md` §Harness transport。

每个 subagent 的输入：
- `~/.claude/references/claude-md-review-principles.md`（传完整文件——相邻原则提供边界上下文，帮助 subagent 避免报告属于其他组的发现；明确告知只应用分配给该 subagent 的那几条 principle）
- `~/.claude/references/deep-discuss-style.md`
- 目标 source 文件，以及 `source path | consumer scope | scope evidence`

每个 subagent 只输出其负责的 principle 维度下的违反/borderline 发现，并逐 section 声明覆盖（审了目标的哪些 section、各 section 在其 principle 维度下是 clean 还是有 finding），使漏审在报告中可见而非静默。subagent 不修改文件、不发 AskUserQuestion。

所有 subagent 完成后，主 session 汇总全部报告：去重、标注每条发现来自哪个 principle、解决跨 principle 冲突，并核对每个 subagent 是否声明覆盖目标全部 section——缺口计入 unresolved / 覆盖范围，不当作 clean。

### 2. 决策

基于 subagent 报告 + 主 session 判断分流：

| 修复性质 | 判定 | 处置 |
|---|---|---|
| 机械修复 | 修法唯一或近唯一，且不改变用户级取舍 | 进入无需提问的落地队列 |
| 真取舍 | 是否接受 finding 存在合理分歧、修法多路各有代价，或会改变指令 scope / 承诺 / 交互策略 | 整理为 `AskUserQuestion` 让用户决策 |

注意 bias：主 session 看过自己写的内容，对 subagent 发现做反驳前先自检"我是在反驳还是在辩护"。当一个 subagent 的发现或反驳要否决另一个时，先核实它依赖的事实主张（"某条目存在/缺失""同类条目都如此"）再裁决——subagent 会臆造存在性事实，未核实的错误前提会击败正确发现。

### 3. 落地

按第 2 阶段的分流结果落地：执行机械修复队列，真取舍按用户选择 Edit。

若审查发现现有原则未覆盖某类问题，用 AskUserQuestion 把「是否改进 `~/.claude/references/claude-md-review-principles.md`」作为一项决策交用户拍板——principles 缺口是高杠杆发现，只在 prose 里附带提及会被略过、用户遗忘后同类坑复发。获批并改完后执行 `/custom:review-skill claude-md-review-principles.md` 循环审查改动。

普通修复与 principles-gap 分支都处理完后统一判断：均无 edit 则循环终止。有 edit 则复审，收敛判据不变——直到一轮复审无需修。复审分两种：

- **首轮 edit 后**：按当前标尺完整重审目标。
- **此后每轮 remediation**：改用 scope-locked 闭合检查——只审被改 section + 该轮可能引入的新问题，禁止重开与本轮改动无关的 section / principle。闭合检查仍由独立中立 subagent 执行、prompt 仍遵守下方「重跑 prompt 不中立」反模式；scope 缩小不等于跳过独立判断。

## 输出

最终报告列出 source 与 consumer scope、findings / decisions / edits、复审结果及 unresolved。无 finding 时明确报告 `CLEAN` 与实际覆盖范围；scope 未确认时不得声明 `CLEAN`。

---

## 反模式

- **减少 subagent 数量**：不要因 diff 小而超出 max-principle-per-subagent 分组上限——分组参数保证每条原则获得充分注意力，不因工作量看似少就放宽。
- **跳过重跑**：不要因改动小或"显然安全"而跳过 Phase 3 的复审循环——编辑者对自己改动有 confirmation bias，复审的价值恰恰在于独立于编辑者的判断。remediation 轮的 scope-locked 闭合检查（机制见 Phase 3）不算跳过；把它降级成"自己看一眼"才是跳过。
- **重跑 prompt 不中立**：重跑时给 subagent 的 prompt 必须是中立重审，禁止把「上一轮 fix 想达成什么 / 去确认它生效」当成功判据喂给 subagent。确认式框架（"verify 这个 fix 解决了 X" / "确认没 reintroduce Y"）把 subagent 推向印证编辑者的修复而非独立挖洞，让编辑者自伤引入的 over-correction 撑过多轮。
