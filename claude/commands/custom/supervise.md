---
name: supervise
description: 用 codeagent-wrapper 启动指定 backend（codex / gemini / claude）跑用户口头描述的任务。Claude 作为 supervisor：spawn 前用 AskUserQuestion 跟用户锁定 success criteria + backend；过程中代答 wrapped agent 的简单决策、复杂决策升级给用户；agent 早停时根据 success criteria 续 resume 同 session；任务结束时把观察到的 agent 行为问题 / 工具缺口写到项目层 `docs/issues/observed-issues.md`。触发：显式 `/custom:supervise <task description>`。
argument-hint: "[--backend codex|gemini|claude] [--autopilot] <task description>"
disable-model-invocation: true
origin: 2026-05-21
---

# supervise

入口 command：把"启 wrapped agent → 在它和用户之间当中介 → agent 早停时续命 → 任务结束沉淀 agent 行为问题"压成一条 supervisor 命令——Claude 跟 wrapped agent 在用户锁定 success criteria 上收敛，才把结果交给用户。

## 何时使用
- 显式 `/custom:supervise <task description>`
- 用户想让另一个 agent 完成开放式任务（无 plan.md），并希望 Claude 监督质量 / 接管 routine 决策 / 沉淀过程问题
- 不要执行：
  - 已有 plan.md → 用 `/custom:execute-plan`（plan 自带 verify gate，supervise 的 success criteria 锁定是冗余）
  - 纯研究 / 查询 / 单文件 trivial 改动 → 直接做，不要为简单任务付 spawn + supervisor 的 overhead

---

## 用户期望的收益（按优先级）

源对话拍过的 ranking，下游 supervisor 取舍按这个顺序：

1. 监督 wrapped agent 完成任务，期间帮用户接管不改方向的决策、复杂决策升级用户
2. 真实捕获 wrapped agent 在过程中的行为问题 / 工具缺口，沉淀到 `docs/issues/observed-issues.md`，供未来 agent 改进
3. Agent 早停时由 supervisor 续 resume 同 session，不让用户手动接管上下文

## 输入契约

| 形态 | 处理 |
|---|---|
| 自由文本 task description | 进入主流程 |
| 显式 `--backend <name>`（codex / gemini / claude） | 用此 backend；跳过下方 backend 推荐 facet |
| 未传 `--backend` | Spawn 前对齐 facet 里 supervisor 按 task 类型推荐 + `AskUserQuestion` 让用户选 |
| `--autopilot` | Dialogue facet 切换为 autopilot 模式（见 §4）：agent 决策点一律由 supervisor 采纳 agent 推荐选项，不升级用户 |
| 未传 `--autopilot`（默认） | Dialogue facet 使用交互模式：supervisor 判断 simple / complex，complex 升级用户 |
| 空 task 或仅参数 | 拒绝执行；提示用户给出 task description |

---

## 主流程（lens，不是步骤清单）

### 1. Spawn 前对齐（主 session 与用户）

下面两个 facet **不是顺序步骤**——可并行 / 迭代 / 回头补。两个都要落地后再进 §2，因为 spawn-prompt 同时依赖它们。

#### Backend 选择

**对齐**：用哪个 codeagent-wrapper backend 跑这个任务。

**lens**：task 性质和 backend 强项的匹配——backend 之间在前端 / 后端 / 数据 / 架构 / 内容创作各有优劣，选错的成本是整轮 spawn 浪费。

**常见询问方向**（不限于此）：
- 用户显式传了 `--backend` → 跳过本 facet
- 任务有明显领域归属 → supervisor 先给推荐 + 理由（前端 → gemini；后端 / 数据分析 → codex；架构规划 / 内容创作 → claude），再用 `AskUserQuestion` 让用户确认或推翻
- 任务跨领域 / 难分类 → `AskUserQuestion` 列三个 backend 让用户选，supervisor 不强推荐

#### Success criteria 锁定

**对齐**：什么算"wrapped agent 完成任务"。

**lens**：没有 plan.md 时，future supervisor 在 §3 裁决 agent 输出时凭什么判断"完成 vs 未完成"——criteria 必须是可观察的 verify 信号，不是模糊的"做完了就行"。

