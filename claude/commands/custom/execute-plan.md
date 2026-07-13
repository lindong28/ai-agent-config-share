---
name: execute-plan
description: 执行 /custom:create-plan 产出的 plan.md——委派 Codex 落地实现、Claude 作为 supervisor 监督到验收通过才交付。用于你已有一份 plan.md、要把它可靠实现出来时。
argument-hint: "<plan.md path>"
origin: 2026-05-19
---

# execute-plan

入口 command：把"先 `/custom:create-plan` 出 plan，再人工切到 Codex 实现，完成后人工回 Claude 检查 + 跑 UX gate"压成一条 supervisor 命令——Claude 监督 Codex 一直跑到 Stop Gate 满足 + 可能的 UX gate 过关，才把结果交还用户。

## 何时使用
- 显式 `/custom:execute-plan <plan.md path>`
- 已有 plan.md（或 long-task 模式下 plan + state.md + journal.md 一并落地）且要进入实施阶段
- 非 plan 任务（自由文本）→ 不要执行：提示用户先 `/custom:create-plan <task>` 产出 plan

---

## 用户期望的收益（按优先级）

源对话拍过的 ranking，下游 supervisor 取舍按这个顺序：

1. 用户不用在 Claude 与 Codex 间手动切换上下文
2. 自动识破 Codex 在 Stop Gate 未满足时的早停并 resume
3. Codex 完成后自动跑 §4 UX gate（契约驱动验证 + test-ux 探索），把发现的 issue 交回 Codex 修复，直到全部解决
4. 执行质量不被单 session 膨胀拖累：工作单元边界默认轮换新 session（§1.5）
5. 每个工作单元的 diff 入 git 前过独立 review gate（§3.5）——review 粒度贴单元，不攒成整 plan 巨型 diff 一次性审

## 输入契约

| 形态 | 处理 |
|---|---|
| `plan.md` 路径（来自 `/custom:create-plan`） | 进入主流程 |
| `plan.md` + 同目录 `state.md` / `journal.md`（long-task 模式） | 同上；额外要求 Codex 按 long-task-protocol 持续更新两份文件，并由 Claude 在 §3 复核 |
| 自由文本 / 非 plan 路径 / 路径不存在 | 拒绝执行；提示用户先 `/custom:create-plan <task>` |

此外，plan「UX 契约影响」段非 skip 时，`docs/contracts/ux-contract.md`（来自 create-ux-contract、非上游 create-plan 的产物）是 §4a 读写的条件依赖——见 §4a。

---

## 主流程（lens，不是步骤清单）

### 1. 启动 Codex（后台 spawn + 捕获 session id）

调用形如：

```
Bash({
  command: "CODEX_TIMEOUT=21600000 ~/.claude/bin/codeagent-wrapper --progress --backend codex - <WORKDIR> <<'EOF'\n<spawn-prompt>\nEOF",
  run_in_background: true,
  timeout: 21900000,
})
```

- `<WORKDIR>` 必须来自 Bash `pwd`，禁止从 `$HOME` / 环境变量推断——repo 路径可能含 worktree 后缀。
- `run_in_background: true` 是硬约束（不可阻塞 Claude 主 session）。
- spawn-prompt 只放未来 LLM 不会自动 default 的非显然信息：
  - 角色：<根据任务进行角色设定，例如负责代码的实现/审查/测试>
  - plan.md 路径（long-task 模式含同目录 state.md / journal.md 路径）——让 Codex 自读，不复述内容
  - 用户原始 task 描述（保留原话，不要 paraphrase）
  - 协议绑定：plan 顶部有 Long-task banner → 严格按 `~/.claude/references/long-task-protocol.md`；任何 stop 判断按 `~/.claude/references/plan-execution-principles.md` 的 Stop Gate
  - 若 plan 含「UX 契约影响」段（非 skip）：代码完成后按该段记录的 apply 指令，把其 L2 条目 + section delta + 已对齐决策 apply 进 `docs/contracts/ux-contract.md`（含目标 §X）并冻结；若发现 ux-contract 需要 plan 未记录的改动则停下并 report，不静默扩展（no-silent-edit）
  - Commit 纪律：不自行 commit——每个工作单元完成后停在 working tree 并 report，commit 由 supervisor 过单元 review gate 后执行（§3.5）
  - Blocked 时：贴满足全部 Stop Gate 的 report
