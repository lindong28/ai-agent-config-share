# Rigor Tiers

本文件是 plan-time rigor 的语义单一来源。planner 记录保真向量 `(A,V)`；下游按向量执行，不从人读标签反推强度。

## Proportionality invariant（对外共享校准 lens）

本节是 rigor 是否成比例的单一判据，供任何 reviewer 引用。

任何 unit of work 上施加的授权 + 验证机制，其强度必须与该 unit 的 `(A,V)`（由反转成本 R 与回归容忍 G 推导）相称：低于所需档位是 under-protect，高于所需档位是浪费（over-rigor）。**该判据对称**——既判机制不足，也判机制过度。

它不只约束 plan：常驻规则 / command / skill 里编码的 rigor，以及 **reviewer 自身 demanded 的验证机制**，都受同一判据约束。对一个 `(A0,V0)` 的对象要求 `V2` 级证据（钉死 model ID、多跑复现 harness、逐 unit 对抗等），本身就是违反本 invariant 的 over-rigor，与"机制不足"同样是 finding。

## Stakes 轴与 assurance 映射

两轴正交、互不抬高：轴 R 只决定授权维 A，轴 G 只决定验证维 V。

| stakes 轴 | light | standard | max |
|---|---|---|---|
| R — 反转成本 / blast radius | 可逆本地改动 → A0 | 部分不可逆或存在状态漂移 → A1 | 生产切流、数据迁移、安全边界、不可撤销外部副作用，或反转须重付一次与生产切流 / 数据迁移同量级、不可回收的成本 → A2 |
| G — 回归容忍度 / 生产稳定性 | 回归易捕获且低影响 → V0 | 会影响真实用户或生产 → V1 | 安全、资金或数据完整性零容忍 → V2 |

| 授权维 | Required assurance |
|---|---|
| A0 | 常规 commit 级授权边界 |
| A1 | 落地前以任务 surface 可承载的方式绑定被改 scope |
| A2 | 最强可用 bound；按 R 轴落 A2 的 unit（不论是因不可逆、authority 还是重付成本）一律接受独立、对抗审查 |

| 验证维 | Required assurance |
|---|---|
| V0 | 同构变换验证一次 pattern，每 unit 做廉价 conformance；全套验证留在 milestone / 末尾 |
| V1 | 每个改行为的 unit 验证被改行为，并有单 reviewer |
| V2 | 承载零容忍风险的 unit 逐 unit 跑全矩阵与对抗性验证 |

**R 读的是反转要付什么代价，不是反转在技术上做不做得到。** "删掉重跑"通常随时做得到，但若重跑要重付一次同量级、不可回收的成本（机时、外部调用费、他人工时、错过就没有第二次的采集窗口），——按 A2 取。这一格最常见的读窄形态正是只认不可逆性：一次要重付十小时 GPU 的批量生成于是落 A0，而它的实际 blast radius 与一次数据迁移同量级。中间带同样要有锚，否则它会往就近的显著锚点靠回去：重付成本可观、但可在本工作单元内吸收的（分钟级重跑、个位数美元的外部调用）→ A1。反向边界同属本句：重付成本可忽略的（本地重编译、秒级重跑）仍是 A0，不因"理论上也花了时间"上抬——否则本句会变成把一切抬进 A2 的万能理由。**这一格放宽会同时扩大下方 Stop Gate 的触发面**：按「颗粒度与 Stop Gate」，实施期新发现的 A 维信号须提交 decision packet，而“重跑代价远超预估”现在也是这样一个信号——planner 据此预期，别把它当成意外打断。

这些档位规定 assurance 结果，不固定 CAS、create-only tag、immutable scope-checker 或 reviewer 数量等机制。任务 surface 不具备某种机制时，使用它能承载的最强等效 assurance——但仅当等效机制达到该维 required 档位才算满足；最强可用机制仍**低于** required 档位（而非仅换用等强机制）时，属下节 Stop Gate，不得当作等效替代静默降档。

