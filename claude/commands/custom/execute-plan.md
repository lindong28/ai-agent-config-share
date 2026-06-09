---
name: execute-plan
description: 用 codeagent-wrapper 启动 Codex 执行 /custom:create-plan 产出的 plan.md，Claude 作为 supervisor 监督到 Stop Gate 满足 + UX 验收过关才交付。触发：显式 `/custom:execute-plan <plan path>`。
argument-hint: "<plan.md path>"
origin: 2026-05-19
---

# execute-plan

入口 command：把"先 `/custom:create-plan` 出 plan，再人工切到 Codex 实现，完成后人工回 Claude 检查 + 跑 UX 验收"压成一条 supervisor 命令——Claude 监督 Codex 一直跑到 Stop Gate 满足 + 可能的 UX 验收过关，才把结果交还用户。

## 何时使用
- 显式 `/custom:execute-plan <plan.md path>`
- 已有 plan.md（或 long-task 模式下 plan + state.md + journal.md 一并落地）且要进入实施阶段
- 非 plan 任务（自由文本）→ 不要执行：提示用户先 `/custom:create-plan <task>` 产出 plan

---

## 用户期望的收益（按优先级）

源对话拍过的 ranking，下游 supervisor 取舍按这个顺序：

1. 用户不用在 Claude 与 Codex 间手动切换上下文
2. 自动识破 Codex 在 Stop Gate 未满足时的早停并 resume
3. Codex 完成后自动跑 §4 UX gate（契约驱动验证 + test-ux 探索），把发现的 issue 交回同一 Codex session 修复，直到全部解决

## 输入契约

| 形态 | 处理 |
|---|---|
| `plan.md` 路径（来自 `/custom:create-plan`） | 进入主流程 |
| `plan.md` + 同目录 `state.md` / `journal.md`（long-task 模式） | 同上；额外要求 Codex 按 long-task-protocol 持续更新两份文件，并由 Claude 在 §5 复核 |
| 自由文本 / 非 plan 路径 / 路径不存在 | 拒绝执行；提示用户先 `/custom:create-plan <task>` |

---

## 主流程（lens，不是步骤清单）

### 1. 启动 Codex（后台 + 同 session 复用）

调用形如：

```
Bash({
  command: "CODEX_TIMEOUT=21600000 ~/.claude/bin/codeagent-wrapper --progress --backend codex - <WORKDIR> <<'EOF'\n<spawn-prompt>\nEOF",
  run_in_background: true,
  timeout: 21900000,
})
```

- `<WORKDIR>` 必须来自 Bash `pwd`，**禁止从 `$HOME` / 环境变量推断**——repo 路径可能含 worktree 后缀。
- `run_in_background: true` 是硬约束（不可阻塞 Claude 主 session）。
- spawn-prompt 只放**未来 LLM 不会自动 default 的非显然信息**：
  - 角色：<根据任务进行角色设定，例如负责代码的实现/审查/测试>
  - 用户原始 task 描述（保留原话，不要 paraphrase）
  - 协议绑定：plan 顶部有 Long-task banner → 严格按 `~/.claude/references/long-task-protocol.md`；任何 stop 判断按 `~/.claude/references/plan-execution-principles.md` 的 Stop Gate
  - 若 plan 含「UX 契约影响」段（非 skip）：代码完成后按该段记录的 apply 指令，把其 L2 条目 + section delta + 已对齐决策 apply 进 `docs/contracts/ux-contract.md`（含目标 §X）并冻结；若发现 ux-contract 需要 plan 未记录的改动则停下并 report，不静默扩展（no-silent-edit）
  - Blocked 时：贴满足 5 项 Stop Gate 的 report
- 从 wrapper banner（stdout 文本流）捕获 Codex 的 `session id`——后续 resume 完全依赖它。当前只能扫描 banner 文本，**捕不到时视为 wrapper / 适配层问题**——排查 stderr / 退出码 / 输出截断，不要直接交给用户。

### 2. 等待与轮询

spawn 后从**后台 Bash 任务结果**捕获 `.output` 路径并记下（即下文的 `<output-file>`）：这是 harness 对后台 bash 任务 stdout+stderr 的完整捕获，**不是** wrapper banner 里 `Log:` 指向的 `codeagent-wrapper-<PID>.log`。每轮轮询调用形如：

