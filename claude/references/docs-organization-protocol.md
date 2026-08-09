# Docs Organization Protocol

项目文档的组织与维护协议——定义项目中应维护哪些文档、每个文档的内容与语义、何时读写、如何在 agent 和人之间传递信息。**Trust-the-LLM 优先**：本文档给的是 WHY + WHAT + 触发例，不是 step-by-step 模板。读完应该能在新项目中推断该怎么做。

---

## 1. 何时启用 / 何时不启用

BINDING rule via CLAUDE.md。`docs/CLAUDE.md` 存在时协议生效——agent 在 docs/ 下工作时 Claude Code 自动加载该文件。

通过 `/custom:sync-docs` 初始化 docs/ 结构（见 §6）。

---

## 2. 核心机制

三个互相支撑的机制：

1. **多种文档类型**——覆盖从架构到变更记录的项目知识光谱
2. **docs/CLAUDE.md**——Claude Code 自动加载，agent 在 docs/ 下工作时协议规则自动 in context
3. **同步机制**——把 **task 产物**（执行工作流留下的产物，本配置下是 Long Task Protocol 的 state.md / journal.md）里有项目级价值的条目、以及本次 diff 改变的当前态，同步到持久化项目文档

### 消费者层级

所有消费者消费的是**项目源代码**，不是源代码运行后的产物。文档的消费者分三层，下层包含上层：

```
  User       ← 看的最少：交付物能力、变更记录、获取/安装/配置、使用验证、运维（若有）
  Developer  ← 中间层：+ 架构、设计决策、契约（行为契约及按需扩展的其他作用域）
  Agent      ← 看的最多：+ 经验、issues、测试 pattern
```

User 是获取项目交付物、按其形态使用它、但不读内部实现的人——具体动作随**交付形态**而定：可部署产品/服务经「部署（环境搭建、状态/数据初始化、运行时配置）→ 像产品用户一样使用并验证 → 运维（配置调整、问题排查）」；非部署交付物（库 / CLI / 数据管道 / 研究代码 等）则是「获取 → 调用 / 运行 → 取产出」。

每个文档标注其**最上层消费者**——标注 `[User]` 意味着三层都看，`[Developer]` 意味着开发者和 Agent 看，`[Agent]` 意味着仅 Agent 需要看。

**Triage 先看消费者**：决定某文档 keep / move / remove（含"溶进 skill 后删除"类 dissolution）前，先查它的最上层消费者，不按上一次 triage 的套路惯性处置。skill 是 Agent 执行面，只有 Agent 读得到——分界线是最上层消费者是否为 Agent：

| 最上层消费者 | 能否溶进 skill 后删除 | 处置 |
|---|---|---|
| `[Agent]`（reference notes 等） | 可 | 内容并入 skill，原文件删除 |
| `[User]` / `[Developer]`（人类读者的政策、教学、架构类文档） | 不可——改成「以 skill 为准」的 redirect stub 等于让读者去读读不到的材料 | 保留并直陈自身内容；仅把可执行清单、判读细则类执行细节用指针 defer 给 skill（skill 仍是 methodology 单一权威）；成段推导/教学直觉移入承载它的同消费者文档，原处留一行立场 + 指针 |

### 目录结构

```
<project>/
├── README.md                              # 项目说明、安装、使用 [User]
├── CHANGELOG.md                           # 用户可感知的变更记录 [User]
└── docs/
    ├── CLAUDE.md                          # 文档索引 + 协议规则（Claude Code 自动加载）[Developer]
    ├── architecture.md                    # 系统结构、模块、分层 [Developer]
    ├── adr/
    │   ├── README.md                      # ADR 索引 [Developer]
    │   └── NNN-<slug>.md                  # 每条决策独立文件（动态增长）
    ├── plans/                             # Plan / Spec 归档 [Developer]
    │   └── <YYYYMMDD>-<short-name>/
    │       ├── plan.md
    │       └── spec.md
    ├── contracts/                         # 各类契约（按项目需要扩展，如 interface-contract.md）
    │   ├── ux-contract.md                 # 行为契约（hard spec）[Developer]
    │   └── ux-test-patterns.md            # 测试 pattern（soft heuristics）[Agent]
    ├── experiences/
    │   ├── README.md                      # Topic 索引 [Agent]
    │   └── <topic>.md                     # 按 topic 分文件（动态增长）
    ├── issues/
    │   ├── README.md                      # Domain 索引 [Agent]
    │   ├── ux-issues.md                   # 产品 UX 问题
    │   ├── ux-contract-issues.md          # Contract 定义问题
    │   └── general.md                     # 通用问题
    ├── references/                        # 详细参考手册（项目特定，消费者因文件而异）
    │   └── <name>.md                      # 部署/配置/运维指南 [User]；字段定义/API 契约 [Developer]
    ├── data/                              # 数据关注点（按项目需要：有外部源 和/或 物化数据时）[Developer]
    │   ├── sources.md                     # 外部数据源：能力 / 可信度分级 / 用法
    │   └── inventory.md                   # 物化数据盘点：有哪些 / 覆盖 / 新鲜度 / source-of-truth
    ├── experiments/                       # 实验结果 / 优化 baseline（curated，供未来优化对比）[Developer]
    │   └── <family>/<name>.json|md        # 结果快照（含测量协议 + 指标），按实验族分
    └── operations/                        # 运维入口（系统在跑什么、怎么管理）[User]
        └── <name>.md                      # services.md / monitoring.md / incidents.md 等
```

