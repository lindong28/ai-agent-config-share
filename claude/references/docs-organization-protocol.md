# Docs Organization Protocol

项目文档的组织与维护协议——定义项目中应维护哪些文档、每个文档的内容与语义、何时读写、如何在 agent 和人之间传递信息。**Trust-the-LLM 优先**：本文档给的是 WHY + WHAT + 触发例，不是 step-by-step 模板。读完应该能在新项目中推断该怎么做。

---

## 1. 何时启用 / 何时不启用

BINDING rule via CLAUDE.md。`docs/CLAUDE.md` 存在时协议生效——agent 在 docs/ 下工作时 Claude Code 自动加载该文件。

通过 `/custom:update-docs` 初始化 docs/ 结构（见 §6）。

---

## 2. 核心机制

三个互相支撑的机制：

1. **7 种文档类型**——覆盖从架构到变更记录的项目知识光谱
2. **docs/CLAUDE.md**——Claude Code 自动加载，agent 在 docs/ 下工作时协议规则自动 in context
3. **提升机制**——**task 产物**（Long Task Protocol 产出的 state.md 和 journal.md）中有项目级价值的条目提升为持久化文档

### 消费者层级

所有消费者消费的是**项目源代码**，不是源代码部署后的产品。文档的消费者分三层，下层包含上层：

```
  User       ← 看的最少：产品功能、变更记录、部署配置、使用验证、运维操作
  Developer  ← 中间层：+ 架构、设计决策、行为契约
  Agent      ← 看的最多：+ 经验、issues、测试 pattern
```

User 是拿到源代码后需要部署、使用、运维的人——部署（环境搭建、数据库初始化、运行时配置）、使用验证（像产品用户一样实际使用部署后的产品，确认功能正常）、运维（日常配置调整、问题排查）。

每个文档标注其**最上层消费者**——标注 `[User]` 意味着三层都看，`[Developer]` 意味着开发者和 Agent 看，`[Agent]` 意味着仅 Agent 需要看。

### 目录结构

```
<project>/
├── README.md                              # 产品说明、安装、使用 [User]
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
    ├── contracts/
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
    └── references/                        # 详细参考手册（项目特定，消费者因文件而异）
        └── <name>.md                      # 部署/配置/运维指南 [User]；字段定义/API 契约 [Developer]
```

动态文件名说明：`NNN-<slug>.md` 编号递增 + kebab-case 标题；`<topic>.md` 按项目实际 topic 命名（如 `deployment.md`、`api-integrations.md`）；`<YYYYMMDD>-<short-name>` 日期前缀 + kebab-case 标题。

### 文档类型概览

| 文档 | 性质 | 核心问题 | 消费者 |
|---|---|---|---|
| README.md（根目录） | Mutable snapshot | 产品是什么、怎么用？ | User |
| CHANGELOG.md（根目录） | Append-only（newest first） | 用户能感知到什么变化？ | User |
| architecture.md | Mutable snapshot | 系统是怎么组织的？ | Developer |
| adr/ | Append-only（每条一文件） | 当初为什么这么设计？ | Developer |
| plans/ | Append-only（归档 plan.md + spec.md） | 当初打算做什么、怎么做？ | Developer |
| contracts/ | Mutable snapshot + heuristics | 用户能用什么功能？测试该覆盖什么？ | Developer |
| experiences/ | Append-only（按 topic 分文件） | 这个坑之前怎么踩过？ | Agent |
| issues/ | Mutable（lifecycle，按 domain 分文件） | 有哪些发现的问题要解决？ | Agent |
| references/ | Mutable snapshot（按项目需要） | 操作层面的详细定义和步骤是什么？ | 因文件而异 |
| docs/CLAUDE.md | Mutable snapshot | 文档索引在哪？协议规则怎么加载？ | Developer |

### 写入路径

| 场景 | 路径 |
|---|---|
| 长任务执行（有 task 产物） | 任务完成后**提升**到项目文档（见 §5） |
| 常规 session（无 task 产物） | 发现值得持久化的信息时**直接写入**项目文档 |

两条路径互补：提升是批量的事后总结；直接写入是逐条的实时记录。提升更系统，直接写入覆盖没有 task 产物的场景。

### 执行模型

文档更新由 **subagent 执行**（`doc-updater`），主 Agent 只负责判断触发条件和组装上下文。多个文档类型需要更新时，并行 spawn 多个实例。

