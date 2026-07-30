---
argument-hint: "[<改了什么> | 空=审查全部文档] [max-principle-per-subagent=5]"
description: 项目文档维护的单入口——说明改了什么就补该改动的文档，不说明就审查并修全部现有文档；docs/ 未初始化时先建结构。覆盖 docs/ + 根 README/CHANGELOG，与代码和质量标尺对齐。
disable-model-invocation: true
---

# sync-docs

单入口维护项目文档，遵循 `~/.claude/references/docs-organization-protocol.md`。审查范围 = `docs/` 下文档 + 根 `README.md` / `CHANGELOG.md`。本文件中：

- `supporting artifact` = 只为文档生成、示例或可复现验证服务的非文档文件；不含改变产品行为或公共接口的实现；
- `审查单元` = 原则组 × 对象簇；单个 review subagent 返回 `complete / incomplete`，全部适用单元都 complete 才是聚合态 `coverage complete`，补派后仍有稳定缺口则是 `coverage blocked`；recipe status 分 `converged / blocked / awaiting-caller-gate`，最后一项是非终态 handoff。

控制骨架分两条 lane：

- 正常：`入口契约 → 写入边界 → 可选 Seed → 初始审查 → 决策 → 落地 / 失效分析 / 重审 → 文档收敛 → [有 supporting artifact 才过 gate] → 原则缺口 → 输出`；
- 阻塞：`写入边界 / Seed / coverage blocked → [已修改 supporting artifact 才过 gate] → Blocked 输出`，不进入原则缺口。

| 状态 | 动作 | 出口 |
|---|---|---|
| 入口契约 | 确认独立 command / supervisor recipe、目标 repo、改动语境、源证据、extra review objects 与 gate owner | 写入边界 |
| 写入边界 | 为目标文档及索引 / cross-ref 建 `write-contract map`；新增候选时先扩展 map | authority 明确 → Seed / 初始审查；需上交 → 决策；未解 → Blocked lane |
| Seed | 有「改了什么」时起草；无入参但 docs/ 未初始化时建构；完整消费 doc-updater 返回 | 无上交项 → 初始审查；有上交项 → 决策；未解依赖 / 写入阻塞 → Blocked lane |
| 初始审查 | 完成全部适用审查单元并汇总 findings | coverage complete → 决策；有 incomplete → 补派 / coverage blocked → Blocked lane |
| 决策 | 处理 Seed 上交项、机械 findings、真取舍、ask-gate 与阻塞请求 | Seed 项解决 → 恢复 Seed / 初始审查；findings 获得处置 → 落地；clean / 只记录原则缺口 → 文档收敛；未解阻塞 → Blocked lane |
| 落地 | 应用已裁决编辑 | 有编辑 → 失效分析；无编辑 → 文档收敛 |
| 失效分析 | 按 changed files + semantic effect 计算受影响审查单元 | 受影响单元重跑 |
| 受影响单元重跑 | 用新独立 context 中立重跑失效单元；有编辑则重新计算失效范围 | 稳定 → 原始范围终审 |
| 原始范围终审 | 用新独立 context 对原始审查范围的全部单元终审 | 有编辑 → 受影响单元重跑；无编辑 → 文档收敛 |
| 文档收敛 | 判断是否修改 supporting artifact | 有 → Supporting artifact gate；无 → 原则缺口 |
| Supporting artifact gate | 独立 command 自跑；recipe 以 `awaiting-caller-gate` 交已声明 ownership 的 caller 跑并等待恢复 | 正常 lane：改变文档事实 → 失效分析，否则 → 原则缺口；Blocked lane → Blocked 输出 |
| 原则缺口 | 拒绝 / 延期则记录；获准则专项审查并在 owning repo 独立 commit | 标尺变化 → 失效分析；否则 → 输出 |
| Blocked lane | 保留未解依赖 / 写入阻塞或 coverage 恢复点；不处理原则缺口 | 已修改 supporting artifact → gate；否则 → Blocked 输出 |
| 输出 / Blocked 输出 | 仅 `converged / blocked` 是终态；`awaiting-caller-gate` 返回 gate 对象与恢复点后等待 caller 恢复 | 结束 / 恢复 |