## 外部接口 driver 的 V2 落地

当一个 unit 的职责是驱动外部接口（CLI / API / SDK）、gate 住一个 A2 live 动作（生产切流 / 迁移 / 不可逆外部副作用 / 重跑须重付同量级不可回收成本），而其验证替身（mock / dry-run）按构造不 exercise 只有 live 动作才走到的分支（输出解析 / 回读 / 状态比较）时，其 V2 的"全矩阵"义务必须由**在 zero-write / dry-run harness 里 exercise 整条 driver 路径**满足，而非逐 touchpoint 的 mock。替身只固定被驱动接口的假想形状；真实接口的偏差只有真实 exercise 才暴露。缺这一 sweep 时，缺陷会在真实 live run 里逐个串行冒出、每轮重付整条 live 代价，属 under-protect，不记为 V2 满足。**兑现物是读数而非声明**：被进入的 live-only 分支（输出解析 / 回读 / 状态比较）清单 + 各自读到的接口输出摘录，给不出即视同未 exercise——「已跑过整条路径」这句话，在真跑过和只跑通入口两种情形下写出来是同一句。

## 记录与组合契约

plan 记录默认 `(A,V)`、per-phase override、两轴理由和人读 label。label 为 `light/standard/max = max(A_level,V_level)`，只供沟通；例如 `R=max, G=light` 的执行向量仍是 `(A2,V0)`。

per-phase override 用于把 rigor 放在真实 stakes 所在的 phase：默认值与当前 phase override 逐维取高（override 只升不降）。**因此默认必须取共同低基线**，再只抬高承载不可逆或零容忍风险的 phase——默认设高会因 override 不能下调而让机械 phase 被迫陪跑高档，正是要避免的过度 rigor。

review-gate 本地定档通过同尺度 adapter 落到 V 维：`trivial→V0`、`中档→V1`、`高档→V2`。最终 unit 强度为：

```text
有效 A = max(plan 默认 A, 当前 phase override A)
有效 V = max(plan 默认 V, 当前 phase override V, review-gate 本地定档 V)
```

review-gate 本地定档是不可降低的 V floor；plan tier 只能加码，不能替换或降低它。A 与 V 的义务叠加执行，不把向量压回标量 label。

## 颗粒度与 Stop Gate

同构机械变换验证一次 pattern 后做廉价 per-unit conformance；只有改行为的 unit 才升级验证。对抗审查只施于定义或修改 authority、或本身按 R 轴落 A2 的 unit；冻结 authority 下的纯机械 payload 不施加对抗审查。V 档规定的"全套 / 对抗"是 milestone 尺度义务：即便某 phase 有效 V 为 V2，其中纯机械 / 冻结-authority payload unit 仍只做 per-unit 廉价 conformance、全矩阵在 milestone 兑现——floor 抬的是 milestone 深度，不把机械 payload 拖进逐 unit 全矩阵。

review-gate 本地定档里属反转成本 / 安全（A 维）的信号若超出 plan 预设 A（如实施时才发现某 unit 不可逆，或重跑代价远超预估、已够到 A2 那一格），不由 V-adapter 静默吸收——adapter 只把定档落到 V floor，新发现的这一面按下段 Stop Gate 处置。

某维 required assurance 无法由任务 surface 机械化时，不得静默丢弃或自行降档。触发 Stop Gate，并向用户提交 decision packet：

| 必含 | 内容 |
|---|---|
| 缺口 | 无法机械化的 required assurance 及证据 |
| 完整选择 | 接受等效替代 / 调整 scope 以满足原 assurance / 停止 |
| 取舍 | 每个选择牺牲什么 |
| 执行动作 | 用户回复后要执行的精确动作 |

获批的等效替代写入 long-task `state.md`（如适用）；未获批不得把该维记为已满足后继续。
