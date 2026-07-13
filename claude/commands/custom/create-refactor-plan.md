---
name: create-refactor-plan
description: 周期性、系统性重构一个代码库（或子系统）以减少 tech debt、提升可维护性/可扩展性/易读性时使用——产出一份可落地的重构计划。开发功能/提性能/加可观测性走各自入口；一次性的"重构某功能"规划走 create-plan；单文件小改直接做，都不用本命令。
argument-hint: "<scope: 目录/组件/子系统> [--rescan] [--no-long-task]"
disable-model-invocation: true
origin: 2026-07-05
---

# create-refactor-plan

入口 command：从一个代码库（或子系统）出发，与用户对齐重构宪章（charter：本轮对齐结论 + 停止判据 + funded/declined 台账，完整字段清单见「产出 plan.md + charter」段），把深度分析出的结构 finding 按对 user / developer / agent 的收益排序，产出一份 `execute-plan` 可直接落地的 `plan.md`。执行与循环复用现有命令。

## 定位：create-plan 的重构专用变体

本命令产出的 `plan.md` 由现有 `/custom:execute-plan` 直接消费，复用其 codex 执行 / Stop Gate / commit。复用 create-plan 的产物契约、`review-plan` 的审查循环、execute-plan 的 codex 执行 recipe。不新建执行命令。

## 流程概览

带两个循环的门控管线（各阶段细节见后续对应小节）：

```
全量对齐 charter(facet) → 深度分析(codex/inline) → [裁决:用户gate] → 按收益排序
   → [选批:用户gate] → 产出 plan.md+charter → [review-plan 循环] → 交 execute-plan
        ⟲ --rescan：复用 charter（跳全量对齐）→ 分析 →[裁决=增量对齐]→ 排序 →[选批]→ 产出 →[停/续:用户gate]
```

三个用户 gate（裁决 / 选批 / 停/续）是"价值取舍归用户、模型不自决"的运行时落点。

## 何时使用 / 不使用

- 显式 `/custom:create-refactor-plan <scope>`：周期性还技术债，提升可维护性 / 可扩展性 / 易读性。
- 不使用：开发功能 / 提性能 / 加可观测性（日志·报警·dashboard）走各自入口；一次性"重构某功能"规划走 `/custom:create-plan`；单文件或几行的小改直接做，别付规划 + codex 的 overhead。

## 参数

| 参数 | 必需 | 默认 | 说明 |
|---|---|---|---|
| scope | ✓ | — | 重构对象：目录 / 组件 / 子系统路径。也可附"这轮只看 X 维度"等对齐信息 |
| --rescan | ✗ | false | 复用已落盘 charter、跳过对已覆盖维度的全量对齐（超出 charter 的新决策仍增量对齐），对上轮改动后的代码增量再扫（见 §再扫描循环） |
| --no-long-task | ✗ | false | opt-out 长任务模式（同 create-plan）；小 scope / 单批一次跑完时可用，跳过 state.md / journal.md |

## 输入契约

| 输入 | 来源 | 必需 |
|---|---|---|
| scope | 用户（CLI arg） | ✓ |
| `refactor-charter.md`（对齐结论 + 停止判据 + funded/declined 台账；完整字段清单见「产出 plan.md + charter」段） | 本命令自产，`--rescan` 时读回 | `--rescan` 时 ✓ |
| docs / ADR / README / `git log` | 代码库（无上游 skill 产出，仅此阶段供给） | 可选但承重——驱动约束基线与"从代码提候选"，缺则候选质量降 |

---

## 核心 framing：三维 + 收益归属 + 优先级 lens

收益归属是排序的依据——缺了它，排序会退回"按纯技术风险"而非"按用户能判断的收益"。

### 三个优化维度与受益方

| 维度 | 定义 | 直接受益 | 收益内容 |
|---|---|---|---|
| 易读性 | 代码 / 结构一眼看懂的程度 | developer, agent | 几乎不触达终端用户；价值 = agent / 新人更快看懂、少改错 |
| 可维护性 | 改动时不漏、不误伤的程度 | developer（直接）、user（间接）、agent | 改一处不漏 → 用户侧少踩回归；agent 改动更安全 |
| 可扩展性 | 沿某方向加功能的容易与安全程度 | user（直接）、agent | 新能力上线更快更稳——对有终端用户的产品是唯一有清晰产品收益的维度；纯内部工具 / 库则受益方仍是 dev / agent |

### 优先级不是固定排名，是一把 lens

