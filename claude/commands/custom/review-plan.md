---
argument-hint: <plan-path> [max-principle-per-subagent=5]
description: 审查一份实现 plan.md，逐条对照 plan-review principle 修复。用于你想审查 **plan 文档本身**的完整性、可执行性与取舍是否站得住时——开始实施前尤其适用，已在实施中要复审文档本身时同样受理。要的是把工作项逐条落到模块、看改造前后的架构与能力差异 → /custom:map-program-architecture。
---

# review-plan

输入 (`$ARGUMENTS`)：待审 plan 文件路径（默认 `.claude/plans/` 最新一份），可附加 `max-principle-per-subagent=N` 覆盖默认值。

## 参数

| 参数 | 必需 | 默认 | 说明 |
|---|---|---|---|
| max-principle-per-subagent | ✗ | 5 | 每个 subagent 至多分配的 principle 数量；值越小，每条 principle 获得越多注意力 |

## 输出契约

交付给 `execute-plan` 的是**最小充分计划**，不是 review 过程或执行期 verifier 的实现蓝图。plan 内容边界以全部适用的 `~/.claude/references/plan-review-principles.md` 为唯一权威，尤其是 P1 / P5 / P9 / P11；本 command 只定义审查编排。`clean` 只是审查状态，修复后仍保持这一输出契约才算成功。

## 工作流

主 session 开始前完整读取 `~/.claude/references/plan-review-principles.md` 与 `~/.claude/references/deep-discuss-style.md`。

本 command 的**所有** subagent spawn（原则审查、目标反证、局部反证）通道按 `~/.claude/references/delegation-policy.md` §Transport selection 判；走 in-process 时用 `general-purpose`，且一律**不传 `name`**——它们的 findings 都要由主 session 消费。