**常见询问方向**（不限于此）：
- 可观察的 verify 信号（测试通过 / 文件存在 / 命令成功 / 输出符合某 shape）
- 输出物的形态 + 落点（文件路径 / commit / PR / 屏幕截图）
- "no regression" 是否在 scope（哪些既有行为不能坏）
- 失败时的 fallback 期待（agent 必须给出 stop report 还是直接放弃）

**关键**：criteria 必须来自用户拍板，不要 supervisor 替用户编。用户不知道答案时（"你帮我想"），用 `AskUserQuestion` 列 2-3 个 candidate criteria 让用户选 / 改 / 自由文本补——而不是 silent default。

---

### 2. 启动 wrapped agent（后台 + 同 session 复用）

调用形如：

```
Bash({
  command: "~/.claude/bin/codeagent-wrapper --progress --backend <BACKEND> - <WORKDIR> <<'EOF'\n<spawn-prompt>\nEOF",
  run_in_background: true,
  timeout: 7200000,
})
```

- `<WORKDIR>` 来自 Bash `pwd`——**禁止从 `$HOME` / 环境变量推断**。
- `run_in_background: true` 是硬约束（不可阻塞 Claude 主 session）。
- spawn-prompt 只放 future LLM 不会自动 default 的非显然信息：
  - 角色：<根据任务进行角色设定>
  - 用户原始 task 描述（保留原话，不要 paraphrase）
  - 用户锁定的 success criteria（§1 facet 产出）
  - Blocked 时：列已尝试 / 卡在哪个具体动作 / 需要用户给什么决策、做什么事情——不要把部分完成包装为已完成
- 从 wrapper 输出捕获 `session id`——后续 resume 完全依赖它。捕不到时视为 wrapper / 适配层问题——排查 stderr / 退出码 / 输出截断，不要直接交给用户。

捕获 session id 后立刻在 `<WORKDIR>/logs/supervise/<task-slug>_<YYYYMMDD-HHmm>.md` 起一个 real-time log（详见 §3）。`<task-slug>` 从用户 task description 取前 3-5 个关键词转 kebab-case（e.g. `fix-auth-token-refresh`）；`<YYYYMMDD-HHmm>` 是 spawn 时刻。

### 3. 等待 + 实时观察日志

```
TaskOutput({ task_id, block: true, timeout: 600000 })
```

10 分钟未完成是常态，继续轮询，不 kill。仅在三种状态进入第 4 步：

- Agent 给出明确完成 summary
- Agent 声称 blocked 并给出 stop report
- Agent 进程异常退出 / 输出截断 / 无 session id

每轮等待之间发一条简短中文状态给用户（"Wrapped agent 仍在执行，已等待 X 分钟"），不要静默。

**实时观察日志**——保护 supervisor 自己不被 memory compaction 抹掉中间观察：

- 落点：`<WORKDIR>/logs/supervise/<task-slug>_<YYYYMMDD-HHmm>.md`（目录不存在则建）
- 写入时机：每收到 agent 输出 / 每次和 agent 对话 / 每次 resume / 每次用户决策
- 写入内容：`<timestamp> <one-line observation>`——除了 agent 这一轮的进度，**必含根因怀疑**（同一类卡点是不是反复出现 / 这是 skill 缺口还是 task 描述歧义 / 关联到之前哪条 log），不只是进度流水。§5 提炼 issue 完全依赖这层观察
- log 是 supervisor 自留的过程证据，**不直接是 issue**——issue 在 §5 任务结束时从 log 提炼

### 4. 判定 wrapped agent 输出并裁决

| 观察到的现象 | 下一步 |
|---|---|
| Agent 给完成 summary + verify 证据 | 核对 lens 是 **agent 给的 verify 证据 ≥ 用户锁定的 success criteria**（每个 criterion 都有可观察证据）；满足 → 进 §5；缺项 → resume 让 agent 补 |
| Agent 停止但 success criteria 任一项无证据 | 同 session resume；resume-prompt 指出哪几项 criterion 无证据 + supervisor 在 log 里看到的相关线索；回到 §3 |
| Agent 抛出问题需要用户决策 | 见下方 **Dialogue facet** |
| Agent 异常 / 无 session id / 输出截断 | 按 wrapper / 适配层问题处理：排查 stderr / 退出码 + 看 `git status` 判断是否已部分完成。**反转成本高（重启丢全部上下文 / resume 损坏 session 后续不可信），supervisor 不要 silent decide**——把诊断结果 + 候选 [resume 同 session / 重启新 session / 放弃交还用户] 通过 `AskUserQuestion` 让用户拍板 |