动态文件名说明：`NNN-<slug>.md` 编号递增 + kebab-case 标题；`<topic>.md` 按项目实际 topic 命名（如 `deployment.md`、`api-integrations.md`）；`<YYYYMMDD>-<short-name>` 日期前缀 + kebab-case 标题。

### 文档类型概览

| 文档 | 性质 | 核心问题 | 消费者 |
|---|---|---|---|
| README.md（根目录） | Mutable snapshot | 项目是什么、怎么用？ | User |
| CHANGELOG.md（根目录） | Append-only（newest first） | 用户能感知到什么变化？ | User |
| architecture.md | Mutable snapshot | 系统是怎么组织的？ | Developer |
| adr/ | Append-only（每条一文件） | 当初为什么这么设计？ | Developer |
| plans/ | Append-only（归档 plan.md + spec.md；按项目需要） | 当初打算做什么、怎么做？ | Developer |
| contracts/ | Mutable snapshot + heuristics（按项目需要） | 用户能用什么功能？测试该覆盖什么？ | Developer |
| experiences/ | Append-only（按 topic 分文件） | 这个坑之前怎么踩过？ | Agent |
| issues/ | Mutable（lifecycle，按 domain 分文件） | 有哪些发现的问题要解决？ | Agent |
| references/ | Mutable snapshot（按项目需要） | 操作层面的详细定义和步骤是什么？ | 因文件而异 |
| data/ | Mutable snapshot + 权威清单（按项目需要） | 外部源是什么/可信吗？物化数据有哪些/多新？ | Developer |
| experiments/ | Append-only（结果快照，按实验族；按项目需要） | 当前 baseline 是什么、优化是否提升/回退？ | Developer |
| operations/ | Mutable snapshot（按项目需要） | 系统在跑什么、怎么管理？ | User |
| docs/CLAUDE.md | Mutable snapshot | 文档索引在哪？协议规则怎么加载？ | Developer |

### 写入路径

| 场景 | 路径 |
|---|---|
| 长任务执行（有 task 产物） | 任务完成后**同步**到项目文档（见 §5） |
| 常规 session（无 task 产物） | 发现值得持久化的信息时**直接写入**项目文档 |

两条路径互补：同步是批量的事后总结；直接写入是逐条的实时记录。同步更系统，直接写入覆盖没有 task 产物的场景。

### 执行模型

文档的读写判断（何时触发、写什么）是协议语义；具体由谁执行写入是实现细节——本配置下由 subagent（`doc-updater`）执行，主 Agent 只负责判断触发条件和组装上下文，多个文档类型需要更新时并行 spawn 多个实例。

详见 `~/.claude/agents/doc-updater.md`。

**内容重新分配**：把一份已有文档的内容拆成多份或搬到别处时，对着**源文件全文**核一遍分配——每一部分都要指得出它去了哪，指不出的就是被丢掉的。只核搬出去的那几段不够：拆分的缝不出现在任何一份 diff 里，因此任何按 diff 驱动的事后检查都捞不回它。各类型的内容能不能被搬走或丢弃，按 §4 该文档类型自己的 Format 判，本节不另立规则。

---

## 3. 根目录文件 [User]

根目录的 README.md 和 CHANGELOG.md 不在 docs/ 下但属于协议管辖范围。读写规则见 §4.1 和 §4.2。

---

## 4. 各文档的读写规则

每种文档的定义结构一致：What → Format → 何时读 → 何时写。建议格式模板见 `docs-format-templates.md`（仅在创建新文档时参考；不是所有类型都有模板——README 和 plans 按惯例组织）。模板中的字段是起点——缺了就补、不够就加、不合适就不塞。判断标准：目标读者只看这条 entry 能否完成他的任务。

---

### 4.1 README.md（根目录）[User]

**What**：项目的入口文档。面向所有拿到源代码的人——介绍这个项目是什么、如何获取/安装/配置使用，以及（若适用）如何部署和运维。

**Format**：Mutable snapshot。按通用开源 README 惯例组织（项目介绍、功能、安装/使用，以及——若适用——部署、配置、运维 等）。

**何时读**

Lens：当你需要理解"这个项目是什么、怎么获取和使用"时。

**何时写**

Lens：当项目的功能、安装方式、使用方式发生变化时。与 CHANGELOG.md 和 contracts/ux-contract.md 联动——如果这两个文档更新了，README 大概率也需要同步。

**服务章节**：项目有长期运行的服务时，README 必须有专门的服务章节（服务清单 + 运维入口）。约定与脚本命名见 `service-operations-protocol.md` §3（脚本）、§4.1（服务章节）。

---

### 4.2 CHANGELOG.md（根目录）[User]

**What**：面向用户的变更记录，位于项目根目录（与 README.md 平级）。按时间倒序记录每次用户可感知的变化。

**Format**：Append-only（newest first）。每条 entry 描述用户视角的变化，不是实现细节。