**severity 定义（分级只按此定义，不按修复成本）**：
- **violation** = 某条 principle 的可执行判据（其 flag 条件）被明确命中，且不修会造成该 principle 要防的实质后果；或目标反证给出完整因果链，证明 plan 按字面执行且 verify 全过仍会造成 consumer goal 失败——且该反例指向**缺失或错误的机制/契约**。前者的实质后果**限于 plan 期必须出清的面**：用户面（consumer goal、plan 所声明 verify 的真实性、用户决策权、承诺面/scope——其中 verify 的真实性只在**放得过 consumer goal 失败**这一形态上算必须出清，判据、例外与可下沉形态见下「verify 类 finding 不单独成档」）、plan 作为交付物的内容边界（scope 溢出、无谓抽象），以及各原则点名、且无法由实施期自决消化的其他实质损害（典型：约束多个执行单元的接口缺口）；修复本身需要用户决策的 finding（高反转成本取舍、无从推导的阈值）同属 plan 期——走「决策」真取舍路径当场问，把人机交互集中在 create-plan、让 execute-plan 免于中途向用户索取决策正是两阶段分工的设计目标（create-plan「风格与取舍」）。后者无法映射现有 principle 时同时记为 principle coverage gap。**原则审查路径的分流**：实质后果不落在上述面上、而修复按 bounded TODO 条目判据属实施期义务的，按 bounded TODO 处置，不判 violation、不触发 plan 重写；目标反证来源的下沉口径更窄，见「目标反证」。（L1/L2/L3 依 `create-plan`「三层产物」。）
- **borderline** = 上述判据未明确命中，或命中但不造成任何实质后果——只是原则精神层面的改善空间；修不修不产生实质差异，即使修复可在实施期顺手完成也不升为 bounded TODO。
- **bounded TODO** = 判据成立、不修确有实质后果，但修复无需用户决策、implementer 凭实施期信息可自行完成，故属实施期——execute-plan 看得到真实代码与测试，比 review 期更有信息修它。两类：把已存在且结构正确之机制再钉细一层（具体参数、边界值、精确措辞；"结构正确"依各 principle 自身判据，典型如 P14——plan 固定比较动作即可，阈值不必 plan 期定死）；或 implementer 可自行设计补全的 L3 缺口，**下沉资格是修复不约束其它执行单元的接口**——跨单元接缝只有 review 期看得全、execute-plan 逐单元执行时反而信息更少，这类保持 violation（正是 violation 面清单末项的典型例）。目标反证来源仅钉细类可下沉（理由见「目标反证」）。它是 implementer 的义务而非抛光，去向与 borderline 不同（见「终止判据」）。归类只按本条判据，不因某轮决定"下沉"而成立。
- **verify 类 finding 不单独成档，按危害落进上面三档**：本条只作用于危害形态为**漏报**的那些。现有 verify 放得过 consumer goal 失败（该失败没有任何断言会红）属 plan 期必须出清——execute-plan 只看得到全绿，不会去问"全绿是不是因为没人在测它"。危害形态是迭代成本、死锁或机具不可负担的（典型 P12 / P17——同样是例示、不是独立入口：具体 finding 仍按它自己的危害形态判，某条若确实使某个失败在 gate 前无人报，回到本条），不适用本条，按各原则自身判据与上面 violation 面清单判。判据是一句：这条不修，有没有哪个真实失败会因此**在 gate 前**没人报？判为"没有"时，写出被检查的那个失败与覆盖它的那条断言（有编号写编号，无编号则引原文）；**指不出那条断言就说明判据答的是"有"，回到出清**。只写"不会"时，它与没找过同形。该前提成立之后，典型可下沉形态是编号与交叉引用、不改变放行条件的范围写法、比较动作已固定后的阈值精确化——这三样是判据的例示、不是独立入口，任一在具体 plan 里改变了放行条件就仍然出清。理由：verify 覆盖与分层那一组 principle 产的 finding 量大，若不分层一律出清，这一大类结构上永远进不了 bounded TODO——实测一次 5 轮评审 27 条 finding 全判 violation、下沉档触发 0 次。
- **不确定性不是 severity**：主 session 先核实 finding 依赖的事实。事实成立且存在上述实质后果才判 violation；事实成立但无实质后果是 borderline；当前无法核实则在 review report 记录证据缺口并标记 blocker，继续取证或请求用户解除，不得为了“保险”先改 plan、再用重跑验证猜测。

**clean** = 某个 gate 经主 session 裁决后无成立的 violation、未决 blocker 或用户决策。仅剩 bounded TODO / borderline 不碍 clean，但 bounded TODO 须先按「终止判据」落进 plan，落盘完成该 gate 才算 clean。

**术语**：
- **candidate root cause**：单条 finding 对失败原因的待核实解释。
- **root cluster**：经主 session 核实、由同一 causal mechanism 产生的 findings 集合；相似 consumer failure / control surface 只用于提出聚类候选，不足以证明同根。
- **root-wide footprint sweep**：同一 candidate root cause 复发时，对已知 manifestations 与上一 remediation 覆盖面做一次合并检查；它检查既有根因覆盖，不是下文评估拟议 edit 的 remediation footprint gate。
- **abstraction reset**：停止 manifestation-specific 的局部追加，改为重设 root cluster 的 contract / invariant / model。
- **impact-scoped review**：只审受改动影响的 principles、consumer path 与 remediation diff。
- **final full review**：覆盖全部适用 principles 的中立审查，不携带修复意图。

**控制流**：入口就是 final full review；clean 进入目标反证。任一 gate 有发现都进入 Finding triage and causal closure → 决策 → 落地 → review routing：局部 remediation 先走 impact-scoped review，有 violation 回到同一 finding 入口，clean 才回 final full review；结构性 remediation 直接回 final full review；目标反证 remediation 后重新通过 final full review 与目标反证；**另有一条无条件边：预算最后一轮并行跑保底反证**（见下）。最终两个 gate 都 clean 才终止；**另一条终止边是收敛停滞熔断，由用户拍板定稿**（见下）。展示与提问风格遵循 `~/.claude/references/deep-discuss-style.md`。

