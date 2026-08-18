---
argument-hint: [project-root=cwd] [定位提示] [calibration=diagnose-only]
description: 审查项目的 LLM 成本观测是否贯通计量、定价成本、主动消费与调用归因，并按影响范围修复。用于新增或修改 LLM 调用、成本报表/告警、定价或 prompt 成本优化后。
---

# review-llm-cost

输入 (`$ARGUMENTS`)：项目根（默认当前工作目录），可附定位提示。`calibration=diagnose-only` 只产出诊断，不提问、不修改，在 remediation 前停止。

审核对照 `~/.claude/references/llm-cost-observability-principles.md`。服务故障告警的 page/消息/合并质量另按 `alerting-review-principles.md`；本命令只判断成本信号是否存在、可比较并进入正确消费链。

## 四层诊断

| 层 | 必查事实 | clean 条件 | 典型修复方向 |
|---|---|---|---|
| 1. 计量 | **请求派发** → provider 返回 usage → parse/validation/save/retry 的完整时序，含 usage 从不返回的路径（超时、断流、5xx、取消）；provider/model/stage/item/attempt、input/output/cache、route 与 outcome；失败计数 | 判据档 P1，含其降级边界一段 | 按 P1 处置。注意它的默认是 blocker：仅凭权威契约声明不足以把 survivorship gap 降为 limitation，须有扣费面带外证据加修复期限 |
| 2. 定价成本 | 精确型号、有效区间、community TTL/cache/fallback、supplement、source currency/FX、priced/nominal/unpriced、fresh/stale/due-review、独立对账 | 未定价不归零；历史按调用时间派生；authority 与算术一致性分开；未知 cohort 可见 | 查询时派生；interval supplement；显式三态/新鲜度；独立 raw-catalog reconciliation（注意它只在映射轴上独立，测不了 catalog 本身错价）；按判据档 P8 的偏差**性质**启动闭环——不要设幅度门限 |
| 3. 消费 | pull surface、周期报表、量结构告警、价格通知；逐 consumer 核对决定性比较的两侧资格、真实基线/上膛、fire/升级/恢复与 dedup/re-arm；当前窗口完整性与历史 baseline 日资格分开取证 | 趋势和异常都有 push；每个 required consumer 的比较确实形成两侧读数；任一侧缺失时显式 unarmed/degraded 而非继续发布可评估结论；stuck firing 仍能暴露新事故 | 增加报表与分责通知；共同 tariff/cache 基准；可见 armed 状态；用完整证据恢复、用下界只做单向判断 |
| 4. 归因 | 调用点、prompt 固定/动态/正文构成、单调增长注入、cache-fit 顺序、同一调用的 actual/all-miss、route/质量 | 优化差额只归因到同一调用与共同 tariff；剩余差额保持未归因；cache hit 与 coverage 分开 | 拆 prompt 构成；稳定块前置；记录 per-call cache/route；同一调用做 actual-vs-all-miss，另列其他 effects |

一个 finding 可跨层，但最终只有一个 owner；上游层修复后，下游只消费新 contract，不复制补丁。

## 工作流

**终止条件（全命令，不属任一阶段）**：常规模式下四层都完成 full review、`blocker=[]`、所有 limitation 已在面向人的消费端主视图或其口径指针上显式承载、证据覆盖最终状态。缺真实输入、等待用户裁决或仅有 fixture PASS 都不能报 clean。`calibration=diagnose-only` 不适用 `blocker=[]`——它按定义不修复，输出冻结报告即为正常结局。


### 0. 定位与接地

列出 provider 调用与 retry、usage schema/writer、pricing resolver/catalog/supplement、成本聚合与审计、pull/push consumer、部署调度、prompt/caller 的完整文件面。先从项目权威成本契约冻结 **declared cost scope**（哪些 stage/call、successful call 还是 billed attempt、哪些 consumer）；没有契约时不得自行窄化，按全部 production paid calls 审。打印目标 checkout 的绝对路径与 commit；真实 usage/部署输入可取得时必须接地，不可取得时收窄结论并列 `unverified`，不能用 fixture 关闭 live 风险。

文件面搜索默认只扫 tracked files：优先 `git grep` / `git ls-files`，使用 `rg` 时显式排除 `.git/**` 与未跟踪运行产物。凭据或校准禁区的越界判据是工具实际把禁区内文件作为读取/搜索目标；允许文件或 `.git` 元数据里偶然出现一段禁区路径字面量，不等于读过该禁区，但 broad search 进入 `.git` 本身仍是不合格的接地动作。

接地不得读取或搜索任何可能含值的凭据载体，包括 `.env`、shell 环境、进程环境、LaunchAgent/服务定义中的内联 secret 与用户级 credential 文件；不得把 secret 值带入 transcript。配置键、默认值与 wiring 只从源码和示例配置取证；live 是否设置一律用只产布尔/计数的仪器，当前工具集做不到时列为 `unverified`，不得为关闭证据缺口扩大读取面。

先冻结被审输入。每个 PASS 仪器必须给出相反结局的对照，scan 必须打印非零对象数；resolver 审计不得调用生产 resolver 得出自己的 expected。告警至少观察一次状态转换；分布阈值先以 before 重复样本证明噪声范围；异常测试核对异常身份与目标副作用。

### 1. 审查

四层各用一个 fresh readonly subagent 并行审查。每个 reviewer 读取完整原则文件、目标文件面与冻结 evidence，只负责一层，返回：`layer`、`status=clean|limitation|blocker`、对象数、**现有正向能力及其明确边界**、已验证事实、finding（file:line + 违反机制 + 影响 + 最小修法）、未核实项与对照结果；不修改文件、不发用户提问。每层至少亲自核实一项现有能力或明确报告对象数为零；blocker 不能把仍然存在的 partial capability 抹成不存在。尤其区分事实层已经记录的字段、聚合层已经派生的对照与人类消费端真正展示/采取动作的能力，不能因最后一层缺失就反向否认上游已存在的事实。