**粒度**：以**逻辑变更**为单位——一个用户可感知的独立变化（feature / bugfix / behavior change）一个 entry。多个 commit 可以组成一个 entry（如果它们共同构成一个完整的用户可感知变化），多个 entry 按日期或版本号分组在一个 `##` 标题下。

**何时读**

Lens：当需要了解项目近期变化时——无论是用户查阅还是 agent 理解近期演进。

**何时写**

Lens：当项目发生了用户可感知的变化时——新功能、行为变更、bug 修复。纯内部实现重构不记录。

触发例（不限于此）：
- 完成了包含用户可感知变化的 plan
- bug fix 改变了用户可见行为
- 版本发布时汇总变更

---

### 4.3 architecture.md [Developer]

**What**：系统的模块结构、分层方式、关键抽象、依赖关系。让新 agent 在不遍历代码的情况下理解项目的组织方式，快速定位自己要改的部分。

**Format**：Mutable snapshot。内容反映当前状态，不保留历史（历史在 git 中）。

**何时读**

Lens：当你需要理解"代码是怎么组织的"或"我要改的东西在哪里"时——读 architecture.md 比遍历文件树便宜且更准确。

触发例（不限于此）：
- 新 session 第一次接触项目
- 设计新功能前，理解现有架构
- 排查跨模块问题时定位相关模块

**何时写**

Lens：当你的变更让"系统怎么组织的"这个答案变了时——新增模块、改变分层、引入新的核心抽象。

触发例（不限于此）：
- 新增或删除模块
- 重构导致层级关系变化
- 引入新的核心依赖或抽象

写入后自检——新 agent 读完应能回答：
- 我要改 X 功能应该先看哪些文件？
- 核心数据 / 状态从哪进入、经哪些阶段变换、最终落到哪？（若有持久化层：用什么存储、schema 是什么）
- 加一个新功能，标准触及点有哪些？

按需追加部署拓扑、外部依赖版本等。

---

### 4.4 adr/ — Architecture Decision Records [Developer]

**What**：项目中的非平凡设计决策——取舍、理由、被否的方案。每条决策独立成文件，包含完整的 context 和 options 分析。让后续 agent 理解"为什么是这样"而不需要重新推理，避免前后矛盾。

**Format**：目录结构，每条决策一个文件，编号递增。**Supersession 模型**：决策可以被后续新 ADR 推翻，但原文件不删不改——新 ADR 中标注 supersedes 并说明原因。删除原文件会让"为什么这次和上次不一样"这个信息永久丢失。

```
docs/adr/
├── README.md                    # 索引：所有 ADR 的列表与状态
├── 001-chose-x-over-y.md
├── 002-auth-middleware-rewrite.md
└── ...
```

**何时读**

Lens：当你要做的设计决策"感觉之前可能处理过类似的"时——先查 ADR 索引比重新推理便宜，且能避免前后矛盾。

触发例（不限于此）：
- 做新的架构或 API 设计决策前
- 看到代码中一个不直觉的设计想理解原因
- 审查 plan 中的设计方向是否与历史决策一致

**何时写**

Lens：你做了一个设计选择，且未来 agent 如果不知道这个选择的存在可能会做出矛盾的决定。

触发例（不限于此）：
- 在两种以上方案中选择了一种
- 推翻了之前的 ADR（创建新文件，标注 supersedes）
- 引入了项目级的架构约束
- 从 journal.md `[decision]` 条目提升（见 §5）

---

### 4.5 plans/ — Plan/Spec 归档 [Developer]

**What**：已完成 plan 的 plan.md 和 spec.md 归档，保留设计意图和需求定义的历史记录。**按项目需要**——工作流产出 plan/spec 时才有此目录；不产出规划文档的工作流跳过。

**Format**：目录结构，每个 plan 一个子目录（`<YYYYMMDD>-<short-name>/`），仅归档 plan.md + spec.md 这类设计/需求产物。归档件在正文之前附 2 行 **Archive status** 导航头——说明执行过程临时产物（如 `state.md` / `journal.md`，若有）按本节不入档，并给出实际结果/裁决的当前查阅入口（须指向具体可定位的文件/章节，非泛指"相关文档"）；不修改 plan 正文本身。

**何时写**

Lens：plan 执行完成后，将 plan.md 和 spec.md（如有）复制到 `docs/plans/<YYYYMMDD>-<short-name>/`。

---

### 4.6 contracts/ — UX 契约与项目扩展契约 [Developer]

**What**：产品面向用户的行为契约和测试指导。包含两层：**hard spec**（产品必须满足的行为契约）和 **soft heuristics**（测试时值得留意的模式和边界情况）。本目录同时是项目自定义契约的落点——契约指被消费方依赖、不可静默改变的约定，项目可按需增加其他作用域的契约文件（如 `interface-contract.md`），文件名以作用域前缀区分。

**Format**：目录结构。

```
docs/contracts/
├── ux-contract.md              # 面向用户的行为契约（hard spec）[Developer]
├── ux-test-patterns.md         # 测试 pattern（soft heuristics）[Agent]
└── <scope>-contract.md         # 项目扩展，如 interface-contract.md [Developer]（消费者按各契约自述）
```

