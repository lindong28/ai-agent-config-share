---
name: execute-plan
description: 执行并验收 /custom:create-plan 产出的 plan.md。用于已有 plan.md、希望 agent 按计划落地、验证并完成 review / UX gate 后交付时。
argument-hint: "<plan.md path>"
origin: 2026-05-19
---

# execute-plan

入口 command：把"先 `/custom:create-plan` 出 plan，再人工切到 Codex 实现，完成后人工回来检查 + 跑 UX gate"压成一条 supervisor 命令——当前主 session 监督独立 Codex implementer 一直跑到 Stop Gate 满足 + 可能的 UX gate 过关，才把结果交还用户。

## 何时使用
- 显式 `/custom:execute-plan <plan.md path>`
- 已有 plan.md（或 long-task 模式下 plan + state.md + journal.md 一并落地）且要进入实施阶段
- 非 plan 任务（自由文本）→ 不要执行：提示用户先 `/custom:create-plan <task>` 产出 plan

---

## 工作单元边界

工作单元默认是一个 phase；强耦合的相邻 phase 或轮换成本高于 context 减负收益的短 phase 可由 supervisor 合并。

---

## 用户期望的收益（按优先级）

源对话拍过的 ranking，下游 supervisor 取舍按这个顺序：

1. 用户不用在 supervisor 与 Codex implementer 间手动切换上下文
2. 自动识破 Codex 在 Stop Gate 未满足时的早停并 resume
3. Codex 完成后自动跑 §4 UX gate（契约驱动验证 + test-ux 探索），把发现的 issue 交回 Codex 修复，直到全部解决
4. 执行质量不被单 context 膨胀拖累：工作单元边界默认轮换新 context（§1.5）
5. 每个工作单元的 diff 入 git 前过独立 review gate（§3.5）——review 粒度贴单元，不攒成整 plan 巨型 diff 一次性审

## 输入契约

| 形态 | 处理 |
|---|---|
| `plan.md` 路径（来自 `/custom:create-plan`） | 进入主流程 |
| `plan.md` + 同目录 `state.md` / `journal.md`（long-task 模式） | 同上；额外要求 Codex 按 long-task-protocol 持续更新两份文件，并由 supervisor 在 §3 复核 |
| 自由文本 / 非 plan 路径 / 路径不存在 | 拒绝执行；提示用户先 `/custom:create-plan <task>` |

此外，plan「UX 契约影响」段非 skip 时，`docs/contracts/ux-contract.md`（来自 create-ux-contract、非上游 create-plan 的产物）是 §4a 读写的条件依赖——见 §4a。

**工作单元一致性 gate（baseline / spawn 前）**：把 plan 的 phase / verify 结构及其显式写出的 review / commit 时序，同本命令「工作单元边界」及 §3.5 对照。plan 若把多个可独立验收的 phase 延后到一次最终 review / commit，或以其他方式与本命令的单元收口契约冲突，不得静默选择其一：先按 user-scope `Surface Choices (Real Ones), Recommend One` policy 让用户决定采用本命令的逐单元边界、保留 plan 的聚合边界，或先回修 plan；说明聚合会扩大 diff、review 与返工失效域。强耦合 phase 已由 plan 明确作为一个工作单元时不构成冲突。把决定作为后续单元划分的权威输入。

首次 spawn 前记录 working-tree baseline：把 `git status --porcelain` 脏文件清单与 `git diff HEAD`（含 staged + unstaged）内容快照写入 plan 同目录 `baseline.patch`。它是 audit trail，不进入单元 review / commit；后续撞车处置见 §3.5。

**并发隔离（开工前）**：其它 agent session 可能并发在同一 repo 执行 plan。开工前按 `~/.claude/references/concurrent-plan-isolation.md` 检测并发、按三层结构隔离在独立 worktree 落地；plan 显式声明"单 session 独占"时可免**建 worktree**（另两层的铁律与并发检测不在豁免内）；执行中出现「执行中提升」的反证即按该节重判该豁免。

---

## 主流程（lens，不是步骤清单）

```
输入 gate → baseline → transport 分流 →【工作单元执行 → verify 裁决 → review gate → commit】↺
                                      ↘ 失败 / 重开 → Trajectory Gate
                                                       ├ 当前执行方案成立 / 低反转成本方案调整 → 回工作单元
                                                       └ 高反转成本 / 目标质变 → Stop Gate → 用户裁决
                                      ↓ 末单元完成
                              可选 UX 修复循环 → docs 收尾 → handoff
任一拟 stop → Stop Gate → 继续执行或合法 stop
```

### 1. 启动 Codex implementer（harness-aware transport）

transport 按当前 harness 选择；两条路径都必须产生可续用的独立 Codex context，不能在 Codex harness 内再嵌套一层 `codeagent-wrapper` supervisor：

| Harness | Transport | Continuation handle |
|---|---|---|
| Claude Code | 后台 `codeagent-wrapper --backend codex`，调用形态见下 | wrapper banner 的 `session id` |
| Codex | 按 `$subagent-spawning` 启动独立 collaboration agent | collaboration continuation handle |

Claude Code 调用形如：

