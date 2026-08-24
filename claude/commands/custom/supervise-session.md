---
name: supervise-session
description: Claude Code only. 监督一个**你没有启动、已经在跑**的 Claude Code session A（要监督由你启动的 agent 用 `supervise`）：在独立 session B 中用确定性 watcher 采样 A，并在结构化异常或终态候选时深审、逐条投递纠正信息。
argument-hint: "<complete target session UUID>"
disable-model-invocation: true
---

# supervise-session

在当前 Claude Code session B 监督一个目标 session A。`$ARGUMENTS` 必须且只能包含一个完整 session UUID；缺失或多于一个时拒绝启动，不替用户选择。

本 command 不适用于只想手动、只读检查一次进展的场景；那种情况用 `review-session-progress`。这里引用它是为了复用深审契约，不表示两个入口可以互换。

## 固定边界

- 一次运行只持久化一个 target。允许写入面限定为 `~/.claude/state/peer-supervision/` 与 `~/.claude/state/session-inbox/` 两个 root；前者保存 B 自己的监督状态、claim、cancel、快照与 review，后者保存 A 的 queue、ack 与 transport lock。越过这两个 root 即失败。
- 不 stop/resume A，不改 A 的代码、plan、state、journal 或证据。深审只读冻结快照。向 A 自动投递的唯一 override 在「深审授权」中定义；除那一句外，上游只读边界全部继续生效。
- 这是 best-effort 行为护栏，不证明消息 provenance，也不构成安全边界。A 在 Stop 看到 intervention 后自行核实、采纳或推翻。
- 消息若在 A 的某次 Stop 已结束后到达，不会主动唤醒或 resume A；它保持 pending，直到 A 的下一次 Stop。
- 不做跨轮语义去重，也不限速。每轮合格的 §5 条目都产生对应的 §6 草稿并逐条投递、通知；相同问题换一种措辞可能重复出现。
- 本 command 只适用于 Claude Code。它依赖 Claude transcript、Stop inbox 与当前 session model，不生成 Codex wrapper。
- 当前 Phase 2 尚未在 `claude/settings.json` 注册 Stop hook；注册前只能验证 watcher 与 inbox 组件，不能宣称 A-side 消费链路已生效。

## 启动

1. 取当前 B 的 `$CLAUDE_CODE_SESSION_ID`；取不到就停止并报告，不能用 mtime 猜。按 `review-session-progress` 的「定位 transcript」步骤定位 A，并执行其中的 compaction/fork 复查。上游在 ≥2 个 `.jsonl` 命中时用 `AskUserQuestion` 让用户选择；本 unattended supervisor 明确收窄为停止并报告全部候选，不静默挑选。以当前 target session id 与 transcript 作为 anchor，每次复查只记录自该 anchor 后出现的 superseding child session ids；没有新 child 记 `[]`，不能用当前 target 的 parent 数代替。发现 superseding child 时停止旧 target 的监督并报告 child id 与 transcript；不得继续向旧 inbox enqueue，也不得把旧 target 的 queue write-back 报作新 A 已收到。target 自身已有 parent history 不构成停止理由。
2. `command -v im-notify` 与 `im-notify --help` 只确认 `im-notify` 可执行。另读取 `FEISHU_GENERAL_NOTIFICATION_WEBHOOK` 是否存在且非空，只输出 `notification_webhook_configured=true|false`，不得打印值；false 时停止并报告配置缺失。这个布尔读数不宣称远端通知通道健康，真实发送结果仍以每次 `im-notify` exit code 为准。
3. 记录 B/A UUID、transcript 绝对路径、A 的 PID、可选 ledger 与 A repo 路径。标准启动要求解析出仍存活的 A PID；取不到时先报告 degraded mode，并明确 `terminal-candidate` 与 `ledger_stalled` 均不可达，再移除 `--target-pid`。
4. 用 Bash `run_in_background: true` 启动下列独立 watcher。6 小时 hard deadline 保证 watcher 自行退出；等待与巡检规则按 `background-agent-monitoring.md`，不要另写无上限等待器。

