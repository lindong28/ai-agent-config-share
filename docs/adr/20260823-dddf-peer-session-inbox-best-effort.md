# ADR-20260823-dddf：peer session supervision 采用 Stop inbox 与确定性 watcher

- Status: accepted by the approved long-task plan; implementation review pending
- Date: 2026-08-23
- Refines: [ADR-009](009-autopilot-phase2-best-effort.md) 的 best-effort、非安全边界定位

## Context

用另一个 Claude Code session 定期运行 `review-session-progress` 能发现长任务 session 自己遗漏的问题，但原流程要用户手工复制介入内容。目标是让 session B 在健康期低成本等待，只在结构化异常出现时深审，并把确需介入的内容交给 session A，同时保留 A 的判断权。

该机制与被监督的 agent 处于同一可写 harness：A 能修改 hook、忽略消息或推翻建议。因此它不能成为可信隔离、授权证明或安全边界。

## Options Considered

### Option A: 每个采样轮次都运行模型深审

- Pros: 最及时，控制流简单。
- Cons: 长任务健康期持续消耗模型额度；无法兑现健康 tick 零模型调用。

### Option B: 确定性 watcher 分层，异常时才运行模型

- Pros: 健康采样完全留在本地进程；异常 episode 最多唤醒一次深审；state 可在 compaction/restart 后恢复。
- Cons: 阈值会漏报或误报；B 的 terminal 判断可能提前结束监督。

### Option C: 给 A 增加能强制采纳的控制通道

- Pros: 可以更积极地纠正 A。
- Cons: 与不 stop/resume A、不修改 A 的工作以及 best-effort 定位冲突；同一可写面也无法提供可信强制。

## Decision

选择 Option B。Claude Code only 的 `/custom:supervise-session <session UUID>` 启动独立 `peer-session-watch.js`。watcher 的健康 tick 不输出、不调用模型；只返回 `anomaly-candidate`、`terminal-candidate`、`cancelled`、`hard-timeout`、`already-watching` 或 completion retry 成功后的 `terminal`。异常身份固定为 `sort(unique(active_signal_codes)).join("+")`，不含正文、时间、review id 或随机值。

深审绑定 ref-reachable 有序接受列表中的 `review-session-progress.md` blob、被监督 target UUID，以及触发 episode 的 transcript path、`frozen_prefix_bytes`、mtime 与 `transcript_prefix_sha256` snapshot。当前列表只有 committed blob `39ae61d7eca4d6d86d8282275aa44b10b7eac88d`；不在列表内时错误同时报告 expected 与 found。接受 review 时允许 transcript 在冻结边界后继续 append，但拒绝短于边界或冻结前缀 digest 不同的对象；这种失配返回 `snapshot-stale` 并重新武装 episode。启动、深审、投递与重启前复查 compaction/fork；gate 记录的是自当前 target/transcript anchor 后出现的 superseding child session ids，而不是 target 自身的 parent history。发现 superseding child 时停止旧 target 并报告，不能继续写旧 UUID queue。

先从自然语言报告独立冻结 `section5_item_ids`，再让每个被声明为合格的 §5「需要介入的地方」与一个 supervisor-channel §6「给目标 session 的指令草稿」一一配对：inbox `body` 来自 §6，`evidence` 保存完整 §5 item；这项 per-item 收窄取代上游 §6 的单段形态。§6 含已填推荐默认值的 `【】` 用户可决位置时照常投递，并在该项通知中明示。四个 producer 计数必须等于同一个正数：模型声明的 §5 inventory、新 enqueue 或 exact duplicate 的 queue receipt、从 queue JSONL 按预期 transport record 回读到的条目、`im-notify` exit-zero；后两项分别命名为 queue write-back verified 与 intervention im-notify exit-zero，不声称 A 已消费或手机已收到。四个计数相等只证明声明的 inventory 与投递结果自一致，不能证明同一个模型已把自然语言报告中的全部 §5 完整转录；这一半仍是 model-bound，不能由生成该 JSON 的模型自我认证。真实 A-side reading 是 inbox ack，待 Phase 3 注册 Stop hook 后成为第五个计数。collision、部分失败和零 intervention 不能靠计数同形变成 complete；state 丢失后的 exact duplicate 由 queue read-back 作为 durable receipt 并继续通知。没有 suppression 分支。