```
Bash({
  command: "CODEX_TIMEOUT=21600000 ~/.claude/bin/codeagent-wrapper --progress --backend codex - <WORKDIR> <<'EOF'\n<spawn-prompt>\nEOF",
  run_in_background: true,
  timeout: 21900000,
})
```

- `<WORKDIR>` 必须来自实际 `pwd`，禁止从 `$HOME` / 环境变量推断——repo 路径可能含 worktree 后缀。
- Claude Code 的 `run_in_background: true` 是硬约束（不可阻塞主 session）；Codex 走 collaboration mailbox，不套后台 shell。
- spawn-prompt 以下列 non-default 信息为 minimum core；按任务补充 isolated implementer 无法自行取得、却影响执行的事实，不把清单当允许内容上限，也不复述它可直接读取的源文件：
  - 角色：<根据任务进行角色设定，例如负责代码的实现/审查/测试>
  - plan.md 路径（long-task 模式含同目录 state.md / journal.md 路径）——让 Codex 自读，不复述内容
  - 用户原始 task 描述（保留原话，不要 paraphrase）
  - 本工作单元的 task / phase 范围、明确排除项，以及 supervisor 作出的合并 / 边界决定
  - 项目根、适用的 repo instructions / tool-routing 规则路径，以及 plan 落盘后新增的用户决定（如有）
  - 协议绑定：plan 顶部有 Long-task banner → 严格按 `~/.claude/references/long-task-protocol.md`；任何 stop 判断按 `~/.claude/references/plan-execution-principles.md` 的 Stop Gate
  - Trajectory Gate：若新证据可能否定当前执行方案，回报目标增量、支撑投入与实际风险作为 Trajectory Gate 输入；裁决归 supervisor，不自行授权下一轮
  - 若 plan 含「UX 契约影响」段（非 skip）：代码完成后按该段记录的 apply 指令，把其 L2 条目 + section delta + 已对齐决策 apply 进 `docs/contracts/ux-contract.md`（含目标 §X）并冻结；新增或修改任一 L1 承诺须同一次编辑内带其对应 L2 验证条件，plan 没提供的同样停下 report；若发现 ux-contract 需要 plan 未记录的改动则停下并 report，不静默扩展（no-silent-edit）
  - Commit 纪律：不自行 commit——每个工作单元完成后停在 working tree 并 report，commit 由 supervisor 过单元 review gate 后执行（§3.5）
  - Review ownership：生成后单元 review gate 由 supervisor 统一编排；implementer 不自行发起 generic / final / closure review。plan 或 plan 落盘后用户明确决定要求的生成后 reviewer multiplicity / 专项审查，先把 charter 回报 supervisor 统一启动；产品语义 judge、LLM report gate、UX 测试等验证照 plan 执行。实施前为解决未决风险而做的设计审查可跑，但必须有不同于单元 gate 的明确失败类别，并回报 reviewer handle / verdict
  - Rigor：读取 `~/.claude/references/rigor-tiers.md`，把 plan 默认 `(A,V)` 与本工作单元 per-phase override 传给 implementer / supervisor；授权控制、验证深度、reviewer multiplicity 与对抗适用面按（默认 ⊔ override）向量缩放、不按 label（review-gate 本地定档在 §3.5 gate 处再逐维并入）
  - 成功回报契约：本单元完成边界、改动文件 / diff、plan verify 的 exact 命令与可观察结果、最终证据新鲜度、遗留风险；复用证据时再附失效分析，blocked 则改走下一项
  - Blocked 时：贴满足全部 Stop Gate 的 report
- 记录当前 transport 的 continuation handle——后续 resume 完全依赖它。Claude Code 捕不到 wrapper `session id` 时排查 stderr / 退出码 / 输出截断；Codex handle 丢失时检查 collaboration agent 状态。两者都先按 transport / 适配层问题处理，不直接交给用户。

### 1.5 Context 拓扑：以工作单元为界复用/轮换

| 规则 | 内容 |
|---|---|
| 单元内 | 早停 resume / 修复循环 / gate 答复必须续用同一 handle：Claude Code resume wrapper session；Codex 对原 collaboration agent 发 follow-up task |
| 单元边界 | 上一单元验收通过（long-task 模式下 state.md / journal.md 已更新，且 §3.5 单元 gate 过 + commit 落盘）后，下一单元默认启新 context——避免长 plan context 膨胀触发频繁 compaction 丢决策。边界新 context 按 §1 的完整 handoff contract 下达；Codex 的隔离方式沿用 `$subagent-spawning`，再附 terse 摘要：上一单元结论 + 本单元接力点 + 任何非显然 carry-over |

### 2. 等待、轮询与周期汇报

等待机制同样按 transport 分流：Claude Code 读取 wrapper `.output`；Codex 按 `$subagent-spawning` 等待 collaboration 状态变化。无论 transport 如何，supervisor 都要把终态消费并路由；agent 的“完成”只会把控制权交回 supervisor，不能成为计划停止点。

启动 plan 时按 `background-agent-monitoring.md` 的「Plan supervisor watchdog」判定并建立 watchdog。

Claude Code spawn 后从后台 Bash 任务结果捕获 `.output` 路径并记下（即下文的 `<output-file>`）：这是 harness 对后台 bash 任务 stdout+stderr 的完整捕获，**不是** wrapper banner 里 `Log:` 指向的 `codeagent-wrapper-<PID>.log`。每轮轮询调用形如：

