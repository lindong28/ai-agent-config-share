---
description: 审查指定 plan 文件并按原则修复。
---

# review-plan

输入：待审 plan 文件路径（默认 `.claude/plans/` 最新一份）。

## 工作流

循环 3 阶段：**审查 → 决策 → 落地**。任一阶段产生改动后回到第 1 步重审，直到无新发现。展示与提问风格遵循 `~/.claude/references/deep-discuss-style.md`——subagent 输出报告与主 session 提问都适用。

### 1. 审查（subagent 独立跑）

spawn general-purpose subagent 跑独立审查，避免主 session 对自己写过的段产生 confirmation bias。

subagent 任务：读 `~/.claude/references/plan-review-principles.md`（按优先级——编号小者胜；conditional 原则仅在适用范围内生效）+ `~/.claude/references/deep-discuss-style.md` + 目标文件，按原则逐条扫报告违反/borderline。subagent 不修改文件、不发 AskUserQuestion，只输出发现报告。

### 2. 决策

基于 subagent 报告 + 主 session 判断，整理为 `AskUserQuestion` 让用户决策。注意 bias：主 session 看过自己写的内容，对 subagent 发现做反驳前先自检"我是在反驳还是在辩护"。不预设修复让用户照单全收。

### 3. 落地

按用户选择 Edit。若有改动，回到第 1 步重审；无改动则循环终止。

若审查发现现有原则未覆盖某类问题，提议改进 `~/.claude/references/plan-review-principles.md`（用户决定）。