- 从 wrapper banner（stdout 文本流）捕获 Codex 的 `session id`——后续 resume 完全依赖它。当前只能扫描 banner 文本，捕不到时视为 wrapper / 适配层问题——排查 stderr / 退出码 / 输出截断，不要直接交给用户。

### 1.5 Session 拓扑：以工作单元为界复用/轮换

**工作单元** = session 粒度的单位，默认一个 phase；以下情况合并为一个单元、不轮换（由 supervisor 判定）：强耦合的相邻 phase（共享大量在场上下文）；预期很短的 phase（轮换的重读成本 > context 减负收益）。

| 规则 | 内容 |
|---|---|
| 单元内 | 早停 resume / 修复循环 / gate 答复，**必须 resume 同 session** |
| 单元边界 | 上一单元验收通过（含 state.md / journal.md 已更新、§3.5 单元 gate 过 + commit 落盘）后，下一单元默认启新 session——避免长 plan 单 session 膨胀触发频繁 compaction 丢决策。边界新 session 仍是一次 spawn，按 §1 那份完整 spawn-prompt 内容下达（**勿只给摘要**——协议绑定、plan/state/journal 路径、本单元会完成代码时的 UX-contract apply 指令等不会自动 default），再附一段 terse handoff 摘要：上一单元结论 + 本单元接力点 + 任何非显然 carry-over |

### 2. 等待、轮询与周期汇报

spawn 后从后台 Bash 任务结果捕获 `.output` 路径并记下（即下文的 `<output-file>`）：这是 harness 对后台 bash 任务 stdout+stderr 的完整捕获，**不是** wrapper banner 里 `Log:` 指向的 `codeagent-wrapper-<PID>.log`。每轮轮询调用形如：

```
Bash({ command: "~/.claude/bin/poll-progress.sh <output-file>" })
```

poll-progress.sh 只读新增进度行（默认每轮最多回显 80 行），据此判断 Codex 是在推进 / 完成 / blocked / stuck。

10 分钟未完成是常态，继续增量轮询，不 kill。仅在三种状态进入第 3 步：

- Codex 给出明确完成 summary
- Codex 声称 blocked 并给出（或漏给）Stop Gate report
- Codex 进程异常退出 / 输出截断 / 无 session id

每轮等待之间发一条简短中文状态（"Codex 仍在执行，已等待 X 分钟"），不要静默——把"在等待"当 stop 理由扔给用户是反模式。

**周期性 FYI 汇报（默认要求）**：执行期内每 ≤30 分钟向用户发一次简短进度汇报。
- **动机**：长执行期里 supervisor 的事件驱动汇报（gate / blocked / 完成时才说话）会造成数小时的静默，用户失去"现在在哪、有没有在动"的可见性，只能反复主动来问。
- **性质**：FYI 单向信息流，不是找用户——不提问、不等待回复、不构成 stop；用户可看可不看。内容：当前阶段 / 自上次汇报以来的推进 / 异常与否 / 下一里程碑，3-8 行。一切照常时一句话即可。
- **机制**：idle 等待期 supervisor 无法主动发消息，须靠调度唤醒——唤醒 / 间隔 / 完成即删的机制归 `~/.claude/references/background-agent-monitoring.md`。FYI 汇报搭同一巡检唤醒的便车（巡检醒来时顺带发一条），不另起第二个 cron。仅 Critical 异常（进程死亡 / 付费墙 / 外部服务故障证据）才额外 PushNotification——周期汇报本身不推送，避免通知疲劳。

需要完整上下文时（§3 裁决 / context 压缩后恢复 / 排查异常），用 `Read(<output-file>)` 读整份 `.output`；poll-progress.sh 只读不改源文件，完整记录始终在盘上。**poll-progress.sh 回显含「跳过 N 行」时必须先全量 `Read(<output-file>)` 再裁决**（单轮新增 > 80 行触发截断）——被跳过的中段在增量模式下不再出现，blocked / Stop Gate report / verify 证据可能正落在中段。resume 会产生新的后台任务 = 新 `.output` 文件，对新文件重新记录路径并从 0 开始轮询。

### 3. 判定 Codex 输出并裁决