```
Bash({ command: "~/.claude/bin/poll-progress.sh <output-file>" })
```

poll-progress.sh 只读新增进度行（默认每轮最多回显 80 行），据此判断 Codex 是在推进 / 完成 / blocked / stuck。

10 分钟未完成是常态，继续增量轮询，不 kill。仅在三种状态进入第 3 步：

- Codex 给出明确完成 summary
- Codex 声称 blocked 并给出（或漏给）Stop Gate report
- Codex implementer 异常退出 / 输出截断 / continuation handle 丢失

每轮等待之间发一条简短中文状态（"Codex 仍在执行，已等待 X 分钟"），不要静默——把"在等待"当 stop 理由扔给用户是反模式。

**周期性 FYI 汇报（默认要求）**：执行期内每 ≤30 分钟向用户发一次简短进度汇报。
- **动机**：长执行期里 supervisor 的事件驱动汇报（gate / blocked / 完成时才说话）会造成数小时的静默，用户失去"现在在哪、有没有在动"的可见性，只能反复主动来问。
- **性质**：FYI 单向信息流，不是找用户——不提问、不等待回复、不构成 stop；用户可看可不看。内容：当前阶段 / 自上次汇报以来的推进 / 异常与否 / 下一里程碑，3-8 行。一切照常时一句话即可。
- **机制**：idle 等待期 supervisor 无法主动发消息，须靠调度唤醒——唤醒 / 间隔 / 完成即删 / 醒来时没有活跃后台任务该怎么分流的机制，均归 `~/.claude/references/background-agent-monitoring.md`。FYI 汇报搭同一巡检唤醒的便车（巡检醒来时顺带发一条），不另起第二个 cron。仅 Critical 异常（进程死亡 / 付费墙 / 外部服务故障证据）才额外 PushNotification——周期汇报本身不推送，避免通知疲劳。

Claude Code 需要完整上下文时（§3 裁决 / context 压缩后恢复 / 排查异常），用 `Read(<output-file>)` 读整份 `.output`；poll-progress.sh 只读不改源文件，完整记录始终在盘上。**poll-progress.sh 回显含「跳过 N 行」时必须先全量 `Read(<output-file>)` 再裁决**（单轮新增 > 80 行触发截断）——被跳过的中段在增量模式下不再出现，blocked / Stop Gate report / verify 证据可能正落在中段。resume 会产生新的后台任务 = 新 `.output` 文件，对新文件重新记录路径并从 0 开始轮询。Codex 则以 collaboration agent 的 message / final status 为裁决输入；需要更多证据时续用原 agent 定向索取，不把整个主 session transcript 再喂一遍。

### 2.5 Trajectory Gate：确认是否继续当前执行方案

supervisor 在 `plan-execution-principles.md`「Trajectory Gate」规定的触发点亲自裁决，不能把 implementer 的自报当 verdict；Trajectory Gate 未裁决前不 dispatch 新 attempt、resume 或 review-fix 轮。裁决与用户边界沿该 reference，Long-task 模式的写入分别沿 `long-task-protocol.md`「state.md 写什么」与「journal.md 写什么」的写入 lens，不为 checkpoint 新增固定 schema。

跨 attempt / resume 轮累积的**同一验证盲区** finding 计数是 supervisor 专属裁决输入——implementer 每轮只见本轮、看不到聚合，只有持 cross-cycle 记忆的 supervisor 能识别"这是同类第 N 个"。一个工作单元内 ≥2 个 finding 共享同一验证盲区（即便分属不同代码机制）时，按 Trajectory Gate 分流 (b) 重设验证策略、一次性真实接口 sweep，不继续逐轮 resume 打补丁。

### 3. 判定 Codex 输出并裁决

| 观察到的现象 | 下一步 |
|---|---|
| Codex 声称完成 + 给出 verify 证据 | 末个工作单元先过 §3.5 单元 gate + commit，再进 §4 UX gate。不要只看"Done"字样——核对的 lens 是 **Codex 的完成证据 ≥ plan 明文规定的 verify gate**（实施步骤覆盖、每个 independently executable verify 的可观察证据、long-task 模式下 state.md 更新——按 plan 实际声明的来，不限于此列举），并按 `plan-execution-principles.md`「Verify 证据新鲜度与失效」确认每条证据仍覆盖最终状态。且质疑判据强度：verify 若是存在性判据（命中 ≥1 / 有输出）而改动涉及"用户能看到多少数据"，PASS 不等于完整——追问 expected-vs-actual（应见多少 vs 实际多少），存在性会掩盖数量缺失。交付物只满足 verify 的**更松读法**（"一套 / N 个"用更少交付、把一个目标当另一个目标验）＝ `plan-execution-principles.md`「判据不可降级」所指"以更易满足的代理判据替换原判据"：能续 implementer 补齐到字面达成的当未达 verify 处置（走本表 Stop Gate 未满足行 / Trajectory Gate）、不惊动用户；字面达成不可行、只能降级判据的（如"当前 UX 一次只出 1 个"）按 Stop Gate 停→升级用户裁决，不由 supervisor 单方消化 |
| Codex 完成一个工作单元（非整个 plan）+ 证据合格 | 过 §3.5 单元 gate + commit 后，按 §1.5 进入下一单元：默认启新 context（带 handoff 摘要）；与当前单元强耦合则续用原 handle |
| Codex 停止但 Stop Gate 任一项不满足 | 先过「Trajectory Gate」；当前执行方案仍成立才续用原 handle，指出哪几项 Stop Gate fail + 各自的 supervisor 证据并回到 §2。执行方案已被否定则按 Trajectory Gate 裁决分流，不以 Stop Gate 为由强迫同方案 resume |
| Codex implementer 异常 / handle 丢失 / 输出截断 | 按当前 transport / 适配层问题处理（不转嫁外部失败）：检查 agent 状态或 stderr / 退出码，看 `git status` 判断是否已部分完成，再决定续用 / 重启路径 |

