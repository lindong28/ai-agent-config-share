---
argument-hint: <skill|command|agent-definition|rules-file|non-principles-reference-path> [optimize] [principle-prune-mode=disable/moderate/aggressive] [max-principle-per-subagent=3]
description: 用于用户明确要求审查并按需修复单个 SKILL.md、command、agent 定义、`rules/` 下的规则文件或 reference（含 principles 文件）时；也覆盖这类 artifact 自身封装外部 program 的职责边界。
---

# review-skill

| 术语 | 含义与约束 |
|---|---|
| `root` / reviewer / lens | root 拥有调度、核实和决策；reviewer 是隔离审查角色；lens 是有独立输入 / 判断 / 输出契约的追加审查维度 |
| `source manifest` | 每项来源记录角色、required / conditional 状态、hash 算法与 expected digest；来源形态为 `repo / path +` 不可变 locator，或嵌入内容；diff-focused 时另含 base / hunks 与 digest |
| `snapshot packet` / `snapshot id` | packet 是 reviewer 的唯一冻结事实源，含审查意图、审查范围、`source manifest`，以及适用时的 `contract packet`；id 绑定完整 packet，任一部分变化就更换 |
| `contract packet` | 适用时由契约预检产出的权威语义清单 |
| `review manifest` | 每条保留原则和每个已触发 lens 到唯一 owning reviewer、状态与报告的映射 |
| `finding set` | 本轮结构化 finding 集合；root 核实前是候选，核实后每项带成立 / scope 状态及全部 originating `review_dimensions` |
| `fix set` | 本轮已核实、in-scope，且由 root 可直接完成或已经用户裁决的待落地修复集合 |

## 输入、状态与产出

| 类别 | 契约 |
|---|---|
| 必需外部输入 | `$ARGUMENTS` 与目标 artifact；用户目标 / 约束；`skill-review-principles.md`、`deep-discuss-style.md` 及当前 harness 的决策 / 委派契约 |
| 条件外部输入 | **目标类型自己的 authoring 标准**（`~/.claude/rules/` 下按 `paths` 匹配该目标的那份——skill / command / agent 走 `skill-authoring.md`，`rules/` 文件走 `rules-authoring.md`）：通用原则集不覆盖各类型特有的质量轴，缺了它交出的「已覆盖」对那些轴零判别力；目标所依赖的权威契约；启用或触发时的 optimization / creation 规则与证据；任何 `fix set` 都需要的 `fix-skill-from-session.md`「验证」契约；原则文件的 handoff contract |
| artifact-failure 专用输入 | 仅观察到 artifact-failure 时需要的 `fix-skill-from-session.md`「Fix 设计」、原始 failure 与 execution evidence |
| 流程内部状态 | `snapshot packet`、`review manifest`，以及适用时的 `contract packet` |
| 给用户与下一轮的产出 | 已核实的 `finding set`、用户决策、落地改动与重审结论；另列保留、延期和 out-of-scope finding |

## 参数

| 参数 | 必需 | 类型 | 默认 | 说明 |
|---|---|---|---|---|
| artifact-path | ✓ | 字符串 | — | 待审 SKILL.md、command、agent 定义、`rules/` 下的规则文件或 reference 路径。principles 文件（`*-principles.md`）也走这里——见下方类型 gate 的能力说明 |
| optimize | ✗ | boolean | false | 显式强制叠加 optimize 审查（默认判定见「模式」） |
| principle-prune-mode | ✗ | 字符串 | moderate | 原则裁剪强度：`disable / moderate / aggressive`；判据见「裁剪原则集」 |
| max-principle-per-subagent | ✗ | 正整数（≥1） | 3 | 常规原则组的分组上限；行为保持型压缩原则组为保持联合判断固定覆盖 3 条原则 |

## 模式

- **review-only**（默认）：仅应用 `~/.claude/references/skill-review-principles.md`，找 violation / borderline finding。
- **review + optimize**：额外应用 `~/.claude/references/skill-optimization-principles.md`，审 wrapper-vs-program 边界、把确定性工作下沉到外部 program。

optimize 的增量价值来自 wrapper-vs-program 边界。先沿用用户已明确裁决的模式；模式未决时，`$ARGUMENTS` 显式启用就直接叠加，目标存在该边界则用 AskUserQuestion 让用户权衡额外成本，否则 review-only。

## 工作流

root 直接拥有调度、核实和决策，不引入 coordinator；out-of-scope finding 只报告，不进入 fix set。展示与提问风格遵循 `~/.claude/references/deep-discuss-style.md`。

最小冻结 → 类型 gate → 模式判定 → 扩展冻结与裁剪 → 契约预检 → 分组审查 → 决策与落地 → 终止 / 重审。