Stop hook 注入的是未受信 supervisor 自报标签。A 在下一次 Stop 自行核实、采纳或推翻；transport id 只保证同一次 enqueue 幂等，不承诺跨轮语义去重。

### Phase 3 记录的升级路径（本阶段不实施）

若 Phase 3 live acceptance 证明手写 monolithic review JSON 的同类漂移仍影响交付，升级方向固定为：machine-known values 由机器生成、持久化并注入；semantic judgement 只由模型生成一次并成为 canonical source；跨 stage 的证明只传 receipt / context id，不再手抄值或复制 literal constant。本 ADR 只记录该路径，本轮不重构现有 review generation。

### 标定默认值

活动静默信号使用 `interval=60s`、`W=20`、`N=20`。标定对象是本机 `~/.claude/projects/` 当时 1,424 个候选中最大的 10 份真实 transcript。按 watcher 的 60 秒采样粒度分桶后，pooled median 为 60 秒；10 个 session 的 per-session median 中 9 个为 60 秒，`4ab94660` 为 120 秒。`N=20` 的 pooled false-anomaly reading 为 1.62%。因此默认行为应诚实理解为这批样本上的固定约 20 分钟静默阈值，不能宣传成已经证实会随 session 节奏自适应。

`M=180` 轮，即默认 3 小时没有新 commit。这个值**未由真实 commit timeline 标定**。辅助读数只覆盖 10 个大 transcript 中 assistant 发起的 `git commit` 命令：380 个内部间隔的 p90 为 108.9 分钟、p95 为 303.6 分钟，超过 180 分钟占 7.63%；命令可能失败或 amend，不能冒充 commit timeline。180 轮是 provisional default，理由是把 git 信号放在 activity 信号之后的低敏感档，而不是测量结论；它只在启动时显式给出且成功验证 repo path 时启用，禁用状态与读取失败分别持久化，不与健康的 `0`/`null` 共用表示。

首次 Phase 3 live 监督运行必须记录 healthy tick、anomaly candidate、terminal candidate 与 hard timeout 数量，并人工核对每个 candidate。若健康推进期出现 candidate，或超过 20 分钟无活动却未产生 candidate，重新评审 `N/W/estimator`；若一次正常任务的 commit 间隔超过 3 小时触发 `git_no_commits`，重新评审 `M`。在取得这轮读数前，两个阈值都只适用于本机当前样本与默认采样间隔。

## Consequences

- 健康浅层 tick 的模型调用和模型 token 都为 0；深审 token 由每条 review record 记录实际模型读数。
- watcher state 由原子 owner+lease claim 单实例推进；并发恢复者返回带 `owner_pid` 与 lease `deadline_at` 的 `already-watching`，不重复唤醒同一 episode。每个 wake 携 canonical `state_file`，加载路径与 state 内身份不一致时拒绝。git 与 `im-notify` 子进程各有 timeout，sleep 受 waiter deadline 截断。
- 同一信号集合不重复深审；集合变化、恢复后复发会重新武装。
- A 已 idle 后到达的消息不会唤醒或 resume A，只能等待下一次 Stop。手机通知 accepted 也不证明 A 已看到或采纳。
- `review-session-progress` 原只读边界中「给目标 session 的一切动作都经用户之手」仅在本 supervisor channel 被显式取代；其余只读条款不变。该例外不唤醒 A，A 可拒绝，并逐项通知用户。
- B 可在 fresh 深审四项 terminal 条件均为 true 时自行结束监督；误判提前退出是已接受风险。completion report 必须先持久化，通知非零则保持 `completion-pending-notify`。
- runtime state、review、inbox 和 acknowledgement 字段是供人排查的数据契约；实现完成后统一交 `/custom:review-schema` 复核。
- `/custom:supervise-session` 明确进入 Codex wrapper denylist；Codex 不获得一个机械上不成立的同名入口。

## 本机制不保证什么

