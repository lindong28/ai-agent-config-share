---
argument-hint: <skill-path> [optimize]
description: 审查指定 SKILL.md / command 文件并按原则修复，可选叠加 optimize 模式。
disable-model-invocation: true
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

循环 3 阶段：**审查 → 决策 → 落地**。任一阶段产生改动后回到第 1 步重审，直到无新发现。展示与提问风格遵循 `~/.claude/references/deep-discuss-style.md`——subagent 输出报告与主 session 提问都适用。

### 1. 审查（subagent 独立跑）

spawn general-purpose subagent 跑独立审查，避免主 session 对自己写过的段产生 confirmation bias。

subagent 任务：读以下文件 + 目标文件，按维度报告违反/borderline——

- 必读：`~/.claude/references/skill-review-principles.md` + `~/.claude/references/deep-discuss-style.md`
- 启用 optimize 模式时追加：`~/.claude/references/skill-optimization-principles.md`
- 若本会话包含目标的创建过程，追加 `~/.claude/references/skill-creation-principles.md` 对创建过程做补充审查
- 若 diff 看起来是 session-level upgrade fix（基于观察到的失败行为对 skill 加指令），追加 `~/.claude/commands/custom/fix-skill-from-session.md` §2 Fix 设计 作为 diff-aware fix-review lens——重点 evaluate 每条新增的 fortification 是否 evidence-driven、强度是否过早升级

报告维度：
- **纵向**：按 review principles 逐条扫；optimize 模式下追加 3 条优化原则
- **横向**：对每个 section 跑 review principle-2 的 section-scope trust-the-model test

subagent 不修改文件、不发 AskUserQuestion，只输出发现报告。报告中明确标注每条发现来自 review 还是 optimize 原则集。

### 2. 决策

基于 subagent 报告 + 主 session 判断，整理为 `AskUserQuestion` 让用户决策。遵循 `~/.claude/references/deep-discuss-style.md` §How #2：

呈现 finding 时附主 session 的判断（同意 / 保留 / 反驳 + 理由），不只是 relay subagent 原文——用户需要看到这层加工才能 trust 决策依据。

**判断反模式**（论证依赖以下任一即不算合规证据）：

| 反模式 | 为什么不要 |
|---|---|
| 路径依赖（previously-was-worse）：用"前任版本更糟" / "上一轮 review 留下的 fix" 当作当前合规的证据 | 前任更糟与当前合规是两件事；fix 自身也要过原则审视 |

### 3. 落地

按用户选择 Edit。若有改动，回到第 1 步重审；无改动则循环终止。

若审查发现现有原则未覆盖某类问题，提议改进对应 principles 文件（用户决定）。