| 节点 | 前进条件 | 阻断 / 回边 |
|---|---|---|
| 最小冻结 | 用户输入与目标的 `snapshot packet` 可读 | digest 不匹配则重建 |
| 类型 gate | 目标是 SKILL.md、command、agent 定义、`rules/` 下的规则文件或 reference | principles 文件按 reference 审查；**但本仓未收录专审 meta-原则的 `/custom:review-principles`**，所以「这套原则本身是否立得住」这一维度不被覆盖——在报告中明确声明该维度未审，不要当作已审过；均不匹配则如实报告不受理，不要当 reference 硬套 |
| 模式判定 | 确定 review-only 或 review + optimize | 需要用户权衡时先 AskUserQuestion |
| 扩展冻结与裁剪 | 其余 required 输入已冻结，原则集已定 | `aggressive` 裁剪先经用户确认 |
| 契约预检 | 契约结果允许继续 | `blocked` 停止；来源漂移则重开 |
| 分组审查 | `review manifest` 零遗漏、无重复，全部 owning reviewer 已完成 | 未过整轮屏障不得决策或编辑 |
| 决策与落地 | 完整 finding set 已核实并形成 fix set | 真取舍先问用户；有改动则新开一轮 |
| 终止 | 无待处理 finding | 列出用户明确保留或延期的 finding |

### 1. 审查

先拒绝无效参数，把用户输入与目标冻结为最小 `snapshot packet`，再据此执行类型 gate 与模式判定；随后扩展冻结其余 required 输入，按 `principle-prune-mode` 定原则集，并构造 `review manifest`。reviewer 读取前验证 locator 的精确字节与 expected digest；不匹配返回 `stale`，不能只回显 snapshot id 后读取可变工作树。

**裁剪原则集**：只裁掉可证明不适用的原则，拿不准则保留；主观相关性裁剪必须显式承担 silent-miss 风险。

| 模式 | 可裁依据 | 输出与 gate |
|---|---|---|
| `disable` | 不裁剪 | 全量原则进入分组 |
| `moderate` | 原则考察对象被目标结构性排除 | 拟裁清单列原则、理由和置信度 / 风险；信息性报告，不阻断 |
| `aggressive` | `moderate` 依据，外加与目标主观判断不相关 | 同一拟裁清单；spawn 前经 `AskUserQuestion` 确认 |

**契约预检**：原则集保留「Demand Contracts for External Interfaces」时，先运行包含它的契约预检原则组；该 reviewer 在同一 turn 内按该原则的语义依赖闭包规则完成契约发现，再应用本组获分配的原则，不增加第二次形式审查。初始 `snapshot packet` 只需冻结已知直接来源；预检发现新的必要来源时先重新冻结，而不是读取 `snapshot packet` 外内容。契约结果是其余组的控制门：

| 结果 | 必需证据 | 后继 |
|---|---|---|
| `applicable` | `contract packet`：required 权威来源的 locator / 命名锚点、各 load-bearing 项的含义、消费者预期行为与未核实项 | root 将 `contract packet` 冻结进 `snapshot packet` 并更换 id；契约预检原则组复核后以新 id 重发报告，再继续 |
| `not-applicable` | 不存在外部接口的证据 | 继续 |
| 该原则被裁剪 | 裁剪证据 | 继续 |
| `needs-refreeze` | 新发现的必要来源 locator | root 纳入新 `snapshot packet` 并重跑预检，直到闭包稳定 |
| `blocked` | 重新冻结后仍不可获得的必要契约 | 停止审查 |

**分组 spawn**：将选中的原则按 `~/.claude/references/skill-review-principles.md` 的 `Principle clusters` 表就近分组（同簇尽量进同一 subagent，每组 ≤ `max-principle-per-subagent`），每组 spawn 一个 fresh isolated reviewer context 并行审查。契约预检原则组已覆盖的原则不重复 spawn；契约结果允许继续后，其余组与适用的追加审查可并行。spawn 时**不传 `name`**——判据见 `~/.claude/references/delegation-policy.md` §Harness transport。

每个隔离 reviewer 的 prompt 必须含：其 `review manifest` assignment、审查范围、相关用户裁决、完整 `snapshot packet` 的嵌入 metadata 或不可变可读 locator、适用的 harness / tool-routing 子集，以及下述返回契约。公共事实源是该 `snapshot packet` 与 `~/.claude/references/deep-discuss-style.md`；可在 prompt 内摘出与本维度相关的 `contract packet` entries，但完整 `contract packet` 仍须可按需读取。prompt 可补充任务指令，但事实或证据必须先冻结进 `snapshot packet`。原则组 reviewer 读取原则索引 / cluster 与获分配原则的完整正文，边界不清时按需追读相邻或完整原则文件；不得由 root 复述原则。diff-focused 时必须读取冻结的 hunks / base，且范围与裁剪依据一致。

所有 reviewer 只输出其负责维度下的 violation / borderline finding：