resume 调用形如（同 spawn 的 flag 组 + 后台 + timeout，仅前缀改为 `resume <SESSION_ID>`）：

```
Bash({
  command: "~/.claude/bin/codeagent-wrapper --progress --backend <BACKEND> resume <SESSION_ID> - <WORKDIR> <<'EOF'\n<resume-prompt>\nEOF",
  run_in_background: true,
  timeout: 7200000,
})
```

resume-prompt 只列：哪几项 success criterion 无证据 + 各自的 supervisor 证据 / log 摘要 + （若用户后续追加过决策）补充上下文。不复述 success criteria 全文——同 session 已有。

#### Dialogue facet（agent 提问 / agent 需要用户决策）

两种模式由 `--autopilot` 参数控制。

##### 交互模式（默认，未传 `--autopilot`）

**对齐**：wrapped agent 抛出一个需要用户决策的问题时，supervisor 是直接回 agent 还是升级到用户。

**lens**：query 是否会实质改变 task 方向 / 触及 success criteria / 有多个合理但下游差异大的选择——会 → 升级用户，不会 → supervisor 直接回。**模糊时 default 是升级用户**——回错的成本是 agent 走偏一段后才发现。

**常见询问方向**（不限于此）：
- 纯 stylistic / naming / 局部实现选择，不改 verify 结果 → supervisor 直接回
- 触及用户锁定的 success criteria 边界 → 升级用户
- 多个选择都合理但下游 effort / 风险 / scope 差异大 → 升级用户
- Agent 询问用户是否在 success criteria 之外加新需求 → 升级用户
- Agent 询问的事 supervisor 在源对话 / log 里已经有明确答案 → 直接回，附引用

**升级到用户用 `AskUserQuestion`**：把 agent 的原始问题 + supervisor 看到的上下文 + 候选选项一起呈现，不要让用户重新读 agent 输出。

##### Autopilot 模式（传了 `--autopilot`）

**目标**：执行期间零用户打扰。所有 agent 决策点由 supervisor 采纳 agent 自身的推荐选项。

**流程**：agent 停下并抛出决策问题时——
- Agent 已给出推荐选项 + 推荐理由 → supervisor 直接 resume agent 采纳该推荐，继续执行
- Agent 只抛了问题没给推荐 → supervisor resume agent，要求 agent 给出可选方案列表 + 推荐选项 + 推荐理由，agent 回复后 supervisor 采纳推荐继续执行
- 每个决策点 supervisor 在 real-time log 记录：agent 问了什么 / 给了哪些选项 / 采纳了哪个推荐 / 理由摘要

**不升级用户**，即使决策看起来重大。Autopilot 模式的契约是用户接受 agent 推荐的决策质量，用户通过 §6 handoff 里的决策点列表做事后审查。

**例外**：§4 表格中 Agent 异常 / 无 session id / 输出截断行不受 autopilot 控制——该场景始终升级用户，因为反转成本（重启丢上下文 / resume 损坏 session）无法由 agent 推荐吸收。

### 5. 任务结束：observed-issues.md 落地

**判据**：§4 走到「Agent 完成 + 证据满足 criteria」或「合法 stop（agent 给了完整 stop report + supervisor 同意进无用户阻断）」分支。Agent 异常退出 / 没产出任何可交付物 → 跳过本节，由 §6 handoff 让用户决定。

**对齐**：把 §3 real-time log 里观察到的 wrapped agent 行为问题 / 工具缺口沉淀到 `<WORKDIR>/docs/issues/observed-issues.md`，供未来 agent 改进。

**Scope 严格限定**（仅以下入 issue）：
- Wrapped agent 反复犯同一类错误 / 走弯路 / 漏掉明显手段
- Wrapped agent 缺某个 skill / 工具 / config 才能高效完成（"如果有 X 这件事会更顺"）
- Wrapped agent 不遵守已存在的 skill / convention

**Scope 排除**（不进 issue）：
- 用户 task 描述本身的歧义 / success criteria 本身的瑕疵
- 环境 / 第三方服务 / git 状态等非 agent 行为问题
- "本可以更好" 的 speculative improvement（任务顺利完成，仅写 actual observed problem）