- 判据不是"用户会不会感知"：一批 finding 里往往只有少数（正确性漂移 / 扩展瓶颈）触达 user，其余是 developer + agent 的内部收益。对内部项，用"这在持续消耗多少 agent / dev 时间、卡住多少扩展"判断价值，别等它有 user 收益才做。
- **agent-legibility 升格**：因"实现主要交给 coding agent"，重复副本 / god file / 无 schema 对 agent 的危害被放大——agent 改一个副本会漏其他、大文件吃满 context 漏 cross-ref、无 schema 无法自验改对没。这是该协作模式带来的非显然权重，SOTA 默认不会强调它。
- 优先级 = f（受益方触达 user 的程度, 是否命中已对齐的扩展方向, 成本 / 风险, 对 agent 的阻塞程度）。因扩展方向每次对齐才知道，不固化排名（固化会退化成 checklist，跨项目失配）。

---

## 需要对齐的点（不限于此）

对齐 facet，非顺序步骤——可并行 / 迭代 / 回退（通用对齐框架见 create-plan 的「需要对齐的点」段）。下列均为重构专属 facet，结论写进 charter。`--rescan` 跳过本节的全量对齐（读已落盘 charter；新 finding 超出 charter 覆盖时的增量对齐见 §分析 裁决步）。风格遵循 `~/.claude/references/deep-discuss-style.md`。

读 docs / ADR 建 intent 基线、跑 `git log` 看模块改动频率——让下面几个 facet 能"从代码提候选"而非让用户从白纸列。

### 本轮 scope 边界与约束基线

**对齐**：这轮扫哪些、不扫哪些；哪些"坏味道"其实是刻意约束、不该动。

**lens**：重构分析最易犯的错是把有依据的架构约束（平台强制的部署副本、明确 ADR 决策、合规要求）当缺陷去修。先读 docs / ADR / README——从代码里提出候选约束（ADR 引用的部署副本、硬编码的合规逻辑）用 `AskUserQuestion` 交用户确认，而非让用户凭空列。约束缺的通常是同步校验 / 显式记录，不是消灭。

**常见询问方向**（不限于此）：scope 粒度（单模块 / 跨端全库）？有无冻结区 / 明确不许动的部分？这轮是否限定只看某一维度？

### 扩展方向

**对齐**：项目将来真实要往哪些方向扩展。

**lens**：可扩展性优化只在会发生的扩展方向上有收益；在不会扩展处加抽象 = 纯增复杂度（负收益）。用户掌握的 roadmap > 代码能推的，所以这必须问用户——但别盲问：先从代码提候选扩展方向（半成品的 provider 抽象、硬编码的地区 / 类型枚举、ADR 提到的未来方向）用 `AskUserQuestion` 交用户确认 / 增补 roadmap-only 的。没有明确扩展方向的模块，默认"当前够用即可"，不为假想未来做可扩展设计。

**常见询问方向**（不限于此）：候选扩展方向里哪些近期（下 1-2 迭代）会发生、哪些远期可缓？有无明确"不会往这扩"的反向信号（别为它设计）？

### 维度权重

**对齐**：这轮在三维中偏重哪些、可牺牲哪些。

**lens**：一轮重构未必三维全做。稳定但难读的老模块也许只值补易读性；即将扩展的模块优先可扩展性。先从 `git log` 改动频率 + 已对齐扩展方向对每模块提候选权重，用 `AskUserQuestion` 交用户确认 / 覆盖，别让用户空手定权重、也别三维平均用力。

**常见询问方向**（不限于此）：这轮有没有明确不做的维度？某维度改善会牺牲另一维度时（如可扩展性↔易读性）偏哪个？

### 风险容忍与 no-regression 边界

**对齐**：哪些既有行为不能坏、可接受多大改动面。

**lens**：重构默认"行为等价"，no-regression 是硬约束。要对齐的是——哪些是必须逐字保持的用户可感知行为、哪些实现细节可自由改；单批改动面控制在多大（大爆炸重构风险 vs 小步安全）。"哪些用户可感知行为必须逐字保持"是用户专属知识、开放问；但已知脆弱 / 难测模块可从 `git log` 频率 + 测试文件提候选、用 `AskUserQuestion` 交用户确认，别空手问。

**常见询问方向**（不限于此）：有无已知脆弱 / 难测的模块要格外保守？每批是否要求可独立回滚？迁移期允许中途临时不一致吗？

### 测试护栏策略

**对齐**：这轮用多少测试做重构安全网。