```bash
node "$HOME/.claude/scripts/peer-session-watch.js" watch \
  --target "<A-session-uuid>" \
  --supervisor "$CLAUDE_CODE_SESSION_ID" \
  --transcript "<absolute-transcript-path>" \
  --target-pid "<A-process-pid>" \
  --repo "<absolute-A-worktree>" \
  --hard-timeout-ms 21600000 </dev/null
```

`--repo` 的路径必须在启动时解析并通过 git worktree 检查；A 确实不在 git worktree 时，用 `--disable-git-signal` 替换 `--repo`，此时 `git_no_commits` 明确禁用。已核实 ledger 时追加 `--ledger`；给出的路径/PID 无法解析时 watcher 拒绝启动，不把失败编码成健康的 `null`/`0`。默认值不在启动块重复传入，避免文档过期后反过来覆盖程序默认值。健康 tick 全部留在 watcher 进程内，模型调用数为 0。

watcher 在启动及每次重启时把 `signal_availability` 持久化到 state，并在由 `wake()` 产生的事件中返回同一 roster。B 报告每个 detector 的 `armed`、`disabled(<reason>)` 或 `warming-up` 状态；缺少一个 detector 不得与“已 armed 但健康”共用静默读数。

| 调参项 | 当前默认与何时修改 |
|---|---|
| `--interval-ms 60000` | 每 60 秒确定性采样；只在需要改变检测分辨率与本地 I/O 频率时修改。 |
| `--window 20` | activity baseline 样本窗；累计满 20 个 activity intervals 前，`activity_silence` 与 `ledger_stalled` 都在 warming-up。后者还要再满足静默阈值，稳定 60 秒节奏下最早约 40 分钟才可触发。 |
| `--silence-multiplier 20` | activity/ledger 静默阈值倍数；中位数被采样下限钉住，所以当前默认实际是固定约 20 分钟阈值，不声称自适应。 |
| `--git-zero-rounds 180` | `git_status === "ok"` 的连续 180 个 60 秒采样无新 commit，即 3 小时；任一轮不是 `ok` 都重置计数。只读调查 session 会经常触发，必要时用 `--disable-git-signal` 明确关闭。 |
| `--hard-timeout-ms 21600000` | 单个 watcher 的 6 小时 hard deadline；续跑必须启动新的有界 watcher。 |

## watcher 事件与轮次

### 1. 处理 watcher 退出

| `kind` | 动作 |
|---|---|
| `anomaly-candidate` | 对固定快照做一次深审；同一 anomaly episode 不重复深审 |
| `terminal-candidate` | 仅配置 `--target-pid` 时可达；对固定快照做 fresh 深审，不能仅凭进程退出宣告完成 |
| `hard-timeout` | 记录与成功不同的 timeout 读数；若用户未取消且 A 仍可定位，启动一个新有界 watcher |
| `cancelled` | 报告取消并停止，不再启动 watcher |
| `already-watching` | 报告事件里的 `owner_pid` 与 `deadline_at`，然后停止；B 没有另一个进程的 completion handle，不等待它 |
| `terminal` | completion report 已先持久化且 completion `im-notify` exit 0；报告 terminal 并停止 watcher |

每个事件都携带 canonical `state_file`；后续命令只能使用该字段，不得从 target UUID、supervisor UUID 或目录命名重新推导。`ledger_stalled` 还要求 `--ledger`、`--target-pid`、目标进程存活、ledger 可读并完成与 `activity_silence` 相同的 baseline warm-up。`git_no_commits` 要求提供 `--repo`，且 `git_status === "ok"` 必须每轮连续成立。

每次深审前、每次投递前以及每次重启 watcher 前，都重新执行启动步骤 1 的 fork 复查；启动与重启读数当场报告，pre-review 与 pre-delivery 读数写入 review JSON。发现 superseding child 时走同一个停止并报告分支。

### 2. 固定快照与深审授权

