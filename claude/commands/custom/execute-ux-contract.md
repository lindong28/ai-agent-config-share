---
name: execute-ux-contract
description: 基于已审过的 ux-contract 驱动 Codex 执行端到端 UX 测试+修复循环，直到 Critical/High issue 清零。触发：显式 `/custom:execute-ux-contract <contract-path>`。
argument-hint: "<contract-path>"
disable-model-invocation: true
origin: 2026-05-28
---

# execute-ux-contract

## 术语

| 术语 | 含义 |
|---|---|
| ux-contract | `/custom:create-ux-contract` 产出的契约文件 |
| L1 | ux-contract 中的产品全貌层——产品是什么、怎么访问、核心使用方式 |
| L2 | ux-contract 中的用户视角 verify 层——每条描述一个可观测的预期行为 |
| L3 | agent-level 内部验证——读取用户通常不看的信息来增强 L2 判定可信度。不属于 ux-contract，由本 command 在 test plan 中补充 |
| test plan | 本 command 将 ux-contract L2 翻译为 agent-executable 测试步骤的产出物，落地为 `plan.md` |
| test session / fix session | 分别执行测试和修复的独立 Codex session，通过 `codeagent-wrapper`（启动独立 Codex session 的 CLI wrapper）启动 |
| supervisor | 执行本 command 的 agent，负责编排 Codex session、裁决产出、维护 state.md/journal.md |
| Stop Gate | `plan-execution-principles.md` 定义的终止条件检查——任何 Codex session 或 supervisor 以任何理由停止前都必须通过 |

## 何时使用

- ux-contract 已经过 `create-ux-contract` + `review-ux-contract` 打磨
- 非 ux-contract 输入（自由文本 / spec / plan）→ 不执行：提示用户先跑上游 command

## 参数

| 参数 | 必需 | 说明 |
|---|---|---|
| contract-path | ✓ | ux-contract 路径（来自 `/custom:create-ux-contract`）|

## 输入契约

| 形态 | 处理 |
|---|---|
| ux-contract 路径（含 L1 + L2 verify 段） | 进入主流程 |
| 路径不存在 / 文件缺少 L2 verify 段 | 拒绝执行；提示先跑 `/custom:create-ux-contract` |

## 引用文件

| 引用 | 何时读 | 读什么 |
|---|---|---|
| `~/.claude/references/long-task-protocol.md` | 生成 plan.md 时 | §8 banner 格式（plan 有此 banner 时整个协议自动 BINDING） |
| `~/.claude/references/plan-execution-principles.md` | 任何 Codex session stop 时、supervisor 考虑停止时 | Stop Gate 段；§4 交接格式 |
| `~/.claude/references/ux-test-patterns.md`（+ `./docs/contracts/ux-test-patterns.md` 若存在） | 构造 test prompt 时 | 测试方法论 + 执行 patterns |

---

## 主流程（lens，不是步骤清单）

### 1. Plan 生成（ux-contract → test plan）

读 ux-contract，生成 test plan：

**L2 翻译**：ux-contract 的每条 L2 verify → agent-executable 测试步骤。翻译要求：
- 保留维度完整性——每条 L2 verify 必须有对应的 test step，不丢维度
- 翻译成 agent 可执行的形式：操作序列 + 观测点 + pass/fail 判据
- 产品访问入口、认证信息从 ux-contract 摘出，写进 test plan 顶部

**L3 补充**：对每条 L2 test step，考虑追加 agent-level 内部验证来增强 L2 判定的可信度。思考 lens：用户看不到但 agent 可以获取的信息中，哪些能增强或质疑 L2 判定？常见的 L3 信息来源包括但不限于：

| 信息来源 | 获取方式示例 | 增强什么判定 |
|---|---|---|
| 网络请求/响应 | browser network 日志、DevTools | 功能是否真实触发后端 |
| 应用日志 | 读 log 文件或 stdout | 错误/异常检测 |
| 数据库/API 状态 | 执行查询或 curl | 数据一致性 |
| 性能指标 | performance API、加载时间测量 | 响应延迟 |

L3 是可选增强，不替代 L2 判定——L2 pass 但 L3 发现异常 → 记为 issue 但不阻断 L2 判定。

**落点**：`plans/<YYYYMMDD>-<HHmm>-<contract-slug>-ux-test/`（contract-slug 由 ux-contract 文件名去后缀推导，HHmm 为执行开始时的 24 小时制时分）

| 文件 | 内容 |
|---|---|
| `plan.md` | 顶部 long-task banner（标记进入 long-task mode）+ ux-contract 引用 + 产品访问信息 + test steps（TS-001, TS-002 …） |
| `state.md` | test steps 转为 `[pending]` 任务 + 空的 Open Issues 段 + 空的 Fix Tasks 段（Fix Tasks 与 test steps 并列，状态同样使用 pending/in_progress/done，每条关联其修复的 issue ID） |
| `journal.md` | 只写 header，不预填 |