**不变量**：seed 初稿不是终点——两种情形落地前都必须过 §2 审查循环。缺陷（"文档没回答用户关心的问题"、audience 错放）在 §2 被 catch，seed 阶段不负责质量。

## 参数

| 参数 | 必需 | 默认 | 说明 |
|---|---|---|---|
| 改了什么 | ✗ | 空 | 自然语言描述本次代码/功能改动。给出→§1 seed；空→跳过 §1（docs/ 未初始化则先 §1 建构）|
| max-principle-per-subagent | ✗ | 5 | 每个 review subagent 至多分到的原则数；这是原则数上限，不代表大 corpus 可只分一个 review subagent |

展示与提问风格全程遵循 `~/.claude/references/deep-discuss-style.md`——review subagent 的报告与主 session 的提问都适用。

## 被 supervisor 编排复用

本文件同时是其他 supervisor 的文档同步 recipe。`disable-model-invocation` 只约束独立 command 入口；caller 不内联调用 `/custom:sync-docs`，而是读本文件并执行完整 recipe，避免 supervisor 嵌 supervisor。

| 边界 | 契约 |
|---|---|
| Caller 输入 | 目标 repo（进入 recipe 前先把 CWD 切到该 repo）、改动语境，以及能让 doc-updater 复核该语境的源证据（如 task 产物路径、commit hash、diff）；不要把 repo 可自读内容改写成摘要替代源证据。受影响文档不在默认对象内时，另列 caller-supplied extra review objects。若允许修改 supporting artifact，须声明 caller 的 gate ownership；未声明则 recipe 不修改该类文件 |
| Recipe 负责 | 记录 target repo、建立写入契约、识别并起草受影响文档、跑完整审查循环与 §3 条件分流，并把未预见取舍交给 caller 的 `AskUserQuestion`；原则缺口获准且无未解撞车时完成 owning repo 的独立 commit |
| Recipe 输出 | recipe / caller gate status transition 轨迹与当前状态、审查范围、实际起草 / 编辑的文档、supporting artifact 与原则文件、coverage 状态与轮数、原始范围终审结果、最终 findings / decisions / edits、未解决的取舍 / 缺失依赖 / 写入阻塞与恢复点、caller gate 结果，以及原则缺口支路的 not-triggered / committed / rejected / deferred 状态（非 not-triggered 时含原因；committed 时再含原则文件 / owning repo / commit hash / scope）；供 caller 的领域 gate 与 handoff 消费 |
| Caller 保留 | 自身的领域 gate、工作状态、目标 repo commit ownership 与最终 handoff；recipe 不接管这些职责 |
| 审查范围 | 有改动语境时只覆盖受影响文档、caller-supplied extra review objects 及其索引 / cross-ref；无改动语境才是全量文档审查 |

Caller 可以为自己已拥有的领域声明 delta，但不得削弱完整 recipe：不能跳过写入边界、把 Seed 当终点、减少原则分组，或跳过编辑后的中立重审。领域 delta 产生的新编辑仍须回到 caller 自己的验证 gate。

进入 recipe 时把目标 repo 的绝对路径保存为 `target_repo`；每次进入 Seed / §2、以及从原则 owning repo 返回后，都先恢复并核验 CWD = `target_repo`。目标 repo 不能依赖当前 shell CWD 隐式记忆。

---

## 0. 范围与写入契约检查

**写入边界**：审查范围不等于修改权限。先确定本次要审什么、哪些文件可怎样写；否则 docs 修复会静默改写历史，或越界成代码重构。

### 0.1 Write-contract map

首次写入前，以命令开始时的工作树为 baseline，按 `docs-organization-protocol.md`「各文档的读写规则」中各类型的 `Format` 与写入 / lifecycle 标签建立候选文件的 write-contract map；候选集包含直接目标及其可能必需的索引 / cross-ref 联动文件。这个 map 只缓存 authority 已有规则，不在本命令另立文档生命周期政策：

