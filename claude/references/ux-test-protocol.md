# UX Test Protocol

围绕产品 user-observable 行为的测试 / 维护 / 进化体系。本文档给三个协同 artifact 的定位 + schema；行为规则在各 command。

---

## §1 体系概述

四个 per-product artifact：

| 文件 | 性质 | 装什么 |
|---|---|---|
| `./docs/contract/ux-contract.md` | mutable snapshot | 当前 product 对用户承诺的可观察行为 |
| `./docs/issues/ux-issues.md` | mutable issue ledger | 当前 product 已确认的 user-observable 问题 |
| `./docs/issues/ux-contract-issues.md` | append-only queue | test-ux 跑测时发现的对 ux-contract 演化的 LLM 候选观察队列 |
| `./docs/proposals/ux-contract-proposals.md` | append-only queue | coding-agent 实现完 user-observable feature shipment 后写入的 contract evolution 候选 |

围绕它们协同的 custom commands：`/create-ux-contract` / `/update-ux-contract` / `/test-ux`——具体 I/O 与流程见 `~/.claude/commands/custom/` 下对应文件。`ux-contract-proposals.md` 由 coding agent 按 BINDING 协议自动 append。

---

## §2 ux-contract.md

### 定位

当前 product 对用户承诺的可观察行为。**user-observable 才在这里**——实现细节、未来路线、已知 bug 都不在。

**必要非充分**：contract 是 owner 明确拍下的最小测试基线，不是 user-observable 的封闭枚举。常识、同类产品惯例、隐含期望即便未列入也属 user-observable 范畴——下游 consumer（test-ux 等）在 contract 之外仍需扩展验证，不以条目数封顶。

### Schema

每段「装什么」与「每条 entry 应让 test-ux 能回答」如下。

> **问句是 lens 引导，不是 schema 字段**。entry 可以是 prose、bullets 或表格，作者按情境取舍。**某条 lens 问题没有实质答案时应省略**——为凑齐 lens 而填的 tautological / 重复别处 / 纯实现细节 / 位置错位内容会反过来污染 test-ux（它会把填出来的字当成真约束去构造测试）。

### 什么证据能 justify 哪些 entry

**Lens**：证据观察粒度匹配 entry 承诺粒度——单帧可观察的渲染 / 文案 / 布局 → 静态页观察；状态转换 / 异步 / 错误态 / 跨 Surface / 时序 → journey 级观察；declared-only 知识 → 代码 / docs 阅读，但不单独支撑"实际渲染发生了 X"型承诺。**§Features / §Quality Bar 内不同 entry 粒度不同**，逐条按 lens 判断而非整段套同一 tier。

下表为三类证据 anchor，consumer command（`/create-ux-contract` / `/update-ux-contract` / `/test-ux`）按 lens + anchor 对照本次收集到的证据：

| 证据 tier | 常见取得方式 | 典型适用承诺形态 |
| --- | --- | --- |
| **静态页观察** | 单 Surface 加载至默认态（启动 app / navigate / openURL 等任一入口，不做后续交互）+ 截图 / DOM dump | 单帧可观察的渲染 / 文案 / 布局 / 视觉规则（对比度、间距等）；persona 背景；owner 明说"不做"的项 |
| **journey 级观察** | 走通从入口到 success state 的完整 flow，看到状态转换 / 异步收尾 / 模态 / 导航 post-action / 错误态真实渲染 | 涉及状态转换 / 异步 / 错误态 / 跨 Surface / 时序的承诺 |
| **代码 / docs / 静态资产阅读** | 静态读源码 / 模板 / state machine / docs | 仅作 cross-check 与边界补全；不单独支撑"实际渲染了 X"型承诺——看不到 if 分支死代码、未触发的模态、被吞的错误、超时未收尾、状态更新但 UI 未刷新等真实问题 |

#### Personas

交互视角用户角色。**Lens**：ux-test 能模拟 persona 描述的角色需求和背景知识去判断用户的测试行为和预期。

每条 entry 应让 test-ux 能回答：

- 想完成什么**核心任务**？（例如：浏览、检索、管理、配置）
- 有哪些**权限**？（例如：是否能执行写操作、访问敏感数据、走 admin 通道）
- 与产品的**关系**如何？（例如：使用频率、熟练度、首次还是回访）
- 访问时有哪些**情境约束**？（例如：常用入口、设备、网络）

#### Surfaces

产品对外暴露的"面"。**Lens**：ux-test 能从这里找到对应产品交互入口。

每条 entry 应让 test-ux 能回答：

- 用户怎么**进入**这个 surface？（例如：URL、菜单入口、外部跳转、命令）
- 是否能**直接定位到某种特定状态**？（例如：URL query / route 参数 / CLI flag）
- 首次进入时**看到什么**？（默认状态）
- 在不同环境下**承诺是否一致**？（例如：跨设备、跨语言、跨角色）

#### Journeys

端到端用户流程。**Lens**：ux-test 能按照这个流程端到端复现用户使用产品的体验，能验证产品过关或者复现问题。