本节其余规则（覆盖策略 / 何时读 / 何时写 / 执行路径）与 §5 同步机制**只覆盖 UX 两文件**。协议不为项目扩展的契约提供集中规则——新增时在该文件开头自述三项：性质（hard spec 还是 heuristics、mutable 还是 append-only）、消费者、写入权威与路径（事实来源、谁有权改、定义类问题往哪跟踪）。这三项由项目 owner 定，agent 起草时不得默认认定。

| 文件 | 性质 | 覆盖策略 |
|---|---|---|
| ux-contract.md | **Hard spec**——产品必须满足的行为契约 | 每次测试都 verify |
| ux-test-patterns.md | **Soft heuristics**——测试时值得留意的模式 | 按预算 / 风险选择性覆盖 |

测试 agent 可以根据可用时间 / 预算决定覆盖深度：时间紧 → 只跑 contract；时间充裕 → contract + patterns。

**何时读**

Lens：当你需要理解"用户能做什么"或"测试应该覆盖什么"时。

触发例（不限于此）：
- 执行产品测试 / UX 测试前——先读 ux-contract.md 确定覆盖面，再按预算读 ux-test-patterns.md
- 规划新功能前，理解现有功能面
- 评估变更的影响范围

**何时写**

ux-contract.md 的写入 lens：当你的变更改变了用户能感知到的产品行为时——新功能、行为变化、功能移除。纯实现重构 / 内部调整不触发。

**执行路径**：ux-contract.md 基于真实端到端产品观察建立，不依赖读代码或文档推断，且**绝不由 agent 静默改**——永远经显式用户对齐。按变更是否经过一个【含显式用户对齐阶段 + 持续自主执行阶段】的工作流分两条路径：

- **主路径（经对齐 + 自主执行的工作流）**：契约更新在【用户对齐阶段】**条件化对齐**、在【自主执行阶段】**应用 + 测试**；契约最终文本随实现一并产出。
- **Fallback（其余变更 / 自由 session）**：agent 不直接写入，而是将演化候选写入 `docs/issues/ux-contract-issues.md`（见 §4.8），由用户通过专用 command（`/custom:create-ux-contract`）处理。

ux-test-patterns.md 的写入 lens：当你在测试过程中发现一个"值得以后也留意"的模式——某个 feature 容易出的边界情况、某个 journey 中常见的陷阱、某类变更容易影响的区域。

写入后自检——测试 agent 读完 contract 能否独立规划一次完整的 UX 测试（知道测什么、从哪个入口进、什么算 pass）；读完 patterns 后测试能否更深入。

---

### 4.7 experiences/ — 经验与坑点 [Agent]

**What**：开发过程中积累的坑点、绕过方法、可复用 pattern、调试技巧。让后续 agent 不用重新踩同样的坑。

**Format**：目录结构，按 topic 分文件。每个文件内 append-only。**文件名本身是轻量级 topic 索引**——agent 先 `ls docs/experiences/` 根据文件名判断该读哪个，避免每次都读所有经验。

```
docs/experiences/
├── README.md              # 索引：所有 topic 文件的列表与简述
├── api-integrations.md    # 外部 API 集成相关坑点
├── deployment.md          # 部署 / 环境相关经验
├── testing.md             # 测试相关 pattern 和 gotcha
└── ...                    # 按项目需要按 topic 增加
```

**何时读**

Lens：当你遇到报错、卡壳、或即将做一个"感觉有坑"的操作时——先看 experiences/ 目录里有没有相关 topic 的文件。

触发例（不限于此）：
- 遇到难以解释的报错 → 根据报错上下文找相关 topic 文件
- 开始处理一个已知复杂的模块或链路
- 部署、迁移等高风险操作前

**何时写**

Lens：你花了非平凡的时间解决一个问题，且解法不能从代码本身看出来。

触发例（不限于此）：
- 发现一个隐藏的 gotcha（API 的未文档行为、环境差异等）
- 找到一个有效的 workaround
- 总结出一个可复用的 pattern
- 从 journal.md `[lesson]` / `[fact]` 条目提升（见 §5）

**候选筛选**（尤其从 journal 批量提升时，先剪枝再落笔）：

- **去重优先**：写入前先扫 `~/.claude/references/` 与本项目 `docs/experiences/`，已被既有内容覆盖的候选 → cut，避免冗余 / 与既有内容漂移。
- **Trust-the-LLM 剪枝**：把候选用 1-2 句 WHAT-framing 交 SOTA 模型，它会自动产出对的东西吗？会 → 模型已知 → cut，别记大段常识。
- **跳过 efficiency-only、要求可泛化**：agent 自己探索能完成、只是慢一点的事不值得记；留下的必须提升未来同类任务的成功率或质量，且能泛化到本项目同类任务、非只对该次 journal 单次任务有用。

写入时找到与 topic 匹配的文件。没有合适的文件时创建新的 topic 文件并更新 experiences/README.md 索引。

写入后自检——未来 agent 遇到类似问题时能否判断"这条经验适不适用我的情况"并直接应用解法。

---

### 4.8 issues/ — 问题跟踪 [Agent]