| 观察到的现象 | 下一步 |
|---|---|
| Codex 声称完成 + 给出 verify 证据 | 末个工作单元先过 §3.5 单元 gate + commit，再进 §4 UX gate。不要只看"Done"字样——核对的 lens 是 **Codex 的完成证据 ≥ plan 明文规定的 verify gate**（实施步骤覆盖、每个 independently executable verify 的可观察证据、long-task 模式下 state.md 更新——按 plan 实际声明的来，不限于此列举）。且质疑判据强度：verify 若是存在性判据（命中 ≥1 / 有输出）而改动涉及"用户能看到多少数据"，PASS 不等于完整——追问 expected-vs-actual（应见多少 vs 实际多少），存在性会掩盖数量缺失 |
| Codex 完成一个**工作单元**（非整个 plan）+ 证据合格 | 过 §3.5 单元 gate + commit 后，按 §1.5 进入下一单元：默认启**新 session**（带 handoff 摘要）；与当前单元强耦合则 resume 同 session |
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

### 3.5 单元 review gate + commit（单元验收的收口）

单元验收证据合格后、进入下一单元（或 §4）前：该单元 diff 过 `~/.claude/skills/review-gate/SKILL.md`，gate 通过即按 `~/.claude/skills/create-commit/SKILL.md` 提交该单元——commit 粒度 = review 粒度 = 工作单元。定档 / 分档执行 / 修复闭环 / 裁决全部沿用 review-gate 原文，本节只列 execute-plan 语境的 delta：

- **指令 artifact 单元走专项路由**：单元 diff 为 skill / command / reference / principles 文件时按 review-gate 专项路由接管（走其映射的对应专项 command，无 backend 选择）；findings 修复随该专项 command 自身的主-session 交互修复闭环施加，不经下面「修复路由」、不 resume implementer——专项 command（review-skill / review-principles）是主-session 交互工作流、无法在 Codex resume 里跑，构成对「不接管」不变量的显式例外（见关键不变量）。下面「高档 reviewer 取与 diff 实际作者异模型」「修复路由」两条只适用其余代码单元。
- **review 对象**：working tree 中本单元改动（含 untracked；剔除 plan.md 同目录的规划 audit trail——plan.md / state.md / journal.md / issues/ 等过程产物，及 §4b/4c 测试证据文件，staging 判据同 §5 Scope）。implementer 不自行 commit（§1 spawn-prompt 纪律）+ 上一单元已 commit ⇒ 未提交部分即本单元。前提是排除 plan 外的 in-flight 改动：首次 spawn 前记录 baseline——`git status --porcelain` 脏文件清单 + `git diff HEAD` 内容快照（staged + unstaged 都要，裸 `git diff` 会漏 staged 侧）落 plan 同目录 `baseline.patch`（属 audit trail；execute-plan 常被 resolve-issues 等编排在脏 repo 上调起），§3.5 一律剔除 baseline 文件；implementer 改动与 baseline 撞同一文件 → 不静默拖到收尾：立即 `AskUserQuestion` 让用户处置解除撞车——baseline.patch 里有该文件完整 pre-image diff 的，凭其拆出 baseline 侧 hunk 后 commit / stash，或授权整文件并入本单元（一并 review + commit）；无可用 pre-image 的（untracked / binary 等不可 patch 文件），只有整文件并入 / 整文件留给用户两项。撞车文件可能承载后续单元依赖的 plan 必需改动，静默排除会让其后每个单元 commit 都建立在不可复现的脏 tree 上；用户明示留给自己时，该文件不入任何单元 commit、不作为已 review 内容对待，§6 注明。
- **高档 reviewer 取与 diff 实际作者异模型**（中档照 review-gate 原文用 claude subagent——review-gate 本就只在高档主张跨模型，独立 context 已达中档目的）：单元 diff 默认作者是 implementer（Codex）→ 高档用 `codeagent-wrapper --backend claude`；supervisor 亲手改的切片（§4.5 品味工件、wrapper / 适配层修复）作者是 Claude → 高档用 codex（review-gate 默认）。作者归属按 supervisor 自身编辑记录判定（谁产出该 hunk 的最终内容归谁），混合作者按作者拆片分别审；同一 hunk 拆不开 → 两个 backend 各审一遍，成本换掉自审盲区。review-gate 写"默认 codex"的前提是作者为 Claude；原则是相对作者异模型，不是固定 codex。修复闭环 resume 原 reviewer 时 backend flag 随原审走（如 `codeagent-wrapper --backend claude resume <session_id> …`）——review-gate 原文的 resume 命令形不带 backend flag，照抄会把 claude session 递给 codex 后端。
- **修复路由**：CRITICAL/HIGH findings 视同单元验收 fail——路由回该切片的作者：implementer 切片 resume 该单元 implementer session（§1.5 单元内同 session）；supervisor 切片（§4.5 品味工件等）supervisor 自修。修复 diff 按 review-gate 修复闭环复核回原 reviewer；gate 未过不 commit、不进下一单元。
- **定档照常生效**：trivial 单元显式免审声明后直接 commit——不为低风险单元付固定 review 成本。
- **覆盖一切入 commit 的 diff**：单元 commit 之后新增的改动（典型：§4 UX 修复）入 commit 前同样过本节 gate——小修复按定档自然落轻档。修复按 mini 单元逐个走「gate → commit → 重跑触发它的验证」，不许多个修复堆积在 working tree——堆积即重造多单元混合 diff，隔离失效。

