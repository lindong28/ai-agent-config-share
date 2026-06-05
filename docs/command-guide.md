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
| `/custom:supervise [--backend codex\|gemini\|claude] [--autopilot] <task>` | Claude 作为 supervisor 用 codeagent-wrapper 跑**开放式任务（无 plan.md）**：spawn 前锁定 success criteria + backend，过程中代答简单决策 / 升级复杂决策（`--autopilot` 则全程不打扰），agent 早停则 resume 续命，结束把 agent 行为问题沉淀到 `docs/issues/general.md` | 是（按 success criteria + Stop Gate resume 收敛） |
| `/custom:resolve-issues [--source <path>] <目标>` | 围绕一个目标批量解决项目 issue：按目标 triage（核实存在性 + consumer scope，回写陈旧项），用户批准后按依赖顺序委派 agent 逐个解决并闭环回灌新 issue | 是（逐 issue 委派 + 回灌循环） |
| `/custom:test-ux <产品/PRD>` | 从自由文本 / PRD 做一次性 ad-hoc 模拟测试：模拟用户测试**已部署**的产品（web / desktop / mobile），输出 issue 清单 | 否（codeagent-wrapper 启动 codex session 执行，可 resume 续跑） |
| `/custom:create-ux-contract [产品上下文]` | 访谈用户写 ux-contract.md（L1 产品全貌 + L2 用户视角 verify + 验收侧重），作为 UX 验收基准 | 内部自动调 `/custom:review-ux-contract` 循环至收敛 |
| `/custom:review-ux-contract <path>` | 按 `ux-contract-review-principles.md` 审查 ux-contract | 三阶段循环（审查→决策→落地），改动后回到第 1 步重审 |
| `/custom:execute-ux-contract <contract-path>` | Claude 作为 supervisor 把已审契约翻译为 test plan，驱动 Codex 跑端到端 UX 测试 + 修复闭环，直到 Critical/High 清零 | 是（test session + fix session 测-修循环） |
| `/custom:create-handoff` | 把 session 关键 context 落到 markdown 给新 session 接力 | 否（单次执行） |
| `/custom:update-docs [type...]` | 按 `docs-organization-protocol.md` 更新项目文档（docs/ + 根目录 README/CHANGELOG）；不指定类型则全部，为每类并行 spawn `doc-updater` agent | 否（并行 subagent 单次执行） |

注：所有 `create-*` / `fix-*` 命令**已经在内部 invoke 对应的 review 循环**. 但有时候内置的循环还是不够，需要额外手动多次触发review。

---

## 工作流组合

### A. 新功能开发：spec → plan → 实施

适用：UI 可操作项多 / user journey 多且复杂，需要更多 LLM 注意力补充验证路径——专门用 create-spec 先跟用户走一轮 L2 对齐才能把验证维度覆盖到位。典型如 web 多页面多状态产品、agent 类多步交互、AIGC / UX-heavy 产品。

```
1. Claude Code 中执行：/custom:create-spec <任务描述>

2. Claude Code 中**循环**执行：/custom:review-spec plans/<date>-<name>/spec.md
   - 人工验证点: 读 spec.md，确认其中的'用户视角verify'对得上你的真实意图
   - 复杂场景: 手动多次触发 review，直到人工判断 Claude Code 基本查不出问题

3. Claude Code 新 session 中执行：/custom:create-plan 把这份 spec 转成 plan: plans/<date>-<name>/spec.md

4. Claude Code 中**循环**执行：/custom:review-plan plans/<date>-<name>/plan.md
   - 人工验证点: 读 plan.md，重点看 L3 中的 verify 步骤
   - 复杂场景: 手动多次触发 review，直到人工判断 Claude Code 基本查不出问题

5. Claude Code 中执行：/custom:execute-plan plans/<date>-<name>/plan.md
   - Claude supervise Codex 实施，按 Stop Gate 收敛；plan 有 UX 入口时自动跑 test-ux 闭环
```

### B. 不需要 spec 的快速 plan

