---
name: execute-ux-contract
description: 基于已审过的 ux-contract 执行端到端 UX 测试+修复循环，直到可即时修复的 Critical/High/Medium issue 清零。
argument-hint: "<contract-path> [max-parallel=N]"
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
| test plan | 本 command 将 ux-contract L2 翻译为 agent-executable test step 的产出物，落地为 `plan.md` |
| test session / fix session | 分别执行测试和修复的独立 Codex session，通过 `codeagent-wrapper`（启动独立 Codex session 的 CLI wrapper）启动 |
| test 阶段 | 一轮次中执行测试的这条腿，由一个或多个并行 test session 组成（与一个 fix session 共同构成一轮次） |
| supervisor | 执行本 command 的 agent，负责编排 Codex session、裁决产出、维护 state.md/journal.md |
| Stop Gate | `plan-execution-principles.md` 定义的终止条件检查——任何 Codex session 或 supervisor 以任何理由停止前都必须通过 |

## 何时使用

- ux-contract 已经过 `create-ux-contract` + `review-ux-contract` 打磨
- 非 ux-contract 输入（自由文本 / spec / plan）→ 不执行：提示用户先跑上游 command

## 参数

| 参数 | 必需 | 说明 |
|---|---|---|
| contract-path | ✓ | ux-contract 路径（来自 `/custom:create-ux-contract`）|
| max-parallel | ✗ | test 阶段并行 test session 的并发上限，默认 5；本轮独立 test step 多时按此上限拆分并行（见 §2.1 并行化决策）|

## 输入契约

| 形态 | 处理 |
|---|---|
| ux-contract 路径（含 L1〔产品全貌 + 访问入口 + 认证〕+ L2 verify 段 + domain 验收段〔适用时〕） | 进入主流程 |
| 路径不存在 / 文件缺少 L2 verify 段 | 拒绝执行；提示先跑 `/custom:create-ux-contract` |

## 引用文件

| 引用 | 何时读 | 读什么 |
|---|---|---|
| `~/.claude/references/long-task-protocol.md` | 生成 plan.md 时 | §8 banner 格式（plan 有此 banner 时整个协议自动 BINDING） |
| `~/.claude/references/plan-execution-principles.md` | 任何 Codex session stop 时、supervisor 考虑停止时、构造 fix/test prompt 时、裁决 step pass 时 | Stop Gate 段；§3 sample-pass + §4 判据与产物诚实性；§5 交接信息 |
| `~/.claude/references/ux-test-patterns.md`（+ `./docs/contracts/ux-test-patterns.md` 若存在） | 构造 test prompt 时 | 测试方法论 + 执行 patterns |
| `~/.claude/references/domain-registry.md` 指明的 domain 测试模式文件（仅 ux-contract 声明对应产品类型时） | 构造 test prompt 时 | 对应 domain 的失败形状 |
| `~/.claude/references/docs-organization-protocol.md` | 延期 ux-contract 矛盾或进入 §3 文档同步时 | 「issues/ — 问题跟踪」写入路径 + 「同步机制」触发语义 |

---

## 主流程（lens，不是步骤清单）

**控制骨架**（gate 链 + 修复循环；节点详情见对应小节）：

```
Plan 生成〔§1〕
  └[Plan 确认门]→ ⟳{ Test 阶段〔§2.1〕
                    →[裁决：真实性核对 · 并发归因 · 收敛判定〔§2.2〕]
                    → 有可即时修复项 ─是→ Fix〔§2.3〕→[裁决：re-test 范围〔§2.4〕]→ 回 Test 阶段
                                     └否→ 出循环 }
  → 文档同步〔§3〕→ 有 committable fix / doc diff ─是→ Commit〔§3〕→ Handoff〔§4〕
                                                     └否→ Handoff〔§4〕
```

