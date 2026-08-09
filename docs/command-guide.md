# Command Guide

针对常见开发阶段的 command 组合用法。

## Commands 速查

| Command | 作用 | 自动循环？ |
|---|---|---|
| `/custom:create-spec <task>` | 写 spec.md（L1 产物 + L2 用户视角 verify + 横切取舍偏好的交付契约） | 内部自动调 `/custom:review-spec` 循环至无新发现 |
| `/custom:create-plan <task> [给我 N 份方案]` | 写 plan.md（含 L3 设计 + 内部 verify；可读 spec 为输入）。**判据是方案要不要交给新的 implementer context 独立接手**，与改动大小无关——单文件且不交接、或方案本轮用完即弃时不走它。默认 bootstrap long-task 模式（plan.md banner + state.md / journal.md），送审前会把阻塞在外部事实上的分支拆成独立 plan；附「给我 N 份方案」则启用 Best-of-N，产出多份候选供挑 | 内部自动调 `/custom:review-plan` 循环至其 severity gate 收敛（非"零发现"） |
| `/custom:review-spec <path>` | 按 `spec-review-principles.md` 审查 spec | 三阶段循环（审查→决策→落地），改动后回到第 1 步重审 |
| `/custom:review-plan <path>` | 按 `plan-review-principles.md` 审查 plan | 循环，但收敛判据是 severity gate（非"零发现"）+ 默认 2 轮预算与停滞熔断，残余项经 AskUserQuestion 交你拍板 |
| `/custom:review-skill <path> [optimize]` | 按 `skill-review-principles.md` 审查并按需修复单个 SKILL.md、command、agent 定义或 reference（含 principles 文件——但本仓未收录专审 meta-原则的命令，所以「这套原则本身立不立得住」这一维度不被覆盖，reviewer 会声明该维度未审）；`optimize` 叠加体积优化维度 | 循环，但重审范围由修复 diff 的影响面界定，不整份重跑全部原则 |
| `/custom:create-skill-from-workflow` | 把刚执行的工作流提取为可复用 skill / command | 内部自动调 `/custom:review-skill` 循环 |
| `/custom:fix-skill-from-session [问题]` | 扫 session 中 skill / command 的错行为，定位 source-level 修复（受理面比 review-skill 宽：CLAUDE.md、hook、settings 都在 fix 范围内） | 是，但**按落点分派**到对应的 review 命令，不一律走 `review-skill` |
| `/custom:execute-plan <plan.md>` | Claude 作为 supervisor 启动 Codex 实施 plan.md：按 Stop Gate 收敛；随后按 plan 声明分流 UX 验收——声明了「UX 契约影响」就应用契约并按契约验证，只有 UX 入口就跑一遍探索式 `/custom:test-ux`，发现的 issue 回灌给 Codex 直到清零 | 是（Stop Gate + UX 验收双循环） |
| `/custom:supervise [--backend codex\|gemini\|claude] [--autopilot] <task>` | Claude 作为 supervisor 用 codeagent-wrapper 跑**开放式任务（无 plan.md）**：spawn 前锁定 success criteria + backend，过程中代答简单决策 / 升级复杂决策（`--autopilot` 则全程不打扰），agent 早停则 resume 续命，结束把 agent 行为问题沉淀到 `docs/issues/general.md` | 是（按 success criteria + Stop Gate resume 收敛） |
| `/custom:resolve-issues [--source <path>] <目标>` | 围绕一个目标批量解决项目 issue：按目标 triage（核实存在性 + consumer scope，回写陈旧项），用户批准后按依赖顺序委派 agent 逐个解决并闭环回灌新 issue | 是（逐 issue 委派 + 回灌循环） |
| `/custom:test-ux <产品/PRD>` | 从自由文本 / PRD 做一次性 ad-hoc 模拟测试：模拟用户测试**已部署**的产品（web / desktop / mobile），输出 issue 清单 | 否（codeagent-wrapper 启动 codex session 执行，可 resume 续跑） |
| `/custom:create-ux-contract [产品上下文]` | 访谈用户写 ux-contract.md（L1 产品全貌 + L2 用户视角 verify + 验收侧重），作为 UX 验收基准 | 内部自动调 `/custom:review-ux-contract` 循环至收敛 |
| `/custom:review-ux-contract <path>` | 按 `ux-contract-review-principles.md` 审查 ux-contract | 三阶段循环（审查→决策→落地），改动后回到第 1 步重审 |
| `/custom:execute-ux-contract <contract-path>` | Claude 作为 supervisor 把已审契约翻译为 test plan，驱动 Codex 跑端到端 UX 测试 + 修复闭环，直到可即时修复的 Critical/High/Medium 清零 | 是（test session + fix session 测-修循环） |
| `/custom:create-handoff` | 把 session 关键 context 落到 markdown 给新 session 接力。**先按 active-plan marker（`~/.claude/bin/active-plan show`）三态分流**：marker 指向本轮 plan → 不写 handoff（plan/state/journal 已是交接物）；在执行 plan 但 marker 缺失 → `active-plan set <plan.md>` 而非写 handoff；确无 plan 才写 | 否（单次执行） |
| `/custom:sync-docs [改了什么] [max-principle-per-subagent=5]` | 项目文档维护单入口（docs/ + 根 README/CHANGELOG）：给出改动描述则补该改动的文档，空参数则审查并修全部现有文档，docs/ 未初始化时先建结构。既可独立调用，也可作为 recipe 被 supervisor 编排复用（入口契约声明目标 repo / 源证据 / gate owner） | 是（审查→决策→落地→失效分析→重审，直到全部审查单元 coverage complete；终态是 `converged` 或 `blocked`，`awaiting-caller-gate` 是交回 caller 跑领域 gate 的中途状态、不是收尾） |
| `/custom:create-refactor-plan <scope> [--rescan]` | 为周期性还技术债写系统化重构 plan.md（提升可维护性 / 可扩展性 / 易读性），`--rescan` 续下一轮 | 内部自动调 `/custom:review-plan` 循环 |
| `/custom:absorb-skill <外部 skill>` | 把外部 skill / command 中有用的内容合并进已有本地 skill / command | 内部按落点分派 `/custom:review-skill` 等收敛 |
| `/custom:borrow-design <target> <reference>` | 对比两份 anatomy / design 文档，产出 consumer-aware、ROI 排序的 borrow checklist（不落地合并） | 否（单次执行，user-only） |
| `/custom:anatomize-llm-workflow <系统>` | 把 LLM 调用型系统的 workflow 提取成质量诊断地图、逐节点审查 prompt | 否（单次执行） |
| `/custom:create-eval-harness <判定 prompt>` | 给单个语义判定 prompt（judge / 分类 / 路由 / 抽取）建带标签 eval 与回归测试 | 否（单次执行） |
| `/custom:review-claude-md <path>` | 按 `claude-md-review-principles.md` 审查单个 CLAUDE.md / AGENTS.md 指令文件的写作质量与结构 | 三阶段循环（审查→决策→落地） |
| `/custom:review-agent-rules` | 审 agent 规则栈：加载关系、跨文件冲突、能力最小权限 | 否（单次审查 + 落地） |
| `/custom:review-session-skills` | 审当前 session 触发过的 skill / command 行为是否合规 | 否（单次审查 + 落地） |
| `/custom:review-memory` | 审跨 session 记忆（当前 harness 范围）是否准确 / 值得留存 | 否（单次审查 + 落地） |
| `/custom:review-alerting [项目根=cwd] [定位提示]` | 按 `alerting-review-principles.md` 审服务故障告警设计质量（值不值得 page、多严重、说什么、要不要合并）并修复 | 三阶段循环（审查→决策→落地），改动后回到审查重跑至无新发现 |
| `/custom:review-cli-output <输出或 capture 路径> [owner 提示]` | 按 `cli-output-review-principles.md` + `human-facing-message-principles.md` 审面向人的终端输出（CLI / status / doctor / 安装器 / 部署脚本 / CI job）：结论是否前置、四态是否可分、未覆盖范围是否说清；能定位 output owner 时改它并重新 capture 复验 | 审查→决策→落地→复验，仍有 finding 则继续（无法绑定 owner 时降级为 review-only） |
| `/custom:review-schema [schema 路径或项目根=cwd] [消费界面提示]` | 按 `schema-design-principles.md` 审会被外部消费者读到、且字段名与值会被人看到的数据契约（artifact 元数据 / API 响应 / 事件 / 配置 / 导出格式）：先取真实实例并在消费界面上接地，再逐条原则并行审查，落地覆盖契约定义 / 写入端 / 消费方 / 跟随物四个面 | 定位→接地→审查→决策→落地循环，落地未产生改动才终止（每条原则一个并行 readonly subagent） |
| `/custom:review-readme <readme 路径> [max-principle-per-subagent=10]` | 按 `readme-review-principles.md` 审单份 README 的内容质量并修复（整个 docs/ 的跨文件一致性走 `sync-docs`） | 三阶段循环（审查→决策→落地），分组并行 subagent，改动后回到第 1 步重审 |
| `/custom:create-aigc-design <效果>` | 为合成 / 编辑 / 后处理 / 多来源接合 / 多步生成类效果写 L1/L2/L3 设计（深度随复杂度伸缩），聚焦算法-视觉-效果层 | 配合 `/custom:review-aigc-design` 循环至过 blocker gate |
| `/custom:review-aigc-design <path>` | 按 `aigc-design-review.md` 在实现前独立评审 AIGC 流水线设计文档 | 配合 `/custom:create-aigc-design` 循环至 blocker 清零 |
| `/routine:session-export` | 把当前 session 导出为可移植归档 | 否（单次执行） |
| `/routine:session-import <归档路径>` | 把导出的 session 归档导入到本机 | 否（单次执行） |

