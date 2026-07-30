---
argument-hint: <contract-path> [max-principle-per-subagent=3]
description: 审查一份 ux-contract.md（通常在 docs/contracts/ 下）是否完整、可验收，并修复发现的问题。用于你写好一份验收契约、想在据此执行 UX 测试前审查它时。
---

# review-ux-contract

输入 (`$ARGUMENTS`)：待审 contract 文件路径（通常是 `docs/contracts/ux-contract.md`），可附加 `max-principle-per-subagent=N` 覆盖默认值。

## 参数

| 参数 | 必需 | 默认 | 说明 |
|---|---|---|---|
| max-principle-per-subagent | ✗ | 3 | 每个 subagent 至多分配的 principle 数量；值越小，每条原则获得越多注意力 |

## 工作流

循环 3 阶段：**审查 → 决策 → 落地**。任一阶段产生改动后回到第 1 阶段重跑，直到无新发现。展示与提问风格遵循 `~/.claude/references/deep-discuss-style.md`——subagent 输出报告与主 session 提问都适用。

### 1. 审查（分组并行 subagent）

将 principles 按 `max-principle-per-subagent` 均匀分组，每组 spawn 一个 general-purpose subagent **并行**审查。

按目标 contract 在 L1 声明的产品类型，查 `~/.claude/references/domain-registry.md` 加载适用的 domain 原则文件，一并纳入上述分组；承接该 domain 原则的 subagent 额外收到对应文件、以及主 session 从 registry 查得的该类型对应契约段名，按其 review flag lens 审该契约段是否到位（subagent 不读 registry，契约段名由主 session 解析后写入其 prompt）。

每个 subagent 的输入：
- `~/.claude/references/ux-contract-review-principles.md`（传完整文件——相邻原则提供边界上下文，帮助 subagent 避免报告属于其他组的发现；明确告知只应用分配给该 subagent 的那几条 principle）
- `~/.claude/references/deep-discuss-style.md`
- 目标 contract 文件

每个 subagent 只输出其负责的 principle 维度下的违反/borderline 发现。subagent 不修改文件、不发 AskUserQuestion。

所有 subagent 完成后，主 session 汇总全部报告：去重、标注每条发现来自哪个 principle、按优先级排序（编号小者胜）。

### 2. 决策

基于 subagent 报告 + 主 session 判断，整理为 `AskUserQuestion` 让用户决策。注意 bias：主 session 看过自己写的内容，对 subagent 发现做反驳前先自检"我是在反驳还是在辩护"。当一个 subagent 的发现或反驳要否决另一个时，先核实它依赖的事实主张（"某条目存在/缺失""同类条目都如此"）再裁决——subagent 会臆造存在性事实，未核实的错误前提会击败正确发现。不预设修复让用户照单全收。

### 3. 落地

按用户选择 Edit。若有改动，回到第 1 阶段，按完整流程重跑；无改动则循环终止。

若审查发现现有原则未覆盖某类问题，用 AskUserQuestion 把「是否改进 `~/.claude/references/ux-contract-review-principles.md`」作为一项决策交用户拍板——principles 缺口是高杠杆发现，只在 prose 里附带提及会被略过、用户遗忘后同类坑复发。改完后对该 principles 文件跑一次 `/custom:review-skill` 循环审查改动。注意本仓未收录专审 meta-原则的 `/custom:review-principles`，所以「这套原则本身立不立得住」这一维度**不被覆盖**——按 review-skill 类型 gate 的要求在报告中声明该维度未审，别当作已过 meta-原则。

---

## 反模式

- **减少 subagent 数量**：不要因 diff 小而超出 max-principle-per-subagent 分组上限——分组参数保证每条原则获得充分注意力，不因工作量看似少就放宽。
- **跳过重跑**：不要因改动小或"显然安全"而跳过第 3 阶段的重跑循环——编辑者对自己改动有 confirmation bias，重跑的价值恰恰在于独立于编辑者的判断。
- **重跑 prompt 不中立**：重跑时给 subagent 的 prompt 必须是中立重审，禁止把「上一轮 fix 想达成什么 / 去确认它生效」当成功判据喂给 subagent。确认式框架（"verify 这个 fix 解决了 X" / "确认没 reintroduce Y"）把 subagent 推向印证编辑者的修复而非独立挖洞，让编辑者自伤引入的 over-correction 撑过多轮。