- 不保证 supervisor 标签、intervention 或 terminal decision 正确，也不证明 provenance 或用户授权。
- 不保证 A 采纳建议，不保证消息在 A idle 后主动送达，不保证跨轮语义去重。
- 不保证当前阈值适用于其它机器、其它 transcript population、其它采样间隔或未来 workload。
- `session-inbox` Stop hook 当前未在 `claude/settings.json` 注册，监督通道因此尚未 live。注册被四个 Stop owner 共用最终确认槽位的冲突阻塞，须由后续独立 plan 解决；本 plan 只交付未注册的 channel 组件。

后续 plan 必须把第三次 3-b 的四条 HIGH 作为注册前输入逐项关闭：

- 重复 `IN-FLIGHT` 在没有 runtime owner 校验时可伪造任务数量；不能仅靠 parser 累积重复 segment。
- 精确分隔符 `" | "` 会与合法自由文本（例如 shell pipeline 说明）冲突，使整条确认 envelope 作废。
- 固定 `.held.<pid>` 回收路径会在 PID 复用时覆盖旧 recovery inode，重新造成已打开 fd 写入不可恢复。
- ISSUE-011：回滚命令与 `.held` 语义没有进入候选锚点覆盖的 tracked 持久载体。后续 plan 重引注册时，必须把可执行回滚 procedure 及其 recovery-file 语义落入 durable tracked carrier，再把它作为注册 gate 的审查对象。

以下是 closure ruling 明确接受、留待后续的已知实现限制：

- `signal_availability` 仍是第二个由模型手抄的 surface，包含逐 tick 递减计数；mismatch 错误不报告 expected-vs-found。
- `rearmAfterSnapshotStale` 清空 `pending_review_snapshot` 后，重复提交旧 review 会落到 generic path-mismatch，`code` 不再是 `SNAPSHOT_STALE`，因此不走结构化 `snapshot-stale` exit。
- watcher lease 没有 generation fencing：release 的 read-token 与 rename 分两步，旧 owner 可能删除其间接管的 successor claim；state writes 同样没有 generation fencing。
- record/deliver 的 `kind` namespace 有七个成员但没有单一 enumeration table；`review-recorded` 与 `delivery-complete` 未在 command 的 watcher event 表中列出。
- `loadState` 只核 recorded path 等于实际打开路径，不核 canonical formula；一份 self-consistent legacy wrong-but-inside state 仍可加载。

## 起草期更正（2026-08-23 review gate）

本 ADR 尚未首次进入 git，按 ADR 索引的起草期规则直接修正正文：首轮把单一 blob pin 改为有序接受列表并绑定 target/trigger snapshot，把 `inbox delivered` 收紧为 queue read-back，并补充 watcher singleton、子进程 timeout、completion notify retry、evidence transport 与显式 signal availability；随后按用户 decision #10 改为 §6 body + §5 evidence，删除不可从 ref 到达的候选 blob，把 freshness 改为冻结前缀 digest，并补 fork fail-stop、真实 queue write-back 命名与 A-side ack 边界；后续以独立 `section5_item_ids` 关闭 count 自指，明确 per-item §6 收窄、canonical state path、snapshot-stale 与 signal roster；closure ruling 再把四数相等收窄为 producer 自一致、以 superseding child ids 取代 parent count、让 queue receipt 恢复丢失的 delivery state，并记录 Phase 3 的结构升级路径与五条 non-blocking limitation。授权来自 supervisor 转交的用户决定与集中修复指令；修订后的 artifact 尚待最终 gate verdict。

## 修订记录

### A-1（2026-08-23）：注册延期与 follow-up 前置条件

纯事实更正：Phase 3 的共享 ack-envelope 重构在连续三轮 3-b 中未收敛，用户裁决将其拆为独立 plan，并要求本 plan 恢复未注册状态。因此正文现在明确 Stop hook 未注册、通道未 live，并记录第三轮 3-b 的四条 HIGH 与 ISSUE-011 的 durable rollback carrier 要求，供后续注册工作消费。授权来自 supervisor 转交的用户裁决；本修订尚待当前 Phase 3-a 候选的 review gate。