**目标反证的保底触发**：预算的最后一轮，无论 full review 是否 clean，都与 principle 审查**并行**跑一次目标反证（同一 plan 快照），其发现与该轮 principle 发现一并进 triage。理由：循环只在有成立 violation 时继续、有 violation 即不 clean，否则反证可能整个预算内一次都不跑，plan 未经对抗式测试就走到熔断。该轮 full review 亦 clean、且自保底反证取快照起 plan 未再改动时，这次保底反证**即满足**终止所需的那次；快照已变（该轮有 remediation）则须在新快照上重跑。

**终止判据（severity 门控，非"零发现"）**：final full review 与目标反证均 clean，即终止循环。真取舍 AskUserQuestion、principle coverage gap 决策必须先落地；blocker 未解除时停止推进 gate，无人值守流阻塞等待而非降级放行。borderline 只留在 review report / 最终汇报，不改 plan、不触发重跑；会影响 `execute-plan` 的运行风险按其实际后果重新分级，不得伪装成 borderline 写入 plan。bounded TODO 则写进 plan 的 bounded TODO 清单（`create-plan`「不留 Open Question：升级路径」允许留置的 TODO 一类），每条注明它细化或补全的是 plan 里的哪一处（步骤、阈值、风险项；缺口类锚定到其所属步骤/单元），并记入 review report。这条落地与其它 remediation 同路——照常过 footprint gate 与 review routing，不设豁免；gate 要的"改变哪个执行决策"由该条所指的那一处回答。理由：实测收敛曲线是长尾；无实质后果的抛光不应污染 implementer 的唯一入口，而放得过失败的 verify gate 必须在 plan 阶段出清；实施期义务反过来只有落进 implementer 的唯一入口才算移交，只进 report 等于丢弃。

**收敛预算与停滞熔断（防审查长尾自我延续）**：自"首次修订后的 final full review"起设**轮次预算，默认 2 轮**。**1 轮 = 一次 final full review 及其 triage / remediation，无论该轮是否走到目标反证**——反证缺席的轮次照常计数，否则预算永不耗尽、保底触发也永远识别不出"最后一轮"。每轮结束前核对收敛趋势，命中任一即判**收敛停滞**：①本轮成立 violation 是**全新区域**的更细规格化而非同根复发（abstraction reset 未触发）、②plan 体量随轮次单调增长、③每轮又新增 owner 决策、④轮次预算耗尽。判停滞则**停止自动改 plan**：把累积残余整理成清单并逐条标明类别（violation / borderline / bounded TODO），用 `AskUserQuestion` 交用户，默认**推荐"当前 plan 定稿、其中的 bounded TODO 落进 plan、borderline 仍只进 report"**，并给出"指定继续深审的具体子系统"备选。**但残余里若含尚未解决的 violation（它们全落在 plan 期必须出清的面上），或本轮 remediation 尚未经任何 gate 复审，默认推荐改为"先修该项 / 先复审再定稿"**，并在清单里单独列出它——那条"定稿 + 下沉"的默认只承接 borderline 与 bounded TODO，拿它承接真 blocker 与本节"放得过失败的 verify gate 必须在 plan 阶段出清"直接相反。用户选"定稿 + 下沉"时，**先按「终止判据」把 bounded TODO 落进 plan，才算定稿**——否则清单只活在规划 session 的对话里，新 session 看不到，用户以为移交了、实际是丢弃了。人在不动点裁决，循环不得自我判定"审干净了"再续跑。理由：对抗式反证对宏大 plan 的更细规格化供给无界，无边界则循环存在数学上无法达到的不动点——必须由轮次预算 + 停滞熔断把人放回决策点，而非等"反证无话可说"。