适用：验证路径相对容易描述——少量可观测条件（命令输出 / 单一文件内容 / 单一 happy path）就能把"算成功"说清楚。create-plan 自带的 §2 facets 已足够覆盖 L1 / L2 / 取舍偏好对齐。典型如 CLI 工具 / 单文件改动 / 后端 bug fix / lib 函数改造。

```
1. Claude Code 中执行：/custom:create-plan <任务描述>

2. Claude Code 中**循环**执行：/custom:review-plan plans/<date>-<name>
   - 人工验证点: 读 plan.md，重点看 L3 中的 verify 步骤
   - 复杂场景: 手动多次触发 review，直到人工判断 Claude Code 基本查不出问题

3. Claude Code 中执行：/custom:execute-plan plans/<date>-<name>/plan.md
   - Claude supervise Codex 实施，按 Stop Gate 收敛
```

### C. 产品上线前 UX 测试（ad-hoc）

适用：web / desktop / mobile 产品在交给真人前先用 AI 模拟扫一遍。没有沉淀验收基准、只需一次性快速过一遍时用这条。输出 issue 清单，不带修复闭环。

```
/custom:test-ux 描述需要评测的产品功能/使用方式/PRD文档
```

### D. 契约驱动的 UX 验收：create → review → execute

适用：产品需要建立**系统性、可复用**的 user-observable 验收规格，且希望测试发现的 Critical/High issue 自动进入修复闭环。相比 C 的一次性 ad-hoc 测试，这条沉淀出一份可反复执行的 ux-contract，并由 supervisor 驱动 Codex 测+修直到收敛。

```
1. Claude Code 中执行：/custom:create-ux-contract [产品描述/入口/文档]
   - 访谈对齐 L1 产品全貌 + L2 用户视角 verify + 验收侧重
   - 内部自动跑 /custom:review-ux-contract 循环至收敛
   - 产出 docs/contracts/ux-contract.md

2. 人工验证点：读 ux-contract.md，确认 L2 验收规格覆盖你真实的上线诉求
   - 复杂场景：手动多次触发 /custom:review-ux-contract <contract path> 直到查不出问题

3. Claude Code 新 session 中执行：/custom:execute-ux-contract docs/contracts/ux-contract.md
   - supervisor 把契约翻译为 test plan，用独立 test session + fix session 跑测-修循环
   - 按 Stop Gate 收敛，Critical/High issue 清零后 commit（委托 create-commit skill）+ handoff
```

> C vs D：`test-ux` 是从自由文本 / PRD 临时拉起的一次性测试，无沉淀、无修复闭环；ux-contract 三件套沉淀可复用的验收规格，且 `execute-ux-contract` 自带测-修闭环。需要反复验收或想要自动修复时选 D。

### E. 监督开放式任务（无 plan）

适用：想让另一个 agent 完成一个**开放式任务但没有 plan.md**，并希望 Claude 监督质量、接管 routine 决策、沉淀过程中暴露的 agent 行为问题 / 工具缺口。

```
/custom:supervise [--backend codex|gemini|claude] [--autopilot] <任务描述>
```

- spawn 前 Claude 用 AskUserQuestion 跟你锁定 success criteria + backend（任务有明显领域归属时 supervisor 先给推荐）
- 执行中代答不改方向的简单决策、复杂决策升级你；`--autopilot` 则采纳 agent 自身推荐全程不打扰，事后在 handoff 的决策点列表里审查
- agent 早停按 success criteria + `plan-execution-principles.md` Stop Gate resume 同 session 续命
- 任务结束把观察到的 agent 行为问题 / 工具缺口沉淀到 `docs/issues/general.md`，供未来 agent 改进

> supervise vs execute-plan：两者都是 Claude-as-supervisor 驱动后台 agent。**有 plan.md 用 `/custom:execute-plan`**（plan 自带 verify gate，无需另锁 success criteria）；**开放式、无 plan 用 `/custom:supervise`**（spawn 前现场跟用户锁 success criteria）。纯研究 / 查询 / 单文件 trivial 改动直接做，不必付 supervisor overhead。

---