| 适用范围 / 条件 | 必需输出 |
|---|---|
| 所有 reviewer | snapshot id、`source manifest` 验证状态、`review_dimension`、未核实项；不修改文件、不发 AskUserQuestion |
| 每条 finding | file:line、原文证据、违反机制 / 影响、最小通用修法及 originating `review_dimensions` |
| 无 finding | 该维度的覆盖证据 |
| 原则组 reviewer | 回显原则；无 finding 时逐原则给证据 |

**行为保持型压缩原则组**：目标正文或 diff 含成段 HOW、精确命令 / 路径、cross-file reference，或包裹外部 program 时：

1. 由一个 reviewer 原子联合覆盖 `Why Over How`、`Simplicity First`、`Progressive Disclosure`；这是 `max-principle-per-subagent` 的固定质量例外，三条原则不再进常规原则组。
2. 将目标引用的 reference、program contract、`--help` 或 usage docs 冻结为输入；不可达项列为未核实。
3. reviewer 对每个 prescriptive block 先判断行为是否必要，再独立判断 authoritative owner；只有 guarantee 不变且组织更小时才报 finding，无 finding 时按公共契约给覆盖证据。

| 判定 | 输出义务 |
|---|---|
| `keep` | 不输出 finding |
| `compress` | 给出保持 guarantee 的更小组织 |
| `move / internalize` | 另给 authoritative owner |
| `delete` | 另给 substitution path |

该原则组属于 review-only，不能因未启用 optimize 而裁掉。

**追加审查**（按条件额外 spawn）：

| 触发条件 | reviewer / lens | 必传冻结输入 | 专属输出 / 约束 |
|---|---|---|---|
| 启用 `review + optimize` | `skill-optimization-principles.md` 全部原则 | 该文件要求的目标 / program evidence | 按其完整契约返回 |
| 本会话包含目标创建或实质修订过程 | `skill-creation-principles.md` | 用户输入、关键创建决策 / 过程证据与产物 | 按其完整契约返回 |
| 本次 diff 由当前 session 中已观察到的 artifact-failure 触发 | `fix-skill-from-session.md`「Fix 设计」 | 原始 failure / execution evidence、待独立核实的诊断候选及 base→diff | diff-aware 根因审查；不得把“修复成功”作为判据 |

整轮屏障只在 `review manifest` 的全集恰好等于保留原则 + 已触发 lens、每项恰有一个 owning reviewer、所有报告 snapshot id 一致，且 root 复核 `source manifest` 无漂移时解除；解除前不得编辑，漂移则丢弃整轮报告并以新 `snapshot packet` 重开。解除后 root 才汇总、去重并解决跨原则冲突；分波并发只影响调度。

### 2. 决策

root 以当前 `snapshot packet` 的完整 finding set 为单位核实、去重并判断是否成立；去重后的 finding 保留全部 originating `review_dimensions`。只有 in-scope finding 进入本轮决策。能自行完成的机械修复直接进入 `fix set`；真取舍按 `~/.claude/CLAUDE.md`「Surface Choices (Real Ones), Recommend One」经 AskUserQuestion 裁决后进入。

呈现 finding 时附 root 的判断和理由。finding 只能依据对应原则测试与已核实事实：前版更差、原则外价值或改动成本不改变 finding 是否成立，只影响处置；跨 reviewer 的存在性事实须独立核实。

### 3. 落地（触发验证重审）

**验证重审**：每个 fix set 只追加一个应用 `~/.claude/commands/custom/fix-skill-from-session.md`「验证」的 lens reviewer；逐原则合规由中立原则 reviewer 唯一拥有，该 lens 消费其报告，只独立检查跨段矛盾、删除依赖、丢失 guarantee 与 fix-footprint 重复。中立重审仍接收「审查」阶段的公共输入，但不接收上一轮 fix rationale、预期成功结论或确认式 framing——重审的价值在于对抗编辑者的 confirmation bias。

按上述分流一次性落地本轮 fix set。若有改动，待整批落地完成后才以新 `snapshot packet` 重审：范围至少包含本轮已修 finding 的 originating `review_dimensions`（原则或已触发追加 lens），再用完整原则索引与已触发 lens 清单对 fix diff 做一次 fresh impact scan，补入其语义可能受影响的 dimensions，并完整运行该 lens。description、控制骨架或外部接口改动是高风险提示；只有改变控制拓扑 / 接口契约、语义影响无法可靠界定或 impact scan 拿不准时才升级全量。不得因全文具有某种结构就自动重审未受影响的全部原则。无待处理 finding 则终止，并列出用户明确保留或延期的 finding。

若审查发现现有原则未覆盖某类问题，用 AskUserQuestion 把「是否改进对应原则文件」作为一项决策交用户拍板。改完后对该 principles 文件再跑一次本 command（按上方类型 gate 的能力说明，meta-原则维度不覆盖）。