**唯一豁免（预算耗尽的唯一解除条件）**：本轮实际触发了 abstraction reset（判据见下「Finding triage and causal closure」第 4 条——同一 causal mechanism 仍未被上一 remediation 的 invariant / model 覆盖），先重设再重算预算。绑到这个可观察事件而非"本轮有无机制类 violation"——后者几乎每轮都成立，豁免会退化成预算永不封顶。注意 ① 与本豁免互斥（其判据本身已含 abstraction reset 未触发），②③ 不被豁免覆盖、命中即交用户；多条同时命中时，只要有一条未被豁免覆盖就交用户。

**本次 review 内**重算累计不超过 2 次，再次命中仍交用户决定是否加预算。已重算次数与"保底反证是否已跑"写进 review report——跨调用续接时读上一份 report 即可，本命令不另设跨 session 状态。

### 原则审查执行机制（final full / impact-scoped）

将 principles 按 `max-principle-per-subagent` 均匀分组，每组 spawn 一个 reviewer 并行审查。

每个 subagent 的输入：
- `~/.claude/references/plan-review-principles.md`（传完整文件——相邻 principle 提供边界上下文，帮助 subagent 避免报告属于其他组的发现；明确告知只应用分配给该 subagent 的那几条 principle。conditional principle 仅在适用范围内生效）
- `~/.claude/references/deep-discuss-style.md`
- 目标文件
- review mode：impact-scoped review 另附 assigned principles 与 remediation diff / change manifest；final full review 标明 neutral / full，不附修复意图

每个 subagent 只输出其负责的 principle 下的发现（附证据 + 命中了哪条 flag 条件）；severity 分级由主 session 按顶部 severity 定义统一裁决，不要求 subagent 自分级。subagent 不修改文件、不发 AskUserQuestion。

每条 finding 还须给出：candidate root cause、受影响的 plan subsystem，以及若不修对 `execute-plan` / consumer 的具体后果。它们是主 session 聚类输入，不是 subagent 的最终裁决。

### Finding triage and causal closure

原则审查的全部 subagent 完成后，或目标反证返回发现后，主 session 按以下顺序汇总，不能把它压成逐 finding 修补：

1. 核实事实并去重同一断言。
2. 先按共同 consumer failure / control surface 提出聚类候选，再核实是否共享 causal mechanism；无法证明同根则保持为独立 candidate root causes。一个成立的 root cluster 只设计一个 remediation。
3. 当成立 root cluster 的 causal mechanism 可能横跨 sibling consumer paths，或其后果是 consumer goal 失败但 verify 通过时，设计 edit 前做 consumer-path closure sweep：沿受影响承诺检查 sibling consumer paths 与对应 verify，寻找 sibling manifestation。sweep 的新增结果必须回到事实核实与去重，再重新聚类；只有核实为同一 causal mechanism 才并入原 root cluster，新根因保持独立。若 post-remediation final full review 的 finding 证明上一批 consumer-path closure sweep 不完整，则按同一 lens 扩大到全部 load-bearing consumer paths；无关的新根因或局部 regression 仍走普通聚类。plan 始终是 sweep 输入；当受影响的 consumer semantics 由外部 source of truth 持有或受影响承诺引用了外部契约时，还必须取得对应权威源定义，无法定位或读取则按证据 blocker 处理；不存在外部 source of truth 且 plan 自包含时，plan 证据即可，本应引用却缺失的外部契约作为 finding。该 sweep 由主 session 执行，不另起一轮 principle reviewer。
4. 同一 candidate root cause 复发时，先核对首支的 deferral 情形；其余先做 root-wide footprint sweep，再按证据分流：
   - 复发 finding 的上一处置是已落进 plan 的 bounded TODO 条目、且按顶部 severity 定义仍判 bounded TODO → 视为 resolved-by-deferral：对清单去重后即完结，不进 footprint sweep / abstraction reset，也不触发「唯一豁免」——下沉是有意的推迟，不是失败的 remediation，中立 reviewer 无跨轮记忆而复报同一条是预期行为。
   - 上一 remediation 的 invariant / model 已覆盖该 causal mechanism，只是既定 edit 未按意图落地 → 补全原 remediation。
   - 同一 causal mechanism 仍未被上一 remediation 的 invariant / model 覆盖 → abstraction reset。
   - 出现新的 causal facts → 回到事实核实与去重，再重新聚类；未完成重聚类前，不预判它属于既有 root cluster 或新的 candidate root cause，也不继续设计 remediation。
   改变用户承诺 / scope 时走 AskUserQuestion。