使用 watcher 事件里的 `frozen_prefix_bytes`、`transcript_mtime` 与 `transcript_prefix_sha256` 作为 snapshot anchor，只分析冻结前缀以内的内容。当前 transcript 可以继续 append，但不能短于该边界，且前缀 digest 必须仍一致。`record-review` 返回 `snapshot-stale` 时停止本轮投递；watcher 已重新武装当前 episode，立即用同一 target 启动新一轮有界 watcher取得新快照，不沿用旧 review。

从 `peer-session-watch.js` 的 `REVIEW_COMMAND_BLOBS` 读取接受列表；索引 0 是当前优先 blob。每个成员必须能从 git ref 经 `git rev-list --objects --all` 到达。读取该 committed blob 中的 `review-session-progress.md` 正文并逐步执行，不能用 working-tree 同名文件替代；校验失败就拒绝，并报告 expected 与 found。

此 command 对该 blob「只读边界」中的一句作显式 override：在 supervisor channel 内，「给目标 session 的一切动作都经用户之手」由本 command 取代，允许把合格的 §6 草稿直接写入 A 的 inbox。理由是 inbox 不会主动唤醒或 resume A、A 可核实并拒绝消息、且每一项都向用户发送 `im-notify`；该段边界的其他所有条款仍然约束本 command。

此 command 还对上游 §6「一段指令草稿」作 supervisor-channel 收窄：先独立冻结全部合格 §5 条目的 `section5_item_ids`，再为每条 §5 分别写一个只覆盖该条、不引入新议题的 §6 草稿。也就是每条 eligible §5 恰好对应一个 §6 body 与一次通知；这个 per-item 规则取代上游单段形态，但不放宽上游的内容范围。

使用 B 当前模型，记录实际 model id 与 input/output token 数；不因不喜欢结论而 reroll，只有 transport failure 可重试。

### 3. 写 review JSON

`review-session-progress` 的自然语言报告仍按其八槽输出。先把报告中每条合格 §5 按原顺序独立转录成 `section5-1`、`section5-2`…，冻结 `section5_item_ids`；再单独生成 §6 interventions 并逐项引用对应 id。左侧清单与右侧 intervention coverage 是两次独立读取，不能用 `interventions.length` 回填左侧。

在 B 的 peer-supervision state 旁写 review JSON；字段名和值会被人读，缺失或 unknown 不得补猜：

```json
{
  "schema_version": 1,
  "review_id": "review-20260823T001000Z-001",
  "created_at": "2026-08-23T00:10:00Z",
  "target_session_id": "3f7b6aa1-f660-4ecd-9c67-cd6b61831c55",
  "snapshot": {
    "transcript_path": "绝对路径",
    "frozen_prefix_bytes": 0,
    "transcript_mtime": "ISO 8601",
    "transcript_prefix_sha256": "冻结前缀的 SHA-256",
    "ledger_path": null,
    "ledger_mtime": null,
    "review_command_blob": "39ae61d7eca4d6d86d8282275aa44b10b7eac88d"
  },
  "section5_item_ids": ["section5-1"],
  "interventions": [
    {
      "section5_item_id": "section5-1",
      "body": "§6 中可直接交给 A 的指令草稿",
      "body_source": "review-session-progress.section6_instruction_draft",
      "evidence": ["对应的完整 §5 介入条目"],
      "evidence_source": "review-session-progress.section5_intervention",
      "has_user_decidable_spots": false
    }
  ],
  "fork_rechecks": [
    { "stage": "pre-review", "superseding_child_session_ids": [] },
    { "stage": "pre-delivery", "superseding_child_session_ids": [] }
  ],
  "signal_availability": {
    "activity_silence": { "status": "warming-up", "remaining_activity_intervals": 3 },
    "ledger_stalled": { "status": "disabled", "reason": "ledger-not-configured" },
    "git_no_commits": { "status": "disabled", "reason": "git-signal-disabled" },
    "terminal_candidate": { "status": "disabled", "reason": "target-pid-not-configured" }
  },
  "terminal_decision": {
    "original_goals_covered": "unknown",
    "no_owner_self_remaining": "unknown",
    "no_in_flight_work": "unknown",
    "no_pending_user_decision_or_blocker": "unknown"
  },
  "review_evidence": ["支持本轮整体判断的读数"],
  "model": { "id": "实际模型 id", "input_tokens": 0, "output_tokens": 0 }
}
```