**落地流程**：

1. 读本次 real-time log（`<WORKDIR>/logs/supervise/<task-slug>_<YYYYMMDD-HHmm>.md`）提炼候选 issue（一条 log 不等于一条 issue——把同一根因的多条 log 合并）
2. 候选 issue 列表为空 → 跳过本节
3. 读 `<WORKDIR>/docs/issues/observed-issues.md`（目录不存在则建目录 + 空文件，再继续）
4. 对每条候选 issue：
   - 现有 file 有相似 entry（相同行为模式 / 相同工具缺口） → 更新该 entry：在 `Occurrences` 列表 append 一条 `<timestamp> + 当前 session id + 当前 backend + 本次发生情形`，**不新增 top-level entry**
   - 无相似 → 新增 top-level entry，schema 见下

Entry schema（JIRA-flavored Markdown）：

```markdown
## [<type>] <title>

- **Created**: 2026-MM-DD HH:MM
- **Type**: bug | improvement | feature
- **Description**: <足够上下文让其他 agent 理解和解决这个问题——做什么任务时 / wrapped agent 是什么 backend / 观察到什么行为 / 期待什么行为 / 可能的 fix 方向>
- **Occurrences**:
  - 2026-MM-DD HH:MM | session `<id>` | backend `<name>` | <本次发生的具体情形>
```

Type 定义：
- `bug`：wrapped agent 行为错了 / 违反已存在的 skill 或 convention
- `improvement`：wrapped agent 行为不错但可以更好（e.g. 走弯路 / 漏 obvious 手段）
- `feature`：缺某个 skill / 工具 / config，加上以后这类问题会消失

### 6. 最终 handoff（用户拿到的唯一交付物）

中文回复，内容由实际执行轨迹决定：

**必含**
- Backend + session id + workdir
- 用户原始 task + 用户锁定的 success criteria
- 最终 outcome：完成 / 合法 stop / 失败
- Verify 证据摘要（每个 success criterion 对应的可观察信号）
- **Working tree 状态摘要**（`git status` / diff 体量）——若 agent 已 commit 则给出 commit hash；若未 commit 则明示"改动在 working tree，用户后续自行 commit"
- Supervisor 中间观察的简短总结（resume 次数 / dialogue 升级次数）
- `observed-issues.md` 落地状态：新增 N 条 / 更新 M 条 / 无 issue
- Real-time log 路径（`<WORKDIR>/logs/supervise/<task-slug>_<YYYYMMDD-HHmm>.md`），供用户需要时回看

**适用时含**
- **交互模式**：Dialogue 升级到用户的决策点列表（每条：agent 问什么 / 用户决策 / 后续效果）
- **Autopilot 模式**：全部自动采纳的决策点列表（每条：agent 问什么 / 给了哪些选项 / 采纳了哪个推荐 / 推荐理由摘要）——这是用户事后审查的唯一入口
- Wrapped agent 异常退出的诊断 + `git status` 摘要 + 用户后续动作建议

若最终是合法 stop 而非完成，按"为什么停（直接证据级别） / 卡在哪个 success criterion / 已独立尝试什么 / 用户具体动作"格式给用户清晰交接信息。

---

## 关键不变量

下面这些 SOTA Claude 默认不会做，失守会让本 command 退化（其他执行时刻的细则在 §1–§6 各自 source-of-truth 里，本节只收录跨节、单一上游 anchor 抓不住的不变量）：

- **wrapper 报错先归因 wrapper / 适配层**：只有观察到第三方原始响应（HTTP 体 / API error code / 状态页）才能写"外部不可用"。
- **背景任务 + TaskOutput 轮询**：必须 `run_in_background: true`；不要因为等久就 kill；不要把"在等待"当 stop 理由扔给用户。
- **语言契约**：与 wrapped agent / 工具交互 English；与用户交互中文。
- **Real-time log 不替代 observed-issues.md**：log 是 supervisor 自留的过程证据（防 memory compaction），观察问题以 entries 形式落地是 §5 的事。两个不同 consumer——log consumer 是 supervisor 自己，issues file consumer 是未来 agent。
- **不接管 task 范围内的代码改动**：Claude 修 wrapper / 适配层允许；替 wrapped agent 写 task 范围内的代码不允许——绕过 supervisor 定位。