- mutable snapshot 只表示内容形态；仅当该类型的写入路径允许本命令直写时，才可原地更新；
- append-only / 归档历史按该类型的 Format 与 lifecycle 选择新增、迁移或 superseding 形状，不把当前态纠偏解释为改写历史的许可；
- 每个候选文件（含索引）按自身文档类型判断；协议无法确定权限时，上交 §2.2 决策而不修改。

每批落地前用这个 map 检查 planned diff；不满足契约时先改写修复形状，不能等 review subagent 事后兜底。

### 0.2 非文档改动边界

若修复必须修改审查范围外的 generator、script、test、fixture 或 config，先在 §2.2 把范围扩张及用户可见影响作为独立决策呈现，未经用户接受不修改：

- supporting artifact 可作为联动修复候选；
- 会改变产品行为或公共接口的改动不由本命令实施——留 issue / handoff，交给正常实现流程。

上面的分类判据落在每个候选修复上、不落在 finding 上——同一条 finding 常有多支候选修复触及不同东西，如「文档说 X、实现没做 X」既可改实现让文档成真，也可判定文档写错了改文档。逐支分类；某支无法确定时，同 §0.1 上交 §2.2 决策而不自行归类。

任何已授权的 supporting artifact 改动都不由 §2 的文档审查代替专项审查；交付前按 §3.1 路由。

---

## 1. Seed（「补某次改动」情形，及 docs/ 未初始化时的建构；其余情形跳过本节）

先对齐、后起草：只能用户回答的取舍在起草前解决——带着未对齐的取舍强行起草，初稿可能违背用户偏好，导致无意义的返工。

docs/ 未初始化的 bootstrap（含无「改了什么」时）：以 repo 现状为 context 走本节建立结构（协议 §6「初始化与更新 docs/」），对齐步照常。

1. **侦察**：从「改了什么」+ docs/ 现状确定受影响的文档类型；有改动语境时同时追踪变更前后的身份与语义，把仍依赖旧状态的现役文档及其索引 / cross-ref 纳入审查范围，历史载荷是否保留按目标文档的生命周期语义判断。对每个类型按 `doc-updater` agent 定义中的对齐 lens 表识别取舍点。
2. **对齐**：存在只能用户回答的取舍（组织方式、粒度、叙事角度等）时，用 `AskUserQuestion` 问用户；剩余决策都能被合理 default 时即对齐充分，无取舍则直接起草。
3. **起草**：先确认 CWD 是目标 repo，再为每个受影响的文档类型并行 spawn `doc-updater`（输入契约见其 agent 定义），每实例传入：
   - `type` = 该实例负责的文档类型——并行分工无法从 repo 反推；
   - `context` = 「改了什么」描述 + 对齐结论 + caller 提供的源证据路径 / hash / diff——这些是 caller 独有上下文，不在 repo 里、doc-updater 无从自读；
   - `write_contract` = §0 为该实例全部候选写入（目标类型 + 必需的索引 / cross-ref 联动）解析出的写入路径与允许的 mutation shape——writer 必须在首次写入前拿到完整 gate 结果；
   - `interactive` = `false`——取舍已前置对齐，起草不现场发问；起草中遇未预见的新取舍，写入返回报告、由 §2.2 统一呈现。

   repo 状态由 doc-updater 自读，主 session 不 restate。

主 session 消费 doc-updater 的完整返回契约：未预见取舍、缺失依赖与写入阻塞都进入 §2.2；不得只收已更新文件而静默丢掉拒写原因。

按文档类型起草的特例：

| 文档类型 | seed 处理 | 条件 / 备注 |
|---|---|---|
| 各文档类型 | 按协议 §4「各文档的读写规则」建议格式起草 | — |
| contracts/ | 只初始化目录结构 | 内容由协议 §4.6「contracts/」的执行路径建立（plan 工作流主路径 / 专用 command fallback），seed 不起草 |
| data/ | 按项目需要可选 | 协议 §4.13「data/」 |
| README + operations | 服务有增删改 / 部署方式变化时联动更新 | 按 `~/.claude/references/service-operations-protocol.md` 检查生命周期脚本齐备；缺失则提示补脚本，不自动写 |

起草完进入 §2——初稿要过审查循环才算数。

---

## 2. 审查循环（两种情形共用：初始审查 → 决策 → 落地 → 受影响单元重跑 → 原始范围终审）

