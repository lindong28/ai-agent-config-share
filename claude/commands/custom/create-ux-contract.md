---
description: 用户说"创建 UX contract / bootstrap user-observable 承诺 / 初始化产品 UX contract / create UX contract"。
disable-model-invocation: true
---

# create-ux-contract

从产品当前的文档 + 实际行为出发，bootstrap 出 `docs/contract/ux-contract.md`（user-observable 承诺）和空的 `docs/issues/ux-issues.md`（issue ledger），作为后续 test-ux 的契约源头。

**协议参照**：`~/.claude/references/ux-test-protocol.md`——两文件的定位、schema、ID 约定、反模式、§什么证据能 justify 哪些 entry。

## Consumer 与产物意识

bootstrap 出的两文件主要由两类类 consumer 消费：

- **test-ux**：跑测时按 contract 各段展开验证；contract 描述不到的承诺会被漏检
- **人 reviewer**：决定 drift / expansion 候选何时合入 contract；当前承诺必须可读、可对比

## Source 处理

**常见来源（不限于此）**：用户描述，实际产品行为（agent-browser / computer use 观察等），项目文档（PRD / README / CLAUDE.md 等），常识与同类产品惯例。

冲突时**不预设谁赢**，走梯度：

1. 实质一致只是表述不同 → 合
2. 能开产品 / 查 docs 原文验证 → 验证而非选边
3. 仍冲突或影响 contract 关键字段 → AskUserQuestion（情境见 §Gap 对齐）
4. 低风险且都无法验证 → fall back 到置信度较高的源（例如 用户描述 > 项目文档），并 flag 不确定性

> 用户描述粗（如"产品就这样"）不等于 ground truth——回 AskUserQuestion 摸具体。

## 端到端真实使用

**默认姿态**：本次 bootstrap 的承诺必须来自用户真实可触达的产品入口——真实部署、真实后端、真实账号、真实数据。除非用户显式允许把任务降级为 docs-only contract bootstrap，否则按本原则执行。

**自助部署优先**：入口不可访问但存在本地化部署路径（本地 dev server / 本地 build / 本地容器 / 模拟器等）且操作只影响本机环境时，主动起服务后继续 bootstrap，不必先问用户。判定"无风险"的 lens：操作可逆、不触达共享或线上资源（生产 DB / 第三方付费或写入型 API / 共享 staging / 真实用户消息通道等）、不影响其他开发者的本地环境。

**BLOCKED 处理**：自助部署不可行 / 自助尝试失败 / 部署需触达上述线上或共享资源 / agent-browser 拉不起 / auth 缺失等时，通过 `AskUserQuestion` 让用户在"修入口 / 换部署 / 显式降级 docs-only / 取消"间决定，不得静默 fall back 到读代码读文档凑 contract。**cost / quota / 时延 / 等待让某条 journey 走不通同样触发 BLOCKED**——让 owner 选 quota override / 降级 docs-only / 取消，不允许在主 session 内自我说服"这里不必走"。

### 什么算端到端

**Lens**：真实入口 = 该产品类型下用户生产环境实际触达的那个 artifact（部署 URL / 应用包 / 安装包 / 触发真实后端的 UI）。下表是常见形态的 non-exhaustive anchors，表外形态（hybrid app / Electron / 嵌入式 widget / CLI / 纯 API 等）回 Lens 判定，不要硬塞进表里。

| 产品类型 | 真实入口（anchors） |
| --- | --- |
| Web | 用户指定的真实部署 URL（production / staging / preview 均可）经浏览器访问，真实网络与真实数据 |
| Mobile / 小程序 | 体验版 / 正式版 / 测试版包，经原生入口或官方调试工具连真实部署后端 |
| Desktop | 真实安装包或用户指定 build，连真实本地/远端服务 |
| API-backed | UI 操作真实触发 API / DB / 权限 / 配额 / 异步任务（可用专门测试账号和测试数据，不替换响应） |

### mock / 静态分析的位置

- 任何替代真实后端 / 真实数据 / 真实用户身份的手段（mock、内部状态注入、`page.setData`、只读源码 + figma 拼承诺等，统称"mock"）只能作为**辅助理解**——补 docs 不写的边界、对齐字段含义。
- 主 bootstrap 结论必须落到真实产品观察上；mock 不能成为 contract 条目的唯一来源。
- 例外：**stable UI 枚举校准**（见反模式段相关条）允许从前端代码常量 / data 配置取值。

### Journey 覆盖最小集

bootstrap 阶段对 protocol §什么证据能 justify 哪些 entry 中 journey 级观察的最小执行要求：**至少走通一条主路径 journey（从入口到 success state）**；分支 journey（重抽 / 放弃 / 异常 / resume 等）可走差量观察——只走与主路径不同的那段。整条都没走通的 §Journeys entry 按 §端到端真实使用 BLOCKED 处理。

## 需要对齐的点

和 user 对齐过程中至少让以下信息变清晰。**不是顺序步骤**——可以并行、迭代、回头补。**AskUserQuestion 遵循 `~/.claude/references/deep-discuss-style.md`：top-down 排序 + 推荐 + pros/cons**。

通用 lens：**"如果现在直接写 contract，test-ux 会因为什么没问清楚而漏检？"**

**建议起点**：owner 视角（定义 user-observable 的语境）→ 按 §端到端真实使用 真实使用产品 + 同步读 docs → gap 对齐（reconcile 冲突）。任一环节暴露前置缺失时允许回退补。

### 产品形态 + owner 视角