### 4. UX gate：ux-contract 同步 + hybrid 测试

> 「UX 契约影响」与「UX 入口」均为 create-plan 在 plan.md 写入的声明（见 create-plan §2「UX 契约影响」facet + L2 user-facing verify 段）；本节按这两个声明分流。

**触发解耦成两条独立条件**：

| 子步 | 触发条件 |
|---|---|
| 4a + 4b（ux-contract 同步 + 契约驱动验证） | plan「UX 契约影响」段非 skip（该段的字段定义见 create-plan §2 facet；无影响 / 产品无 ux-contract 则该段标 skip）|
| 4c（探索式 test-ux） | plan 的 L2 给出 agent 可作为真实用户访问的产品 instance（按 `/custom:create-plan` 三层 framing；物理形态无关——部署 URL / staging / 体验版 build / 小程序 instance / desktop 安装包 / agent-accessible 本地端口等，以 plan 实际描述为准），**与 ux-contract 是否变化无关** |

- 两条都不满足（纯内部重构 / 无 UX 入口且无契约影响）→ **§4 整段 skip**，直接进 §5。
- ux-contract 中性但用户可感知的变更（如 UX bugfix）→ 仅 4c 触发，**跑 test-ux、不跑 4a/4b**。

**4a 应用 ux-contract 更新**

本步是 docs-organization-protocol 的 contracts/ 段主路径的【自主执行阶段】。由 Codex 的 implementer session（与代码 + §5 Doc 同步一并；该 apply 任务随完成代码的那个工作单元的 spawn-prompt 下达——§1.5 轮换后未必是 §1 首 spawn 的 session）把 plan「UX 契约影响」段记录的 L2 条目 + section delta + 已对齐决策 apply 进 `docs/contracts/ux-contract.md` §X（apply 指令见 create-plan facet 产出 (d)）。这是执行 plan 已批准意图、**非静默改**。

- **no-silent-edit 不变量**：若 Codex 在应用时发现 ux-contract 需要 plan 未记录的改动（出现了 plan 没覆盖的取舍）→ 停下，supervisor `AskUserQuestion` 让用户拍，不静默扩展 ux-contract。

**4b 契约驱动验证（借方法、不嵌命令）**

ux-contract 在 4a 更新并冻结后，把本 plan「UX 契约影响」段列出的变更 L2 条目翻成 test step、用 **独立的 Codex test session 跑**（区别于 implementer session——测试不污染实现上下文；与 4c 的 test-ux 同一套 §2 后台轮询 + §3 裁决编排）。翻译与 test prompt 构造照 `~/.claude/commands/custom/execute-ux-contract.md` §1（L2 翻译 + Plan 确认门）+ §2.1（Test prompt 构造 + 端到端原则）的 recipe——supervisor 读这几段借其法、不调命令；引用文件给路径让 test session 自读，不复述。

