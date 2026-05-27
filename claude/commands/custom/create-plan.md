---
name: create-plan
description: 用户给一个模糊任务描述（设计/重构/新增功能/规划 xxx）、需要先产出 plan.md 再实现时使用。单文件改动或已存在 plan 的场景不用。
argument-hint: <task description> [可附 "给我 N 份方案" 启用 Best-of-N]
origin: 2026-04-30
---

# create-plan

入口 command：从模糊任务描述出发，访谈用户对齐关键决策，写出**可被另一个 session 落地实现**的 plan.md。

## 何时使用
- 显式 `/create-plan <task description>`
- 任何"先有 plan，后实现"的工作流入口

## 参数

| 参数 | 必需 | 说明 |
|---|---|---|
| task description | ✓ | 模糊任务描述（自由文本）。任务范围 / 使用形态 等 alignment 信息也可一并写入；也可以是 spec.md 路径 |
| spec | ✗ | spec.md 路径（来自 `/create-spec` 或手写）。提供则 §2 中 L1 / 取舍偏好 / L2 三个 facet 跳过对齐——plan 直接以 spec 为契约，本 command 聚焦 L3 |
| Best-of-N | ✗ | 默认 single plan。在 task 中说"给我 N 份方案" / "Best-of-N" / 类似措辞 → 触发并行 fan-out（N=2-5）|
| no-long-task | ✗ | **默认启用 long-task 模式**；opt-out 详见 §2「长任务模式」 |

---

## Consumer 与产物意识

plan.md 由 implementer（新 claude code session）+ reviewer（`/custom:review-plan`）阅读——除让 reader 不重读本会话就能推进 / 审外，还须凭 verify 步骤自证完成、让 reviewer 能审取舍（详见 §1 三层 framing + §3 必答项）。

**plan.md 是 review / 实施的唯一入口**。引用上游工件（spec.md / PRD / design doc）时，plan 自身要在文档显眼处（典型：顶部"输入"段）说明：上游路径 + 上游覆盖什么 lens（如"L1 / 横切取舍由 spec 承载，详见 spec.md §X"）+ plan 自身聚焦什么（如"本 plan 含 L3 设计 + L2 verify 的实施版"）。

判据：facts inline 进 plan 会节省 N 次 implementer 跳转 → 含（典型如 API 调用模板、外部规范摘录、可复用代码具体定位）；planner 研究过程 / alignment 草稿 / 推翻方案中间路径 → 不含。

---

## 1. Framing：三层产物意识 + 横切取舍

本节是提纲——若同任务存在 spec.md，L1 / L2 / 横切取舍的详谈与契约文本由 spec 承载（见 `claude/commands/custom/create-spec.md`），plan 阶段聚焦 L3；若没 spec，§2 facets 自带对齐能力。

### 三层产物（一切从 L1 倒推）

- **Layer 1 (L1) — 最终产物 + 使用方式**：implementer 完成实施后交给『真实使用者』的东西 + 使用者拿来做什么决策 / 后续动作。同样物理形式的产物用途不同会彻底改变需要的设计深度（例：AIGC 对比报告"选一个上线"vs"取长补短做一个新的"）。L1 是反推起点——错了 L2/L3 全错。
- **Layer 2 (L2) — 用户视角 verify**：从 L1 使用者视角看『算交付完成』的可观测条件，独立于内部实现。TDD-style：先写"成功的样子"，再设计实现。
- **Layer 3 (L3) — 设计决策 + 内部 verify**：在 L1+L2 框定下做的实现取舍（管线分层、接口契约、可观测性、错误处理）+ 每个取舍的内部自检（types / lint / 单元测试 / 关键不变式）。**本 command 的主战场。** 内部 verify 跟设计交替进行——不是把所有 verify 推到末尾。

### plan 中按层落地

plan 必须把三层在文档中串起来——每层在 plan 里应该写什么：

