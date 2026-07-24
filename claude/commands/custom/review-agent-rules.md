---
name: review-agent-rules
description: 审计并按需修复目标项目实际生效的 CLAUDE.md / AGENTS.md 规则栈，包括跨文件冲突 / 遮蔽、死引用 / 漂移、可机械验证的 workspace 合规，以及无独立风险保证的重复 context / gate / model work。单文件写作质量走 review-claude-md，session 行为复盘走 review-session-skills。
argument-hint: "[project-root | 空=当前项目]"
disable-model-invocation: true
---

# review-agent-rules

## 输入、产出与边界

| 项目 | 契约 |
|---|---|
| 目标项目 | `$ARGUMENTS` 为空时取当前项目根；非空时解析为目标项目绝对根。下文“目标项目”均指该绑定 |
| 默认范围 | 目标项目，以及从项目根向上到 user scope 实际生效的 CLAUDE.md / AGENTS.md、它们引用的 rules / references，和同层级 harness settings（`settings.json` / `settings.local.json`——其 hooks / permissions 条目同属生效规则） |
| 审查对象 | 规则本身的矛盾、漂移、死引用、遮蔽关系、`token / workflow inefficiency`（含指令层 rigor 与 stakes 的相称性）、静态 transport 的 `capability / least-privilege` 相称性，以及可机械验证规则与 workspace 实践的符合性 |
| 不负责 | 单个 CLAUDE.md / AGENTS.md 的通用写作质量（`/custom:review-claude-md`）；当前 session 中 harness artifact 的异常行为归因（`/custom:review-session-skills`）；项目产品文档同步（`/custom:sync-docs`）；plan.md 实例的 `(A,V)` 相称性（`/custom:review-plan`） |

审计 I/O 流：

| 事实 / 产物 | Producer / source | Consumer | Status |
|---|---|---|---|
| harness 加载 / 遮蔽权威 | `~/.claude/CLAUDE.md`「Harness 适配」 | 阶段 1 | 必需 |
| 实际生效规则栈与行为引用 | 阶段 1 还原并跟随引用 | 阶段 2–3 | 必需；无法确认记 `unresolved` |
| 可机械验证的 workspace 事实 | 阶段 2 验证动作 | 阶段 3 | 条件；存在可机械验证主张时必需，无则 `N/A`，应有但证据不足记 `unresolved` |
| 本次执行证据 | 当前 session | 行为规则的合规判断 | 条件；缺失时不建立该类合规主张 |
| caller / gate 路径 | 阶段 1 还原 | 效率候选记录 | 条件；按“效率候选记录”状态门 |
| telemetry | 当前可得观测 | 效率候选的影响依据 | 条件；缺失时只能记 `projected` |
| 最终审计报告（含适用的效率候选记录） | 本 workflow | 用户 / caller | 必需输出；只对已核实覆盖范围给终态，证据缺口记 `unresolved` |

效率候选记录：

| 字段 | 适用性 | 状态 / 证据门 |
|---|---|---|
| 规则来源 / 适用范围 | 必需 | `value / unresolved` |
| 消费方（实际接收 context 或执行工作者） | 必需 | `value / unresolved` |
| 重复成本落点 | 条件 | 重复形 finding 必需记 `value / unresolved`；over-rigor / capability 等无重复子类记 `N/A` |
| 各重复单元及其独立风险保证 | 条件 | 重复形 finding 必需记 `value / unresolved`（含独立风险 contract 与验证强度）；over-rigor / capability 等无重复子类记 `N/A` |
| 无损替代路径 | 必需 | `value / unresolved`；说明改动（重复形删除/合并、over-rigor 降档、capability 去权 / 降 transport 档）后由谁承接每项保证 |
| 承重证据 | 必需 | `value / unresolved`；包含 locator、snapshot / observed_at、当前适用性复核或失效边界 |
| caller / gate 路径 | 条件 | 存在记 `value`，不存在记 `N/A`，应存在但无法核实记 `unresolved` |
| 影响依据 | 必需 | 有 telemetry 才能记 `measured`，否则记 `projected` |
| disposition | 必需 | 枚举、证据门与后继见下表 |