- **L2 翻译歧义时**（一条 L2 有多种合理判据解读）→ supervisor 先 `AskUserQuestion` 让用户裁定，再 spawn test session（对齐 §1 Plan 确认门）。
- **execute-plan 专属 delta**（借 recipe 时按本 command 语境补/改这几处）：test step 源自本 plan 变更 L2 条目的翻译、scope 限变更条目不全量重测；recipe 里 `<plans 子目录实际路径>` 产出位置改为 plan.md 同目录的 `issues/`（供 §4 严重度裁决的 issue 回链复用）；recipe 内一切自指「本 command 文件 §X」解析为 `execute-ux-contract.md`、非本文件。
- **不内联调 `/custom:execute-ux-contract` 命令**——它是完整 supervisor（建自己的 `plans/<>-ux-test/` 子目录、跑多轮 test-fix、做自己的 commit），内联会 supervisor 嵌 supervisor，其 commit / state 与本 command §5 commit / state 冲突。独立的 `execute-ux-contract` 命令保持现状不动，供用户需要时单独跑全量 ux-contract 验证。

**4c 轻量 test-ux 探索**

对新 feature 跑一趟 `/custom:test-ux`（探索式），输入同现状（UX 入口 + plan 功能预期摘要 + 真实验收环境：账号 / 配额 / 副作用范围），抓 ux-contract 没写到的 unknown-unknown。

**严重度裁决**

4b / 4c 任一产出 issue 后按严重度裁决：

| 严重度 | 处理 |
|---|---|
| 任一 Critical / High / Medium 未解决 | 视同 Codex 早停——resume 实现该改动所在工作单元的 implementer session（§1.5 轮换后未必是最新 session，按 issue 定位到对应单元；4b/4c 的 issue 都路由回它修），传 issue 文件路径 + 关键证据摘要 + plan 路径，要求修复并触发 plan 的 verify；修复 diff 过 §3.5 gate + commit（mini 单元，逐个不堆积）后**回到本节按原触发重跑**：有 UX 契约影响 → 回 4a 重新 apply / 冻结 ux-contract + 4b 重验，再跑 4c；ux-contract 中性 → 重跑 4c |
| 仅剩 Low | 写进 §6 最终 handoff 让用户决定是否当场修，不强制循环 |

UX 修复循环按 §3 同一套 Stop Gate 收敛——**同一类 issue 连续修复指令未推进时**，Claude 必须先独立排查（wrapper 是否丢输出 / repo 当前状态 / Claude 直接跑 issue 复现命令 / 报告是否有歧义），再决定是否把 blocker 升级给用户。

### 4.5 AIGC / 语义质量任务的监督升格

**触发条件**：plan 交付物的质量取决于 prompt / 生成内容 / LLM judge（AIGC 产物、语义判官、分类器等非确定性工件）。纯工程型 plan 不触发。

触发后，supervisor 的职责在 §2-§4 基线上升格三条：

1. **亲自抽看产物**：supervisor 对生成产物做小样本多模态抽查（看图 / 读文 / 听音），形成独立质量判断——implementer 自报、自动 gate 通过、测试全绿都不能替代这一眼。抽样即可，不全量看（成本控制）。
2. **品味工件设计权归 supervisor**：生成 prompt / judge rubric / 评分协议这类品味工件，由 supervisor 主导设计与修订（implementer 负责接线、测试、批量执行）；至少做到逐版审查。"不接管"不变量对品味工件不适用（见关键不变量的限定）。
3. **质量不达标先诊断再派活**：靠"亲自看产物 + 读判官原始输出"定位根因（措辞问题 / 机制问题 / 上游设计问题），再下发针对性修复——禁止把"再改改 prompt"原样丢回 implementer 重试。

依据：生成质量卡住时，靠 implementer 逐版改 prompt 文笔常推不动——根因可能在机制 / 上游设计（如 judge 拿生成所用的同一描述当批改答案的循环论证），措辞 / 机制 / 上游设计都可能、别预设，只有 supervisor 独立看产物的诊断回路能定位。

### 5. Commit（plan 完成时）

**判据**：§3 走到「Codex 完成 + 给出 verify 证据」分支 + §4 UX gate clear（或 N/A）。§3 走到「Stop Gate 不满足」或「Codex 异常」分支时不走本节——半成品不入 git history。

**Scope**：
- 进 commit：Codex 在本次 plan 实施中新增 / 修改的代码 + docs（含根 README / install.sh 等 plan 显式声明的改动）
- 不进 commit：plan.md / state.md / journal.md（audit trail 与代码分离，用户自行决定单独 commit 或 `.gitignore`）；repo 中与本 plan 无关的 in-flight 改动；runtime / build artifact
**执行**：按 `claude/skills/create-commit/SKILL.md` 执行，将上述 Scope 约束作为文件 staging 的判断依据。判据成立直接 commit，不另外 AskUserQuestion——反转成本（`git reset --soft HEAD~1`）低于一次中断交互。若 Codex 已在执行期把 scoped 改动逐步提交完、working tree 无残留，本步无新 commit。