- **L1**：最终产物形态、使用者、调用模式、范围 / 约束 / 假设——**有 spec 时引用 spec，不重述**
- **L2**：用户视角 verify——**有 spec 时仍要 inline 写在 plan 里**，但形式从 spec 的"用户审用措辞"翻译成 implementer-executable 步骤（命令+预期输出 / subagent 模拟用户流程 / 截图比对脚本 / 评测分数检查等）。spec 是契约源头，plan 是 implementer 执行版；维度一致，形式不同。详见 §3「必答项表格」+ `~/.claude/references/plan-review-principles.md` Principle 11
- **L3**：用户决策与取舍、planner research 得到的 actionable facts（API 调用模板、外部规范、可复用代码具体定位）、内部 verify

### 横切：取舍偏好（贯穿 L1 + L2 + L3）

取舍偏好不属于任何一层——用户在多个维度之间的相对优先级会在每一层触发 multi-option 决策（L1 产物形态、L2 verify 维度阈值、L3 实现取舍）。用户初始描述**通常不会包含这些权衡**，需要显式对齐。AIGC / UX-heavy 产品尤其常见；纯 binary feature 任务可省略。

### 关于顺序

建议访谈顺序：**L1 → 取舍偏好 → L2 → L3**（有 spec 时前 3 步 spec 已对齐，本 command 直接进 L3）。但**允许迭代回退**——L3 设计踩到没对齐的实现取舍，回头补。严格顺序不重要，反推方向 + 横切意识重要。

§2 除了三层 + 横切，还会对齐**元决策** facet：单 plan vs Best-of-N（输出策略）。长任务模式**默认启用**——仅在用户显式 opt-out 时跳过 bootstrap，详见 §2「长任务模式」。

### 风格与取舍

遵循 `~/.claude/references/deep-discuss-style.md` 的风格。本 skill 的关键 framing：

- **质量 ≫ 速度**：plan 质量直接决定实现质量。plan 阶段可以接受更长的访谈、更高频率的用户介入；绝大部分人机交互应该集中在这个阶段，不是实现阶段。
- **没有绝对对错的点必须让用户拍**。多个合理方案并存时，把它们摆出来；不要替用户决策。

---

## 2. 需要对齐的点（不限于此）

planner 和 user 对齐的过程中，至少要让以下几类信息变清晰。**这不是顺序步骤**——可以并行、迭代、回头补；**也不是穷举清单**——任务特性需要的其他对齐点（compliance / 隐私 / 国际化 等）随时加入。

通用 lens：**"为了不让 implementer 走偏，我现在缺哪些只能用户回答的信息？"** 剩余决策都能被 agent 合理 default 时，对齐充分。

**反推方向**：每个对齐 facet 带 Layer 标——L1 是 L2/L3 的契约、L2 是 L3 的契约。建议从 L1 开始扫到 L3，但访谈中暴露上层缺失时允许回退补。任何时候问『这是为最终产物服务的吗？』，否就是设计走偏。

研究 / 探索 / 跑命令确认假设是对齐的有机组成部分——读 reference 代码、查外部规范、跑 probe 确认环境——能让你给出更高质量 plan 的动作都该做，不要因为没明确写出就跳过。（注意：这里的"确认假设"是 research-time probe，跟 §1 三层框架里的 L2/L3 verify 不是一回事。）

**borderline 决策的两条 path**：

- **反转成本高**（一旦写进 plan、implementer 实施后再翻盘代价大）→ 立刻 AskUserQuestion："决策 X / 我的 default 是 Y / 理由 Z / 你确认还是推翻？"
- **能合理 default**（reviewer 看了能审、翻盘成本低）→ planner 自己拍 + 写进 plan 末 Defaulted Decision 表给 reviewer 审

### 最终产物 + 使用形态 + 使用方式（L1）

> **若同任务 spec.md 已存在**：本 facet 跳过——L1 由 spec 承载，plan 直接引用 spec.md 中相应段落，不重述。

**对齐**：plan 落地后给『真实使用者』的产物形态、使用形态（怎么调用 / 在哪运行）、**使用方式（拿到产物用来做什么决策 / 后续动作）**。这是一切设计的反推起点。