```
Bash({ command: "~/.claude/bin/poll-progress.sh <output-file>" })
```

poll-progress.sh 只读新增进度行（默认每轮最多回显 80 行），据此判断 Codex 是在推进 / 完成 / blocked / stuck。

10 分钟未完成是常态，继续增量轮询，不 kill。仅在三种状态进入第 3 步：

- Codex 给出明确完成 summary
- Codex 声称 blocked 并给出（或漏给）Stop Gate report
- Codex 进程异常退出 / 输出截断 / 无 session id

每轮等待之间发一条简短中文状态（"Codex 仍在执行，已等待 X 分钟"），不要静默——把"在等待"当 stop 理由扔给用户是反模式。

需要完整上下文时（§3 裁决 / context 压缩后恢复 / 排查异常），用 `Read(<output-file>)` 读整份 `.output`；poll-progress.sh 只读不改源文件，完整记录始终在盘上。**poll-progress.sh 回显含「跳过 N 行」时（单轮新增 > 80 行触发截断）必须先 `Read(<output-file>)` 全量再裁决**——被跳过的中段在增量模式下不再出现，blocked / Stop Gate report / verify 证据可能正落在中段。resume 会产生**新的后台任务 = 新 `.output` 文件**，对新文件重新记录路径并从 0 开始轮询。

### 3. 判定 Codex 输出并裁决

| 观察到的现象 | 下一步 |
|---|---|
| Codex 声称完成 + 给出 verify 证据 | 进 §4 UX gate。**不要只看"Done"字样**——核对的 lens 是 **Codex 的完成证据 ≥ plan 明文规定的 verify gate**（实施步骤覆盖、每个 independently executable verify 的可观察证据、long-task 模式下 state.md 更新——按 plan 实际声明的来，不限于此列举）。**且质疑判据强度**：verify 若是存在性判据（命中 ≥1 / 有输出）而改动涉及"用户能看到多少数据"，PASS 不等于完整——追问 expected-vs-actual（应见多少 vs 实际多少），存在性会掩盖数量缺失 |
| Codex 停止但 Stop Gate 任一项不满足 | 用同一 session resume Codex（见下方 resume 调用），指出哪几项 Stop Gate fail + 各自的 supervisor 证据；回到 §2 |
| Codex 异常 / 无 session id / 输出截断 | 按 wrapper / 适配层问题处理（不转嫁外部失败）：排查 stderr / 退出码，看 `git status` 判断是否已部分完成，再决定 resume / 重启路径 |

resume 调用形如（spawn 同一套 flag 组 + 后台 + timeout，仅 path prefix 改为 `resume <SESSION_ID>`）：

```
Bash({
  command: "CODEX_TIMEOUT=21600000 ~/.claude/bin/codeagent-wrapper --progress --backend codex resume <SESSION_ID> - <WORKDIR> <<'EOF'\n<resume-prompt>\nEOF",
  run_in_background: true,
  timeout: 21900000,
})
```

resume-prompt 也走 trust-the-model——只列：本次 Stop Gate 哪几项 fail + 各自的 supervisor 证据 + plan 路径 + （若 long-task）当前 state.md / journal.md 摘要。**不复述 Stop Gate 全文**——Codex 重读 reference 文件即可。

### 4. UX gate：ux-contract 同步 + hybrid 测试

> 「UX 契约影响」与「UX 入口」均为 create-plan 在 plan.md 写入的声明（见 create-plan §2「UX 契约影响」facet + L2 user-facing verify 段）；本节按这两个声明分流。

**触发解耦成两条独立条件**：

| 子步 | 触发条件 |
|---|---|
| 4a + 4b（ux-contract 同步 + 契约驱动验证） | plan「UX 契约影响」段非 skip（该段的字段定义见 create-plan §2 facet；无影响 / 产品无 ux-contract 则该段标 skip）|
| 4c（探索式 test-ux） | plan 的 L2 给出 **agent 可作为真实用户访问的产品 instance**（按 `/custom:create-plan` 三层 framing；物理形态无关——部署 URL / staging / 体验版 build / 小程序 instance / desktop 安装包 / agent-accessible 本地端口等，以 plan 实际描述为准），**与 ux-contract 是否变化无关** |

