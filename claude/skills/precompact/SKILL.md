---
name: precompact
description: Use when 用户在 compact / 上下文压缩前要求先把关键信息落盘、或要你检查关键信息是否都已落盘并补上缺的。把本轮只活在 context 里、而压缩后续跑要用的事实补进本 session 既有的台账，并报出仍未落盘与仍未核实的项。不用于任务收尾归档；把工作交接给一个没有本会话上下文的新 session 走 /custom:create-handoff。
origin: 2026-08-19（源：video-eval-arena program `20260819-rt-puremodel-arm`，用户提醒后补写的那批续跑事实；复盘见 ai-agent-config `docs/issues/harness-issues.md` HARNESS-222）
---

# precompact

骨架：定落点 →〔确无台账 → 指路 `/custom:create-handoff` 并早退 ｜ marker 的 `type` 认不出 → 报诊断、待用户指定落点后再续〕→ 扫缺口 → 抽验 → 写盘 → 清账。任何早退或中断路径都照样产出清账回复。

本 skill 只读 run-program 与 long-task-protocol 的既有契约。**落点必须与恢复 briefing 会读的那几个文件严格同一份**——那份 briefing 由 `claude/scripts/hooks/post-compact-restore.js` 在压缩后注入新 context，是压缩后的 agent 拿到的唯一线索。它不判断"是不是该落盘了"：用户的这次触发就是那个信号。但被模型自动命中、而非用户点名时，先按〔扫缺口〕跑一遍再动写操作；扫出来为空就不写盘，仍按〔清账〕给出四项后结束。

## 定落点

```bash
~/.claude/bin/active-plan show
```

无 marker 时它以 exit 0 打印 `no active plan declared`；有 marker 时打印 marker JSON。按其中的 `type` 字段分四态，**不得退化成「非 program 即 plan」二分**（ADR-005 `marker-type-four-state-classification`，作用域覆盖全部消费者）：

| marker 的 `type` | 台账目录 | 有 lifecycle 的事项写哪 | 无 lifecycle 的认知写哪 |
|---|---|---|---|
| `"program"` | run-program 台账目录 | `program.md`：属于某个 task 的更正改**对应那一行**（哪些事实归 ledger 权威，以 `run-program.md`「ledger 只对 program 级事实有权威」那句列举的为准，别照本文另记一份短名单）；横切整个 program、不属于任何行的写**十列表格以外的正文** | 同目录 `journal.md` |
| `"plan"` | long-task plan 目录 | `state.md`：条目级的进 Tasks / Open Issues；横切整个交付物、不属于任何条目的写进**条目外的那一段**（只保留一段，改写到当前真值），并**保有**一条指向它的 Open Issue | 同目录 `journal.md` |
| 字段缺失（marker 早于该字段） | 按 legacy plan 处理 | 同 `"plan"` 行 | 同 `"plan"` 行 |
| 其余任何值（含非字符串） | 不冒充任何已知形态 | 报诊断、请用户指定落点，不得落进下面的「确实没有台账」分支 | — |

**承上表 plan 行**：条目外那段与那条 Open Issue 都**不是上游契约**——`long-task-protocol.md` 的 state.md 只有 Tasks / Open Issues 两节，「字段不够用时自由追加」那句的作用域是一条 task 内部的字段。本 skill 仍这么写，是因为两轨的恢复指令不对称：program 分支有一句点名的「表格以外的正文一并读」，plan 分支只给到文件级的 `read state.md and journal.md`，其 action 还把注意力收窄在"接续 in_progress 的那条 task"上——条目外的段落因此只被泛读覆盖、不被点名。用 Open Issue 而不是 Task 作锚有两条理由：briefing 在 plan 分支里**唯一点名的条目类型就是它**（`open issues live here`，仅在 `state.md` 存在时打印），而它又确有 lifecycle——内容被折进各 task 的字段后 `resolved`，折不进去的（读数、估计一类）按 `wontfix` 加一句说明收尾，别让它永远 open 卡住完成核对。这条 exposure 还要按〔清账〕报出来。