**lens**：使用者是谁、怎么调用、**拿到产物用来做什么**？同样物理形式的产物在不同用途下需要的设计深度可以差好几个数量级——一份对比两个 AIGC 系统的报告，用来"选一个上线"和用来"取长补短做一个新的"，前者只需黑盒分数，后者必须拆解到算法/模块层让用户能迁移局部优势。什么明确算成功？这个定义往往主观，取决于使用者心中的使用场景，需要主动挖出来。哪些约束 / 假设是硬限制？planner 在做哪些隐式假设、需要用户确认？

**常见询问方向**（不限于此）：

- **使用者形态**：终端用户（GUI / CLI / web）/ 程序代码（lib import / API / SDK）/ 系统组件（webhook / event consumer）/ 部署环境（k8s operator / sidecar）— 哪一种或哪几种？
- **调用模式**：一次性同步 / 长任务异步 / 流式 / 事件触发？
- **运行 / 部署边界**：本地脚本 / 进程内 lib / 独立 CLI / 长驻服务 / 分布式集群？
- **使用方式 / 下游用途**：使用者拿到产物**用来做什么决策 / 后续动作**？同形式不同用途会彻底改变评价指标和分析深度（如对比报告"选一个 vs 取长补短"决定要不要拆到算法层；技术 spec"立刻实施 vs 长期演进参考"决定要不要写 trade-off 和迁移路径）
- **成功定义**：什么算明确成功？这个定义往往主观——"质量达标"指什么、"用户可用"指什么、"完成"是 demo-able 还是 prod-ready？使用者心中的成功画面可能跟 planner 默认的不一样，必须挖出来
- **范围与边界**：用户最初描述里的模糊点在哪？某个被当作"目标"的措辞是否存在多种合理解读？什么明确**不**做？失败时该怎么应对？
- **硬限制**：合规 / 性能 / 成本 / 兼容性 / 安全等非功能性限制？
- **隐式假设**：planner 识别出但需要用户确认的假设（外部系统行为、接口契约、数据格式等）

**为什么这点是反推起点**：跳过它直接谈取舍最常见的失败是**过度设计**（设计了根本不需要的层）或**遗漏设计**（漏掉真正需要详细设计的层）。L1 错了，L2 用户视角 verify 全错、L3 设计取舍维度也全错——所以这里必须先收敛。

### 取舍偏好

> **若同任务 spec.md 已存在**：本 facet 跳过——取舍偏好的横切对齐由 spec 承载。plan 的 L3 设计需**与 spec 中已对齐的取舍方向一致**，发现 plan 阶段必须推翻 spec 中的取舍才能继续时，按 long-task-protocol §6 处理（spec 是契约）。

**对齐**：用户在多个维度之间的相对优先级。

**lens**：这次任务的关键维度是哪几个？用户更看重哪些、愿意牺牲哪些？

**常见询问方向**（不限于此）：

- 用户交互体验 vs AIGC 产出质量
- 性能 / 成本 / 稳定性 三角中的偏向
- 代码复杂度 vs 可演进性
- 当下交付速度 vs 长期维护成本

### 用户视角 verify（L2）

> **若同任务 spec.md 已存在**：本 facet **不跳过，但语义变成翻译**——输入是 spec 的 user-facing verify dimensions（措辞偏用户审用），输出是 implementer-executable 翻译版（命令+预期输出 / subagent 模拟用户流程 / 截图比对脚本 / 评测分数断言等）写进 plan。每条 spec dimension 都要有 plan 对应步骤；翻译不能丢维度、不能把多维 acceptance 降级成单一 binary check。详见 plan-review-principles Principle 11。

**对齐**：从 L1 使用者视角看『算交付完成』的可观测条件。这层独立于内部实现，应在设计取舍之前先收敛——类比 TDD 的 RED：先写"成功的样子"，再去想怎么实现。

**前置依赖**：L2 verify 的内容由 L1（产物 + 使用方式）决定；维度优先级和阈值由取舍偏好决定。所以本节前应已对齐取舍偏好（见上一节）；如果到这里发现 verify 维度该测什么不清楚，回头补取舍偏好。