**真实数据接地（verify 证据的地基）**：plan verify 针对的行为若依赖真实生产输入 / 数据流（监控能否上膛、部署里前提基线是否真产出、用户实际能看到多少），且**该真实输入可取得**——则合成 / 历史回放 / 臆想输入的 PASS **不算通过**：MUST 用真实数据验证（非 advisory），合成只作 smoke。这是静默失效的收口——对合成输入验通过、生产真实数据流从没接地，坑直达用户。真实输入**确实不可取得**时（如需部署后才有）**DEFER 不 CLOSE**：记为部署后强制 live 补验义务，未过前该能力不算激活、plan 不算最终交付；live 补验失败按不 ship / 升级用户裁决，不静默当已交付。

Claude Code resume 调用形如（同 spawn 的 flag 组 + 后台 + timeout，path prefix 改为 `resume <SESSION_ID>`）：

```
Bash({
  command: "CODEX_TIMEOUT=21600000 ~/.claude/bin/codeagent-wrapper --progress --backend codex resume <SESSION_ID> - <WORKDIR> <<'EOF'\n<resume-prompt>\nEOF",
  run_in_background: true,
  timeout: 21900000,
})
```

`<WORKDIR>` 在 resume 上与 spawn 同等重要、且同等生效（wrapper ≥ 5.9.2）：它决定被恢复的 agent 在哪棵树上工作，与 `<SESSION_ID>` 决定的"哪段对话"是两回事。写错或省略不会报错，只会让「自己找文件 / 自己产出 diff」这类步骤静默作用在别处。

Codex harness 对原 collaboration agent 发 follow-up task，语义与上面 resume 相同。两条路径的 prompt 都走 trust-the-model——只列与本次 continuation 相关的 supervisor 裁决：Stop Gate fail 项及证据、Trajectory Gate verdict 与方案调整、执行期间新增的用户决定，以及 plan 路径和（若 long-task）当前 state.md / journal.md 摘要。**不复述 gate 全文或主对话**——Codex 重读 reference / state 文件即可。

### 3.5 单元 review gate + commit（单元验收的收口）

单元验收证据合格后、进入下一单元（或 §4）前：该单元 diff 过 `~/.claude/skills/review-gate/SKILL.md`，gate 通过即按 `~/.claude/skills/create-commit/SKILL.md` 提交该单元——commit 粒度 = review 粒度 = 工作单元。定档 / 分档执行 / 修复闭环 / 裁决全部沿用 review-gate 原文（含其对 plan `(A,V)` 的组合，见 rigor-tiers.md），本节只列 execute-plan 语境的 delta：

- Review ownership 与去重按以下顺序裁决：
  1. supervisor 先盘点本单元已有 reviewer 的对象 / diff 边界、失败类别、独立性、continuation handle 与 verdict。
  2. 先保留 plan 与后续用户决定要求的 reviewer multiplicity。
  3. 每个 retained charter 启动前都冻结 closure contract。尚未启动的 charters 只有在 reviewer mechanism / expertise、独立性拓扑、scope、evidence、return schema 与 closure 全部兼容时才合并，并分别返回 verdict；任一不兼容则保持独立。已完成 review 只覆盖其原 prompt 与证据实际满足的 contract，不事后扩张。原 handle 不可续用时按该 contract 的 replacement semantics；只有 contract 允许定向 closure 时，才按原 transport 新起 reviewer，传原 charter / finding、修复 diff 与原返回契约，只做 closure。
  4. 产品语义 judge、LLM report gate、UX 测试与代码 gate 验证不同风险，不互相替代。实施前参与设计或修法的 reviewer 不算生成后独立 gate。