**lens**：test 是重构的安全网（改错了能被 catch），但加 test 有成本、不是越多越好。判据 = 加 test 的成本 vs 不加所冒的风险（该模块改动频率 × 改错的线上影响 × 当前覆盖缺口）。频率与覆盖缺口可从 `git log` / 测试文件读出、线上影响是用户专属知识——模型从代码提候选护栏强度、把线上影响不确定处用 `AskUserQuestion` 交用户，别把用户专属因子折进公式自决。高频改 + 高影响 + 低覆盖 → 先补 characterization / 快照测试再重构；低频稳定 + 低影响 → 别为重构硬造 test。

**常见询问方向**（不限于此）：有无现成测试基建可复用（决定补测试的实际成本）？可接受的安全网类型（characterization / 快照 / 单元）有无偏好？

### 停止判据（收益下界）

**对齐**：这轮做到什么程度算够、`--rescan` 何时该停。

**lens**：重构可以无限做下去；停止判据是"还值不值得继续投"的价值判断——归用户，不是模型自决。收益下界的档位形式作 `AskUserQuestion` choice set 提候选，阈值本身的取舍仍归用户。定一个收益下界（低于它的 finding 不再 fund）写进 charter，`--rescan` 收敛时据此把剩余项交用户拍停 / 续。

**常见询问方向**（不限于此）：收益下界怎么表达（只做 P0/P1 档？只做触达 user 的？effort 上限？）？这轮有无硬性时间 / 预算盒子？

---

## 分析、裁决、排序与选批

对齐充分后（`--rescan` 从此处起，读 charter 跳过「需要对齐的点」的全量对齐）：

1. **深度分析**（codex 或 inline，按 scope 定）：无论哪条路径，每条 finding 必须 file:line 接地、经 Claude 核验——否则 step 3 排序 / step 4 选批无从判真伪。scope 大 / 跨多组件 → 委派 codex 深度分析（借 execute-plan 的「启动 Codex / 等待与轮询 / 判定 Codex 输出并裁决」段 + `supervise.md` 的「启动 wrapped agent / 增量轮询」段的后台 spawn recipe）；codex 隔离于本命令上下文，spawn-prompt 是它唯一的任务通道，必须传够它推不出的信息（floor，非 cap，允许 codex 按 runtime 补充）：角色（重构结构分析者）+ 分析任务 + 本轮 scope 边界 + 已对齐的约束基线 + 真实扩展方向 + 本轮维度权重 + finding 格式（每条 file:line 接地 + codex 自己判 constraint vs defect），传法按模式（首轮内联对齐结论、`--rescan` 传 `refactor-charter.md` 路径自读）。scope 小 / 单模块 → Claude inline 分析。
2. **charter 未覆盖的新决策裁决**：分析（codex 或 inline Claude）遇到 charter 没覆盖、又需用户拍的决策，不得静默默认——hold 住，`AskUserQuestion` 只问那一点 delta、写回 charter，再继续。最典型是"约束还是缺陷"（docs / ADR 未明确 settle）；此外任一已对齐 facet 在新 finding 上未 settle（未覆盖的扩展方向 / 维度权重 / scope·risk 边界）同样适用。首轮多数已被刚做的对齐覆盖；`--rescan` 时这是防 charter 过时、把新决策交回用户的 gate。
3. **按收益排序**：用 §核心 framing 的优先级 lens 给每条 finding 标（受益方 / 命中维度 / 是否命中扩展方向 / 成本·风险 / 对 agent 阻塞）。
4. **选批**：排序清单 `AskUserQuestion` 交用户选这轮 fund 哪些——把取舍权留给用户的关键 gate，不替用户全做。funded / declined 结果记入 charter 台账（供 `--rescan` 区分新 vs declined）。

---

## 产出 plan.md + charter，并审查收敛

落点 mirror create-plan：`./plans/<YYYYMMDD>-refactor-<scope-slug>/`，含：