**lens**：把自己代入使用者——产物到手后，使用者会用什么 workflow 检查它 work？这些检查的可观测形式是什么（命令输出 / 文件内容 / UI 截图 / 评测分数 / 人工判断 / 跨多步业务流）？哪些是 happy path、哪些是 error / 边界路径？

写不出 verify、还要等"实现完了再说"——那是 L1 没收敛清楚，回头补 L1。

**常见询问方向**（不限于此）：

- **happy path verify**：使用者怎么验证功能成功？跑命令看输出 / 点 UI 看反馈 / 读文件看内容 / 跑评测看分数 / 跨多步业务流？
- **error / 边界 verify**：设计上要兜的失败模式（超时 / 输入异常 / 权限缺失 / 性能不达标）哪些必须可被使用者验证？
- **verify 的形式不强求 shell**：使用者接受的不一定是"命令 + stdout"——视觉判断 / 主观质量 / 人工对照都是合法形态，不要硬塞成 shell 输出
- **agent 自主覆盖真实使用路径 + 人工兜底**：planner 主动按使用者实际经历的路径展开自动化 verify——agent 能自主 trace / 排查 / 回归的尽量让 agent 跑；真必须人工的（真账号 / 真硬件 / 主观审美）作为 gate，gate 前用 agent 自动检查兜底主要风险

**关键**：L2 verify 必须独立于内部实现来描述——既不写"内部数据结构 X 长这样" / "内部状态机 Y 转移到 Z"（那是 L3 内部 verify），也不从代码内部状态机 / pipeline 反推 verify 维度（尤其多阶段 / 多状态 / 多页面产品，要按使用者实际经历的路径定）。

### 设计决策 + 内部 verify（L3）

**对齐**：在 L1 + L2 框定下，需要用户拍板的具体设计决策；以及伴随每个设计决策的内部 verify。

**lens**：
- 产物需要哪些具体的设计决策？哪些用户已有明确想法、哪些需要 planner 摆出候选方案让用户选？
- 每个非平凡设计决策都该有对应的内部 verify——让 implementer 实现这个决策时能自检对错（types / lint / 单元测试 / contract test / 关键不变式断言）。内部 verify **跟设计交替进行**，不是把所有 verify 推到末尾。

**常见询问方向**（不限于此）：

- **可观测性**：开发者如何观察产物执行过程？产物行为 / 生成质量出问题时，怎么通过观测物定位问题？
- **管线设计**：产物是否需要分阶段管线？如果是，分几个阶段、阶段间契约（数据格式 / 错误传递）是什么？
- **内部 verify 形式**：每个关键设计决策对应的检查（unit test / 类型签名 / contract test / 关键不变式断言）

**关键**：选择权在用户——你的职责是梳理候选方案和 pros / cons 给 user，不是自己拍板。

**L2 vs L3 verify 边界**：L2 是"使用者眼里算成功"的契约；L3 内部 verify 是"实现侧避免低级错误的兜底"。两者都要——内部对了不等于使用者满意（review 那边的 Principle 1 警示），但缺内部 verify 会把所有错误推到 L2 去 catch，迭代成本爆炸。

### 输出策略

**对齐**：单 plan 直接交付，还是 Best-of-N 并行多份让用户挑选。

**优先级**：若 task 里已含 Best-of-N 信号（"N 份方案" / "Best-of-N" / 类似措辞）→ 直接采用，skip 该项 alignment；仅当 N 未给出时追问 N。

**lens**（无信号时使用）：任务解空间是 narrow-convergent 还是 broad-divergent？前面 alignment 已经收敛关键决策（取舍 + 设计）→ 通常 single plan；多个合理方向并存 / 用户想看 alternatives → Best-of-N 有 ROI。N 份大同小异 = 浪费——只有 alignment 给 writer 留了发挥空间时才适用。

决定 Best-of-N 时再问 N（建议 2-3，≤5）。详见 §3「Best-of-N 输出」。

### 长任务模式（默认启用）

**默认**：create-plan 的场景天然适合状态外部化协议——多步骤、跨多 session 是常态。default 启用 long-task：plan banner + state.md + journal.md 一并 bootstrap。