**审查范围**：「补某次改动」情形聚焦改动波及的文档 + caller-supplied extra review objects + 它们的索引 / cross-ref；「审查全部」情形覆盖全部 `docs/` 文档 + 根 README.md / CHANGELOG.md。

### 2.1 审查编排与 coverage gate

两组 review subagent 并行跑独立审查。分工同时受两个维度约束：

| 维度 | 分组约束 | 防止的失真 |
|---|---|---|
| 原则负载 | 把判断同一审查维度的相邻原则放在一组；每个实例不超过 `max-principle-per-subagent`，结果写入 coverage map | 原则过多稀释注意力 |
| 对象负载 | 实例无法在单个 context 内完整读完对象、追到必要源码并应用全部获配原则时，按可独立核实的语义域拆成不同对象簇；共享的 source-of-truth / cross-ref 可同时进入多个 scope，不阻止拆分 | 原则数未超限却对大 corpus 抽样 |

主 session 在派发前建立 coverage map；其中一个审查单元 =「原则组 × 对象簇」，每个适用的审查单元恰有 review subagent 负责。并发槽不足时分 wave 顺序派发，不通过扩大单实例负载来省 review subagent。

**Docs 结构审查**组——`docs-review-principles.md`：
- 读的引用文件：
  - `~/.claude/references/docs-review-principles.md`（传完整文件——相邻原则提供边界上下文；明确告知只应用分到该 subagent 的那几条）
  - `~/.claude/references/docs-organization-protocol.md` + `~/.claude/references/deep-discuss-style.md`
  - `~/.claude/references/service-operations-protocol.md`——只发给分到 P5（服务运维）的那个 subagent，它是 P5 的 authority；其余 subagent 不需要
- 审查对象：审查范围内的 docs/ 文档 + 根 README.md / CHANGELOG.md + caller-supplied extra review objects。README.md 在本组只做 cross-ref / audience 边界 + Content Currency（P3）检查，写作质量由 README 内容审查组覆盖；Content Currency（P3）对全部审查对象生效——含 README、CHANGELOG 与 extra review objects，不止分到 P3 的 subagent 的审查对象。

**README 内容审查**组——`readme-review-principles.md`（仅当审查范围内存在 README 或其他 user-facing 使用文档时 spawn）：
- 读的引用文件：`~/.claude/references/readme-review-principles.md`（同上，传完整文件但只应用分到的那几条）+ `~/.claude/references/deep-discuss-style.md`
- 审查对象：根 README.md 及审查范围内其他 user-facing 使用文档

所有 review subagent 不修改文件、不发 AskUserQuestion。每个实例必须读完获配 scope 后一次性返回全部有证据的发现，发现第一条不得提前结束；无法覆盖的对象 / 引用要明确列出，不能以「无问题」代替未审。返回契约：

- `coverage：complete`，或 `coverage：incomplete | 未审对象/语义 | 原因`
- 每条发现：`所属原则(§N) | 定位(文件+段/行) | 一句缺陷 | 它依赖的存在性主张(若有，供核实)`

coverage gate：`建立 map → 派发审查单元 → 收集 complete / incomplete 声明 → 可恢复的 scope/context 缺口补派使用新 context 的 review subagent 并回到收集；authority 不可读等稳定缺口上交 §2.2，请求解决后恢复该单元；本轮无法解决则标记 coverage blocked，不得当作收敛 → coverage complete 后汇总发现`。

每个 review subagent 都接收：coverage-unit 标识、获配原则组、精确对象簇（路径 / 语义边界）、必要的全局 cross-ref 范围、应读的 authority，以及上述返回契约；不能只给全局审查范围让它自行推断对象簇。分到 Content Currency 或其他需要核实改动 / 当前态原则的 review subagent，另接收「Seed」使用的改动语境 / 源证据并自行读取，不用 supervisor 摘要替代。纯文档内在质量 review subagent 不接收这些额外证据，避免稀释审查信号。