- **`plan.md`**：用户选中那批 finding 的 execute-plan 可落地实现版。内容满足 create-plan 的「输出：plan.md」段（implementer 必答项表），但按重构 shape 重锚，不照搬产品 plan 的槽：
  - 原样带过：当前状态（可观察事实）、要做什么（指向具体文件 / 模块）
  - 重锚：使用者 = developer / agent；使用方式 = 维护 / 沿扩展方向扩展该 scope；取舍偏好 + 三层影响 → charter 维度权重（易读 / 可维护 / 可扩展 weighting）及其如何塑造选批与 verify 分级；verify 主轴 = no-regression（行为等价）
  - skip-with-reason：UX 契约影响（重构行为等价、无 ux-contract 变化 → 按 create-plan 的「UX 契约影响」facet skip 掉 execute-plan 的 4a/4b）。同理，create-plan 必答项表的两行按重构 shape 分别处理：「phase 边界用户决策」典型 N/A（三个用户 gate 在本命令运行时而非 plan.md，plan.md 内无待决 phase 决策）；「顶层入口文档同步」仅纯内部、无 developer 入口结构变化的重构才 N/A——重塑 developer 入口结构（模块布局 / 扩展点）的易读性 / 可扩展性重构改了 developer 入口文档，须保留为真实必答（同步架构 / 模块布局文档），别一刀切回填「无」。面向用户产品的重构，若想用 execute-plan 4c 探索式 test-ux 兜 no-regression，可在 plan.md L2 暴露 agent 可访问的产品实例（4c 触发与 ux-contract 是否变化无关）
  - verify 随风险分级（勿一刀切"每步补快照"，与 §测试护栏 对齐的策略挂钩）：高风险步 → characterization / 快照测试证据；低风险纯内部步 → 公共接口不变 / typecheck / 既有测试保绿即可
  - 长任务模式下，plan.md 顶部插长任务 banner（execute-plan 据此识别 long-task 模式）
- **`refactor-charter.md`**（charter 完整字段清单）：对齐结论（scope 边界 + 约束基线 / 扩展方向 / 维度权重 / 风险边界 / 测试策略）+ 停止判据（收益下界，首轮与用户对齐）+ 每轮 funded / declined finding 台账（供 `--rescan` 区分新 vs declined）。同 plan/state/journal，属规划 audit-trail，不进 execute-plan 的代码 commit。
- **`state.md` / `journal.md`**：长任务模式默认启用（继承 create-plan，`--no-long-task` 可 opt-out）——按 create-plan 的「长任务模式 bootstrap」段落 state / journal（banner 见上 plan.md 项）。

写完跑 `/custom:review-plan <plan path>` 循环审查到无需修——重构 plan 尤其要审 no-regression verify 是否真兜得住行为漂移。

---

## 再扫描循环（--rescan）

execute-plan 落地一批后重跑 `--rescan`：复用 charter、只跳过对已覆盖维度的全量对齐——不跳过新决策：超出 charter 覆盖的 finding 仍走 §分析 裁决步做增量对齐。对改动后的代码增量再扫：(a) 之前被掩盖、现在暴露的 finding；(b) 重构本身引入的新 finding。据 charter 台账区分真新 vs declined，产出下一批（走 §分析 → §产出）。

停止是用户的决定，不是模型自决：收敛时（剩余 finding 都低于 charter 收益下界，或本轮扫出零 finding、子系统看似收敛）用 `AskUserQuestion` 交用户"停 / 降低收益下界 / 全量对齐"——模型自决"哪些不值得 / 已收工"就是替用户做取舍。若增量对齐反复触碰扩展方向 / 风险边界，说明业务大背景已整体偏移 → 提示用户重跑不带 `--rescan` 全量对齐。

---

## Handoff

打印：

```
refactor plan written: /abs/path/to/plans/<date>-refactor-<name>/plan.md
charter:               /abs/path/to/plans/<date>-refactor-<name>/refactor-charter.md
state:                 /abs/path/to/plans/<date>-refactor-<name>/state.md      # 长任务默认启用（--no-long-task 时无）
journal:               /abs/path/to/plans/<date>-refactor-<name>/journal.md    # 同上

下一步：在新 session 跑 `/custom:execute-plan <plan.md>`
落地后 `/custom:create-refactor-plan <scope> --rescan` 续下一轮
```

---

## 关键不变量

SOTA Claude 默认不会做，失守会让本 command 退化：

- **优先级与停止留给用户**：重构可无限做、优先级又无客观真值——SOTA 默认会自己拍板；但 fund 哪批、何时停是价值取舍，只有用户能定，模型不自决。
- **codex 委派传够任务上下文**：charter 内容（扩展方向 / 约束基线 / scope / 维度权重）是 codex 推不出的非显然输入——只传 spawn recipe 不传任务内容，codex 会脱靶或把约束当缺陷。
- **执行复用不重造**：codex 执行 / Stop Gate / commit 复用 execute-plan；不内联调用它（避免 supervisor 嵌套 + commit / state 冲突），只产出它消费的 plan.md。
- **语言契约**：与 codex / 工具交互 English，与用户交互中文。