**opt-out 信号**：用户表达不想要状态外部化（state.md / journal.md / banner）的意图——如 `--no-long-task` / "轻量" / "不用 long-task" 等。无 opt-out 信号即按默认启用。

详见 `~/.claude/references/long-task-protocol.md` 协议本身。本 facet 只决定 plan 写完后是否 bootstrap state.md / journal.md + 加 banner。

---

## 3. 输出：plan.md

落点逻辑——长任务模式默认启用，子目录形态是默认。平铺仅在显式 opt-out 长任务 + 无 spec + 单 plan 时使用：

| 条件 | 落点 |
|---|---|
| 默认（长任务启用，可选叠加 spec） | `./plans/<YYYYMMDD>-<short-name>/plan.md`（与 state.md / journal.md / spec.md 共存） |
| Best-of-N | `./plans/<YYYYMMDD>-<short-name>/plan-<i>.md`，子目录承载 N 份 |
| Opt-out 长任务 + 无 spec + 单 plan | `./plans/<YYYYMMDD>-<short-name>.md`（平铺） |

- `<short-name>`：从任务描述提 3-5 词 kebab-case；有 spec 输入时复用 spec 所在目录名
- 同日重名加序号 `-2`、`-3`（平铺）；子目录加 `_v2` 后缀
- `plans/` 目录不存在则新建

格式自由，结构跟着任务走。**有 spec.md 时**：

- "使用方式" / "取舍偏好 + 三层影响" 两项**可由 plan 引用 spec.md 对应段落满足，无须重述**（事实信息 / 决策方向，implementer 直接读 spec 即可）
- "用户视角 verify"项**仍要 inline 写在 plan 里**——但形式从 spec 的"用户审用措辞"翻译成 implementer-executable 步骤（命令+预期输出 / subagent 模拟用户流程 / 截图比对脚本 / 评测分数断言）。每条 spec dimension 必须有 plan 对应步骤；翻译不能丢维度。详见 plan-review-principles Principle 11。
- 顶部"输入"段按 §Consumer 与产物意识 落（spec.md 路径 + 覆盖 lens + plan 聚焦）

内容必须让 implementer 能答出以下问题（不能答即失败；更多必要项见 `~/.claude/references/plan-review-principles.md`）：

| Implementer 必须能从 plan 答出 | 不合格示例 |
|---|---|
| 当前状态是什么（可观察事实，非主观判断） | "代码不好维护" / "现在很乱" |
| 要做什么（明确指向新建/修改的具体文件、API、模块） | "整理一下" / "优化性能" |
| **使用方式 / 下游用途**：使用者拿到产物用来做什么决策 / 后续动作（决定设计深度——如对比报告"选一个 vs 取长补短"） | 没说 → implementer 无从判断要做多深 |
| **取舍偏好 + 三层影响**：用户在产品/UX/工程维度上的相对优先级，以及它在 L1 产物形态、L2 verify 维度阈值、L3 实现取舍各自塑造了什么；不适用任务（binary feature 等）需说明原因 | "随便选" / 没列 / 只列一句"用户说要好用" |
| **用户视角 verify**（L2：覆盖 happy + error path 的可观测条件，独立于内部实现；**必须 implementer-executable form**——命令+预期输出 / subagent 模拟用户流程 / 截图比对脚本 / 评测分数断言 / 结构化 rubric。有 spec 时是 spec dimension 的翻译版，每条 spec dimension 必须有 plan 对应步骤） | "跑一下应该 OK" / "实现完了再看" / "类型对了就行" / "使用者满意"（spec 措辞照搬不翻译） |
| **内部 verify**（L3：每个非平凡设计决策对应的实现侧自检——unit test / 类型签名 / contract test / 关键不变式断言；agent 可独立跑） | "走个 lint" / "看下编译过没过" |
| **verify 步骤的人机边界**：每条 verify 标识 agent 可独立完成 vs 需人工介入；人工项必须说明自动化先兜底了哪些 | 没标 → implementer 不知道哪步会被 block |
| 用户需要在 phase 边界做什么决策、为什么做、看什么材料做、怎么最短路径打开材料、如何回复 | "用户选一个方案" / "用户看一下 mock" |
| 用户首见面 / 顶层入口文档是否需要同步 | 没提 |
| 哪些决策是访谈中没问、planner 自己拍的（"我默认 X，因为 Y"） | 没列 → reviewer 无从审 |