注：多数 `create-*` / `fix-*` 命令**已经在内部 invoke 对应的 review 循环**（见上表「自动循环？」列——`create-handoff` / `create-eval-harness` 等标「否」的没有）。内置循环不够时，可对同一份产物额外手动多次触发 review。

注：**三个 skill 由 `claude/CLAUDE.md` 的 BINDING 节强制，不靠你记得点它**——`review-gate`（生成或修改代码 / 脚本 / 常驻配置后，宣告完成或 commit 前的强制质量门，trivial 可声明式免审）、`decision-review`（能陈述成"在 A 与 B 之间选了 A"的非平凡决策，按它动手**之前**先过一道外部评审；免审判据由该 skill 单一维护，这里不复述）、`web-visual-system`（页面没有视觉系统或系统不自洽时，写 CSS **之前**先定视觉参数）。前两个审的东西不同、都要过：review-gate 审产物是否正确实现了决策，decision-review 审决策本身站不站得住。它们没有 slash command 入口，列在这里是为了让你知道 agent 为什么会在这些时点停下来做额外的事。另有 `create-commit`（commit 工作流：staging 纪律 + message 规范，被 execute 类命令的 commit 步骤委托）、`agent-browser`（浏览器自动化，被 `test-ux` / `execute-ux-contract` 消费）与 `tdd-workflow`（测试先行的 RED→GREEN 纪律，被 fix session 引用作回归约束）三个 skill 由相关流程按场景调用。