plan.md banner 按 `~/.claude/references/long-task-protocol.md` §8 格式。

**Plan 确认门**：supervisor 评估翻译质量。若 L2 翻译存在歧义（多种合理的 pass/fail 判据解读）或 L3 补充选择不确定，AskUserQuestion 指出具体疑问点让用户裁定；无疑问则直接进入测试。

### 2. Test-Fix 循环（supervisor 编排）

每轮次由一个 test session + 一个 fix session 组成，各用独立 Codex session 避免上下文干扰。

#### 2.1 Test Session

**端到端原则**：test session 的核心结论必须来自真实部署的产品入口。什么算端到端：

| 产品类型 | 真实入口 |
|---|---|
| Web | 用户指定验收 URL（production / staging / preview）经浏览器访问，真实网络与真实数据 |
| Mobile / 小程序 | 体验版 / 正式版 / 测试版包，经原生入口或调试工具连真实后端 |
| Desktop | 真实安装包或指定 build，连真实本地/远端服务 |
| API-backed | UI 操作真实触发 API / DB / 权限 / 配额 / 异步任务 |

表外形态回到默认姿态判定。mock（替代真实后端/数据/用户身份的手段）只作辅助诊断——解释端到端现象或定位根因，不替代端到端结论。

**工具选择 lens**：根据产品类型选择合适的端到端模拟方式——agent-browser 适合 Web 产品的浏览器交互，computer use 适合需要原生 UI 操作的桌面/移动应用，产品原生接入（CLI、API client 等）适合非 GUI 产品。具体工具用法见对应工具文档。

启动 Codex（后台 + 独立 session）：

```
Bash({
  command: "~/.claude/bin/codeagent-wrapper --progress --backend codex - <WORKDIR> <<'EOF'\n<test-prompt>\nEOF",
  run_in_background: true,
  timeout: 7200000,
})
```

`<WORKDIR>` 必须来自 Bash `pwd`。从 wrapper 输出中捕获 Codex session id（handoff 需要）。

**Test prompt 构造**——信息在文件中已有则给路径让 Codex 自己读，只在 prompt 中传递文件中没有的指令：

引用文件（Codex 读取详情）：
- `plan.md` 路径（含 test steps、产品访问信息、pass/fail 判据）
- ux-contract 路径（issue 中引用 L2 条目的来源）
- 本 command 文件 §2.1 端到端原则 + §Issue 格式
- `~/.claude/references/ux-test-patterns.md`
- `~/.claude/references/plan-execution-principles.md`（Stop Gate）
- `journal.md` 路径（Codex 可追加执行过程中的观察和经验，不修改已有内容）

本轮次指令（不在上述文件中的信息）：
- 首轮次：执行 plan.md 中全量 test steps；后续轮次：执行 supervisor 指定的 test step ID 列表
- 产出路径：`<plans 子目录实际路径>/issues/round-<N>-test.md`；无 issue 时也要写 "all pass" 报告

等待轮询：`TaskOutput({ block: true, timeout: 600000 })`，10 分钟未完成是常态，继续轮询。每轮次等待之间发简短中文状态。

#### 2.2 Supervisor 裁决（test → fix 之间）

读 test session 产出。以下是常见情况的处理 lens（不是完整列表，supervisor 应基于实际情况判断）：

| 情况 | 处理 |
|---|---|
| Codex 过早 stop（未执行完 test steps 或未满足 Stop Gate） | resume 同一 session 继续，指出哪些 test steps 未执行 |
| 正常完成，有 issue 报告 | 逐条裁决（见下方核心原则） |
| 正常完成，全部 pass | 更新 state.md，进入 §3 Commit |

逐条 issue 裁决的核心原则：
- 发现 ux-contract 本身有误（L2 描述与产品预期矛盾）→ AskUserQuestion 报告具体矛盾 + 建议修复 ux-contract 还是修复产品，**不静默调整 test plan**
- 证据或严重度判定模糊 → AskUserQuestion 附上具体 issue + 证据 + 两种判定的后果，让用户裁定

更新 state.md：test steps 状态更新（pass / fail / blocked）；保留的 issue 加入 Open Issues；为 Critical/High issue 创建 Fix Tasks。

更新 journal.md：本轮次测试发现摘要 + 裁决理由。

**收敛判定**：有 Critical/High/Medium 未修复 → 进 §2.3 fix session；仅剩 Low → 跳过修复，直接进 §3 Commit（issue 留给用户在 handoff 时决定）。

#### 2.3 Fix Session

启动新 Codex session（独立于 test session），启动方式同 §2.1。

**Fix prompt 构造**——同样遵循"文件中有则给路径，prompt 只传文件中没有的指令"：