- 两条都不满足（纯内部重构 / 无 UX 入口且无契约影响）→ **§4 整段 skip**，直接进 §5。
- ux-contract 中性但用户可感知的变更（如 UX bugfix）→ 仅 4c 触发，**跑 test-ux、不跑 4a/4b**。

**4a 应用 ux-contract 更新**

本步是 docs-organization-protocol §4.6 主路径的【自主执行阶段】。由 **implementer Codex**（在其实现 session 内，与代码 + §5 doc-sync 一并；该 apply 任务已随 §1 spawn-prompt 下达）把 plan「UX 契约影响」段记录的 **L2 条目 + section delta + 已对齐决策** apply 进 `docs/contracts/ux-contract.md` §X（apply 指令见 create-plan facet 产出 (d)）。这是执行 plan 已批准意图、**非静默改**。

- **no-silent-edit 不变量**：若 Codex 在应用时发现 ux-contract 需要 plan **未记录**的改动（出现了 plan 没覆盖的取舍）→ **停下，supervisor `AskUserQuestion` 让 owner 拍**，**不静默扩展 ux-contract**。

**4b 契约驱动验证（借方法、不嵌命令）**

ux-contract 在 4a 更新并**冻结**后，把本 plan「UX 契约影响」段列出的**变更 L2 条目**翻成 test step、用 **独立的 Codex test session 跑**（区别于 implementer session——测试不污染实现上下文；与 4c 的 test-ux 同一套 §2 后台轮询 + §3 裁决编排）。翻译与 test prompt 构造照 `~/.claude/commands/custom/execute-ux-contract.md` §1（L2 翻译 + Plan 确认门）+ §2.1（Test prompt 构造 + 端到端原则）的 recipe——supervisor 读这几段借其法、不调命令；引用文件给路径让 test session 自读，不复述。

- **L2 翻译歧义时**（一条 L2 有多种合理判据解读）→ **supervisor 先 `AskUserQuestion` 让 owner 裁定，再 spawn test session**（对齐 §1 Plan 确认门）。
- **execute-plan 专属 delta**（借 recipe 时按本 command 语境补/改这几处）：test step 源自本 plan 变更 L2 条目的翻译、scope 限变更条目不全量重测；recipe 里 `<plans 子目录实际路径>` 产出位置改为 plan.md 同目录的 `issues/`（供 §4 严重度裁决的 issue 回链复用）；recipe 内一切自指「本 command 文件 §X」解析为 `execute-ux-contract.md`、非本文件。
- **不内联调 `/custom:execute-ux-contract` 命令**——它是完整 supervisor（建自己的 `plans/<>-ux-test/` 子目录、跑多轮 test-fix、做自己的 commit），内联会 supervisor 嵌 supervisor，其 commit / state 与本 command §5 commit / state 冲突。独立的 `execute-ux-contract` 命令保持现状不动，供 owner 需要时单独跑全量 ux-contract 验证。

**4c 轻量 test-ux 探索**

对新 feature 跑一趟 `/custom:test-ux`（探索式），输入同现状（UX 入口 + plan 功能预期摘要 + 真实验收环境：账号 / 配额 / 副作用范围），抓 ux-contract 没写到的 unknown-unknown。

**严重度裁决**

4b / 4c 任一产出 issue 后按严重度裁决：

| 严重度 | 处理 |
|---|---|
| 任一 Critical / High / Medium 未解决 | 视同 Codex 早停——resume 同一 implementer Codex session（4b/4c 的 issue 都路由回它修），传 issue 文件路径 + 关键证据摘要 + plan 路径，要求修复并触发 plan 的 verify；**回到本节按原触发重跑**：有 UX 契约影响 → 回 4a 重新 apply / 冻结 ux-contract + 4b 重验，再跑 4c；ux-contract 中性 → 重跑 4c |
| 仅剩 Low | 写进 §6 最终 handoff 让用户决定是否当场修，不强制循环 |

UX 修复循环按 §3 同一套 Stop Gate 收敛——**同一类 issue 连续修复指令未推进时**，Claude 必须先独立排查（wrapper 是否丢输出 / repo 当前状态 / Claude 直接跑 issue 复现命令 / 报告是否有歧义），再决定是否把 blocker 升级给用户。

### 5. Commit（plan 完成时）