- 指令 artifact 单元走专项路由：单元 diff 为指令 artifact（skill / command / reference / principles / CLAUDE.md·AGENTS.md——类型集以 review-gate「专项路由」定义为准）时按 review-gate 专项路由接管（走其映射的对应专项 command，无 backend 选择）；findings 修复随该专项 command 自身的主-session 交互修复闭环施加，不经下面「修复路由」、不 resume implementer——专项 command（review-skill / review-claude-md）是主-session 交互工作流、无法在 Codex resume 里跑，构成对「不接管」不变量的显式例外（见关键不变量）。下面「修复路由」只适用其余代码单元。
- review 对象：working tree 中本单元改动（含 untracked；剔除输入 gate 后冻结的 `baseline.patch`、plan.md 同目录的规划 audit trail，以及 §4b/4c 测试证据文件；staging 判据同 §5 Scope）。implementer 不自行 commit（§1）+ 上一单元已 commit ⇒ 未提交部分即本单元。implementer 改动与 baseline 撞同一文件时立即 `AskUserQuestion`：有可用 pre-image diff 则拆出 baseline hunk 后 commit / stash，或授权整文件并入本单元一起 review + commit；无可用 pre-image 的 untracked / binary 文件只能整文件并入或整文件留给用户。用户保留的文件不作为已 review 内容，§6 注明。
- 修复路由：CRITICAL/HIGH findings 视同单元验收 fail。进入新的 closure 修复轮前先过「Trajectory Gate」：review 证明的是 artifact 当前有缺陷，不证明保存它仍是最小充分方案；简化、替换或删除 artifact 也可以是正确修复。当前执行方案仍成立时再路由回该切片的作者：implementer 切片续用该单元 handle；supervisor 切片（§4.5 品味工件等）supervisor 自修。修复后先按证据失效范围恢复 plan verify，再让每个被失效的 retained charter 沿自身 continuation handle / closure contract 复核；单元 gate 沿 review-gate closure，合并调用中的各 verdict 也分别闭合。closure 修复若再改 artifact，则重新做失效分析与 verify。任一适用 gate 未过不 commit、不进下一单元。
- 定档照常生效：trivial 单元显式免审声明后直接 commit——不为低风险单元付固定 review 成本。
- 覆盖一切入 commit 的 diff：单元 commit 之后新增的改动（典型：§4 UX 修复）入 commit 前同样过本节 gate——小修复按定档自然落轻档。同一 root cause / 失效域、必须一起成立的强耦合修复组成一个 mini 单元，走「失效分析 → 恢复 plan verify → gate → commit」；无关修复不得混装。

### 4. UX gate：ux-contract 同步 + hybrid 测试

> 「UX 契约影响」与「UX 入口」均为 create-plan 在 plan.md 写入的声明（见 create-plan §2「UX 契约影响」facet + L2 user-facing verify 段）；本节按这两个声明分流。

**触发解耦成两条独立条件**：

| 子步 | 触发条件 |
|---|---|
| 4a + 4b（ux-contract 同步 + 契约驱动验证） | plan「UX 契约影响」段非 skip（该段的字段定义见 create-plan §2 facet；无影响 / 产品无 ux-contract 则该段标 skip）|
| 4c（探索式 test-ux） | plan 的 L2 给出 agent 可作为真实用户访问的产品 instance（按 `/custom:create-plan` 三层 framing；物理形态无关——部署 URL / staging / 体验版 build / 小程序 instance / desktop 安装包 / agent-accessible 本地端口等，以 plan 实际描述为准），**与 ux-contract 是否变化无关** |

- 两条都不满足（纯内部重构 / 无 UX 入口且无契约影响）→ **§4 整段 skip**，直接进 §5。
- ux-contract 中性但用户可感知的变更（如 UX bugfix）→ 仅 4c 触发，**跑 test-ux、不跑 4a/4b**。

4b / 4c 的独立 Codex test contexts 统一按 §1 当前 harness transport 启动并记录 handle，等待与裁决沿 §2 / §3；两步只借下游 command 的测试 recipe，不内联其完整 supervisor。

**4a 应用 ux-contract 更新**

本步是 docs-organization-protocol 的 contracts/ 段主路径的【自主执行阶段】。由 Codex implementer context 把 plan「UX 契约影响」段记录的 L2 条目 + section delta + 已对齐决策 apply 进 `docs/contracts/ux-contract.md` §X；该 apply 任务随完成代码的那个工作单元的 spawn-prompt 下达（§1.5 轮换后未必是 §1 首个 context，apply 指令见 create-plan facet 产出 (d)）。这是执行 plan 已批准意图、**非静默改**。

- **no-silent-edit 不变量**：若 Codex 在应用时发现 ux-contract 需要 plan 未记录的改动（出现了 plan 没覆盖的取舍）→ 停下，supervisor `AskUserQuestion` 让用户拍，不静默扩展 ux-contract。
- **L1/L2 成对写入不变量**（docs-organization-protocol contracts/ 段同名不变量的创作侧，apply 步是它的强制点）：新增或修改任一 L1 承诺时，同一次编辑内写出其对应 L2 验证条件；plan 没提供的，按 no-silent-edit 停下交 supervisor，不落无验证条件的承诺。

**4b 契约驱动验证（借方法、不嵌命令）**

ux-contract 在 4a 更新并冻结后，把本 plan「UX 契约影响」段列出的变更 L2 条目翻成 test step、用独立的 Codex test context 跑（区别于 implementer context——测试不污染实现上下文）。翻译与 test prompt 构造照 `~/.claude/commands/custom/execute-ux-contract.md` §1（L2 翻译 + Plan 确认门）+ §2.1（Test prompt 构造 + 端到端原则）的 recipe——supervisor 读这几段借其法、不调命令；引用文件给路径让 test context 自读，不复述。

