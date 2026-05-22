---
name: execute-plan
description: 用 codeagent-wrapper 启动 Codex 执行 /custom:create-plan 产出的 plan.md。Claude 作为 supervisor：按 plan-execution-principles 检查 Stop Gate、必要时 resume 同一 Codex session；若 plan 声明了 UX 入口，自动跑 /custom:test-ux 并把 Critical/High issue 回灌给 Codex 修，直到清才把结果交付用户。触发：显式 `/custom:execute-plan <plan path>`。
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
3. Codex 完成后自动跑 test-ux，issue 回灌给同一 Codex session 直到清

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
  command: "~/.claude/bin/codeagent-wrapper --progress --backend codex - <WORKDIR> <<'EOF'\n<spawn-prompt>\nEOF",
  run_in_background: true,
  timeout: 7200000,
})
```

- `<WORKDIR>` 必须来自 Bash `pwd`，**禁止从 `$HOME` / 环境变量推断**——repo 路径可能含 worktree 后缀。
- `run_in_background: true` 是硬约束（不可阻塞 Claude 主 session）。
- spawn-prompt 只放**未来 LLM 不会自动 default 的非显然信息**：
  - 角色：<根据任务进行角色设定，例如负责代码的实现/审查/测试>
  - 用户原始 task 描述（保留原话，不要 paraphrase）
  - 协议绑定：plan 顶部有 Long-task banner → 严格按 `~/.claude/references/long-task-protocol.md`；任何 stop 判断按 `~/.claude/references/plan-execution-principles.md` 的 Stop Gate
  - Blocked 时：贴满足 5 项 Stop Gate 的 report
- 从 wrapper 输出捕获 Codex 的 `session id`——后续 resume 完全依赖它。当前只能扫描输出文本，**捕不到时视为 wrapper / 适配层问题**——排查 stderr / 退出码 / 输出截断，不要直接交给用户。

### 2. 等待与轮询

```
TaskOutput({ task_id, block: true, timeout: 600000 })
```

10 分钟未完成是常态，继续轮询，不 kill。仅在三种状态进入第 3 步：

- Codex 给出明确完成 summary
- Codex 声称 blocked 并给出（或漏给）Stop Gate report
- Codex 进程异常退出 / 输出截断 / 无 session id

每轮等待之间发一条简短中文状态（"Codex 仍在执行，已等待 X 分钟"），不要静默——把"在等待"当 stop 理由扔给用户是反模式。

### 3. 判定 Codex 输出并裁决

| 观察到的现象 | 下一步 |
|---|---|
| Codex 声称完成 + 给出 verify 证据 | 进 §4 UX gate。**不要只看"Done"字样**——核对的 lens 是 **Codex 的完成证据 ≥ plan 明文规定的 verify gate**（实施步骤覆盖、每个 independently executable verify 的可观察证据、long-task 模式下 state.md 更新——按 plan 实际声明的来，不限于此列举） |
| Codex 停止但 Stop Gate 任一项不满足 | 用同一 session resume Codex（见下方 resume 调用），指出哪几项 Stop Gate fail + 各自的 supervisor 证据；回到 §2 |
| Codex 异常 / 无 session id / 输出截断 | 按 wrapper / 适配层问题处理（不转嫁外部失败）：排查 stderr / 退出码，看 `git status` 判断是否已部分完成，再决定 resume / 重启路径 |

resume 调用形如（spawn 同一套 flag 组 + 后台 + timeout，仅 path prefix 改为 `resume <SESSION_ID>`）：

```
Bash({
  command: "~/.claude/bin/codeagent-wrapper --progress --backend codex resume <SESSION_ID> - <WORKDIR> <<'EOF'\n<resume-prompt>\nEOF",
  run_in_background: true,
  timeout: 7200000,
})
```

resume-prompt 也走 trust-the-model——只列：本次 Stop Gate 哪几项 fail + 各自的 supervisor 证据 + plan 路径 + （若 long-task）当前 state.md / journal.md 摘要。**不复述 Stop Gate 全文**——Codex 重读 reference 文件即可。

### 4. UX gate（仅当 plan 声明 UX 入口时触发）

判据：**plan 的 L2 user-facing verify 段是否给出 agent 可作为真实用户访问的产品 instance**（按 `/custom:create-plan` 三层 framing；物理形态无关——部署 URL / staging / 体验版 build / 小程序 instance / desktop 安装包 / agent-accessible 本地端口等都算，以 plan 实际描述为准）。

- **判据不成立** → 跳过本节，直接进 §5
- **判据成立** → 跑 `/custom:test-ux`，把 UX 入口 + plan 中的功能预期摘要 + 真实验收环境（账号 / 配额 / 副作用范围）作为输入

test-ux 产出 issue 后按严重度裁决：

| 严重度 | 处理 |
|---|---|
| 任一 Critical / High / Medium 未解决 | 视同 Codex 早停——resume 同一 Codex session，传 issue 文件路径 + 关键证据摘要 + plan 路径，要求修复并触发 plan 的 verify；回到本节顶部重跑 test-ux |
| 仅剩 Low | 写进 §6 最终 handoff 让用户决定是否当场修，不强制循环 |

UX 修复循环按 §3 同一套 Stop Gate 收敛——**同一类 issue 连续修复指令未推进时**，Claude 必须先独立排查（wrapper 是否丢输出 / repo 当前状态 / Claude 直接跑 issue 复现命令 / test-ux 报告是否有歧义），再决定是否把 blocker 升级给用户。

### 5. Commit（plan 完成时）

**判据**：§3 走到「Codex 完成 + 给出 verify 证据」分支 + §4 UX gate clear（或 N/A）+ working tree 有 Codex 实施产物且 diff 非空。§3 走到「Stop Gate 不满足」或「Codex 异常」分支时不走本节——半成品不入 git history。

**Scope**：
- 进 commit：Codex 在本次 plan 实施中新增 / 修改的代码 + docs（含根 README / install.sh 等 plan 显式声明的改动）
- 不进 commit：plan.md / state.md / journal.md（audit trail 与代码分离，用户自行决定单独 commit 或 `.gitignore`）；repo 中与本 plan 无关的 in-flight 改动；runtime / build artifact
- staging 用 explicit path（`git add <file>`），不用 `git add -A`——后者会污染 commit 并可能带入 secret

**Message**：
- 格式：`<type>(scope): <description>` ≤72 字符；types: `feat` `fix` `refactor` `docs` `test` `chore` `perf` `ci` `style` `build`
- 默认 subject-only；body 仅在 subject + diff 不足以让 reviewer 推出非显然设计决策时加；body bullet 写设计意图 / 架构变更（why、what 概念上变了），不写文件级细节（diff 已含）
- per-bullet derivability test：每条候选 bullet 自问「reviewer 能从 subject + diff 推出来吗」，能 → drop
- 不附 `Co-Authored-By`；对齐 repo 最近 commit 风格

**Auto-commit**：判据成立直接 commit，不另外 AskUserQuestion；commit 错了用户可 `git reset --soft HEAD~1` 重做，反转成本低于一次中断交互。

### 6. 最终 handoff（用户拿到的唯一交付物）

中文回复，内容由实际执行轨迹决定：

**必含**

- Codex session id + plan 路径
- commit hash（§5 产物的可追溯 anchor；若 §5 跳过则注明原因，如 diff 为空 / Stop Gate 未满足）
- 变更摘要 + 关键文件
- 已跑的 plan verify + 可观察证据
- Claude 作为 supervisor 的简短判断：是否遵循 plan / long-task / Stop Gate / 残余风险

**适用时含**

- 跑过 test-ux：轮次数、最终 issue 状态、未阻断交付的 Medium/Low 残留及定位
- Long-task 模式：state.md 最终状态简述（Tasks 全 done / Open Issues 全 closed）

若最终是合法 stop 而非完成（罕见，必须通过完整 Stop Gate），按 plan-execution-principles §4「Stop 时给清晰可执行的交接信息」格式：为什么停（直接证据级别） / 阻塞哪一步 / 已独立覆盖什么 / 用户具体动作。并提示用户做完后可重跑 `/custom:execute-plan <same plan path>`。

---

## 关键不变量

下面这些 SOTA Claude 默认不会做，失守会让本 command 退化：

- **同 session 复用 Codex**：Codex 中途 stop 后必须 `resume <session_id>` 续，禁止启新 session——会丢上下文让 Codex 重新分析 plan，等于让用户付两份 token。
- **wrapper 报错先归因 wrapper / 适配层**：只有观察到第三方原始响应（HTTP 体 / API error code / 状态页）才能写"外部不可用"。
- **背景任务 + TaskOutput 轮询**：必须 `run_in_background: true`；不要因为等久就 kill；不要把"在等待"当 stop 理由扔给用户。
- **语言契约**：与 Codex / 工具交互 English；与用户交互中文。
- **Stop Gate 是三方统一的收敛规则**：管 Codex 的 stop、管 UX 修复循环、**也管 Claude 自己作为 supervisor 决定停下时**——没有这层统一，任一循环都会被错误地按"N 次重试"逻辑收敛。
- **Long-task 模式下 state.md / journal.md 是交付证据**：Codex 声称完成但两份文件没更新 → 视同 verify 缺项，resume 让 Codex 补。
- **不接管 plan 范围内的代码改动**：Claude 修 wrapper / 适配层允许；替 Codex 写 plan 范围内的代码不允许——绕过 supervisor 定位。

### 容易踩的独立失败模式

下面这些不直接是某条 invariant 的反面，但是真实的踩坑形态：

- Codex 仅给 summary 但 plan verify 没真跑可观察证据——单凭"Done"字样就进 §4 / §5
- Stop Gate 自检由 Claude 替 Codex 编理由让 stop 合法
- test-ux Critical / High issue 累积到 handoff 才暴露，没在第 4 步回灌 Codex