注：`deep-discuss` skill（按场景自动触发）——任务 tradeoff 重、想先一起把方案想清再动手、但还不值得产出 plan.md 时用；产出共识而非 plan，谈拢后可衔接 `/custom:create-plan`。

注：`decision-review` skill（按 description 自动触发，也可显式点名）——它是**决策层的 gate**，不是可选的复查：手上有一个能陈述成"在 A 与 B 之间选了 A"的决策、而尚未按它动手（写文件、起长跑、改远端状态、对外发话都算）时进入。非平凡的决策会起一个只读 Codex 评审者对抗式审，过了才动手，放行后的决策连同作用域落到 `docs/adr/`。**什么算平凡、怎么声明免审，以该 skill 为准**——`claude/CLAUDE.md` 明确不在别处给可据以自判的改述。它与 `review-gate` 是两道分开的门，过一个不抵另一个。

注：`design-critique` 与 `web-visual-system` 两个 skill 是**同一件事的判与产两侧**，都可显式点名、也会按 description 触发。要评价一个界面（视觉层级、信息架构、认知负荷、情绪、AI-slop 味道）用 `design-critique`，它给出 slop verdict + Nielsen 十项打分 + P0–P3 优先级问题清单与行动计划；发现根因是"这个页面的视觉参数从来没被决定过"（字号阶梯 / 间距 ladder / 高度层级 / 圆角族 / 动效 / 状态矩阵 / 色彩角色）时，换 `web-visual-system` 去定这套参数——它带 probe 脚本（对着参照产品或自己的页面取实测值）和 validate 脚本（对渲染后的页面报 PASS/FAIL/UNCHECKED）。新建界面、整体改版、以某产品为参照复刻时**先定参数再写 CSS**，别等事后审；已有设计系统内的改动和单个布局 bug 照既有系统走，两个 skill 都不适用。

注：`game-release-loop` skill（显式点名才触发）——把一款浏览器游戏推到可发布：能力门（源码 / 仅构建 / 未知）→ 授权门（只诊断 / 可修复）→ 旅程×目标覆盖账本 → `READY` / `PARTIALLY VERIFIED` / `NOT READY`。它编排的是已有件（`test-ux` / `create-ux-contract` / `review-ux-contract` / `execute-ux-contract` / `tdd-workflow`），所以适用于"要对发布下结论"而非单次探索式测试；后者直接用 `/custom:test-ux`。首次用先按 `claude/skills/game-release-loop/references/game-profile.md` 模板为该游戏填一份配置档。

---

## 工作流组合

### A. 新功能开发：spec → plan → 实施

适用：UI 可操作项多 / user journey 多且复杂，需要更多 LLM 注意力补充验证路径——专门用 create-spec 先跟用户走一轮 L2 对齐才能把验证维度覆盖到位。典型如 web 多页面多状态产品、agent 类多步交互、AIGC / UX-heavy 产品。