引用文件（Codex 读取详情）：
- 本轮次 Critical/High issue 文件路径（Codex 自己读 issue 详情和证据）
- ux-contract 路径（预期来源，帮助理解修复目标）
- `~/.claude/references/plan-execution-principles.md`（Stop Gate）
- `journal.md` 路径（Codex 可追加修复过程中的观察和经验，不修改已有内容）

指令（不在上述文件中的约束）：
- 修复范围：只修 issue 描述的问题，不做额外重构
- 内部 verify：修复后跑项目已有的测试/lint/类型检查
- **不修改 ux-contract / plan.md / state.md**——这些由 supervisor 维护

#### 2.4 Supervisor 裁决（fix → re-test 之间）

读 fix session 产出。以下是常见情况的处理 lens（不是完整列表，supervisor 应基于实际情况判断）：

| 情况 | 处理 |
|---|---|
| Codex 过早 stop（未完成全部修复或未满足 Stop Gate） | resume 同一 session 继续，指出哪些 fix tasks 未完成 |
| 修复完成 + 有 internal verify 证据 | 更新 state.md Fix Tasks 状态 → 回 §2.1 发起下一轮次 test |
| 同一 issue 连续 2 轮次修复未推进 | supervisor 独立排查（`git diff` / 复现命令 / 日志）后，必须 AskUserQuestion 报告排查发现并请求指示（用户可选：提供修复线索、降级 severity、标记 won't-fix） |

**Re-test 范围决策**（supervisor 判断）：修复范围小且局部 → 只 re-test 受影响的 test steps + 回归抽检；修复范围大或涉及共享模块 → 全量 re-test。不确定时偏向全量。

### 3. Commit（fix 完成时）

**判据**：state.md 所有 Critical/High Fix Tasks 为 done + 所有 test steps 最近一轮次 pass（或仅剩 Low）+ working tree 有 fix session 产出的改动且 diff 非空。无 fix session（首轮即全 pass）或 diff 为空时跳过本节。

**Scope**：
- 进 commit：fix session 在本次 test-fix 循环中修改的代码
- 不进 commit：plan.md / state.md / journal.md（audit trail）；ux-contract（不可变）；repo 中与本次 fix 无关的 in-flight 改动

**执行**：必须用 create-commit skill 完成本次 commit（不自行手写 message）——skill 定义的 message 格式是本 command 的 commit 标准，其中「不附 Co-Authored-By」在本 command 内优先于全局 Bash 默认的 Co-Authored-By trailer。执行 skill 时按上述 Scope 显式 `git add` 只 stage fix session 的改动——skill 默认会包含全部 tracked 修改，不显式限定会把无关的 in-flight 改动带进 commit。

### 4. Handoff

**前置条件**：state.md 中所有 Critical/High Fix Tasks 为 done + 所有 test steps 最近一轮次 pass（或仅剩 Low）。

中文回复，内容由实际执行轨迹决定：

**必含**

- ux-contract 路径 + test plan 路径
- 测试轮次数 + 各轮次 Codex session id
- state.md 最终状态简述（含 test steps 覆盖情况）

**适用时含**

- 已修复 issue 摘要 + 对应修复的 commit
- 未修复的 Low issue 清单 + 定位信息
- 发现的 ux-contract 矛盾（supervisor 在 §2.2 标记的）
- journal.md 中值得用户关注的 lesson / decision

若最终是合法 stop 而非完成，按 plan-execution-principles §4 格式交接。

---

## Issue 格式

每条 issue 需包含以下信息，让 coding agent 能定位和修复问题：

| 问题 | 对应信息 |
|---|---|
| 什么坏了？ | 实际观察到的现象 |
| 应该是什么？ | 引用 ux-contract L2 的具体条目（条目编号或原文） |
| 在哪里？ | 产品位置（URL / 屏幕 / 元素） |
| 怎么观察到？ | 触发条件或观察方法（操作路径 / 环境条件 / 检测命令） |
| 有什么证据？ | 端到端证据（截图、DOM 状态、网络响应、日志等） |
| 严重度 | Critical / High / Medium / Low |

---

## 关键不变量

| 不变量 | 为什么 |
|---|---|
| **ux-contract 不可变（supervisor 不自行修改）** | 发现矛盾时 AskUserQuestion 让用户决策；静默改 ux-contract 会让 review 的投资失效 |
| **背景任务 + TaskOutput 轮询** | 不阻塞 supervisor session；不因等久就 kill；不把"在等待"当 stop 理由 |
| **核对 Codex 产出 ≥ verify gate** | 不因 Codex 报告 "Done" 就进下一步——逐项检查实际执行结果和证据；同样不因 Codex 声称 "blocked / 外部不可解" 就转交用户——按 Stop Gate 独立验证 Codex 可控缓解已穷尽 |