人工验证的迭代速度远低于 agent 独立执行——所以且每个人工 gate 前优先用 agent 可独立完成的验证压低人工 gate 的失败概率。

写作时可参考 `~/.claude/references/plan-creation-patterns.md`——非强制的 style / structure 模式，按任务情境 case-by-case 采纳，**不是 review gate**（gate 在 `plan-review-principles.md`）。

### Best-of-N 输出（可选）

只在 §2「输出策略」里和用户对齐过、确认要 Best-of-N 时执行；否则跳过本节。

**fan-out 时机**：alignment（§2 全部 facets）只跑一次，结果对 N 个 writer 共享；fan-out 发生在 alignment 完全收敛之后、写 plan 之前。alignment 不并行——alignment 的价值在于深度，不是吞吐。

**writer 独立性**（anti-default 警告）：每份 plan 由独立 sub-agent 产生（Agent tool 并发调用，单条响应里发 N 次）。每个 sub-agent 必须**独立做技术调研**——读 CLAUDE.md / README / 相关代码自己形成判断，不复用主 session 的研究 cache。否则 N 份 plan 会高度雷同，Best-of-N 失去意义。

**风格变量注入**（可选）：fan-out 前，planner 基于对任务的理解可以提议 N 个互斥的风格角度（贴合任务领域，如"REST-first / 事件驱动 / 命令模式"或"最小可行 / 工程稳健 / 激进重构"），用 AskUserQuestion 让用户在"注入提议角度"和"全部用同一 prompt（采样多样性）"之间选。注入是放大差异的工具，不强制；任务领域不清晰时直接采样即可。

**回传**：每个 writer 写完 plan-`<i>`.md 后向主 planner 返回 ≤120 字结构化摘要（方案核心 / 范围 / 关键路径 / 主要风险）。主 planner 不重读 plan 文件——基于摘要构造对比表给用户看。

**审查与 handoff**：Best-of-N 阶段**不跑审查**。用户挑选某份后，对所选 plan 跑 §「审查」workflow，再走 §「Handoff」单 plan 形态。落选 plan 不归档、不删除——交给用户。

**N 上限**：≤5（避免并发过载与对比表噪音）。

### 长任务模式 bootstrap

默认执行——仅在 §2「长任务模式」对齐为 opt-out 时跳过本节。

写完 plan.md 后做三件事——shape 由 `~/.claude/references/long-task-protocol.md` 绑定，照其里 "plan.md banner" / "state.md 写什么" / "journal.md 写什么" 三段的格式落：

1. **plan.md 顶部插 banner**（紧跟 frontmatter / 标题之后，按 long-task-protocol 的 banner 段模板照抄）
2. **同目录创建 `state.md`**：把 plan 里的步骤逐条转成 `[pending]` 任务条目（标题 / Goal / Verify 字段从 plan 步骤摘出来），Open Issues 段留空
3. **同目录创建 `journal.md`**：只写 header（标题 + 用法引导块），不预填示例条目——让 implementer 第一次写时按协议格式自己落

Best-of-N 模式下，长任务 bootstrap 等用户挑选 plan 后再做（在 §「Handoff」单 plan 形态前）；不为 N 份候选 plan 各 bootstrap 一份。

### 不留 Open Question：升级路径

plan **不留 open question**。任何 OQ 必须先走升级：

1. **能 research 的** → planner 自查（读代码、查规范、跑命令 verify）
2. **research 也答不出的** → 当场用 AskUserQuestion 问用户
3. **用户明确同意 default X** → 记为 Defaulted Decision，不留 OQ
4. **用户答"后面再说"或回答模糊** → 是搁置不是授权。给出具体 default + 一句理由，再问一次 Y/N 确认；确认后再记 Defaulted Decision