5. 检查收敛状态：blocker 未解除时按「终止判据」停止推进或等待；仍有未核实的新 manifestation、causal fact 或待重新聚类事实时，从本节起点继续收敛；其余情况再标注 principle、按 severity 分级、按优先级排序（编号小者胜），进入「决策」。

### 决策

**先按 severity 分，再按修复性质分流**：borderline → 仅进 review report / 最终汇报（不改 plan、不重跑）；bounded TODO → 按「终止判据」落进 plan 的 bounded TODO 清单；violation → 按下表决定是否上 AskUserQuestion，不是所有 violation 都值得一个用户 gate：

| 修复性质 | 处置 |
|---|---|
| **机械修复**（修法唯一或近唯一，且不设定或改变任何用户级取舍：补已有接口的可观察断言、修命令/路径 bug、消除歧义措辞、把已对齐取舍落成文字） | 通过下方 remediation footprint gate 后，agent 自决直接修，向用户汇报即可，不上 AskUserQuestion——让用户对一排"(推荐)"点确认是橡皮图章，不是决策 |
| **真取舍**（约束 vs 缺陷之争、scope 增减、修复方案多路各有代价、会改变 plan 承诺面；凭空设定质量/成本阈值、改动承诺面措辞均属此类——阈值只有能从 plan 已声明取舍或实测基线数据推导时才算机械） | 整理为 `AskUserQuestion` 让用户决策，不预设修复让用户照单全收 |

**Remediation footprint gate**：落地前合并查看同一 root cluster 的拟议改动，而不是逐行判断“机械”，并按全部适用 principles（尤其 P1 / P5 / P9 / P11）裁决 plan 内容边界。若整体 footprint 新增方案表面或 implementer obligations，必须说明它改变哪个执行决策或 PASS/FAIL；说不出则退回更高抽象层。若改变方案形态或承诺面，按真取舍处理。若 footprint 加重验证/授权机制的强度（抬升既有断言严格度、证据义务、重验规则等；为既有承诺补缺的断言属 floor、不在此列），还须对照受影响 unit 的有效 rigor `(A,V)`（组合依 rigor-tiers「记录与组合契约」）裁决——floor/ceiling 分界与锚定前提依 P9（先确认声明档位与实际 stakes 相称；上限只管强度，不砍 P9 所述 existence floor；判据见 `~/.claude/references/rigor-tiers.md`「Proportionality invariant」）：确认档位后仍超档的加重按 P9 属 over-rigor——该 finding 不判 violation，降为 borderline——超档的加重是不该做的事，记进 report 即可，没有留给 implementer 的义务；档位存疑则连同档位一起按真取舍交用户。无论是否触发本条裁决，review report 均须写明本轮锚定的 `(A,V)`（plan 未声明则按实际后果校准并写明）。

裁决时防以下 bias——主 session 看过自己写的内容，易替自己辩护：

- 对 subagent 发现做反驳前先自检"我是在反驳还是在辩护"。
- 当一个 subagent 的发现或反驳要否决另一个时，先核实它依赖的事实主张（"某条目存在/缺失""同类条目都如此"）再裁决——subagent 会臆造存在性事实，未核实的错误前提会击败正确发现。

### 落地

先应用当前批次全部已接受的 remediation，再按合并后的影响面路由 review；分散 edit 会让同批 findings 落在不同 plan 快照上，重新制造审查长尾。

