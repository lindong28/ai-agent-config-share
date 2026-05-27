---
description: 审查 ux-contract.md 并按原则修复，结合实际产品部署验证。
---

# review-ux-contract

输入：待审 contract 文件路径（通常是 `docs/contracts/ux-contract.md`）。

## 工作流

循环 3 阶段：**审查 → 决策 → 落地**。任一阶段产生改动后回到第 1 步重审，直到无新发现。展示与提问风格遵循 `~/.claude/references/deep-discuss-style.md`——subagent 输出报告与主 session 提问都适用。

### 1. 审查（subagent 独立跑）

spawn general-purpose subagent 跑独立审查，避免主 session 对自己写过的段产生 confirmation bias。

subagent 任务：读 `~/.claude/references/ux-contract-review-principles.md`（按优先级——编号小者胜）+ `~/.claude/references/deep-discuss-style.md` + 目标 contract 文件 + **访问实际产品部署验证 contract-reality alignment**（按 contract 中记录的产品入口；入口不可访问时在报告中标注 unable to verify，不跳过），按原则逐条扫报告违反/borderline。subagent 不修改文件、不发 AskUserQuestion，只输出发现报告。

### 2. 决策

基于 subagent 报告 + 主 session 判断，整理为 `AskUserQuestion` 让用户决策。注意 bias：主 session 看过自己写的内容，对 subagent 发现做反驳前先自检"我是在反驳还是在辩护"。不预设修复让用户照单全收。

### 3. 落地

按用户选择 Edit。若有改动，回到第 1 步（重新 spawn subagent 独立审查，不可用主 session 自审替代）；无改动则循环终止。

若审查发现现有原则未覆盖某类问题，提议改进 `~/.claude/references/ux-contract-review-principles.md`（用户决定）。改完后执行 `/custom:review-principles ux-contract-review-principles.md` 循环审查改动——principles 文件本身也要过 meta-原则。