### 6. 最终 handoff（用户拿到的唯一交付物）

中文回复，内容由实际执行轨迹决定：

**必含**

- Codex session id + plan 路径
- commit hash 列表（§3.5 各单元 commit + §5 收尾 commit 的可追溯 anchor；某步无 commit 则注明原因，如 diff 为空 / Stop Gate 未满足）
- 变更摘要 + 关键文件
- 已跑的 plan verify + 可观察证据
- 各单元 review gate 裁决摘要（含 trivial 免审声明与 waive 记录）
- Claude 作为 supervisor 的简短判断：是否遵循 plan / long-task / Stop Gate / 残余风险

**适用时含**

- 跑过 §4 UX gate：契约驱动验证（4b）/ test-ux（4c）的轮次数、最终 issue 状态、ux-contract 是否已 apply（4a）、未阻断交付的 Medium/Low 残留及定位
- Long-task 模式：state.md 最终状态简述（Tasks 全 done / Open Issues 全 closed）

若最终是合法 stop 而非完成（罕见，必须通过完整 Stop Gate），按 plan-execution-principles §5「Stop 时给清晰可执行的交接信息」格式：为什么停（直接证据级别） / 阻塞哪一步 / 已独立覆盖什么 / 用户具体动作。并提示用户做完后可重跑 `/custom:execute-plan <same plan path>`。

---

## 关键不变量

下面这些 SOTA Claude 默认不会做，失守会让本 command 退化：

- **Session 复用以工作单元为界**（§1.5）：SOTA Claude 默认会一刀切（死守一个 session、或逢停就开新）——两个方向都丢：单元内乱开新 session 丢上下文（= 付两份 token），单元边界死守旧 session 则 context 膨胀拖质量。机制与边界判定见 §1.5。
- **wrapper 报错先归因 wrapper / 适配层**：只有观察到第三方原始响应（HTTP 体 / API error code / 状态页）才能写"外部不可用"。
- **背景任务 + 增量轮询**：必须 `run_in_background: true`；主轮询姿势见 §2（增量读新增、必要时全量兜底）；不要因为等久就 kill；不要把"在等待"当 stop 理由扔给用户。但"不被动 kill"≠"被动等"：Codex 反复对抗可解的环境争用（资源锁 / cron·launchd 抢占 / 端口冲突 / stale 锁）时，supervisor 主动做可逆干预或（副作用不确定 / 触及线上时）`AskUserQuestion`，见 `supervise.md` §3「环境争用监测」——不是干等它磨过去。
- **语言契约**：与 Codex / 工具交互 English；与用户交互中文。
- **Stop Gate 是三方统一的收敛规则**：管 Codex 的 stop、管 UX 修复循环、也管 Claude 自己作为 supervisor 决定停下时——没有这层统一，任一循环都会被错误地按"N 次重试"逻辑收敛。
- **不替 Codex 编 Stop Gate 满足的理由**：复核早停时逐项要 supervisor 自己的独立证据，别把 Codex 的自报当"已满足"放行——想收尾时最易发生，一放行「识破早停」(收益 #2) 即失效。
- **入 git 的 diff 必先过单元 review gate（§3.5）**：SOTA Claude 默认会把 review 攒到最后一次性做（整 plan 巨型 diff 审不动）或放任 implementer 执行期自行 commit（绕过 gate 的零审路径）——两个方向都丢 review 粒度。implementer 不自行 commit 是此不变量的执行面。
- **Long-task 模式下 state.md / journal.md 是交付证据**：Codex 声称完成但两份文件没更新 → 视同 verify 缺项，resume 让 Codex 补。
- **不接管 plan 范围内的代码改动**：Claude 修 wrapper / 适配层允许；替 Codex 写 plan 范围内的代码不允许——绕过 supervisor 定位。限定：prompt / rubric / 评分协议等品味工件不算"代码"，§4.5 触发时其设计权本就归 supervisor。另一例外：指令 artifact 单元走专项路由时（§3.5），findings 修复随专项 command 的主-session 交互闭环施加、不 resume implementer——非绕过 supervisor 定位，而是 review-skill / review-principles 只能主-session 跑。