**判据**：§3 走到「Codex 完成 + 给出 verify 证据」分支 + §4 UX gate clear（或 N/A）+ working tree 有 Codex 实施产物且 diff 非空。§3 走到「Stop Gate 不满足」或「Codex 异常」分支时不走本节——半成品不入 git history。

**Scope**：
- 进 commit：Codex 在本次 plan 实施中新增 / 修改的代码 + docs（含根 README / install.sh 等 plan 显式声明的改动）
- 不进 commit：plan.md / state.md / journal.md（audit trail 与代码分离，用户自行决定单独 commit 或 `.gitignore`）；repo 中与本 plan 无关的 in-flight 改动；runtime / build artifact
**执行**：按 `claude/skills/create-commit/SKILL.md` 执行，将上述 Scope 约束作为文件 staging 的判断依据。判据成立直接 commit，不另外 AskUserQuestion——反转成本（`git reset --soft HEAD~1`）低于一次中断交互。

### 6. 最终 handoff（用户拿到的唯一交付物）

中文回复，内容由实际执行轨迹决定：

**必含**

- Codex session id + plan 路径
- commit hash（§5 产物的可追溯 anchor；若 §5 跳过则注明原因，如 diff 为空 / Stop Gate 未满足）
- 变更摘要 + 关键文件
- 已跑的 plan verify + 可观察证据
- Claude 作为 supervisor 的简短判断：是否遵循 plan / long-task / Stop Gate / 残余风险

**适用时含**

- 跑过 §4 UX gate：契约驱动验证（4b）/ test-ux（4c）的轮次数、最终 issue 状态、ux-contract 是否已 apply（4a）、未阻断交付的 Medium/Low 残留及定位
- Long-task 模式：state.md 最终状态简述（Tasks 全 done / Open Issues 全 closed）

若最终是合法 stop 而非完成（罕见，必须通过完整 Stop Gate），按 plan-execution-principles §5「Stop 时给清晰可执行的交接信息」格式：为什么停（直接证据级别） / 阻塞哪一步 / 已独立覆盖什么 / 用户具体动作。并提示用户做完后可重跑 `/custom:execute-plan <same plan path>`。

---

## 关键不变量

下面这些 SOTA Claude 默认不会做，失守会让本 command 退化：

- **同 session 复用 Codex**：Codex 中途 stop 后必须 `resume <session_id>` 续，禁止启新 session——会丢上下文让 Codex 重新分析 plan，等于让用户付两份 token。
- **wrapper 报错先归因 wrapper / 适配层**：只有观察到第三方原始响应（HTTP 体 / API error code / 状态页）才能写"外部不可用"。
- **背景任务 + 增量轮询**：必须 `run_in_background: true`；主轮询姿势见 §2（增量读新增、必要时全量兜底）；不要因为等久就 kill；不要把"在等待"当 stop 理由扔给用户。**但"不被动 kill"≠"被动等"**：Codex 反复对抗可解的环境争用（资源锁 / cron·launchd 抢占 / 端口冲突 / stale 锁）时，supervisor 主动做可逆干预或（副作用不确定 / 触及线上时）`AskUserQuestion`，见 `supervise.md` §3「环境争用监测」——不是干等它磨过去。
- **语言契约**：与 Codex / 工具交互 English；与用户交互中文。
- **Stop Gate 是三方统一的收敛规则**：管 Codex 的 stop、管 UX 修复循环、**也管 Claude 自己作为 supervisor 决定停下时**——没有这层统一，任一循环都会被错误地按"N 次重试"逻辑收敛。
- **Long-task 模式下 state.md / journal.md 是交付证据**：Codex 声称完成但两份文件没更新 → 视同 verify 缺项，resume 让 Codex 补。
- **不接管 plan 范围内的代码改动**：Claude 修 wrapper / 适配层允许；替 Codex 写 plan 范围内的代码不允许——绕过 supervisor 定位。

### 容易踩的独立失败模式

下面这些不直接是某条 invariant 的反面，但是真实的踩坑形态：

- Codex 仅给 summary 但 plan verify 没真跑可观察证据——单凭"Done"字样就进 §4 / §5
- Stop Gate 自检由 Claude 替 Codex 编理由让 stop 合法
- test-ux Critical / High issue 累积到 handoff 才暴露，没在第 4 步就交回 Codex 修