**What**：agent 在开发过程中发现的值得跟踪的问题——bug、可改进项、feature 建议。agent 驱动的轻量 issue tracker，也可用于自动化流水线的输入。

**Format**：domain 文件只存 **open** issues；条目判定 `resolved`/`wontfix` 时整条移入 `archive/closed.md`（见下方 lifecycle）。每个 domain 文件内 mutable（open 条目有 lifecycle）。**按 domain 分文件的核心好处**：不同 domain 的 issues 有不同的优先级和 consumer，domain 文件让自动化流水线可以精确地只处理相关的 issues——这一好处只对 open issues 成立（archive 没有按 domain 处理的消费者），故 archive 用单一扁文件、不按 domain 分。

```
docs/issues/                   # domain 文件 = 只存 open issues
├── README.md                  # 索引：各 domain 文件的列表与 scope
├── ux-issues.md               # 测试产品时发现的 UX 问题（contract 在实际产品中被 broken）
├── ux-contract-issues.md      # contract 本身的问题（定义缺失 / 不准确 / 过时）
├── harness-issues.md          # Agent Harness 自身的问题——hooks / 适配层 / agent·skill 行为 / settings
├── general.md                 # 不属于特定 domain 的通用 issues
└── archive/
    └── closed.md              # resolved + wontfix 条目（翻状态时从 domain 文件整条移入；只 grep 查史，不通读）
```

**Domain 文件划分 lens**：当一类 issues 有独立的 consumer（自动化流水线、特定的 review 流程）或明显不同的优先级时，给它单独的文件。例：UX issues 直接影响用户体验，优先级天然高于 skill 优化建议——分开存放让优先级管理更容易。

**何时读**

Lens：当你在规划"接下来做什么"或评估项目健康状态时。

触发例（不限于此）：
- 开始新的开发 session，查看待解决问题
- 自动化流水线检查特定 domain 的 issues（如 test-ux 只读 ux-issues.md）
- 评估技术债务

**何时写**

Lens：你发现了一个值得在未来某个时间点解决的问题，但不属于当前任务的范围。

触发例（不限于此）：
- test-ux 发现产品行为与 contract 不符 → `ux-issues.md`
- test-ux 发现 contract 本身的定义有问题 → `ux-contract-issues.md`
- 发现 Agent Harness 自身（hooks / skill / settings 等）的问题但本次不就地修 → `harness-issues.md`
- 代码审查 / skill 维护中发现改进项 → `general.md`
- 从 state.md Open Issues 提升——任务结束时仍 open 的 issue（见 §5）

**ux-issues.md 和 ux-contract-issues.md 的写入约束**：必须基于真实端到端产品观察，不依赖读代码或文档推断。只有 `/custom:test-ux` 等实际执行产品的流程才能写入这两个文件。通过 §5 提升的 UX-domain issue 如果不是基于真实端到端产品观察，应归入 `general.md` 而非 `ux-issues.md` / `ux-contract-issues.md`。

**harness-issues.md 的写入路由**：默认写当前项目的 `docs/issues/harness-issues.md`。本机的 harness 配置由某个 git 仓提供（`~/.claude` / `~/.codex` 指向它）、且该仓不是当前项目时，按下表选落点——让纯 user-scope 的问题集中在该仓统一 triage，同时不让项目专属的问题挤进去。

| 该问题 | 落点 |
|---|---|
| 不牵涉当前项目的任何特有内容——理解、复现与修复它只用得上 harness 侧的东西：该仓提供的配置、hooks、skill / command / reference、安装器与它装的 MCP、插件，以及 harness 运行时自身 | 该仓仓根的 `docs/issues/harness-issues.md`（该仓还没有这个文件时按本节格式新建） |
| 牵涉当前项目（其 `.claude/`、项目级 CLAUDE.md / AGENTS.md、项目特有的代码与配置），或判不准 | 当前项目的 `docs/issues/harness-issues.md` |

**跨仓写入：报出，不代为 commit**：在本轮回复里报出条目标题、文件绝对路径，并点明它是一处**未提交**改动；不代为 commit——那个仓有本 session 之外的写入者，何时提交、与什么一起提交由用户定。不报出，条目就成了别人工作树里一处无人知道的改动，会被随手的清理带走。

写入后自检——下一个处理者只看这条 entry 能否判断"要不要修、怎么复现、优先级多高"。

**Issue lifecycle**：`open` 条目活在 domain 文件里。判定 `resolved` 或 `wontfix` 的**同一步**，把整条（含 Notes 里的修复方式 / 验证证据 / 不修理由）从 domain 文件移入 `archive/closed.md`，不留在原文件、不删除。如此定位 open issue 的读取面由结构保证恒定，不随历史累积膨胀；archive 保留全部历史、可 grep。triage 用的 `docs/issues/*.md` 是**非递归 glob**，天然不扫 `archive/` 子目录——故走该 glob（或直接打开某 domain 文件）的 consumer 零改动；递归 grep / 遍历 `docs/issues/` 前缀的 consumer 仍会读到 archive 条目（带 `[resolved]`/`[wontfix]` 标记、通常有用，需要时自行排除 `archive/`）。状态枚举与条目模板见 `docs-format-templates.md` §4.8。