**ask-gate 桥接**：review subagent 不能自己 AskUserQuestion，但原则会要它 ask（如 `readme-review-principles` P1 reader/task 歧义须停下问、原则文件的 escape-valve）。触发这类情形时，review subagent 把它当一条发现上交 §2.2（那里才有提问权）并标注「需问用户、非可径改的缺陷」，不得静默跳过。

coverage complete 后，主 session 对两组发现去重、标注原则来源（及所属组），再按优先级排序（编号小者胜）。

### 2.2 决策

finding 裁决必须等 coverage complete；此前只处理让 coverage 能继续的依赖、写入阻塞与稳定缺口：

| 输入状态 | 处理 | 下一路径 |
|---|---|---|
| 写入边界 / Seed 的缺失依赖或写入阻塞 | 可自主解决则直接处理；确需用户取舍或权限时才 `AskUserQuestion` | 解决 → 恢复写入边界 / Seed / 初始审查；未解 → command blocked |
| review subagent `incomplete` 且可恢复 | 用新 context 补派缺失单元 | 回 coverage gate 收集 |
| 稳定缺口 | 请求解决 authority / scope；本轮不能解决则标记 coverage blocked | 已解决 → 恢复对应单元；未解 → §3.1 后 §4 blocked 返回 |
| coverage complete + 机械 findings | 核实后直接落地 | §2.3 |
| coverage complete + 真取舍 / ask-gate | 汇总为 `AskUserQuestion` | 用户决策后 §2.3 |
| coverage complete + 一条 finding 有多支候选修复、各支处置不同 | 逐支定处置，把「选哪一支」当作一项真取舍汇总为 `AskUserQuestion`；不得拿留在审查范围内那一支的处置替整条 finding 收口 | 用户决策后 §2.3 |
| coverage complete + 原则缺口 | 记录，不在本节重复询问 | 文档收敛后 §3.2 |
| coverage complete + clean report | 不制造用户选择 | 文档收敛 |

三条卫语：

- **bias check**：主 session 可能看过自己产出的内容（§1 seed 初稿、或上一轮落地的编辑）——反驳一条发现前先自省"我是在评估问题还是辩护自己写的"。
- **先核实再裁决**：一条发现或反驳要否决另一条时，先核实它依赖的存在性主张（"某条目存在/缺失""同类条目都如此"）——review subagent 会臆造存在性主张，未核实的错误前提会击败正确发现。
- **不预设真取舍的修复**：需要用户决策的 findings 呈现为可选项，不让用户照单全收；机械修复仍按上表直接落地。

### 2.3 落地、失效分析与重跑

每轮 review subagent 报告先按 §2.2 判断是否需要决策；需要时决策后批量应用编辑，clean report 则不产生编辑。产生编辑后，从 changed files + semantic effect 计算失效范围：直接变更的对象、其索引 / cross-ref / audience 入口，以及可能受影响的审查单元。拿不准是否受影响时纳入，而不是用「文件没改」排除语义依赖。

按以下状态流推进：

1. 初始审查经决策、落地后没有编辑，审查循环收敛；有编辑则计算失效范围。
2. 只重跑失效范围对应的审查单元；该轮经决策、落地后仍有编辑，重新计算失效范围并重复本步。
3. 受影响单元重跑没有编辑后，使用新独立 context 执行原始范围终审。
4. 原始范围终审的发现仍回 §2.2；落地产生编辑则回第 2 步，没有编辑则审查循环收敛。

这样无关审查单元只在最终兜底时重读，而不是每个小编辑后重复消耗。

**重跑中立**：每次受影响单元重跑和原始范围终审都须同时满足 prompt 中立与 context 中立，使用新的独立 context；继续上一轮 review subagent thread 不算中立。prompt 禁止把「上一轮编辑想达成什么 / 去确认它生效」当成功判据喂进去——确认式框架（"verify 这个 fix 解决了 X"）会把 review subagent 推向印证编辑而非独立挖洞。

---

## 3. 交付或阻塞返回前的条件支路

