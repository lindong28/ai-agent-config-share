---
argument-hint: <skill-path> [optimize]
description: 审查指定 SKILL.md / command 文件并按原则修复，可选叠加 optimize 模式。
---

# review-skill

输入 (`$ARGUMENTS`)：待审 SKILL.md / command 文件路径，可附加优化意图启用 optimize 模式。

## 参数

| 参数 | 必需 | 类型 | 默认 | 说明 |
|---|---|---|---|---|
| skill-path | ✓ | 字符串 | — | 待审 SKILL.md / command 文件路径 |
| optimize | ✗ | boolean | false | 是否叠加优化审查（在 review 之外追加架构精简维度） |

## 模式

- **review-only**（默认）：仅应用 `~/.claude/references/skill-review-principles.md`，找违反/borderline。
- **review + optimize**：额外应用 `~/.claude/references/skill-optimization-principles.md`，找架构精简机会。

optimize 启用判定：用户在 `$ARGUMENTS` 或原始 prompt 中表达了优化意图（语义判断，不限于"精简 / 减 token / optimize"等措辞）→ 启用；意图不明确 → 用 AskUserQuestion 询问，不要默认启用。

## 工作流

循环 3 阶段：**审查 → 决策 → 落地**。任一阶段产生改动后回到第 1 步重跑，直到无新发现。展示与提问风格遵循 `~/.claude/references/deep-discuss-style.md`——subagent 输出报告与主 session 提问都适用。

### 1. 审查（per-principle 并行 subagent）

每条 principle 各 spawn 一个 general-purpose subagent **并行**跑独立审查，确保每条原则获得充分注意力，不因原则数量增长而稀释。

每个 subagent 的输入：
- `~/.claude/references/skill-review-principles.md`（传完整文件而非截取单条——相邻原则提供边界上下文，帮助 subagent 避免报告属于其他 principle 的发现；但明确告知只应用指定的那一条 principle）
- `~/.claude/references/deep-discuss-style.md`
- 目标文件

每个 subagent 只输出其负责的 principle 维度下的违反/borderline 发现。subagent 不修改文件、不发 AskUserQuestion。

追加维度（按情况额外 spawn）：
- 启用 optimize 模式时：额外 spawn 1 个 subagent 应用 `~/.claude/references/skill-optimization-principles.md` 全部 3 条
- 若本会话包含目标的创建过程：额外 spawn 1 个 subagent 应用 `~/.claude/references/skill-creation-principles.md`
- 若 diff 看起来是 session-level upgrade fix：额外 spawn 1 个 subagent 应用 `~/.claude/commands/custom/fix-skill-from-session.md` §2 Fix 设计 作为 diff-aware fix-review lens

所有 subagent 完成后，主 session 汇总全部报告：去重、标注每条发现来自哪个 principle、解决跨 principle 冲突。

### 2. 决策

基于 subagent 报告 + 主 session 判断，整理为 `AskUserQuestion` 让用户决策。遵循 `~/.claude/references/deep-discuss-style.md` §How #2：

呈现 finding 时附主 session 的判断（同意 / 保留 / 反驳 + 理由），不只是 relay subagent 原文——用户需要看到这层加工才能 trust 决策依据。

**判断反模式**（论证依赖以下任一即不算合规证据）：

| 反模式 | 为什么不要 |
|---|---|
| 路径依赖（previously-was-worse）：用"前任版本更糟" / "上一轮 review 留下的 fix" 当作当前合规的证据 | 前任更糟与当前合规是两件事；fix 自身也要过原则审视 |
| 未核实事实主张：让一个 subagent 的发现/反驳否决另一个，却没核实它依赖的"某条目存在/缺失""同类条目都如此"等主张 | subagent 会臆造存在性事实，未核实的错误前提会击败正确发现 |

### 3. 落地

按用户选择 Edit。若有改动，回到第 1 步——按 Phase 1 完整流程重跑；无改动则循环终止。

若审查发现现有原则未覆盖某类问题，用 AskUserQuestion 把「是否改进对应 principles 文件」作为一项决策交用户拍板——principles 缺口是高杠杆发现，只在 prose 里附带提及会被略过、用户遗忘后同类坑复发。改完后执行 `/custom:review-principles <principles-file>` 循环审查改动——principles 文件本身也要过 meta-原则。

---

## 反模式

- **合并 subagent**：不要因 diff 小或原则相关而把多条原则塞进同一个 subagent——独立性保证的是跨原则交叉发现不被单 subagent 的上下文污染。
- **跳过重跑**：不要因改动小或"显然安全"而跳过 Phase 3 的重跑循环——编辑者对自己改动有 confirmation bias，重跑的价值恰恰在于独立于编辑者的判断。