用户在调用时给了台账路径就用它，没给才取 marker。落点只认 marker，不要扫 `plans/` 挑 mtime 最新的目录（成因见 `~/.claude/references/long-task-protocol.md`「声明 active plan」节）。

非零退出一律不是关于 marker 的读数：`NOTHING WAS READ OR WRITTEN` 表示无 session id，按其自述处置，别把它读成「无台账」。

无 marker 时不要静默跳过，按实际情形分两种：

- **能指认出本 session 正在执行的台账**（用户说了，或本轮确实一直在写某个 `program.md` / `state.md`）→ 补 marker 后再落盘。补之前先用 `AskUserQuestion` 让用户确认路径与类型——`active-plan set` 收的是那个文件的路径（不是目录），而 marker 按 session 持久化、写错不是本轮可撤的：它会把错的目录注回之后每一次压缩，并让 `create-handoff` 误判为不需要交接。文件是 `program.md` 时 `--type program` 必给：缺省值是 `plan`，给错不报错，但恢复 briefing 会走 plan 分支，那条「表格以外的正文一并读」的指令整条不出现——本 skill 的主要落点在恢复侧读不到。它唯一的信号是**指错方向**的那一种：`active-plan set` 会 warn「`state.md` 尚不存在」、恢复 briefing 会打同样的 NOTE（program 目录本就不用 state.md，故必触发），说的是缺文件、不是类型给错。看到这两句就回来查 `type`。
- **确实没有台账** → 明说落不了盘，指向 `/custom:create-handoff`，照常给清账回复后结束。不要为此现造一个台账目录。

## 扫缺口

**Lens**：压缩后的那个 agent 手上只有台账 + journal + 一份恢复 briefing。凡是要靠本轮记忆才知道的事，现在不写就没了。

**操作化的扫法**：逐条扫状态载体——条目自身的状态先刷到当前真值，然后问那个真正吃力的问题：*本轮我知道、而任何一个条目都装不下的是什么？* 状态载体按条目切分（program 侧是十列表格的行，plan 侧是 TASK / ISSUE 条目），实测两次丢失的都恰好是不属于任何一个条目的东西，逐条走一遍结构上就捞不出它们。

下面是实测真丢过的类别（**不限于此**，它是记忆触发器不是清单）：

| 类别 | 实测形态与纪律 |
|---|---|
| 目标本身被追加或收窄 | 实测：`goal` 那一行写于 `created_at`，用户几小时后追加的约束从未回写它，而压缩后的 agent 与 run-program 的 Stop Gate 都把它当权威读。**先回写 `goal` 本身**，再在条目外补细节——只写细节等于把那行留成假的 |
| 照抄即可的长命令 | 试跑真正跑通的那条批次命令。不许写"见 journal 里那几条"——那些散在多条日志里、还带着 `--only-run` 之类的临时收窄，接手者拼不回来 |
| 起跑前必做的准备动作 | 清占用的端口、revision 现取别抄。漏了不报错，只是拿到一份与旧 attempt 逐字同形的日志 |
| 当前该在哪棵树上继续 | 各 commit 分别落在哪个分支/工作树，以及后续都在哪棵合流树上做。缺它接手者会回到某个单边分支继续改 |
| 外部评审/子任务的续接方式 | 决策评审的 session id、它给的应修条目原文、以及"改完只需两问复核、不重开全审"这类续接契约 |
| 推翻过某个解释的对照读数 | 曾经的因果归因被哪次对照实测推翻。不写，下一轮会重新得出那个已被证伪的结论 |
| 下游未跑段的具体闸与风险 | 点到 `file:line` 的那道闸、以及"还有几道没走"这个未知量的规模 |
| 用户在过程中提出、约束交付物整体的要求 | 这类要求不属于任何条目。实测一次审计：11 条原子要求作为交付判据的捕获率 0/11 |
| 带不确定性来源的时间估计 | 估的是什么、不确定性来自哪 |