| Disposition | 证据门 | 后继 |
|---|---|---|
| `finding` | 所有必需字段已核实，且 inefficiency 与无损替代均成立 | 进入 decisions / edits |
| `retain` | 所有必需字段已核实，但 inefficiency 或无损替代被否定 | 记录结论，不编辑 |
| `unresolved` | 任一必需字段**已实际尝试核实却被真阻断**（源不可达 / 权限拒绝等）——廉价可查的（读源码 / 跑 `--help` / 查 filesystem）不得跳过后当未核实 | 保留证据缺口，不编辑 |

遵循 `~/.claude/references/deep-discuss-style.md`；不要把“实践当前如此”静默当作规则应当如此。

## 审计骨架

### 1. 还原生效规则栈

按当前 harness 的加载与遮蔽语义，从 user scope 到目标项目识别真正生效的指令文件；项目同时存在 CLAUDE.md 与 AGENTS.md 时，按 harness 适配规则补读被遮蔽但仍有约束力的文件。跟随规则文件中会改变执行行为的引用，记录每条规则的来源与适用范围。

**两个相称性检查默认执行**（无需触发信号，均为静态编码的廉价核查）：(a) capability/least-privilege——静态 transport（spawn 子 agent / 外部 program 的权限档）授予的运行时权力是否与任务所需相称；(b) over-rigor——mandate 的 assurance 是否超出 stakes 所需档位（判据均见 §3）。更重的**重复 / 成本拓扑还原**仍**按触发门**：用户明确要求效率审计或初扫出现重复迹象时，再为候选链路补消费方、加载生命周期 / 触发条件 / 重复频率，还原 `context / workflow 成本拓扑`。

无法确认某文件是否生效时标为 `unresolved`，不要把“文件存在”误报成“规则已加载”。

### 2. 从规则到可验证主张

只把能由 workspace 事实验证的规则转成检查主张，例如文件/目录存在性、命名、同源关系、必备内容、禁止落点、命令或路径真实性、settings/permission 等 harness 配置条目所引用对象是否存在（如指向已退役工具的死引用）。每条主张保留：`来源 | 适用范围 | 期望状态 | 验证证据`。

沟通风格、推理偏好等行为规则不能靠静态 filesystem 证明；除非本次有执行证据，否则不把它们伪装成合规检查。

### 3. 规则、实践与效率审计

| 分类 | 判定 |
|---|---|
| `practice violation` | 规则清晰且仍有效，workspace 实践违反它 |
| `stale rule` | 规则描述的对象已退役，或权威事实已改变；不能仅凭“多数项目都没遵守”判旧规则过时 |
| `conflict / shadowing` | 同一适用范围内的规则互相矛盾，或加载遮蔽让预期规则实际不生效 |
| `dead reference` | 规则指向不存在或不可解析的文件、section、命令或路径 |
| `token / workflow inefficiency` | 同一消费方重复摄入等价规则 / context，或同一对象与风险 contract 被重复 review、test、judge、轮询或重跑，却没有独立风险保证；或某规则 / 指令 mandate 的 rigor 超出其治理对象 stakes / 可逆性所需档位（`~/.claude/references/rigor-tiers.md` proportionality invariant），即便无重复 |
| `capability / least-privilege 违规` | 规则栈 route 进的 work-driving command / skill 的静态 transport 授予执行工作者超出任务所需的运行时权力（sandbox / approval / kill / FS-write 档）；危害轴是共享宿主 / 并发 session 的 blast-radius，与 inefficiency 正交（判据见下 capability 段）|
| `unresolved` | 当前机器、权限或证据不足以判断；保留缺失证据，不猜结论 |

finding 必须给出规则原文位置、验证动作/事实和影响。没有 finding 时明确报告 clean 与实际覆盖范围。

`token / workflow inefficiency` 与 `capability / least-privilege 违规` finding 必须满足“效率候选记录”的证据门。重点检查 ownership 不清、兼容 contract / charter 未合并或证据无失效边界造成的重复 model work。文件长、调用多或措辞相似本身都不是 finding；不能证明无损替代时保留现状。

**over-rigor 子类**（只判 over 方向）不要求“重复”：其判据是 `~/.claude/references/rigor-tiers.md` 的 proportionality invariant。审计对象是规则栈 route 进的 work-driving command / skill 里**静态编码**的 rigor（不止 CLAUDE.md 散文）；**不含**这些 command / skill 产出的 plan.md 实例的 `(A,V)` 相称性，也不含某 session 观测到的运行时 rigor（分属 review-plan 与 review-session-skills）。效率候选记录中 `重复成本落点`、`各重复单元及其独立风险保证` 记 `N/A`，`消费方` 记承担过度 rigor 的执行工作者，disposition 证据门里的“inefficiency 成立”读作“rigor 过度成立”。降档修复须证明无损替代：降到相称档位后由谁承接每项真实风险保证，不弱化实际保护；证明不了则 `retain`。