```
1. Claude Code 中执行：/custom:create-spec <任务描述>

2. Claude Code 中**循环**执行：/custom:review-spec plans/<date>-<name>/spec.md
   - 人工验证点: 读 spec.md，确认其中的'用户视角verify'对得上你的真实意图
   - 复杂场景: review 命令自带收敛判据（`review-spec` 跑到无新发现；`review-plan` 按 severity gate + 轮次预算，残余项经 AskUserQuestion 交你裁决），到它自己说收敛为止。额外手动再跑的价值是换一轮注意力——你觉得还有在意却没被提到的风险时再跑，不是靠"跑到不出新发现"来判停

3. Claude Code 新 session 中执行：/custom:create-plan 把这份 spec 转成 plan: plans/<date>-<name>/spec.md

4. Claude Code 中**循环**执行：/custom:review-plan plans/<date>-<name>/plan.md
   - 人工验证点: 读 plan.md，重点看 L3 中的 verify 步骤
   - 复杂场景: review 命令自带收敛判据（`review-spec` 跑到无新发现；`review-plan` 按 severity gate + 轮次预算，残余项经 AskUserQuestion 交你裁决），到它自己说收敛为止。额外手动再跑的价值是换一轮注意力——你觉得还有在意却没被提到的风险时再跑，不是靠"跑到不出新发现"来判停

5. Claude Code 中执行：/custom:execute-plan plans/<date>-<name>/plan.md
   - Claude supervise Codex 实施，按 Stop Gate 收敛；随后按 plan 声明做 UX 验收（有契约影响则应用契约并按契约验证，只有 UX 入口则跑探索式 test-ux），issue 回灌直到清零
```

### B. 不需要 spec 的快速 plan

适用：**方案要交给新的 implementer context 接手**（这是 create-plan 的准入判据），且验证路径相对容易描述——少量可观测条件（命令输出 / 单一文件内容 / 单一 happy path）就能把"算成功"说清楚。create-plan 自带的 §2 facets 已足够覆盖 L1 / L2 / 取舍偏好对齐。典型如 CLI 工具 / 后端 bug fix / lib 函数改造。改动只涉及单文件**且**不交接、或方案本轮对话用完即弃时，直接在对话里对齐即可，不必落盘。

```
1. Claude Code 中执行：/custom:create-plan <任务描述>

2. Claude Code 中**循环**执行：/custom:review-plan plans/<date>-<name>/plan.md
   - 人工验证点: 读 plan.md，重点看 L3 中的 verify 步骤
   - 复杂场景: review 命令自带收敛判据（`review-spec` 跑到无新发现；`review-plan` 按 severity gate + 轮次预算，残余项经 AskUserQuestion 交你裁决），到它自己说收敛为止。额外手动再跑的价值是换一轮注意力——你觉得还有在意却没被提到的风险时再跑，不是靠"跑到不出新发现"来判停

3. Claude Code 中执行：/custom:execute-plan plans/<date>-<name>/plan.md
   - Claude supervise Codex 实施，按 Stop Gate 收敛；随后按 plan 声明做 UX 验收（有契约影响 → 应用契约并按契约验证；只有 UX 入口 → 探索式 test-ux）
```

### C. 产品上线前 UX 测试（ad-hoc）

适用：web / desktop / mobile 产品在交给真人前先用 AI 模拟扫一遍。没有沉淀验收基准、只需一次性快速过一遍时用这条。输出 issue 清单，不带修复闭环。

```
/custom:test-ux 描述需要评测的产品功能/使用方式/PRD文档
```

### D. 契约驱动的 UX 验收：create → review → execute

适用：产品需要建立**系统性、可复用**的 user-observable 验收规格，且希望测试发现的、可即时修复的 Critical/High/Medium issue 自动进入修复闭环。相比 C 的一次性 ad-hoc 测试，这条沉淀出一份可反复执行的 ux-contract，并由 supervisor 驱动 Codex 测+修直到收敛。

```
1. Claude Code 中执行：/custom:create-ux-contract [产品描述/入口/文档]
   - 访谈对齐 L1 产品全貌 + L2 用户视角 verify + 验收侧重
   - 内部自动跑 /custom:review-ux-contract 循环至收敛
   - 产出 docs/contracts/ux-contract.md

2. 人工验证点：读 ux-contract.md，确认 L2 验收规格覆盖你真实的上线诉求
   - 复杂场景：手动多次触发 /custom:review-ux-contract <contract path>；该命令自己循环至无新发现，额外再跑是为了换一轮注意力

3. Claude Code 新 session 中执行：/custom:execute-ux-contract docs/contracts/ux-contract.md
   - supervisor 把契约翻译为 test plan，用独立 test session + fix session 跑测-修循环
   - 按 Stop Gate 收敛，可即时修复的 Critical/High/Medium issue 清零后 commit（委托 create-commit skill）+ handoff
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