别把触发面理解成"压缩风险"：实测第一笔损失发生时并未发生压缩——同一 session 后段就已无法回忆那条命令，只能从 argparse parser 反推、连踩三次才重建。**距离产生它的那一轮远了**即可丢失。这是扫描时该带的宽度，不是本 skill 的触发条件。

## 抽验

凭记忆先写，但对"记错了后果最重、验证又最便宜"的那几类**当场取一次读数**：commit sha、分支与工作树路径、文件路径、端口、外部 session id。这些正是源实例里实际靠 `git log` 与任务 `.output` 核出来的几类。

通用的取证判据归 `~/.claude/references/evidence-sufficiency.md`；本 skill 独有的是那条不对称：**记错的事实写进盘比不写更坏**——压缩后的 agent 没有任何办法发现它错了，会当权威用。取不到读数的照写，标"未核实"；读数与记忆不符时以读数为准，并把被推翻的那个记忆值一并记下（它常常正是别处推理的隐含前提）。

## 写盘

- 分类轴见 `~/.claude/references/long-task-protocol.md` 的「lifecycle 是分类轴」与「为什么 mutable vs append-only 拆两个文件」两节；两轨各自的具体落点由上面的落点表给出。
- 条目外的那段标一个当场时钟读数作为它的刷新时刻。program 侧不要为了塞它去改十列表格的行结构，plan 侧不要挤进某条 task 的字段里。
- journal 条目的时间戳一律取当场 `date` 读数，不得凭记忆或推算。两轨都适用——`long-task-protocol.md` 只建议条目带 timestamp、未强制当场读数，所以这条在这里必须自足；实测锚点与该纪律的由来见 `~/.claude/commands/custom/run-program.md`「初始化 ledger」节。
- **只有 journal 是追加的**。`program.md` 正文与 `state.md` 是**可变 snapshot**：本次落盘改写它们到当前真值，不保留历次快照——逐次堆带时钟戳的叙事块，正是 ADR-015 拆两个文件要消灭的形态（实测 30+ 巡检叙事块淹掉状态表，接手者与恢复 briefing 都抓不到当前态）。要留"本次补了什么、依据哪条读数"就写进 `journal.md`。

## 清账

写完后给用户一段回复，含四项。**空值一律显式写出，并附一句依据**（扫了哪几类、扫到哪里为止）——无依据的"没有"与"没扫"读数相同：

1. 补进去了什么——按上面的类别点名，不是"已同步关键信息"。
2. 仍未落盘、只活在 context 里的还有什么。
3. 实际取过哪几条读数、各是什么值（commit sha / 分支名 / 端口号原文）。没有这一项，跑完抽验与整段跳过的输出完全同形。
4. 哪几条标了未核实。走 plan 轨且写了条目外那段时，这里一并报出那条已知 exposure（恢复 briefing 的 plan 分支只泛读 state.md、不点名条目以外，指向它的只有你留的那条 Open Issue）。

清账干净时明确告诉用户可以压缩了。

## 不做

- 不改 `run-program.md` / `long-task-protocol.md` / 恢复 hook，也不新建第三个状态文件——ADR-015 已把可变快照与 append-only 时间线的分工定死，第三个文件是第三个会被忘记的地方。
- 不做任务收尾：不跑组装级交付验证、不清扫耐久信息进 tracked docs、不删台账目录。那些是 run-program 收口的动作，此刻任务还没完。
- **有台账时**不写 handoff——有 active plan 还额外写 handoff 会立刻产生两份漂移的副本（见 `long-task-protocol.md` 反模式表）。确无台账那条出口不受此限，它本就该指路 create-handoff。
- 不替用户触发压缩。