详见 `~/.claude/agents/doc-updater.md`。

---

## 3. 根目录文件 [User]

根目录的 README.md 和 CHANGELOG.md 不在 docs/ 下但属于协议管辖范围。读写规则见 §4.1 和 §4.2。

---

## 4. 各文档的读写规则

每种文档的定义结构一致：What → Format → 何时读 → 何时写。建议格式模板见 `docs-format-templates.md`（仅在创建新文档时参考；不是所有类型都有模板——README 和 plans 按惯例组织）。模板中的字段是起点——缺了就补、不够就加、不合适就不塞。判断标准：目标读者只看这条 entry 能否完成他的任务。

---

### 4.1 README.md（根目录）[User]

**What**：项目的入口文档。面向所有拿到源代码的人——介绍产品是什么、如何部署和配置、如何日常运维。

**Format**：Mutable snapshot。按通用开源 README 惯例组织（产品介绍、功能、部署、配置、运维等）。

**何时读**

Lens：当你需要理解"这个项目是什么、怎么部署和使用"时。

**何时写**

Lens：当产品的功能、安装方式、使用方式发生变化时。与 CHANGELOG.md 和 contracts/ux-contract.md 联动——如果这两个文档更新了，README 大概率也需要同步。

---

### 4.2 CHANGELOG.md（根目录）[User]

**What**：面向用户的变更记录，位于项目根目录（与 README.md 平级）。按时间倒序记录每次用户可感知的变化。

**Format**：Append-only（newest first）。每条 entry 描述用户视角的变化，不是实现细节。

**粒度**：以**逻辑变更**为单位——一个用户可感知的独立变化（feature / bugfix / behavior change）一个 entry。多个 commit 可以组成一个 entry（如果它们共同构成一个完整的用户可感知变化），多个 entry 按日期或版本号分组在一个 `##` 标题下。

**何时读**

Lens：当需要了解产品近期变化时——无论是用户查阅还是 agent 理解近期演进。

**何时写**

Lens：当产品发生了用户可感知的变化时——新功能、行为变更、bug 修复。纯实现重构 / 内部调整不记录。

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
- 数据从用户输入到持久化怎么流？
- 项目用了什么数据库/存储，schema 是什么？
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

### 4.5 plans/ [Developer]

**What**：已完成 plan 的 plan.md 和 spec.md 归档。保留设计意图和需求定义的历史记录。

**Format**：目录结构，每个 plan 一个子目录（`<YYYYMMDD>-<short-name>/`），仅归档 plan.md + spec.md（不含 state.md / journal.md）。

**何时写**

Lens：plan 执行完成后，将 plan.md 和 spec.md（如有）复制到 `docs/plans/<YYYYMMDD>-<short-name>/`。

---

### 4.6 contracts/ — UX Contract 与测试 Pattern [Developer]

**What**：产品面向用户的行为契约和测试指导。包含两层：**hard spec**（产品必须满足的行为契约）和 **soft heuristics**（测试时值得留意的模式和边界情况）。

**Format**：目录结构。

```
docs/contracts/
├── ux-contract.md
└── ux-test-patterns.md
```

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

写入时找到与 topic 匹配的文件。没有合适的文件时创建新的 topic 文件并更新 experiences/README.md 索引。

写入后自检——未来 agent 遇到类似问题时能否判断"这条经验适不适用我的情况"并直接应用解法。

---

### 4.8 issues/ — 问题跟踪 [Agent]

**What**：agent 在开发过程中发现的值得跟踪的问题——bug、可改进项、feature 建议。agent 驱动的轻量 issue tracker，也可用于自动化流水线的输入。

**Format**：目录结构，按 domain 分文件。每个文件内 mutable（条目有 lifecycle）。**按 domain 分文件的核心好处**：不同 domain 的 issues 有不同的优先级和 consumer，domain 文件让自动化流水线可以精确地只处理相关的 issues。