- **L2 翻译歧义时**（一条 L2 有多种合理判据解读）→ supervisor 先 `AskUserQuestion` 让用户裁定，再 spawn test context（对齐 §1 Plan 确认门）。
- **execute-plan 专属 delta**（借 recipe 时按本 command 语境补/改这几处）：test step 源自本 plan 变更 L2 条目的翻译、scope 限变更条目不全量重测；recipe 里 `<plans 子目录实际路径>` 产出位置改为 plan.md 同目录的 `issues/`（供 §4 严重度裁决的 issue 回链复用）；recipe 内一切自指「本 command 文件 §X」解析为 `execute-ux-contract.md`、非本文件。
- **不内联调 `/custom:execute-ux-contract` 命令**——它是完整 supervisor（建自己的 `plans/<>-ux-test/` 子目录、跑多轮 test-fix、做自己的 commit），内联会 supervisor 嵌 supervisor，其 commit / state 与本 command §5 commit / state 冲突。独立的 `execute-ux-contract` 命令保持现状不动，供用户需要时单独跑全量 ux-contract 验证。

**4c 轻量 test-ux 探索**

借 `/custom:test-ux` 的对齐、端到端测试、test-prompt 与 issue contract recipe 跑探索式测试，抓 ux-contract 没写到的 unknown-unknown。输入 UX 入口 + plan 功能预期摘要 + 真实验收环境的适用项（如账号、配额、副作用范围）。

**严重度裁决**

4b / 4c 任一产出 issue 后按严重度裁决：

| 严重度 | 处理 |
|---|---|
| 任一 Critical / High / Medium 未解决 | 视同 Codex 早停——续用实现该改动所在工作单元的 implementer handle（§1.5 轮换后未必是最新 handle，按 issue 定位到对应单元；4b/4c 的 issue 都路由回它修），传 issue 文件路径 + 关键证据摘要 + plan 路径，要求按 §3.5 的 mini 单元边界修复；失效的 plan verify 必须在 gate / commit 前恢复，commit 后再按 `plan-execution-principles.md`「Verify 证据新鲜度与失效」重跑被失效的 4a/4b/4c 下游子链路 |
| 仅剩 Low | 写进 §6 最终 handoff 让用户决定是否当场修，不强制循环 |

UX 修复循环按 §3 同一套 Stop Gate 收敛——**同一类 issue 连续修复指令未推进时**，supervisor 必须先独立排查（transport 是否丢输出 / repo 当前状态 / supervisor 直接跑 issue 复现命令 / 报告是否有歧义），再决定是否把 blocker 升级给用户。

### 4.5 AIGC / 语义质量任务的监督升格

**触发条件**：plan 交付物的质量取决于 prompt / 生成内容 / LLM judge（AIGC 产物、语义判官、分类器等非确定性工件）。纯工程型 plan 不触发。

触发后，supervisor 的职责在 §2-§4 基线上升格三条：

1. **亲自抽看产物 + 语义一致性评测**：supervisor 对生成产物做小样本多模态抽查（看图 / 读文 / 听音），形成独立质量判断——implementer 自报、自动 gate 通过、测试全绿都不能替代这一眼。抽样即可，不全量看（成本控制）。**关键区分（此处最易失守）**：元数据 / 代理判据（标签互异、计数达标、格式合规、"N 个不同标签"）**不是**语义一致性评测——必须核对**产物内容本身是否表达了目标属性**（标注"困倦"的图是否真的显困？标注的情绪 / 类别 / 意图是否在像素·文字·音频里真实成立），靠看内容、不靠看标签；label / metadata 可以全绿而内容全错，正是把「标签验收」误当「质量验收」这一步漏掉，会让漂移直达用户。有条件时用 **LLM-as-judge 对输出的目标属性**做自动化一致性 gate；产品 pipeline 若已有 / 本应有此 judge，核实它已接线且有效（judge 缺失、断线或只审上游代理物而非最终产物 = 无 gate）。
2. **品味工件设计权归 supervisor**：生成 prompt / judge rubric / 评分协议这类品味工件，由 supervisor 主导设计与修订（implementer 负责接线、测试、批量执行）；至少做到逐版审查。"不接管"不变量对品味工件不适用（见关键不变量的限定）。
3. **质量不达标先诊断再派活**：靠"亲自看产物 + 读判官原始输出"定位根因（措辞问题 / 机制问题 / 上游设计问题），再下发针对性修复——禁止把"再改改 prompt"原样丢回 implementer 重试。

依据：生成质量卡住时，靠 implementer 逐版改 prompt 文笔常推不动——根因可能在机制 / 上游设计（如 judge 拿生成所用的同一描述当批改答案的循环论证），措辞 / 机制 / 上游设计都可能、别预设，只有 supervisor 独立看产物的诊断回路能定位。

### 5. 文档同步与收尾 Commit（plan 完成时）

单元代码已在 §3.5 逐单元过 gate + commit——本节只处理收尾：文档同步产出 + 漏在单元 commit 外的残留改动。

**判据**：§3 走到「Codex 完成 + 给出 verify 证据」分支 + §4 UX gate clear（或 N/A）。§3 走到「Stop Gate 不满足」或「Codex 异常」分支时不走本节——"半成品不入 git history"按单元粒度执行：已过 §3.5 gate 的单元 commit 是成品增量、留在 history；未过验收的在制单元不 commit、不追加收尾 commit。