| 路径 / 条件 | Gate owner 与动作 | 下一状态 |
|---|---|---|
| 文档收敛；无 supporting artifact | 无专项 gate | §3.2 |
| 文档收敛；独立 command 修改了 supporting artifact | 主 session 执行 review-gate | gate 改变文档事实 → §2；否则 → §3.2 |
| 文档收敛；recipe 修改了 supporting artifact | 返回 `awaiting-caller-gate` + gate 对象 / 恢复点；已声明 ownership 的 caller 执行领域 gate 后恢复 recipe | gate 改变文档事实 → 失效分析；否则 → §3.2 |
| coverage blocked；无 supporting artifact | 保留 coverage 恢复点 | §4 blocked 返回 |
| coverage blocked；已修改 supporting artifact | 按入口完成上述 gate 执行 / caller 交接，不把未审 artifact 当可交付产物 | 保留 gate 影响与 coverage 恢复点 → §4 blocked 返回 |

正常收敛时 §3.1 与 §3.2 依次检查而非二选一；gate 使文档事实变化后，文档重新收敛时从 §3.1 重新评估。

### 3.1 Supporting artifact 的交付 gate

若本次按 §0.2 修改了 supporting artifact，专项 gate 的执行权按入口分流：独立 command 在正常交付或 blocked 返回前执行 `~/.claude/skills/review-gate/SKILL.md`；supervisor recipe 仅在 caller 已显式声明 gate ownership 时修改该类文件，随后返回 `awaiting-caller-gate` + caller gate status `pending`，携带 supporting artifact、gate 对象和恢复点。caller gate `passed` 后恢复 recipe；gate `blocked` 时 recipe 保持 `awaiting-caller-gate`，caller 按 Stop Gate 交接 `recipe status + gate status + resume point`，解除后继续 gate 再恢复 recipe。gate 未通过前不得产出 `converged`。review-gate 的专项路由与修复闭环是 authority，不在本文件复制。

gate 产生修复后按 changed files + semantic effect 重新判断：正常路径中，修复若改动文档或改变文档所陈述的事实，回 §2.3 做失效分析、受影响单元重跑与原始范围终审；supervisor caller 也须按同一条件重新进入 recipe。blocked 路径保留该影响与恢复点，不宣称原始范围终审已完成。

### 3.2 原则缺口决策、修复与重审

原则缺口是高杠杆发现；只在 prose 附带提及会被略过、同类坑复发：

1. 审查暴露 `docs-review-principles.md` 或 `readme-review-principles.md` 未覆盖的问题时，先定位原则文件及其 owning repo，并记录该 repo 的 dirty baseline。
2. 用 `AskUserQuestion` 询问是否改进原则，并说明将编辑、专项审查、独立提交的具体动作，以及当前脏状态与同文件撞车。有撞车时一并裁定：拆分支路 diff（推荐）、明确授权整文件纳入（披露扩大后的 commit scope），或延期。
3. 用户拒绝或延期 → 不编辑原则，记录 rejected / deferred 后进入 §4。获准 → 编辑原则，执行 `/custom:review-skill <原则文件>` 直到收敛，再按 `~/.claude/skills/create-commit/SKILL.md` 在 owning repo 独立提交。默认 staging scope 只包含本支路产生的 diff、不带入 dirty baseline；只有用户明确授权「整文件纳入」时例外，并在 commit 及输出 scope 中披露。
4. 原则独立 commit 完成后，恢复并核验 CWD = `target_repo`，按新原则进入失效分析与受影响审查单元重跑；重新收敛后再评估 §3。

---

## 4. 输出

向调用者 / 用户返回 recipe status（`converged / blocked / awaiting-caller-gate`）与 caller gate status（`N/A / pending / passed / blocked`）的 transition 轨迹和当前状态、审查范围、本次实际修改的文档 / supporting artifact / 原则文件、coverage 状态与轮数、原始范围终审结果、最终 findings / decisions / edits、未解决的取舍 / 缺失依赖 / 写入阻塞与恢复点、专项 gate 结果，以及原则缺口支路状态（非 not-triggered 时含原因；committed 时再含 owning repo / commit hash / scope）。`blocked` 不能用「未修改」或“已收敛”代替；`awaiting-caller-gate` 不是 recipe 终态，但 caller gate `blocked` 时是 caller 的合法 stop 状态，须保留两层状态与恢复点；只有 recipe `converged` 可进入 caller 的完成 / commit 路径。
