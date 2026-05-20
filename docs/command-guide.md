# Command Guide

针对常见开发阶段的 command 组合用法。

## Commands 速查

| Command | 作用 | 自动循环？ |
|---|---|---|
| `/custom:create-spec <task>` | 写 spec.md（L1 产物 + L2 用户视角 verify + 横切取舍偏好的交付契约） | 内部自动调 `/custom:review-spec` 循环至无新发现 |
| `/custom:create-plan <task>` | 写 plan.md（含 L3 设计 + 内部 verify；可读 spec 为输入） | 内部自动调 `/custom:review-plan` 循环至无新发现 |
| `/custom:review-spec <path>` | 按 `spec-review-principles.md` 审查 spec | 三阶段循环（审查→决策→落地），改动后回到第 1 步重审 |
| `/custom:review-plan <path>` | 按 `plan-review-principles.md` 审查 plan | 同上 |
| `/custom:review-skill <path> [optimize]` | 按 `skill-review-principles.md` 审查 skill/command；`optimize` 叠加体积优化维度 | 同上 |
| `/custom:create-skill-from-workflow` | 把刚执行的工作流提取为可复用 skill / command | 内部自动调 `/custom:review-skill` 循环 |
| `/custom:fix-skill-from-session [问题]` | 扫 session 中 skill / command 的错行为，定位 source-level 修复 | 内部自动调 `/custom:review-skill` 循环 |
| `/custom:execute-plan <plan.md>` | Claude 作为 supervisor 启动 Codex 实施 plan.md：按 Stop Gate 收敛；plan 有 UX 入口则自动跑 `/custom:test-ux` 把 Critical/High issue 回灌 Codex 直到清 | 是（Stop Gate + UX 验收双循环） |
| `/custom:test-ux` | 模拟用户测试**已部署**的产品（web / desktop / mobile），输出 issue 清单 | 否（fan-out subagents 单次执行） |
| `/custom:create-handoff` | 把 session 关键 context 落到 markdown 给新 session 接力 | 否（单次执行） |

注：所有 `create-*` / `fix-*` 命令**已经在内部 invoke 对应的 review 循环**. 但有时候内置的循环还是不够，需要额外手动多次触发review。

---

## 工作流组合

### A. 新功能开发：spec → plan → 实施

适用：UI 可操作项多 / user journey 多且复杂，需要更多 LLM 注意力补充验证路径——专门用 create-spec 先跟用户走一轮 L2 对齐才能把验证维度覆盖到位。典型如 web 多页面多状态产品、agent 类多步交互、AIGC / UX-heavy 产品。

```
1. Claude Code 中执行：/custom:create-spec <任务描述>

2. Claude Code 中**循环**执行：/custom:review-spec plans/<name>-<date>/spec.md
   - 人工验证点: 读 spec.md，确认其中的'用户视角verify'对得上你的真实意图
   - 复杂场景: 手动多次触发 review，直到人工判断 Claude Code 基本查不出问题

3. Claude Code 新 session 中执行：/custom:create-plan 把这份 spec 转成 plan: plans/<name>-<date>/spec.md

4. Claude Code 中**循环**执行：/custom:review-plan plans/<name>-<date>/plan.md
   - 人工验证点: 读 plan.md，重点看 L3 中的 verify 步骤
   - 复杂场景: 手动多次触发 review，直到人工判断 Claude Code 基本查不出问题

5. Claude Code 中执行：/custom:execute-plan plans/<name>-<date>/plan.md
   - Claude supervise Codex 实施，按 Stop Gate 收敛；plan 有 UX 入口时自动跑 test-ux 闭环
```

### B. 不需要 spec 的快速 plan

适用：验证路径相对容易描述——少量可观测条件（命令输出 / 单一文件内容 / 单一 happy path）就能把"算成功"说清楚。create-plan 自带的 §2 facets 已足够覆盖 L1 / L2 / 取舍偏好对齐。典型如 CLI 工具 / 单文件改动 / 后端 bug fix / lib 函数改造。

```
1. Claude Code 中执行：/custom:create-plan <任务描述>

2. Claude Code 中**循环**执行：/custom:review-plan plans/<name>-<date>
   - 人工验证点: 读 plan.md，重点看 L3 中的 verify 步骤
   - 复杂场景: 手动多次触发 review，直到人工判断 Claude Code 基本查不出问题

3. Claude Code 中执行：/custom:execute-plan plans/<name>-<date>/plan.md
   - Claude supervise Codex 实施，按 Stop Gate 收敛
```

### C. 产品上线前 UX 测试

适用：web / desktop / mobile 产品在交给真人前先用 AI 模拟扫一遍。

```
/custom:test-ux 描述需要评测的产品功能/使用方式/PRD文档
```

---