```
完成判据 → sync-docs 完整 recipe
                 ├ UX contract 超出已批准 delta → 回 §4 apply / verify → 审查循环
                 ├ 原则缺口获准 → owning repo 独立 commit → 审查循环
                 ├ 原则缺口拒绝 → 继续当前文档审查
                 └ clean → 残留 review gate → 目标 repo commit → handoff
```

**文档同步（commit 前先做；借 recipe、不嵌命令）**：每个完成的 plan 都按 `~/.claude/commands/custom/sync-docs.md` 的「被 supervisor 编排复用」契约，执行完整 recipe；不内联调用 `/custom:sync-docs`。不能再以「无用户可感知变化」跳过——协议的同步源还包括 plan/spec、journal/state 与 diff 改变的 Developer / Agent 文档。单元执行中 implementer 改的文档、或任何单元级手动文档更新，都**不等于**本节的完整 recipe——不得以「某单元即同步载体」替代 §5 的独立完整 recipe（doc-updater 系统识别 + 独立中立 review）。§3.5 单元 commit 走 create-commit 时被其文档 checkpoint 的 caller 例外豁免（文档统一由本节兜），故本节是 execute-plan 文档同步的唯一收口，必须可靠触发：plan 判为完成后又追加改动产品行为 / 服务 / 接口的单元或工作时，重新触发本节。

先从 plan 所属工作树确定目标 repo 的绝对根路径 `target_repo`，把 CWD 切到该路径后再进入 recipe。传给 recipe 的改动语境须包含用户原始 task、plan 路径、spec 路径（如有）、long-task 时的 state/journal 路径、本 plan 各工作单元 commit hash，以及收尾残留 diff；让 doc-updater 和 review subagent 直接读这些源证据。审查范围限于本 plan 波及的文档 + 索引 / cross-ref，不扩成全 repo 文档审计。

**plan 自己的「文档同步」段是 hint、不是 doc scope**（易踩的静默漏档）：recipe 的 doc-updater 系统识别独立扫全部文档类型（判定受影响文档，非全 repo 逐档审计）——**不得**把 plan 列的那几个文件当同步范围、直接照单喂 doc-updater 跳过系统识别。尤其两处协议要求、却常不在 plan 清单里的 **plan-completion 提升不可漏**：plan.md（+spec）归档到 `docs/plans/<YYYYMMDD>-<short-name>/`（`docs-organization-protocol.md` §4.5，附 Archive-status 头）+ journal 的 `[decision]`/`[decision-revision]` 评估提升为 ADR（§4.4）。

execute-plan 专属 delta：

- **UX ownership**：`docs/contracts/ux-contract.md` 内容仍由 §4a 独占。审查可以报告 contract finding；若修复超出 plan 已批准 delta，按 §4a no-silent-edit 让用户拍板，获准后回 §4 重新 apply / 验证，不在本节直接改完后收口。
- **Commit ownership**：目标 repo 内 recipe 只产出项目文档编辑及本节授权的 supporting artifact；本 command 显式承接其 review gate、staging、commit 和最终 handoff。gate 修复若改变文档或其陈述事实，重新进入 recipe 的文档审查闭环。
- **原则缺口独立提交**：由 recipe「原则缺口决策与修复」支路完成 owning repo 的 scoped 独立 commit。完成后回目标 repo 继续文档审查，最终 handoff 同时列出该 commit hash；不并入目标 repo 的收尾 commit。
- **Gate 恢复**：recipe status 为 `awaiting-caller-gate` 时，对其返回的 supporting artifact 执行 review-gate；gate passed 后按恢复点续跑 recipe，改变文档事实时把结果送回失效分析。gate blocked 时保留 `recipe=awaiting-caller-gate + gate=blocked + resume point`，按 Stop Gate 交接；只有 recipe 返回 `converged` 才进入后续收尾。
- **Blocked 分流**：recipe status 为 `blocked` 时不进入残留 review gate / 收尾 commit，也不宣称 plan 完成交付；按 recipe 恢复点和 Stop Gate 输出可执行交接，解除后重进本节。

**Scope**：
- 进收尾 commit：文档同步的产出 + recipe 授权且已过 gate 的 supporting artifact + 漏在单元 commit 外的本 plan 残留改动
- 不进 commit：plan.md 同目录规划 audit trail（plan.md / state.md / journal.md / issues/ 等过程产物）；§4b/4c 测试证据等过程性产物；repo 中与本 plan 无关的 in-flight 改动；runtime / build artifact——本判据同样约束 §3.5 的单元 commit
- 残留 diff 过 review-gate 后才 commit（引用各单元裁决、不重审已过 gate 的 diff；纯 doc 产出通常落 trivial 免审）

**执行**：按 `~/.claude/skills/create-commit/SKILL.md` 提交——Scope（见上）作 staging 判据，message 沿用 skill 格式、不手写。单元 commit 已覆盖全部改动且无 doc 残留时，本步无新 commit。

### 6. 最终 handoff（用户拿到的唯一交付物）

中文回复，内容由实际执行轨迹决定：

**必含**