| 骨架构件 | 成员 |
|---|---|
| gate | Plan 确认门 · pass 真实性核对 · 收敛判定 · 文档审查收敛 · Commit 判据 · Handoff 前置 |
| method | Test 阶段 · Fix session |
| output | plan/state/journal · issues/* · commit · handoff |
| 贯穿出口 | 任何 session / supervisor 停止前过 Stop Gate（`plan-execution-principles.md` §0）· 欠明确 / 高代价分支走 AskUserQuestion · 合法非完成停止按 `plan-execution-principles.md` §5 交接信息 交接 |

### 1. Plan 生成（ux-contract → test plan）

读 ux-contract，生成 test plan：

**L2 翻译**：ux-contract 的每条 L2 verify → agent-executable test step。翻译要求：
- 保留维度完整性——每条 L2 verify 必须有对应的 test step，不丢维度
- 翻译成 agent 可执行的形式：操作序列 + 观测点 + 判据；判据形态随 verify 而定——客观可判的用二元 pass/fail，主观 / 视觉 / 人工对照类 verify 用 judgment + evidence（意图 bar + 证据），不强凑二元阈值
- 产品访问入口、认证信息从 ux-contract 摘出，写进 test plan 顶部

**L3 补充**：对每条 L2 test step，考虑追加 agent-level 内部验证来增强 L2 判定的可信度。思考 lens：用户看不到但 agent 可以获取的信息中，哪些能增强或质疑 L2 判定？常见的 L3 信息来源包括但不限于：

| 信息来源 | 增强什么判定 |
|---|---|
| 网络请求/响应 | 功能是否真实触发后端 |
| 应用日志 | 错误/异常检测 |
| 数据库/API 状态 | 数据一致性 |
| 性能指标 | 响应延迟 |

L3 是可选增强，不替代 L2 判定——L2 pass 但 L3 发现异常 → 记为 issue 但不阻断 L2 判定。

**domain 验收段翻译（仅 ux-contract 含 domain 验收段时）**：该段每项不是二元 pass/fail，而是 judgment + evidence——翻译成的 test step 要：(a) 在机制验收已要求的同一次端到端 playthrough 上顺带采该项写明的证据类型；(b) 额外跑一个该 domain 最易失败的切片（如游戏开局 churn 期）；(c) 对照该项写的意图 bar 判断（judge 模型 / 人工），附证据。失败形状参考 `~/.claude/references/domain-registry.md` 指明的 domain 测试模式文件。

**落点**：`plans/<YYYYMMDD>-<HHmm>-<contract-slug>-ux-test/`（contract-slug 由 ux-contract 文件名去后缀推导，HHmm 为执行开始时的 24 小时制时分）

| 文件 | 内容 |
|---|---|
| `plan.md` | 顶部 long-task banner（标记进入 long-task mode）+ ux-contract 引用 + 产品访问信息 + test steps（TS-001, TS-002 …） |
| `state.md` | test steps 转为 `[pending]` 任务 + 空的 Open Issues 段 + 空的 Fix Tasks 段（Fix Tasks 与 test steps 并列，状态同样使用 pending/in_progress/done，每条关联其修复的 issue ID） |
| `journal.md` | 只写 header，不预填 |

plan.md banner 按 `~/.claude/references/long-task-protocol.md` §8 格式。

**Plan 确认门**：supervisor 评估翻译质量。若 L2 翻译存在歧义（多种合理的 pass/fail 判据解读）或 L3 补充选择不确定，AskUserQuestion 指出具体疑问点让用户裁定；无疑问则直接进入测试。

### 2. Test-Fix 循环（supervisor 编排）

每轮次由一个 test 阶段 + 一个 fix session 组成，各用独立 Codex session 避免上下文干扰。test 阶段内部沿用同一「上下文隔离」逻辑：本轮 test step 相互独立时可拆到多个并行 test session（拆分判据与收益见 §2.1 并行化决策）。

#### 2.1 Test 阶段

**端到端原则**：test session 的核心结论必须来自真实部署的产品入口。什么算端到端：

| 产品形态 | 真实入口 |
|---|---|
| Web | 用户指定验收 URL（production / staging / preview）经浏览器访问，真实网络与真实数据 |
| Mobile / 小程序 | 体验版 / 正式版 / 测试版包，经原生入口或调试工具连真实后端 |
| Desktop | 真实安装包或指定 build，连真实本地/远端服务 |
| API-backed | UI 操作真实触发 API / DB / 权限 / 配额 / 异步任务 |

表外形态回到默认姿态判定。mock（替代真实后端/数据/用户身份的手段）只作辅助诊断——解释端到端现象或定位根因，不替代端到端结论。

**最终产物不可替代**——若产品有可与 L2 观测分离的异步/持久化最终产物（生成类的图/视频/GIF、文档类的导出文件、数据类的落库记录等），在 ux-contract 中识别它，把它的本轮真实产出写成至少一条 test step 的 pass 判据；判定规则见 `plan-execution-principles.md` §4「产物不可替代」。纯 UI 行为类 ux-contract（导航、校验提示、布局、状态切换）没有可分离的最终产物，其端到端结论由 L2 翻译出的 test step 直接承载，本轮真实性由 §2.2 真实性核对统一保证。

**工具选择 lens**：根据产品形态选择合适的端到端模拟方式；具体工具用法见对应工具文档。

| 产品形态 | 端到端模拟方式 |
|---|---|
| Web 产品的浏览器交互 | agent-browser |
| 需要原生 UI 操作的桌面 / 移动应用 | computer use |
| 非 GUI 产品 | 产品原生接入（CLI、API client 等） |

**并行化决策（supervisor 启动前判断）**：本轮要跑的 test step 按依赖关系分组、每组起一个独立 test session 并行执行——让每条路径拿满上下文（呼应 §2 的上下文隔离）、同时缩短端到端等待。唯一硬约束是依赖独立：有前后依赖的 step（持久化后复访、叠加在一次 happy-path 产出上等）落到同一片或自带前置，拿不准是否有依赖 → 落同片；其余按功能簇切分以分配注意力。

**共享态非串行理由**：并行 session 跑在同一真实部署产品上会并发命中限速 / 全局配额 / 单例门控等共享态——这是要在并发下评估的产品维度（生产本就承受远超此的并发量），不是要回避的污染；命中后由 §2.2 归因，不靠预先串行掩盖。仅当并行 session 会通过共享可变数据污染彼此观测前提（如同一账号数据被一方改写）才需处理，且优先隔离（独立测试账号 / 数据），隔离不可行才同片。

并发上限取 `max-parallel`（默认 5——避免压垮被测部署、超出 supervisor 可追踪与裁决的范围）；可并行的 step 不足、或拆分无收益时退回单 test session。拆组后，supervisor 为每个并行 session 分配它负责的那组 test step + 一个全轮唯一的 `<group>` 标识。下面的启动方式对每个 test session 各执行一次。

启动 Codex（后台 + 独立 session）：

```
Bash({
  command: "CODEX_TIMEOUT=21600000 ~/.claude/bin/codeagent-wrapper --progress --backend codex - <WORKDIR> <<'EOF'\n<test-prompt>\nEOF",
  run_in_background: true,
  timeout: 21900000,
})
```

`<WORKDIR>` 必须来自 Bash `pwd`。从 wrapper 输出中捕获 Codex session id（handoff 需要）；并从后台 Bash 任务结果捕获 `.output` 路径记下（即下文 `<output-file>`）——这是 harness 对后台任务 stdout+stderr 的完整捕获，不是 wrapper banner 里 `Log:` 指向的 `codeagent-wrapper-<PID>.log`。并行多个 test session 时，对每个 session 分别捕获其 session id 与 `.output`。

**Test prompt 构造**——信息在文件中已有则给路径让 Codex 自己读，只在 prompt 中传递文件中没有的指令：

引用文件（Codex 读取详情）：
- `plan.md` 路径（含 test steps、产品访问信息、pass/fail 判据）
- ux-contract 路径（issue 中引用 L2 条目的来源）
- 本 command 文件 §2.1 的端到端原则 / 最终产物真实性 / 工具选择三段（并行化决策是 supervisor 职责，test session 不需要）+ §Issue 格式
- `~/.claude/references/ux-test-patterns.md`
- `~/.claude/references/domain-registry.md` 指明的 domain 测试模式文件（仅 ux-contract 声明对应产品类型时）
- `~/.claude/references/plan-execution-principles.md`（Stop Gate + §4 判据与产物诚实性）
- `journal.md` 路径（Codex 可追加执行过程中的观察和经验，不修改已有内容）

本轮次指令（不在上述文件中的信息）：
- 本 session 只观测与报告 issue，不改动产品代码 / 不修复——修复由独立 fix session 承担
- 本 session 执行 supervisor 在本 prompt 中列出的 test step ID——即「本轮要跑的 step」（首轮：全量；后续轮次：§2.4 选定的 re-test 子集）中分配给本 session 的分片（§2.1 并行拆分；未拆分即本轮全部）
- 对涉及最终产物的 pass 判据，报告中附本轮真实产出证据（生成时间戳 / 新建产物路径 / 实时触发记录），不得用既有文件或上一轮产物充当 pass 证据
- 产出路径：`<plans 子目录实际路径>/issues/round-<N>-test-<group>.md`（`<group>` 用 supervisor 注入的本 session 唯一标识，避免并行产出互相覆盖；单 test session 时后缀可省）；无 issue 时也要写 "all pass" 报告

等待轮询：每次轮询用 `~/.claude/bin/poll-progress.sh <output-file>` 增量读新增进度行，据此判断 Codex 在推进 / 完成 / blocked / stuck；10 分钟未完成是常态，继续轮询不 kill。每次轮询之间发简短中文状态。并行多个 test session 时对每个的 `<output-file>` 各自轮询，本轮次所有 test session 都完成后才进 §2.2 裁决（任一过早 stop 按 §2.2 表 resume 那个 session）。裁决取证、或 poll-progress.sh 回显含「跳过 N 行」（单次轮询新增超回显上限触发截断）时，必须先 `Read(<output-file>)` 全量再裁决——被跳过的中段在增量模式下不再出现，blocked / Stop Gate / verify 证据可能正落其中；poll-progress.sh 只读不改源文件，完整记录始终在盘上。resume 同 session 会产生新后台任务 = 新 `.output` 文件，对新文件重新记录路径并从 0 起轮询。

#### 2.2 Supervisor 裁决（test → fix 之间）

读本轮所有 test session 的产出（并行时有多个 `round-<N>-test-*.md`，先聚合 issue 再逐条裁决）。以下是常见情况的处理 lens（不是完整列表，supervisor 应基于实际情况判断）：

| 情况 | 处理 |
|---|---|
| Codex 过早 stop（未执行完 test steps 或未满足 Stop Gate） | resume 同一 session 继续，指出哪些 test steps 未执行 |
| 正常完成，有 issue 报告 | 逐条裁决（见下方核心原则） |
| 正常完成，全部 pass | 先做 pass 真实性核对（见下），通过才更新 state.md，进入 §3 文档同步与 Commit |

**裁决每条 pass 前必做真实性核对**（按 `plan-execution-principles.md` §3 sample-pass + §4 判据与产物诚实性）：证据是否来自本轮真实链路（非历史 / 缓存 / 上次 session 产物）、是否覆盖 plan pass 判据的全部维度、有没有被降级成中段态或弱验证（形态见 §4「判据不可降级」；含用强制置态 / 注入到达某个 gated 结果而非真实使用路径——这只证明能渲染、不算 pass）？任一存疑 → 不写 pass，要求 Codex 补跑本轮真实链路；判据本身需要松动 → 先 AskUserQuestion，不静默改判据。

**并发引发观测的归因**（并行多 session 时）：并发可能让单 session 不出现的现象浮现（共享态门控触发、资源竞争、相互影响的状态等）。按"该 step 是否预期此结果 + 系统响应是否符合设计"归因，不默认归为失败、也不默认归为"并发噪声"：产品对并发的设计响应正确触发（如限速 / 配额按预期挡下）→ 评其 UX 是否可接受、归到对应 step，不当 happy-path 失败误报；并发处理真的坏了（该触发没触发 / 触发错 / 文案错）→ happy-path bug；暴露的容量或限制边界 → 记一条 issue（信息类）。

**judgment + evidence 项的裁决**（domain 验收项、以及 §1 归为 judgment + evidence 的主观 / 视觉 / 人工对照类 L2；非二元 pass/fail）：核对的不是"pass/fail 对不对"，而是证据是否充分（该项写明的证据类型采全；domain 项还需覆盖其最易失败切片）+ 判断是否对照了 ux-contract 写的意图 bar（而非 Codex 临时换标准）。证据不足 → 要求补采；判断与 bar 冲突、或 bar 本身需调整 → AskUserQuestion，不静默改 bar。

逐条 issue 裁决的核心原则：
- 发现 ux-contract 本身有误（L2 描述与产品预期矛盾）→ AskUserQuestion 报告具体矛盾 + 建议修复 ux-contract 还是修复产品，不静默调整 test plan。选修产品 → 建 Fix Task 回 §2.3；选修 contract → 起独立 session 只 apply 已批准修正，跑 `/custom:review-ux-contract` 收敛，再按 create-commit 仅提交该获准 contract delta，重生成受影响 test steps 并 re-test；选延期 → 按 `docs-organization-protocol.md`「issues/ — 问题跟踪」写入 `docs/issues/ux-contract-issues.md` 并在 handoff 披露
- 证据或严重度判定模糊 → AskUserQuestion 附上具体 issue + 证据 + 两种判定的后果，让用户裁定

更新 state.md：test steps 状态更新（pass / fail / blocked）；保留的 issue 加入 Open Issues；为可即时修复的 Critical/High/Medium issue 创建 Fix Tasks（需显式设计 / 产品决策类不建 Fix Task）。

更新 journal.md：本轮次测试发现摘要 + 裁决理由。

**gap 驱动到处置**，不止于"列出"：每条保留的 issue（含 L2↔build 背离、domain 验收暴露的 gap、expected-FAIL 的 L2 锚定项）确认后先分类——confirming 一个 gap "仍成立"不是终点，是分类的起点：
- **可即时修复**（机制清晰、范围局限、fix session 调研现有代码即可实现、无需外部设计 / 产品决策）→ 建 Fix Task、进 §2.3 fix session 当轮修掉。不要因为它能贴上"超出 ux-contract / build pending"标签就 defer——把 fix session 能修的包装成待裁决＝转嫁（违反 `plan-execution-principles.md` §0 Stop Gate）。
- **需显式设计 / 产品决策**（多种合理形态、涉及叙事 / balance / 产品决策，fix session 无法单方拍）→ 记入 state.md Open Issues + `docs/issues/<domain>.md`；起一个 Codex session 调研现有代码 / 架构、提出候选方案 + 推荐选择（不是不做技术调研就抛选择题），把"修不修 / 选哪种形态"留到 §4 handoff 用 AskUserQuestion 显式裁定。
- **拿不准归属**：某 gap 属哪类拿不准（fix session 能否单方定形态）→ 默认归「需显式设计 / 产品决策」走 §4 gate；与上一条对称——欠路由（把产品决策塞给 fix session 自拍）和过度 defer（把能修的挂起）都是错。

**收敛判定**：有可即时修复的 Critical/High/Medium → 进 §2.3 fix session 当轮修；其余（仅剩 Low、或"需显式设计 / 产品决策"类）→ 进 §3 文档同步与 Commit，未决项按 §4 经 AskUserQuestion 交付裁定。

#### 2.3 Fix Session

启动新 Codex session（独立于 test session），启动方式同 §2.1。

**Fix prompt 构造**——同样遵循"文件中有则给路径，prompt 只传文件中没有的指令"：

引用文件（Codex 读取详情）：
- 本轮次 Critical/High/Medium issue 文件路径（Codex 自己读 issue 详情和证据）
- ux-contract 路径（预期来源，帮助理解修复目标）
- `~/.claude/references/plan-execution-principles.md`（Stop Gate）
- `~/.claude/skills/tdd-workflow/SKILL.md` 的 `Run Tests (They Should Fail)` 与 `Run Tests Again`（回归测试的 RED→GREEN 约束；coverage 只在项目已有可用基础设施时记录并防回退）
- `journal.md` 路径（Codex 可追加修复过程中的观察和经验，不修改已有内容）

指令（不在上述文件中的约束）：
- 修复范围：只修 issue 描述的问题，不做额外重构
- 回归保护：先增加能复现 issue 的最小自动化检查并看到它失败，再修复至通过；现有基础设施无法表达时，记录原因与等价的可执行检查
- 内部 verify：跑新回归检查以及项目已有的测试/lint/类型检查
- **不修改 ux-contract / plan.md / state.md**——这些由 supervisor 维护
- 若某 issue 的修复需要产品 / 设计 / 叙事形态决策（多种合理形态、非纯机制 bug）→ 不要自行选定实现，stop 并在产出中标注该 issue 需回 supervisor 走产品决策（Stop Gate 的「最大化独立完成」不覆盖形态决策，避免误吞）

#### 2.4 Supervisor 裁决（fix → re-test 之间）

读 fix session 产出。以下是常见情况的处理 lens（不是完整列表，supervisor 应基于实际情况判断）：

| 情况 | 处理 |
|---|---|
| Codex 过早 stop（未完成全部修复或未满足 Stop Gate） | resume 同一 session 继续，指出哪些 fix tasks 未完成 |
| 修复完成 + 新回归检查与 internal verify 证据完整 | 更新 state.md Fix Tasks 状态 → 回 §2.1 发起下一轮次 test |
| 同一 issue 连续 2 轮次修复未推进 | supervisor 独立排查（`git diff` / 复现命令 / 日志）后，必须 AskUserQuestion 报告排查发现并请求指示（用户可选：提供修复线索、降级 severity、标记 won't-fix） |

**Re-test 范围决策**（supervisor 判断）：修复范围小且局部 → 只 re-test 受影响的 test steps + 回归抽检；修复范围大或涉及共享模块 → 全量 re-test。不确定时偏向全量。

### 3. 文档同步与 Commit（test-fix 收敛时）

**进入判据**：state.md 所有 Critical/High/Medium Fix Tasks 为 done + 所有 test steps 最近一轮次 pass（剩余未 pass 的仅对应 Low、或已归类为"需显式设计 / 产品决策"的 deferred gap——后者经 §4 AskUserQuestion 裁定，不建 Fix Task、不阻断收尾）。达到任务边界就先跑文档 recipe；不以 fix diff 作为 recipe 的前置。

**文档同步（commit 前先做）**：先从被测产品工作树确定目标 repo 的绝对根路径 `target_repo`，把 CWD 切到该路径；再读 `~/.claude/commands/custom/sync-docs.md`「被 supervisor 编排复用」契约，对本节 Scope 执行完整 recipe，不直接调用 `/custom:sync-docs`。传入 ux-contract、test plan / state / journal、各轮 issue 与 session 证据、fix diff；审查范围只覆盖这些 task 产物 / diff 波及的文档及其索引 / cross-ref。

Caller delta：ux-contract 仍由 §2.2 的产品裁决与「ux-contract 不可变」不变量管辖，recipe 不可把文档 finding 当场写回 ux-contract。文档审查新发现 contract finding 时回 §2.2 走上述分支；修产品或 contract 的路径完成 re-test 后再回本节审查循环，延期路径写 issue 后回循环。目标 repo 的文档编辑与 commit ownership 仍属本节；本节显式承接 recipe 返回的 supporting artifact gate，在 Commit 判据前执行 `review-gate`，gate 修复若改变文档或其陈述事实则重新进入 recipe。原则缺口的 owning repo 独立 commit 由 recipe 支路完成，不并入目标 repo 的本节 commit；完成后回到文档审查循环。

Recipe status 为 `awaiting-caller-gate` 时先执行返回的 supporting artifact gate；gate passed 后按恢复点续跑 recipe，gate blocked 时保留两层状态与恢复点并按 Stop Gate 交接。只有 recipe `converged` 才进入 Commit 判据；recipe `blocked` 同样不宣称 test-fix 收敛，解除后重进本节。

**Commit 判据**：recipe 收敛后，working tree 有本节 Scope 内的 committable fix / 文档 diff 才 commit。无 fix session（首轮即全 pass）且 recipe 无文档编辑，或 Scope 内 diff 为空时，只跳过目标 repo commit，不跳过上述文档审查。

**Scope**：
- 进 commit：fix session 在本次 test-fix 循环中修改的代码 + doc 同步的产出 + 本节授权且已过 gate 的 supporting artifact
- 不进 commit：plan.md / state.md / journal.md（audit trail）；ux-contract（不可变）；repo 中与本次 fix 无关的 in-flight 改动；runtime / build artifact

**执行**：调用 `~/.claude/skills/create-commit/SKILL.md`，将上述 Scope 约束作为文件 staging 的判断依据。message 沿用 skill 定义的格式（不自行手写）。

### 4. Handoff

**前置条件**：state.md 中所有 Critical/High/Medium Fix Tasks 为 done + 所有 test steps 最近一轮次 pass（剩余未 pass 的仅对应 Low、或 deferred 的"需显式设计 / 产品决策"gap）。

中文回复，内容由实际执行轨迹决定：

**必含**

- ux-contract 路径 + test plan 路径
- 测试轮次数 + 各轮次 Codex session id
- state.md 最终状态简述（含 test steps 覆盖情况）
- §3 的完整 sync-docs manifest：recipe / caller gate status transition 轨迹与当前状态（含 `awaiting-caller-gate + gate blocked` 的合法 stop）、审查范围、实际起草 / 编辑的文档 / supporting artifact / 原则文件、coverage 状态与轮数、原始范围终审结果、最终 findings / decisions / edits、未解决的取舍 / 缺失依赖 / 写入阻塞及恢复点、caller gate 结果（无对应项也要明示记录）+ 目标 repo commit hash（跳过 commit 则注明原因）
- 原则缺口支路状态：not-triggered / committed / rejected / deferred；非 not-triggered 时附原因，committed 时再附原则文件 + owning repo + 独立 commit hash + scope

**未决 gap（走 AskUserQuestion）**

§2.2 归类为"需显式设计 / 产品决策"的未决 gap，handoff 时用 AskUserQuestion 让用户当场裁定，不写进 prose——选项至少含「现在修（附 Codex 调研后的候选方案 + 推荐选择）/ 推迟 / won't-fix」。

**适用时含**

- 已修复 issue 摘要 + 对应修复的 commit
- 用户批准的 ux-contract 修正 + 独立 contract commit hash
- 未修复的 Low / 纯信息 issue 清单 + 定位信息（无"修不修"决策的才留 prose；有决策的走上面 AskUserQuestion）
- 发现的 ux-contract 矛盾（supervisor 在 §2.2 标记的）
- journal.md 中值得用户关注的 lesson / decision

若最终是合法 stop 而非完成，按 `plan-execution-principles.md` §5「交接信息」交接。

---

## Issue 格式

每条 issue 需包含以下信息，让 coding agent 能定位和修复问题：

| 问题 | 对应信息 |
|---|---|
| 什么坏了？ | 实际观察到的现象 |
| 应该是什么？ | 期望依据（据 issue 来源）：L2 verify 条目 / domain 验收项的意图 bar / L3 判定依据——引用具体条目编号或原文 |
| 在哪里？ | 产品位置或后端定位（URL / 屏幕 / 元素 / 接口 / 数据位置） |
| 怎么观察到？ | 触发条件或观察方法（操作路径 / 环境条件 / 检测命令） |
| 有什么证据？ | 端到端证据（截图、DOM 状态、网络响应、日志等） |
| 严重度 | Critical / High / Medium / Low |

---

## 关键不变量

下面这些 SOTA Claude 默认不会做、且单一上游 section 抓不住（跨节才成立），失守会让本 command 退化：

- **ux-contract 不可变（supervisor 不自行修改）**：发现矛盾时 AskUserQuestion 让用户决策；仅 §2.2 获用户批准的 contract 修正可由独立 session apply，并须过专项审查与独立 commit。静默改 ux-contract 会让 review 的投资失效。
- **背景任务 + 增量轮询**：不阻塞 supervisor session；主轮询姿势见 §2.1（增量读新增、必要时全量兜底）；不因等久就 kill；不把"在等待"当 stop 理由。
- **核对 Codex 产出 ≥ verify gate**：不因 Codex 报告 "Done" 就进下一步——逐项检查实际执行结果和证据；同样不因 Codex 声称 "blocked / 外部不可解" 就转交用户——按 Stop Gate 独立验证 Codex 可控缓解已穷尽。
- **判据与产物诚实性（判据不可降级 / 产物不可替代）**：见 `plan-execution-principles.md` §4——supervisor 不可单方面放松 plan 写下的 pass 判据，也不可用历史/缓存/中段态冒充本轮真实产出；需降级先按 §2.2 AskUserQuestion；绕过会让整个 ux-contract 失去验收基准。
- **gap 驱动到处置，不止于列出**：能修的 gap 当轮修，只有需显式设计 / 产品决策的才 defer（流程见 §2.2 / §4）；把 fix session 能修的包装成"产品决策"回避修复＝转嫁，违反 `plan-execution-principles.md` §0 Stop Gate。