**对齐**：产品类型（web / CLI / API / desktop）、owner persona 形态、"现在就想确保被记下的承诺"。

**lens**：什么是 user-observable——这个产品的真实用户从哪里看到承诺被违背？这层语境不清，Surfaces / Journeys / Features 都没落点。

调用时附了描述先吸收；否则用 AskUserQuestion 问。同步读 PRD / README / CLAUDE.md 等项目文档。

### 观察入口

**对齐**：本次 bootstrap 实际观察的是哪个部署 / 哪个 build / 哪个账号身份。bootstrap 完成时主 session 在向用户的总结里复述这些信息，方便后续 test-ux 复测同一真实产品状态。

**lens**："本次要观察的是哪个版本 / 构建？用什么账号或身份？环境与外部服务是否就绪？仅有本地 dev server / 源码时这是否真是用户的可触达对象？"

入口不可访问时按 §端到端真实使用 BLOCKED 处理段处理——不静默 fall back。

### 覆盖度 / 时间窗 / 解释力度（owner 拍）

**对齐**：bootstrap 的 ceiling——floor 由"能让 test-ux 跑"定，ceiling 由 owner 在以下轴上的偏好决定。

**lens**：什么是这版 contract **不该装**的？回答这个比"该装什么"更能定边界。

**常见轴**（不限于此）：

- 列尽所有 user-observable feature vs 只列核心承诺
- 含路线图 / 即将上线 vs 只当前 v0 actually-implemented
- 含 planner 合理推断 vs 只 owner 明确承诺

### 产品实际行为

**对齐**：按 §端到端真实使用 走真实入口 + 按 §Journey 覆盖最小集 走通主路径，建立"产品现在长什么样 + 实际发生了什么"的直观。

**lens**：docs / 源码 能告诉你"应该发生什么"；只有真实使用的观察能告诉你"实际发生了什么"——后者是 §Journeys entry 与跨 Surface / temporal 类型 entry 的唯一合格证据来源。

### Gap 对齐

比对：用户描述 vs 文档说法 vs 实际产品行为。遇到冲突或不确定时 → AskUserQuestion。

常见触发情境（不限于此）：
- 文档与实际行为不一致
- 描述与文档/实际任一冲突
- §Quality Bar 阈值无客观依据（如响应式断点、内容鲜度阈值）
- §Out of Scope 不确定某项是"故意不做"还是"v0 暂未做"

## 产物

按 protocol §2 / §3 Schema 写两个文件：

- `docs/contract/ux-contract.md`：按 protocol §2 Schema 的所有段
- `docs/issues/ux-issues.md`：空 ledger，按 protocol §3 Schema

**语言**：正文默认用中文。

### 落笔前的证据 gate

落笔前对每条 entry 自问"这条由什么 tier 的证据支撑"，按 protocol §什么证据能 justify 哪些 entry 对照。**证据 tier 不够时按 §端到端真实使用 BLOCKED 走，不在 contract 落笔**——没有"基于 X 推断"的中间态。

### 交付总结里必须复述的内容

向 owner 汇报时，除了入口 / 账号 / build，还要明确：

- 本次实际观察过哪些 journey（按 success state 列）
- 哪些 journey / §Feature entry 因 BLOCKED 走了 docs-only 降级或取消、未进入 contract，让 owner 看到 contract 缺口
- 不要用"行为路径已覆盖"之类把静态页证据偷换成 journey 证据的总括语——owner 看不到降级就无法判断 contract 可信度

## 反模式

- **跳过实际使用产品** —— 违反 §端到端真实使用 默认姿态 / 自助部署优先；规则与例外详见该段
- **mock / 内部状态 / figma 替代真实使用** —— 替代真实后端 / 账号 / 数据跑出的状态只能作为辅助理解线索，不得作为 contract 条目的唯一来源（参见 §端到端真实使用）
- **从代码反推 surface/feature** —— bootstrap 阶段禁用于"发现"新 surface/feature，可能误把 internal 路由当公开承诺。但**校准 stable UI 枚举**（见下条）是允许的例外
- **stable UI 枚举仅靠单次观察推断** —— 对页面分节、合法 slug、tier、状态等**离散有限枚举**，必须从 source-of-truth（前端代码常量、data 配置、PRD 表）取值；仅看某一天 UI 渲染的结果推断枚举会丢"空时不渲染"的项（例：观察看到日报 4 节就写"4 节"，实际代码定义 5 节、当天第 5 节恰好为空）
- **把 v1/v2/v3 路线图条目当 §Out of Scope** —— 这些是 PRD/VISION 已说明的"未来做"项，§Out of Scope 仅装"故意永不做" + "v0 不做未来不限"两类
- **§Features 的"不做"字段列"可能没必要的边界"** —— 仅列 owner 明确不做的项；猜测不写
- **bootstrap 阶段写 issue** —— 本 command 仅推断 contract；issue 留给 test-ux
- **拿不足 tier 的证据填高 tier entry** —— 例：用静态页观察支撑 §Journeys entry、用代码阅读支撑跨 Surface / temporal 类型 §Feature entry。protocol §什么证据能 justify 哪些 entry 是硬约束；不够时走 BLOCKED 处理，不要默写
- **让 journey 验证悄悄滑过去** —— 任务规划写"必要时走 X journey"留逃避空间、用 cost / quota / 时延等借口在主 session 内自我说服不必走、交付总结用"行为路径已覆盖"之类总括语遮盖未走通的 journey；这三种动作同性质——按规则该 BLOCKED 时就 BLOCKED，让 owner 决策