| 反模式 | 为什么不要 |
|---|---|
| resolved/wontfix 后留在原 domain 文件、只翻 status 字段 | open 路径读取面无界增长——每次定位 open issue 要读越来越多无关闭项；应翻状态即移入 `archive/closed.md` |
| 直接删整条 entry（不归档） | 删整条丢历史：wontfix 的决策理由、resolved 的 root-cause 取证 git 里都没有；归档而非删除 |

---

### 4.9 references/ — 详细参考手册（消费者因文件而异）

**What**：主文档的详细参考附件——粒度太细不适合放在主文档中，但对部署、运维或开发日常工作不可或缺。

**Format**：目录结构，按项目需要增加文件。文件内容为 Mutable snapshot。

**消费者层级**：references/ 内的文件消费者因内容而异——部署配置和运维操作指南是 [User] 级别（拿到源代码就需要看），字段定义和 API 契约是 [Developer] 级别。每个文件在开头标注自己的读者。

**与主文档的关系**：references/ 中的文件不独立存在，而是被 README.md、architecture.md 等主文档引用。主文档回答概念层面的问题（"系统怎么组织的"），references/ 回答操作层面的问题（"这个表有哪些字段"、"这个接口的入参是什么"、"怎么给用户加配额"）。

**何时读**

Lens：当你需要操作层面的具体信息（字段定义、配置参数、API 入参、运维步骤）时——通常是跟随主文档中的引用链接，也可以主动查找。

触发例（不限于此）：
- 主文档引用了详细参考信息（如 architecture.md 中的 "schema 详见 references/schema.md"）
- 需要查阅某个接口的具体入参或返回值
- 部署或运维时需要具体的配置参数和步骤

**何时写**

Lens：当主文档需要引用的详细信息超出其自身粒度时。内容因项目而异——不是每个项目都需要 schema.md 或 api-contract.md。

---

### 4.10 experiments/ — 优化 baseline（结果快照）[Developer]

**What**：curated 的实验结果，作为未来优化的参考锚点——典型是「当前已达标的优化结果」存为 baseline，供将来的优化轮次（改 prompt / pipeline / 算法 / 参数 / 策略 等）在**同一测量协议**下对比（是否提升 / 是否回退）。区别于实验过程中的**短暂 scratch**（原始批量跑、probe、中间产物）——后者不入 git、不进 docs/。本节的判据是「这条结果未来会被拿来对照吗」，不是「这是不是实验产出」。

**Format**：目录结构（按项目需要），按实验族分子目录。每个结果快照写入后不再修改，目录层面 **append-only**（新 baseline 增量加入，不覆盖旧的）。快照必须自带**测量协议**（输入集 / 数据集、指标定义、以及评分方式——视实验类型而定：人工 rubric / LLM judge / benchmark 环境 / 回测设定 等）——否则未来无法可比对照。

```
docs/experiments/
└── <family>/                       # 按实验族分（如 batch-sets/）
    └── <name>.json|md              # 结果快照（测量协议 + 指标 + 关联 commit/版本）
```

**何时读**

Lens：你要开一轮优化（改 prompt / pipeline / 参数）、需要知道「当前 baseline 是什么、改完算不算提升」时——先看 docs/experiments/ 有没有相关实验族的 baseline。

触发例（不限于此）：
- 开始一轮针对已有产物质量的优化前，取 baseline 作对比锚点
- 判断一次改动是提升还是回退

**何时写**

Lens：一次实验产出了你会拿来和未来优化对比的结果（尤其是被判定「达标」的当前最优）——把它连同测量协议固化为 baseline。

触发例（不限于此）：
- 用户判定当前优化结果达标 → 存为该实验族的新 baseline
- 一次有结论的对比 / 消融结果值得作为未来参考

写入后自检——未来开优化轮的人/agent 能否凭这条 baseline 在**相同测量协议**下判断提升还是回退。

---

### 4.11 operations/ — 运维入口 [User]

**What**：系统的运维总览——回答"我有哪些长期运行的服务、各自怎么自启、怎么验证、出错看哪里"这类入口性问题。读者从 operations/ 进来，不依附于其他主文档。

**Format**：目录结构，按项目需要增加文件。文件内容为 Mutable snapshot。典型文件：

- `services.md` — 服务清单（服务 / Supervisor / 当前状态 / 运维入口 / Instructions 位置）
- `monitoring.md` — 监控与告警链路（哪个指标在哪个 dashboard、谁负责）
- `incidents.md` — 事故记录与演练（按时间顺序的 incident postmortem 摘要）
- 项目按需扩展（如 `runbooks/<scenario>.md`）

每个服务标注其运维入口（repo own→生命周期脚本；vendored→原生接口）——脚本集合、实现子集与契约见 `service-operations-protocol.md` §3。

**与 references/ 的边界**

| | operations/ | references/ |
|---|---|---|
| 角色 | 运维入口（主动起点） | 主文档的细节附件（被引用） |
| 读者路径 | 直接进来回答"系统在跑什么" | 从 README/architecture 链接跟过来 |
| 粒度 | 跨服务/跨组件的总览 | 单一组件/接口/数据结构的细节 |
| 失去主文档引用是否仍有价值 | 是——本身是入口 | 否——孤立的细节意义有限 |