允许在 plan 里留：

- **TODO**：implementer 实施时要做但 plan 不指定 how 的工作
- **risk**：planner 判断有风险（实现可能跑偏、外部依赖可能失效）的点 + 缓解策略

不要为了"看起来完整"而幻觉细节，但也不要用 OQ 替代调研。

### 审查

自检通过后、handoff 之前，对 plan 跑 `/custom:review-plan <plan path>` 进行循环审查（命令定义见 `~/.claude/commands/custom/review-plan.md`，按其 3 阶段循环跑到无新发现）。循环未终止不进入 handoff——review-plan 的 gate 比 §3 表格更全，跳过会让 implementer 撞上未发现的 plan 缺陷。

### Handoff

**子目录形态**（默认 / 长任务启用 / 有 spec）打印同子目录下所有相关文件：

```
plan written: /abs/path/to/plans/<date>-<name>/plan.md
spec:    /abs/path/to/plans/<date>-<name>/spec.md       # 若有 spec
state:   /abs/path/to/plans/<date>-<name>/state.md      # 长任务默认启用
journal: /abs/path/to/plans/<date>-<name>/journal.md    # 长任务默认启用

下一步：在新 session 里跑 `claude '实现 <path-to-plan.md>'`
（implementer 会自动按 plan banner + 全局 CLAUDE.md 长任务协议读 state/journal；spec.md 由 plan 内引用）
```

**平铺单 plan**（opt-out 长任务 + 无 spec）打印：

```
plan written: /abs/path/to/plans/<date>-<name>.md

下一步：在新 session 里跑 `claude '实现这份 plan：<path>'`
```

**Best-of-N**（fan-out 完成后）先打印对比表：

| # | 角度 | 方案核心 | 范围 | 主要风险 | 文件 |
|---|------|---------|------|---------|------|
| 1 | ... | ... | ... | ... | `plans/<date>-<name>/plan-1.md` |

附一句"挑选完后告诉我哪份，我对它跑 §审查 再交付"。用户确认后对所选 plan 跑审查 → 走单 plan handoff 形态。

---

## 反模式（常见，不限于此）

- **维度驱动访谈**：按固定维度清单扫一遍——会问用户已能从描述推出来的东西
- **没对齐 L1（产物 + 使用形态 + 使用方式）就谈取舍**：维度全是错的——同样形式的产物用途不同，需要的设计深度可以差好几个数量级（如 AIGC 对比报告"选系统"vs"取长补短"）
- **没对齐取舍偏好就写 L2 verify**：AIGC / UX-heavy 任务里，用户体验维度多且互相牵制，但 verify 维度优先级没跟用户拍——阈值全是 planner 默认，交付时争议
- **verify 单层化**：只写 internal verify（types / lint / unit test）就声称设计完整 → plan 不知道交付的样子；只写 user-facing 不写每个非平凡设计决策的内部检查 → 错误全推到交付 gate，迭代成本爆炸
- **替用户决策**：把"分布式一致性用强一致还是最终一致"或"傻瓜式 vs 高级可调"这类高反转成本取舍自己拍——plan 阶段最需要用户拍板的事
- **把 mandatory workflow gate 降级为用户选项**：§3 的 procedural steps（审查 / 长任务 bootstrap / Handoff 等）是 planner autonomous 执行的环节，不是设计取舍——停下来征求"要不要跑 review-plan / 是否 bootstrap" 是把本属 planner 的工作流决策推给 user。设计取舍 → AskUserQuestion；workflow gate → 直接执行。
- **verify 没区分人机边界**：可自动化的 API / CLI / browser / DevTools 验证被写成"人工测试"；或需要用户真机判断的 manual gate 前没有用脚本 / mock / 截图 / DB / API 先排除主要风险——implementer 会过早 blocked
- **用户决策交接过薄**：phase 边界写"让用户选择/确认"，但没定义选择目标、选项取舍、直接可看的材料、最短访问路径和回复格式——implementer 会把决策 gate 降级成文字推荐或让用户自己找材料