每条 entry 应让 test-ux 能回答：

- 谁触发、在**什么场景**下？
- 复现需要按**什么顺序**操作？
- **成功状态**长什么样？（test-ux 据此判 pass）
- 有哪些 **near-miss 看似 OK 实则错**？（例如：列表顺序错、数据陈旧但 UI 正常——预先列出可显著降漏报率）

#### Features

surface 内的原子能力和契约。**Lens**：ux-test 要能判定"哪些 expectation 是承诺 / 哪些是想多了"。

每条 entry 应让 test-ux 能回答：

- **承诺**哪些行为？
- 哪些**近邻行为是故意不做的**？（test-ux 据此区分真问题与误期望）
- **边界情境**下表现如何？（例如：空输入、无效参数、超限、冲突状态）
- 跨多个 Surface 时**各自呈现差异**？

#### Quality Bar

产品自定的"够不够好"基线。

每条 entry 应让 test-ux 能回答：

- 衡量哪个**维度**？
- 怎么算 **fail**？（例如：客观可二元判断的阈值"<2s"而非泛"快"）
- fail 时**关联到哪些 Surface / Feature / Journey**？（影响 issue 归位与严重度判定）
- 怎么**观察或取样**？（例如：单次抽查、滚动窗口、N 次采样）

#### Out of Scope

产品设计**明确不做**的事。

每条 entry 应让 test-ux 能回答：

- **为什么不做**？（例如：与产品定位相悖、设计选择、法务/合规约束——test-ux 据此判该缺失是否当 issue 报）
- 用户容易**误期望**到的情形是什么？
- 这条约束的**来源**？（例如：VISION / PRD / 设计决策）

### ID 命名

§Personas / §Surfaces / §Journeys / §Features / §Quality Bar 每条 entry 用**自然语言类型名**做 ID 前缀，让 reader 不查表就理解类型。后缀（数字 / 语义名）按 product 习惯定。

### ID 修改

ID 改名 / 编号调整 / 重排 / 复用都允许。修改时需要注意不破坏 `docs/issues/ux-issues.md` 与 `docs/issues/ux-contract-issues.md` 内对 ux-contract.md 的引用。

---

## §3 ux-issues.md

### 定位

当前 product 已确认的 user-observable 问题清单。与 ux-contract 配对——ux-contract 说"应该怎样"，ux-issues 说"现在哪些没做到"。

格式：

```
## Issues

- [pending] Issue-1 <title>
  - Discovered: <when/where — persona / journey 触发场景>
  - Description: <现象 + 为什么是问题>
  - Notes (optional): <其他有助于验证和解决 issue 的上下文信息>

- [in_progress] Issue-2 <title>
  - Discovered: ...
  - Description: ...
  - Notes: <当前进展 / 阻塞点>

- [done <YYYY-MM-DD>] Issue-3 <title>
  - Discovered: ...
  - Notes: <修复方式 / 验证证据>

- [cancelled] Issue-4 <title>
  - Discovered: ...
  - Notes: <为什么不修>
```

**字段使用 lens**：让下一个 reviewer（人或 LLM）只看这条 entry 就能回答"这是什么 / 何时发现 / 现在什么状态 / 下一步该做什么"。缺哪个字段就补哪个；上面字段不够用时自由追加字段。

**status 4 态语义**：

- `pending` 已发现未处理
- `in_progress` 正在修
- `done` 已修复 + 验证通过
- `cancelled` 决定不修

---

## §4 ux-contract-issues.md

### 定位

test-ux 在跑测中发现的**任何与 ux-contract 演化相关的观察** append-only 队列：包括契约与实际行为的不一致、未覆盖但合理的扩展点、对 contract 结构本身的改进建议等。

格式：

```
## <YYYY-MM-DD HH:MM> [<type>] <title>

- Discovered: <when/where — persona / journey 触发场景>
- Description: <观察到的事实 + 与 contract 的对比>
- Recommendation: <修改建议>
```

**字段使用 lens**：让下一个 reviewer（人或 LLM）只看这条 entry 就能回答"观察到什么 / 何时发现 / 建议如何处置"。缺哪个字段就补哪个；上面字段不够用时自由追加字段。

**type 语义**（开放枚举，按场景可创新值）：

- `drift`: ux-contract 声称 X 而实际 Y
- `expansion`: ux-contract 未覆盖但合理的扩展候选 (e.g. persona/surface/journey/feature)
- `redesign`: 对 ux-contract 结构 / schema 本身的改进建议

---

## §6 反模式

| 反模式 | 为什么不要 |
|---|---|
| 把待办事项 / 修复计划写进 ux-contract | ux-contract 是当前承诺；待修的 bug 是 ux-issues |
| ux-issues 修复后直接删整条 entry | mutable 是 status 字段流转，不是条目消失；删整条丢历史 |
| 为满足 lens 问题做填空式冗充 | tautological（"非精选项不显示精选 badge"——这本是承诺的反面）/ 重复别处 / 实现细节 / 位置错位的内容会污染 test-ux 的判断锚——无实质答案应省略 |