**capability / least-privilege**（`capability / least-privilege 违规` 分类的判据详情）：判据同为 proportionality（相称性），但维度是**执行工作者被授予的运行时权力**（sandbox / kill / FS-write 档），而非施加于被改 unit 的 authorization+verification 机制强度 (A,V)——审计 spawn 子 agent / 外部 program 时的静态 transport 权限档是否超出该任务实际所需。缺陷方向**同为 over（过授）**：least-privilege 只判过授（欠授只是功能 bug、不在本命令 scope）。与 over-rigor 的区别在**危害轴**——over-rigor 浪费的是 assurance 努力，capability 过授则弱化共享宿主 / 并发 session 的 blast-radius 保护（如只读任务拿到 full-capability transport）。**审计边界、效率候选记录映射、无损替代证明门均同 over-rigor 子类**（将“rigor 过度”读作“能力过授”，`消费方` 为被过授的执行工作者）；capability 特有的无损替代如“只读评审改用只读 FS + 仅 /tmp 写、去除 kill”，证明不了则 `retain`。

### 4. 决策、修复与复验

修法唯一或近唯一、可逆且不改变规则语义的机械修复直接执行并汇报；finding 是否成立存在合理分歧、修法多路各有代价、会改变规则语义 / source of truth / scope，或有破坏性 / 外部影响时，集中呈现为 `finding | 证据 | 推荐修复 | 影响面`，通过 `AskUserQuestion` 让用户选择。修复归属由 source of truth 决定：实践错则修实践；规则错则修 owning rule；遮蔽/同源问题则修加载结构。`token / workflow inefficiency` 修复须保留独立风险保证：保留唯一 owner，删除无独立风险保证的重复摄入 / 调用，或合并 contract 兼容的工作。不得复制规则制造第二真相。

**finding 的 scope（项目 vs user）不改变可动作性**：user-scope / 跨项目共享的载体（user CLAUDE.md 及其 references、user-level skill / command、被规则栈 route 进的共享 wrapper / transport）与项目载体一样，成立即按下方落点修——**不得**因「是 user-level / 共享 / 会波及别的项目」把它排除、延到「另一次 user-scope review」或降格为只观察；共享载体 blast-radius 更大（波及所有项目），更该修。

修复后按落点进入 owning workflow：

| 落点 | Owning workflow |
|---|---|
| CLAUDE.md / AGENTS.md（symlink 审其实际 source） | `/custom:review-claude-md` |
| principles 文件 | `/custom:review-principles` |
| skill、command、其他 reference | `/custom:review-skill` |
| 项目 README / CHANGELOG / docs/ | 以目标项目为 `target_repo`，将 finding、规则来源、修复 diff 与原验证证据作为改动语境 / 源证据，按 `sync-docs.md`「被 supervisor 编排复用」执行完整 recipe |
| script、hook、配置或其他文件 | 相关测试 + 生成后 review gate |
| symlink / 目录结构等 filesystem 状态 | 重新运行原验证 |

| Owning workflow 结果 | 原审计动作 |
|---|---|
| owner 定义的成功终态 | 重新运行每项原验证，再判断是否完成 |
| 等待中 / 非终态 | 保留 owner 状态与 recovery point；不恢复原验证 |
| 非成功终态，或 `unresolved / stale / blocked` | 停止原审计，以 `unresolved` 回传缺失证据与 recovery point；owner 后续达到成功终态后才能恢复 |

各 owner 保有自己的状态词汇与成功判据；例如 docs recipe 只有其「输出」定义的 `recipe status = converged` 才是成功终态。恢复后确认实践与规则一致且未制造新冲突。

## 输出

最终审计报告包含审计范围与加载关系、findings/decisions/edits、未解决证据缺口及验证结果。对每个适用的效率候选，输出 `context / workflow 成本拓扑` 及一份符合“效率候选记录”schema 的记录。只报告已核实的合规结论；未覆盖范围不得写成 clean。