`body` 来自对应条目的 §6 draft，`evidence` 保存完整 §5 item；`review_evidence` 只保存支持本轮整体判断的 readings。§5 为空时 `section5_item_ids` 与 `interventions` 都为空，不投递 §2 或 §4。若 §6 含已填入推荐默认值的 `【】` 用户可决位置，仍立即投递，并把 `has_user_decidable_spots` 设为 `true`；该项的 `im-notify` 必须明示 contained `【】` user-decidable spots，不能因此阻塞或丢弃。不要从自由自然语言做关键词分类。

### 4. 记录、投递与完整性

从当前 watcher 事件读取 `state_file` 并赋给 `EVENT_STATE_FILE`；下面两个命令必须使用这一个原值，不得自行拼路径：

```bash
node "$HOME/.claude/scripts/peer-session-watch.js" record-review \
  --state-file "$EVENT_STATE_FILE" --review-file "<review-json>"
node "$HOME/.claude/scripts/peer-session-watch.js" deliver-review \
  --state-file "$EVENT_STATE_FILE" --review-file "<review-json>"
```

只有下面四个 producer-side 计数完全相等、且独立清单非空，才算 producer 对这份已声明 inventory 的投递自一致：

```text
section5_item_ids length
  == enqueue accepted count
  == queue write-back verified count
  == intervention im-notify exit-zero count
```

四个计数都只覆盖 producer 侧：第一项是模型独立转录并声明的 §5 inventory，第二项是新 enqueue，或 exact duplicate 经 queue read-back 证明已持久化，第三项是 producer 重读 queue 后仍找到同一 transport record，第四项是本机 `im-notify` exit 0。四数相等只证明该 inventory 与投递结果自一致；它不能证明同一个模型已把自然语言报告中的全部 §5 完整转录。§5 语义完整性仍是 model-bound，不能由生成这份 JSON 的模型自我认证。四项也都不表示 A-side consumption，不证明 Stop hook 已注册。真实 A-side 读数只有 inbox ack；Phase 3 注册 Stop hook 后才能把 ack 作为第五个计数接入。当前 Phase 2 没有该读数，不能把四数相等表述为 A 已处理。

没有 suppression 分支。任一 gap 或 `im-notify` 非零都保持监督、报告具体计数，不宣告投递完成。§5 为空时四个计数都是 0，但 `delivery_complete` 必须保持 false，并返回独立的 `delivery-empty`，不能用空集相等冒充完整投递。非 terminal 空集直接重启 watcher；四项 terminal 条件均为 true 时不需要凭空制造 intervention，可以继续 completion。

本轮非 terminal 且投递完整时，用同一个 event `state_file` 重启一轮有界 watcher。`delivery-incomplete` 时按 state 中逐条 delivery record 重试缺失 enqueue/notification，不得通过重开 watcher 绕过 gap。

### 5. 终止与重试

只有 fresh 深审同时给出以下四个布尔 `true` 才进入 completion：原始目标已覆盖、无 owner=self 剩余项、无 in-flight、无未决用户决策或 blocker。任何 `false`、`unknown` 或歧义都继续监督。

终止顺序固定为：持久化 completion report → `im-notify` → 只有 `im-notify` accepted（exit 0）才写 `terminal`。exit 0 不证明手机实际收到；收件状态保持未核实。通知失败时 state 保持 `completion-pending-notify`、`deliver-review` 非零退出并记录下一次有界重试时间；立即用同一参数重启 watcher，它只消费 retry state、按有界 backoff 重试通知，不在失败期间进入 terminal，也不重新采样或触发深审；重试成功返回 `terminal`。

用户要求取消时，原子创建 state 旁的 `.cancel` 文件；watcher 下一 tick 返回 `cancelled` 并退出。取消不删除已有 inbox、review 或 completion 记录。