- implementer continuation handle 列表（wrapper session id 或 collaboration agent handle）+ plan 路径
- commit hash 列表（§3.5 各单元 commit + §5 收尾 commit 的可追溯 anchor；某步无 commit 则注明原因，如 diff 为空 / Stop Gate 未满足）
- 变更摘要 + 关键文件
- 已跑的 plan verify + 可观察证据。任何走**判据降级**路径结案的 verify（见 §3 / `plan-execution-principles.md`「判据不可降级」），作为显式 delta 列出（plan verify 原文 vs 实际交付值 + 降级理由），不报为普通"达成"
- 各单元 review gate 裁决摘要（含 trivial 免审声明与 waive 记录）
- 文档同步的完整 manifest：recipe / caller gate status transition 轨迹与当前状态（含 `awaiting-caller-gate + gate blocked` 的合法 stop）、审查范围、实际起草 / 编辑的文档 / supporting artifact / 原则文件、coverage 状态与轮数、原始范围终审结果、最终 findings / decisions / edits、未解决的取舍 / 缺失依赖 / 写入阻塞及恢复点、caller gate 结果（均为 0 / 无时也明示，以区分 clean run 与未执行）
- 文档同步的原则缺口支路状态：not-triggered / committed / rejected / deferred；非 not-triggered 时附原因，committed 时再附原则文件 owning repo + 独立 commit hash + scope
- supervisor 的简短判断：是否遵循 plan / long-task / Stop Gate / 残余风险

**适用时含**

- 跑过 §4 UX gate：契约驱动验证（4b）/ test-ux（4c）的轮次数、最终 issue 状态、ux-contract 是否已 apply（4a）、未阻断交付的 Medium/Low 残留及定位
- Long-task 模式：state.md 最终状态简述（Tasks 全 done / Open Issues 全 closed）

若最终是合法 stop 而非完成（罕见，必须通过完整 Stop Gate），按 plan-execution-principles §5「Stop 时给清晰可执行的交接信息」格式：为什么停（直接证据级别） / 阻塞哪一步 / 已独立覆盖什么 / 用户具体动作。并提示用户做完后可重跑 `/custom:execute-plan <same plan path>`。

---

## 关键不变量

下面这些 SOTA supervisor 默认不会做，失守会让本 command 退化：

- Context 复用以工作单元为界（§1.5）：SOTA supervisor 默认会一刀切（死守一个 context、或逢停就开新）——两个方向都丢：单元内乱开新 context 丢上下文（= 付两份 token），单元边界死守旧 context 则膨胀拖质量。机制与边界判定见 §1.5。
- transport 报错先归因 transport / 适配层：Claude Code 检查 wrapper，Codex 检查 collaboration agent / mailbox；只有观察到第三方原始响应（HTTP 体 / API error code / 状态页）才能写"外部不可用"。
- 等待不做空轮询：Claude Code 用后台任务 + 增量轮询，Codex 用 collaboration mailbox wait；不要用空 model turn 反复查询未变化状态，不要因为等久就 kill，也不要把"在等待"当 stop 理由扔给用户。
- 环境争用要主动处置：Codex 反复对抗可解的资源锁、cron / launchd 抢占、端口冲突或 stale 锁时，supervisor 主动做可逆干预；副作用不确定或触及线上时再 `AskUserQuestion`，见 `supervise.md` §3「环境争用监测」。
- 语言契约：与 Codex / 工具交互 English；与用户交互中文。
- Stop Gate 是三方统一的收敛规则：管 Codex 的 stop、管 UX 修复循环、也管主 session 自己作为 supervisor 决定停下时——没有这层统一，任一循环都会被错误地按"N 次重试"逻辑收敛。
- 不替 Codex 编 Stop Gate 满足的理由：复核早停时逐项要 supervisor 自己的独立证据，别把 Codex 的自报当"已满足"放行——想收尾时最易发生，一放行「识破早停」(收益 #2) 即失效。
- 入 git 的 diff 必先过单元 review gate（§3.5）：SOTA supervisor 默认会把 review 攒到最后一次性做（整 plan 巨型 diff 审不动）或放任 implementer 执行期自行 commit（绕过 gate 的零审路径）——两个方向都丢 review 粒度。implementer 不自行 commit 是此不变量的执行面。
- 生成后 review 只有一个 inventory owner（§3.5）：supervisor 统一识别风险类别、合并兼容 charter、续用原 reviewer 做 closure；implementer 不另起重叠 generic/final review。去重不跨风险 contract——产品语义、UX、代码正确性仍分别有证据。
- 验证按依赖失效，不按修改次数清零：最终 gate 的有效证据必须覆盖最终状态；无相关变化的本次执行证据继续有效，相关变化后只重跑被失效的最小验证与必要的最终 gate。
- Long-task 模式下 state.md / journal.md 是交付证据：Codex 声称完成但两份文件没更新 → 视同 verify 缺项，续用原 handle 让 Codex 补。
- 不接管 plan 范围内的代码改动：supervisor 修 transport / 适配层允许；替 Codex 写 plan 范围内的代码不允许——绕过 supervisor 定位。限定：prompt / rubric / 评分协议等品味工件不算"代码"，§4.5 触发时其设计权本就归 supervisor。另一例外：指令 artifact 单元走专项路由时（§3.5），findings 修复随专项 command 的主-session 交互闭环施加、不续用 implementer——非绕过 supervisor 定位，而是 review-skill / review-claude-md 只能主-session 跑。