- 局部修复未改变 goal / scope / architecture / user promise / shared verify topology，也未新增 artifact / protocol → impact-scoped review 覆盖受影响 principles + P9 Simplicity，并对受影响 consumer path 做局部反证。
- 触及上述任一项、跨多个 root cluster，或做过 abstraction reset → 直接进入 final full review。
- 无论中间如何路由，宣告 clean 前必须通过 final full review；通过后才进入终止所需的那次目标反证。预算最后一轮的保底反证不受此约束（它与 principle 审查并行、不构成终止条件）。

若成立的发现无法映射现有 principle（即 principle coverage gap），用 AskUserQuestion 把「是否改进 `~/.claude/references/plan-review-principles.md`」作为一项决策交用户拍板——principle coverage gap 是高杠杆发现，只在 prose 里附带提及会被略过、用户遗忘后同类坑复发。改完后对该 principles 文件跑一次 `/custom:review-skill` 循环审查改动。注意本仓未收录专审 meta-原则的 `/custom:review-principles`，所以「这套原则本身立不立得住」这一维度**不被覆盖**——按 review-skill 类型 gate 的要求在报告中声明该维度未审，别当作已过 meta-原则。

### 目标反证

spawn 1 个独立 general-purpose subagent，把 plan 当作 implementer 的唯一入口，尝试构造可信的反例执行轨迹：implementer 严格按 plan 字面执行、所有 verify 均通过，但最终产物仍不满足 plan 声明的 consumer goal。若 plan 声明了上游输入，subagent 可按 plan 的入口指引读取理解目标所必需的文件；不要额外喂作者的实现思路或修复意图。

subagent 的输入：
- `~/.claude/references/plan-review-principles.md`（用于把反例映射到已有 principle，而不是再逐条审一遍）
- `~/.claude/references/deep-discuss-style.md`
- 目标文件

只报告能给出完整因果链的实质反例，不把"可以更详细"、措辞偏好或泛化风险当反例，也不为凑数制造发现；按影响排序。**反例必须指向缺失或错误的机制/契约**——若某反例的唯一补救是把 plan 里已存在且结构正确的机制再钉细一层（具体参数、边界值、某步骤的精确措辞），那是 implementer 的实施期义务、记为 bounded TODO 候选，不算反证 violation。注意反证路径的下沉口径**窄于**主分流（后者还收 L3 缺口类）：反证前提是 verify 全过仍失败，钉细类实施时必然触碰、不会漏，缺口类下沉则没人告诉 implementer 现有 verify 抓不到那个失败——后者仍是反证 violation。每条输出：plan 证据 → 按字面执行的路径 → 为什么现有 verify 仍会通过 → consumer goal 如何失败 → 命中的 principle + flag 条件；若无法映射但失败后果成立，标记为 principle coverage gap。构造不出可信反例则只输出 `PASS`。subagent 不修改文件、不发 AskUserQuestion、不做 severity 裁决。

目标反证的发现送入同一 Finding triage and causal closure，再进入「决策」与「落地」。principle coverage gap 不因现有 principle 未覆盖而放行：先按机械修复 / 真取舍分流修 plan，再按「落地」的 principle coverage gap 机制决定是否补 principle。

---

## 反模式

- **final full review 减少覆盖**：不要因 diff 小而超出 max-principle-per-subagent 分组上限。impact-scoped review 只运行路由命中的原则，不属于减少完整 gate 覆盖。
- **跳过应有重审**：不得用“改动很小”绕过 review routing，也不得跳过终止前的 final full review 与目标反证。
- **混淆两种 review**：impact-scoped review 必须携带 diff / change manifest；final full review 必须中立。两者不能互相替代。
- **同根 finding 继续局部补丁**：达到 abstraction reset 条件后继续追加字段、checker 或 fallback，会把 plan 变成 review 产物的实现蓝图。