```
docs/issues/
├── README.md                  # 索引：各 domain 文件的列表与 scope
├── ux-issues.md               # 测试产品时发现的 UX 问题（contract 在实际产品中被 broken）
├── ux-contract-issues.md      # contract 本身的问题（定义缺失 / 不准确 / 过时）
└── general.md                 # 不属于特定 domain 的通用 issues
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
- 代码审查 / skill 维护中发现改进项 → `general.md`
- 从 state.md Open Issues 提升——任务结束时仍 open 的 issue（见 §5）

**ux-issues.md 和 ux-contract-issues.md 的写入约束**：必须基于真实端到端产品观察，不依赖读代码或文档推断。只有 `/custom:test-ux` 等实际执行产品的流程才能写入这两个文件。通过 §5 提升的 UX-domain issue 如果不是基于真实端到端产品观察，应归入 `general.md` 而非 `ux-issues.md` / `ux-contract-issues.md`。

写入后自检——下一个处理者只看这条 entry 能否判断"要不要修、怎么复现、优先级多高"。

**Issue status**：`open` / `resolved` / `wontfix`。格式模板见 `docs-format-templates.md` §4.8。

| 反模式 | 为什么不要 |
|---|---|
| issue 修复后直接删整条 entry | mutable 是 status 字段流转，不是条目消失；删整条丢历史 |

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

### 4.10 docs/CLAUDE.md [Developer]

文档索引 + 协议规则加载点（Mutable snapshot）。Claude Code 在 docs/ 下工作时自动加载。写入 lens：docs/ 下新增、重命名或删除文档时同步更新索引。

---

## 5. 提升机制：task 产物 → 项目文档

### Why

task 产物服务于一个具体任务的执行过程。任务完成后，其中一部分信息有项目级的持久价值。提升机制把这部分信息迁移到项目文档中，让它们的生命周期不再绑定于单个任务。

### 何时提升

**Lens**：当一个有 task 产物的任务到达自然边界时——审视产物中是否有项目级价值的条目。

触发例（不限于此）：
- 长任务完成（所有 Tasks done、verify 通过）
- 长任务被取消但 journal 中有有价值的发现
- session 结束前，当前 session 有 task 产物

### 提升判断 lens

> "如果我是一个全新的 agent，从未参与过这个任务，这条信息是否能帮我在这个项目中更有效地工作——且不能从代码本身看出来？"

通过这个 lens 的条目值得提升。没通过的留在 task 产物中作为历史归档。

### 提升路径

| task 产物条目 | 提升到 | 附加判断 |
|---|---|---|
| plan.md + spec.md（如有） | docs/plans/ | 复制到 `docs/plans/<YYYYMMDD>-<short-name>/`（不含 state.md / journal.md） |
| journal.md `[decision]` | adr/ | 写入判断见 §4.4 写入 lens |
| journal.md `[lesson]` / `[fact]` | experiences/ | 写入判断见 §4.7 写入 lens；写入与 topic 匹配的文件 |
| state.md Open Issues（任务结束时仍 open） | issues/ | 写入判断见 §4.8 写入 lens；写入与 domain 匹配的文件 |
| 任务完成 + 产出包含用户可感知变化 | contracts/ + CHANGELOG.md（根目录） | 用户的产品体验是否发生了变化？ux-contract.md 走 §4.6 执行路径（主路径：随实现 apply；否则 → issue 间接路径），ux-test-patterns.md 可直接写入 |

### 提升不是复制粘贴

task 产物的条目是执行过程中的即时记录，面向"接手同一任务的 agent"。项目文档面向"从未参与该任务的未来读者"。提升时改写格式以匹配目标文档的语义和受众。

---

## 6. 初始化与更新 docs/

通过 `/custom:update-docs [type...]` 命令手动触发。不指定类型则更新所有类型。文档不存在则创建，已存在则增量更新。创建时按 §2 目录结构初始化、生成 docs/CLAUDE.md 索引、按 `docs-format-templates.md` 初始化各文档。

详见 `~/.claude/commands/custom/update-docs.md`。

---

## 7. 反模式

| 反模式 | 为什么不要 |
|---|---|
| 没跑 update-docs 就手动创建零散文档 | 用 `/custom:update-docs` 初始化完整结构，确保 docs/CLAUDE.md 存在 |
| 把所有 journal 条目都提升 | 提升是过滤，不是转储——大量低价值条目稀释信号 |
| Architecture 当 codemap / 文件列表用 | architecture.md 是概念层面的理解，不是 `find . -type f` 的输出 |
| ADR 中只写结论不写 context 和 options | 没有理由和方案对比的决策不可审计、不可合理推翻 |
| UX Contract 只列功能不写如何 verify | 测试 agent 需要知道怎么验证，不只是知道功能存在 |