Layer 3 先列出全部 required consumer，再逐个给出其决定性比较两侧的资格判据与阴性对照；存在源码 wiring 或 fixture 分支不等于比较成立。尤其不得用当前窗口的完整性证明历史 baseline 日合格，也不得只验证 `baseline_days` 是非零——要让历史侧缺失/不合格并观察该 consumer 是否转为 unarmed/degraded。漏掉任一 required consumer 的这张逐项证据表，不得给 Layer 3 定最终状态。

最终四层表须同时保留贯通盘点：计量层有哪些 declared-scope 事件/字段确实落下；定价层是否按查询/调用时间派生并把 priced/nominal/unpriced 与 freshness 暴露给哪个主视图；消费层实际存在的报表、量结构告警与价格通知各有几个；归因层现有 per-call cache split、actual provider/route 与 same-row actual/all-miss 派生能到哪一层。没有亲自核实这些正向对象，不得只凭 blocker finding 冻结报告。

主 session 核实存在性事实、去重跨层 finding，并先按下表定 layer status，再给局部 finding 标严重度。`blocker` 表示该层核心能力缺失或其整层结论不可用；`limitation` 是已被权威契约诚实收窄、declared scope 外、尚无生产阳性实例，或不否定该层核心能力的局部缺陷。局部 finding 可以是 HIGH，但不能仅凭“值得修”升级成 layer blocker。

| 层 | 结构性 blocker | 不单独阻断整层的 limitation/finding |
|---|---|---|
| 1 | declared scope 内普遍无 per-call 事件；attempt 的存在性取决于派发之后的某一步（usage 未返回即无记录）；unknown 与 0 同形；surviving-call 数据被契约或消费端称为 billed-attempt total | survivorship gap **默认是 blocker**，只有同时满足判据档 P1 那一段的三项才降为 limitation：契约已限定口径、扣费面带外证据证明占比可忽略、且带修复期限；scope 外调用点；无阳性实例的局部 failure path |
| 2 | 未定价归零；无 provider/time-aware 价格；价格状态不可见；对账按构造不能与 resolver 分歧；已知系统性 tariff 偏差尚未完成 P8 的事实源修正与全消费者闭环，使该层金额结论仍建立在已知错误或未闭合的价格证据上 | 已显式 nominal/stale/due-review、且没有已知系统性偏差或未闭合修正的权威性缺口；不改写核心金额语义的局部维护/显示问题 |
| 3 | 只有 pull；无趋势或异常 push；任一 required consumer 的决定性比较按构造没有真实两侧却发布可评估结论；规则永久不上膛且读作健康 | 已形成真实两侧并上膛的链路中的局部文案、筛选、时效或未演练状态；不推翻该 consumer 核心结论的单点缺陷 |
| 4 | 调用点、prompt、cache、route 中任一必要归因轴在 declared scope 内完全缺失，或优化结论没有同一调用与共同 tariff 证据 | 已有受控归因证据后的迁移边界、scope 外 route、进一步解剖机会或局部展示缺口 |

### 2. 决策与落地

常规模式下，把核实后的 finding 通过 `AskUserQuestion` 交用户逐项裁决，标出推荐修复与不修影响；按选择修复后进入第 3 节重验。`calibration=diagnose-only` 输出冻结报告即停止，不进入本节。

### 3. 重验范围

| 变化 | 失效的既有 green | 最小重验范围 |
|---|---|---|
| usage event、schema、writer、provider-return/failure/retry 时序 | Layer 1；依赖其字段/完整性的 Layer 2–4 证据 | Layer 1 全层 + 实际消费该 contract 的下游层 |
| resolver、tariff、effective interval、FX、freshness 或型号映射 | Layer 2；所有金额、比较、阈值与归因成本 | Layer 2 全层 + Layer 3 金额/生命周期 + Layer 4 成本归因 |
| 报表、告警、通知、基线或部署 wiring | 对应 Layer 3 consumer 与 lifecycle | 受影响 consumer 的真实输入、push/arming/transition；上游 contract 未变则不重跑 |
| prompt、动态注入、route/model、cache 采集或质量 gate | Layer 4；相关 per-call 成本与 cache 结论；若 usage shape 变则 Layer 1 | Layer 4 同调用对照 + 受影响的 Layer 1/2 字段与 Layer 3 展示 |

除上表外，出现新 provider/model/stage、unpriced cohort、attempt failure path、价格过 TTL/复核期、真实输入或部署状态漂移、对象数变零、对照不再能报相反结局，都会使对应 green 失效。局部修复后只重跑受影响层及其下游依赖；最终仍要在 final tree/runtime 做一次四层 full review，确认没有旧证据因依赖变化失效。

不为本命令引入 ledger、receipt 或长期 review 状态机。

## 校准测试

本节不在运行路径上——只在修改本命令后由维护者执行。

校准用的预期集合（跑一遍本命令、比对它该发现哪些 finding）**刻意不放在本文件里**：命令正文会被执行 context 载入，答案就会经由第 1 节要求的强制阅读抵达 layer reviewer，校准从此度量复述而非发现。本仓未收录那份预期集合——要做校准得自己按同一纪律另起一份，不要写进本文件。

## 反模式

- 把 expected set 交给 reviewer，让它按答案找证据。
- reconciliation 复用生产 resolver，或以一次 snapshot 证明告警 lifecycle。
- 为得到 clean 把 unpriced、unarmed、in-progress 或 survivor-only scope 吞成零/健康。
- 局部修复后全量无差别重跑，或只重跑修改点而不重验失效的下游 green。