举例：`operations/services.md` 列出所有服务 + 各自启动方式 + 链接到 `references/wechat-sources.md`；`references/wechat-sources.md` 只讲微信源添加步骤、被 README §信源 和 `operations/services.md` 同时引用。

**何时读**

Lens：当你需要从系统整体视角了解运维状态时——服务清单、监控配置、最近的 incidents——而不是去钻某个单一组件的细节。

Lens（归属判断）：当你要判断一个运维动作**由谁执行**时。operations/ 是"这件事 agent 自己能不能做"的权威记录——凭据放在哪、用哪个脚本、有什么前置约束都写在这里。注意这个 lens 触发的时机与上一个相反：上一个在你想了解现状时触发，这个在你**已经认定不必了解**时触发，因为把动作判给别人本身就是一次归属判断，而做这个判断所需的事实只存在于 operations/。

触发例（不限于此）：
- 拿到一个新项目，想知道"它在跑什么、谁拉起的"
- 服务异常排查，先看 services.md 找正确的诊断起点
- 新机器部署，按 services.md 清单逐项 bring-up
- 加新服务前，先看现有服务的守护 pattern
- 正要把一个运维动作记成待办 / 残留 / 交接项，或说成需要用户执行——先确认它不是自己就能做的

**何时写**

Lens：当一个长期运行的服务/监控链路/运维流程有了变化时——新增、移除、守护方式调整、监控指标增减——同步更新 operations/ 对应文件。

触发例（不限于此）：
- 新增/移除一个 launchd 守护的服务
- 服务的自启机制改变（从手动改为 launchd / 从 cron 改为 launchd 等）
- 新增监控告警通道
- 完整执行一次 incident 后写入 incidents.md

operations/ 不替代 experiences/deployment.md——前者是"现状快照"（mutable），后者是"踩坑记录"（append-only）。新加一个服务时：operations/services.md 加一行（现状），experiences/deployment.md 如果踩了坑也加一条经验（历史教训）。

---

### 4.12 docs/CLAUDE.md [Developer]

文档索引 + 协议规则加载点（Mutable snapshot）。Claude Code 在 docs/ 下工作时自动加载。写入 lens：docs/ 下新增、重命名或删除文档时同步更新索引。

---

### 4.13 data/ — 数据源与物化数据 [Developer]

**What**：项目的数据关注点，两面：**(a)** 消费的**外部数据源**——提供什么能力、各数据/字段的可信度分级、怎么用；**(b)** 项目的**物化数据**（内置 / 拉取缓存 / 计算物化的本地持久化数据，统称"物化数据"）——实际存了哪些数据集、覆盖范围、新鲜度、谁是 source-of-truth、怎么治理。让 coding agent 不必翻代码或试错就知道"有哪些数据可用、来自哪、可信到什么程度"——**用错数据 / 不知道有什么数据时，这里就是更新的锚点**。

**何时启用**：项目消费外部数据源、或物化了非平凡的本地数据时。纯无状态、无外部数据依赖的项目不需要——这是**可选**类型。两面缺哪面可只建一个文件。

**Format**：目录，两个文件。字段模板见 `docs-format-templates.md` §4.13。

| 文件 | 性质 | 覆盖 |
|---|---|---|
| sources.md | Mutable snapshot | 每个外部源：能力（实测带日期）、可信度分级、用法/限制/认证 |
| inventory.md | Mutable snapshot + 权威清单 | 物化数据盘点：有哪些、覆盖、新鲜度、source-of-truth |

**大 / 活 store 的逐数据集清单别手维护**：store 随取数不断漂移，这种清单必然脱节、甚至讲反主源（还写着旧主源、实际早换了）。故 inventory.md 只放 curated 概览，权威清单交给一条能从 store 重新查出当前态的命令（regen 命令）生成；store 小 / 静态时手维护逐数据集清单才可以。

**何时读**

Lens：当你要用 / 取 / 治理项目数据，或不确定"有哪些数据可用、来自哪个源、可不可信"时。

触发例（不限于此）：
- 新功能要消费数据前——先看 sources.md 有哪些源能力、inventory.md 已有哪些数据
- 在输出 / 计算引用某项数据前，确认其可信度分级
- 数据治理 / 清理 / 迁移前，inventory.md 是 source-of-truth 盘点起点

**何时写**

sources.md 写入 lens：新增 / 移除一个外部源，或某源的能力 / 可信度分级 / 用法 / 限制变化（**含实测发现旧认知有误**）时。

inventory.md 写入 lens：**物化数据的当前态实质变化时**——这类变化常**不伴随代码 diff**（一次取数跑完就过时），故触发不能只挂在 diff 上（不限于此）：① 新增 / 废弃一类数据集或换了主源；② 周期性或在重大数据操作后**重跑 regen 命令**刷新概览与权威清单。

写入后自检——新 agent 读完 sources.md 能回答"该用哪个源、它可信吗、怎么调"；读完 inventory.md 能回答"现在有哪些数据、多新、哪份权威、怎么再生成清单"。

---

## 5. 同步机制：task 产物 / diff → 项目文档

### Why

task 产物服务于一个具体任务的执行过程。任务完成后，其中一部分信息有项目级的持久价值。同步机制把这部分信息迁移到项目文档中，让它们的生命周期不再绑定于单个任务。除 task 产物的条目外，本次 **diff** 也是一类同步源——mutable snapshot 类文档记录的是当前态，diff 改变了它就要同步到改完后的现实，这类同步不依赖 task 产物（自由 session 也会发生）。

### 何时同步

**Lens**：当一个任务到达自然边界、或一次改动落地时——审视 task 产物中是否有项目级价值的条目（提升），以及本次 diff 是否改变了某 snapshot doc 的当前态（同步）。

触发例（不限于此）：
- 长任务完成（所有 Tasks done、verify 通过）
- 长任务被取消但 journal 中有有价值的发现
- session 结束前，当前 session 有 task 产物
- 自由 session 中改动产生用户可感知变化、或改变了某 snapshot doc 的当前态

### 提升判断 lens

> "如果我是一个全新的 agent，从未参与过这个任务，这条信息是否能帮我在这个项目中更有效地工作——且不能从代码本身看出来？"

通过这个 lens 的条目值得提升。没通过的留在 task 产物中作为历史归档。

### 同步路径

**同步**有两种**触发源**：task 产物里的**条目**——**提升**为持久 doc，和本次 **diff 改变的当前态**——同步到 mutable snapshot doc（让快照等于改完后的现实）。前者由「提升判断 lens」过滤项目级价值，后者由「diff 是否改变该 doc 的当前态答案」判断。两类都在任务边界一次过。

| 触发源 | 落点 | 附加判断 |
|---|---|---|
| plan.md + spec.md（如有） | docs/plans/ | 复制到 `docs/plans/<YYYYMMDD>-<short-name>/`（仅 plan.md + spec.md） |
| journal.md `[decision]` | adr/ | 写入判断见 §4.4 写入 lens |
| journal.md `[lesson]` / `[fact]` | experiences/ | 写入判断见 §4.7 写入 lens；写入与 topic 匹配的文件 |
| state.md Open Issues（任务结束时仍 open） | issues/ | 写入判断见 §4.8 写入 lens；写入与 domain 匹配的文件 |
| diff 含用户可感知变化 | CHANGELOG.md（根目录）[User]（+ contracts/，视交付形态） | CHANGELOG append 用户视角 entry；contracts/ 仅当交付形态有面向用户的行为契约时——ux-contract.md 走 §4.6 执行路径（主路径：随实现 apply；否则 → issue 间接路径），ux-test-patterns.md 可直接写入 |
| diff 改变功能 / 安装 / 使用方式 | README.md（根目录）[User] | 见 §4.1；与 CHANGELOG / contracts 联动 |
| diff 增删服务 / 改守护方式 / 监控链路 | operations/（+ README 服务章节）[User] | 见 §4.11；按 `service-operations-protocol.md` 检查生命周期脚本是否齐备 |
| diff 改变模块 / 分层 / 核心抽象 | architecture.md [Developer] | 见 §4.3 写入 lens |
| diff 改变外部源能力 或 物化数据当前态 | data/（sources.md / inventory.md）[Developer] | 见 §4.13；inventory 别手维护逐数据集清单，刷新走 **regen 命令** |

### 提升不是复制粘贴

task 产物的条目是执行过程中的即时记录，面向"接手同一任务的 agent"。项目文档面向"从未参与该任务的未来读者"。提升时改写格式以匹配目标文档的语义和受众。

---

## 6. 初始化与更新 docs/

独立维护时通过 `/custom:sync-docs [改了什么]` 手动触发；拥有收尾职责的 supervisor 按 `sync-docs.md`「被 supervisor 编排复用」契约执行完整 recipe，不内联调用命令。独立命令给出改动描述则补该改动的文档，空参数则审查并修全部现有文档。文档不存在则创建，已存在则增量更新。创建时按 §2 目录结构初始化、生成 docs/CLAUDE.md 索引、按 `docs-format-templates.md` 初始化各文档。

详见 `~/.claude/commands/custom/sync-docs.md`。

---

## 7. 反模式

| 反模式 | 为什么不要 |
|---|---|
| 没跑 sync-docs 就手动创建零散文档 | 用 `/custom:sync-docs` 初始化完整结构，确保 docs/CLAUDE.md 存在 |
| 把所有 journal 条目都提升 | 提升是过滤，不是转储——大量低价值条目稀释信号 |
| Architecture 当 codemap / 文件列表用 | architecture.md 是概念层面的理解，不是 `find . -type f` 的输出 |
| ADR 中只写结论不写 context 和 options | 没有理由和方案对比的决策不可审计、不可合理推翻 |
| UX Contract 只列功能不写如何 verify | 测试 agent 需要知道怎么验证，不只是知道功能存在 |
| inventory.md 给大 / 活 store 手维护逐数据集清单 | 随取数漂移、必然脱节甚至讲反主源；应"概览 + regen 命令"、权威清单由该命令生成（store 小 / 静态除外） |
| sources.md 记成静态承诺、不带实测与日期 | 数据源能力 / 权限会变；能力与可信度分级须带实测探查与日期，否则误导后续 agent |
