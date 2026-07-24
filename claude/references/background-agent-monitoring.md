# Background Agent 与 Plan Supervisor 监控

主 session 用 `codeagent-wrapper`（`run_in_background`）委派长时后台任务、随后转入 idle 等待其完成回调时，按此协议保活。

前半段只管 **idle 等待期**——已 yield turn、靠完成回调唤醒的阶段；supervisor 仍在主动轮询后台任务输出（未 yield）时不适用。计划执行还要遵循后半段：它处理的不是进程挂起，而是 supervisor 在代理终态之后没有继续路由的失活。

## 为什么需要主动巡检

后台任务只在**进程退出**（完成或崩溃）时回调；**静默挂起**（进程存活、零输出、永不退出）不触发完成回调，idle 的 supervisor 对它有盲区，无主动巡检则挂起无上限空耗 wall-clock 不被发现。`Monitor` 工具能在运行期流式观察，但需你主动建立——这正是本协议要求的。

## 派发前自限（每次后台 codex/agent 派发都套）

巡检若只靠 supervisor 记得建立就不可靠；把第一道防线做成**派发命令自身的自限**，不依赖注意力：

1. **自限超时（最强）**：包硬 deadline 到点自杀，deadline 按"最坏合法时长"取、不按期望时长。经 `codeagent-wrapper` 派发时用其原生参数（单位均为**毫秒**）：`CODEX_INACTIVITY_TIMEOUT`（stdout 零输出即杀，默认 1800000=30min，`0` 关闭——对口静默挂起）+ `CODEX_TIMEOUT`（总时长上限，默认 21600000=6h）。非 wrapper 命令用 shell 包裹 fallback：`( cmd </dev/null & p=$!; (sleep <秒> && kill $p)& k=$!; wait $p; kill $k )`——它只保证杀直接子进程，cmd 自身 fork 的进程树需 `setsid` + `kill -- -<pgid>` 回收；需要 cmd 退出码时在 `kill $k` 前用 `rc=$?` 暂存。
2. **`</dev/null` 掐 stdin**：`codex exec` 等一律重定向 stdin，杜绝阻塞在读 stdin（实测一次 raw `codex exec` 复审卡在 `Reading additional input from stdin...` ~43 分钟无人察觉——raw 派发没有 wrapper 的原生超时可兜底）。

**长静默本地命令不进被监控任务**："多分钟、零 stdout、无模型往返"的本地命令（GB 级 DB 快照 / 迁移 / 全量验证，例见「卡死处置」），别作为被委派 codex 任务里的一步——codex 本身扛得住（实测单条 25min 静默命令 codex `exit 0`），当初 ai-radar 是被监控层误判挂起后外部 kill（exit 130，非 codex/websocket 死）。「卡死处置」的计算活性探针能挡住这类误杀，但**别把安全押在 supervisor 每轮都跑探针上**：改由 supervisor 自己 `run_in_background` bash 直跑，纯本地进程根本不在被监控的 codex 任务面上、也不横跨委派轮次的静默窗口，从源头免于误判。（留在 codex 任务里、单纯调大 `CODEX_INACTIVITY_TIMEOUT` 也救不了——它管 wrapper 自限超时、不管外部巡检。）跑完再把结果交给 codex 任务消费。

## 怎么巡检

- **机制**：cron 定时任务，或 `Monitor` 工具盯一个 staleness 条件；派发的同一轮就建立，不等转入 idle 后补。
- **看的信号**：后台任务的 `.output` 文件（`run_in_background` 对其 stdout+stderr 的捕获，spawn 时从后台 Bash 任务结果取得路径；**不是** wrapper banner 里 `Log:` 指向的 `codeagent-wrapper-<PID>.log`）——看其 mtime / 大小增长。**但输出停滞 ≠ 挂起**：GB 级快照 / 迁移 / 全量验证这类合法命令会几十分钟零 stdout。所以"进程存活 + 输出停滞"不足以判挂起，须再查一层计算活性（判据与 `task_computing` 探针见「卡死处置」）：输出停滞且计算/本地 IO 也停滞才算疑似挂起。
- **间隔**：默认 15 分钟，按需手改。按该任务单步合法静默的最长时长上调，以免误报正在干活的 agent（一个 20 分钟的生成步不该被当成挂起）。

## 卡死处置

零增长疑似挂起时，先判 hung vs 仅是慢，**判据必须确定性、不靠肉眼看 stdout 静默**（stdout 静默是头号误判源）：

1. **计算活性**（对 CPU / 本地 IO 型工作决定性）：跑下方 `task_computing <后台任务根 pid>`——子树里有后代在跑（R 态）、在做不可中断 IO（D/U 态）、或累计 CPU 在推进（`sqlite3 .backup` / `cp` / 编译 / 迁移等）= **在干活的慢** → 继续等、不 kill。ai-radar ~20min 误杀正是缺这一层：2GB 快照子进程始终在耗 CPU/IO，却因零 stdout 被判挂起而外部 kill（exit 130）。**但纯等模型/网络往返的 codex 任务 CPU 天生空闲**，本项不适用——那类靠 codex stdout 心跳 / `CODEX_INACTIVITY_TIMEOUT` 判，不能因 CPU 空闲就判挂。
2. **环境争用**：仅当计算/IO 也停滞，再查是否被并发 codex 抢占、端口/锁被占等卡住（这类才是真卡死的常见形态）。

判为仍在干活（慢）→ 继续等、不干预。判为真挂起（输出停滞 **且** 计算/IO 停滞）：处置（kill 后 resume 同 session / 重启新 session）丢上下文、且误判则误杀合法慢任务，反转成本高 → **不要 silent decide**，用 `AskUserQuestion` 呈现诊断（停滞时长 / **计算活性结果** / 进程与输出信号 / 是否疑似环境争用）+ 候选 [继续等 / kill 后 resume 同 session / 重启新 session] + 推荐，让用户拍板。

```bash
# 计算活性探针：任务进程子树里是否有后代在"算或在做本地 IO"（未挂）。
# $1 = 后台任务根 pid（run_in_background 的 bash pid，从 spawn 结果取）。
# exit 0 = 在干活(未挂)；exit 1 = 计算与本地 IO 都停滞(疑似挂起)。
# 仅对 CPU / 本地 IO 型工作决定性；纯等模型/网络往返的任务 CPU 天生空闲，
# 不适用本探针——那类由 codex 的 stdout 心跳 / CODEX_INACTIVITY_TIMEOUT 兜底。
# 局限：reparent(PPID→1)到别处的 worker 会逃出子树遍历；GB 级本地活按§派发前自限
# 留作 supervisor 直系子进程即可规避（勿改用进程组兜——同组的兄弟任务会污染判断）。
task_computing() {
  local root=$1 all="$1" frontier kids p
  frontier=$(pgrep -P "$root" 2>/dev/null)
  while [ -n "$frontier" ]; do            # 逐层展开后代（进程树有限，必终止）
    all="$all $frontier"; kids=""
    for p in $frontier; do kids="$kids $(pgrep -P "$p" 2>/dev/null)"; done
    frontier=$kids
  done
  local s1 s2
  s1=$(ps -o pid=,state=,time= -p $all 2>/dev/null)
  [ -z "$s1" ] && return 1                                        # 全退出 = 没在算
  echo "$s1" | awk '{print $2}' | grep -qE '^[RDU]' && return 0   # R运行 / D·U不可中断IO = 在干活
  sleep 12                                                        # ps time= 是整秒分辨率，窗口放宽以捕获低 CPU
  s2=$(ps -o pid=,state=,time= -p $all 2>/dev/null)
  echo "$s2" | awk '{print $2}' | grep -qE '^[RDU]' && return 0
  [ "$(echo "$s1"|awk '{print $1,$3}'|sort)" != "$(echo "$s2"|awk '{print $1,$3}'|sort)" ]  # 累计 CPU 有推进
}
```

## 删除巡检

任务完成 / 无活跃后台任务时删除巡检（尤其 durable cron），避免空转泄漏。

## Teammate 生命周期：消费即回收

in-process teammate（Agent tool 委派、以 name 寻址的子代理，含 execute-plan 的 implementer / reviewer / UX agent 等）完成最终报告后**不会自行终止**——按观测到的 harness 行为（非文档契约，变化时以实际语义为准），它保持 idle-alive 以便续聊、不触发完成回调，并会阻塞 renderer / session 收尾、随 spawn 数量累积。回收不能靠"记得清理"，绑定到两个可识别动作；用户自行 spawn、或明确要长驻续聊的 teammate 不在回收义务内：

1. **消费即回收**：teammate 的最终报告被消费、且裁决后不再需要它（无 closure / 续聊计划）→ 同一轮 `TaskStop <name>`。计划续用的（如 reviewer 等 closure 复核）在 closure 完成的那一轮回收。
2. **收尾清点**：工作流到达终态——不再有待消费的 teammate 工作、即将交出可能是最后一轮的回复——就按 spawn 台账逐名对账回收，不依赖"最终 handoff / 宣告完成"等仪式性措辞出现（被打断的工作流在恢复轮补做）。台账覆盖本 session 内嵌套 command / 子流程 spawn 的 teammate（嵌套调用把记名义务随之传递）；台账缺失时用 harness 提供的 running-teammate 枚举兜底。

配套：teammate 已 idle 而报告未回传时，先一次 `SendMessage` 索取（常见于报告成文未发送），收到后按上两条回收。

## Plan supervisor watchdog

`execute-plan` 的 supervisor 必须持续消费 implementer、reviewer 与 UX agent 的终态；“某个 agent 已结束”不是计划完成。仅当当前 Codex surface 的已验证调度契约同时保证回到**同一 task**，并能由该 task 重新发现和取消 schedule 时，启动 plan 才建立间隔不短于 5 分钟的 watchdog（默认间隔仍按上文 15 分钟）；本计划完成或通过 Stop Gate 合法 blocked 时取消它。

watchdog 每次恢复同一 task 后，读取该 task 的现有上下文与计划状态（long-task 时包括 `state.md` / `journal.md`），判断终态是否已被路由：合格结果进入下一 gate，finding 按 `execute-plan` 的 closure contract 路由修复、再由受影响 reviewer 复核，未满足 Stop Gate 的停止继续执行。它不新建项目运行账本；线程持久上下文和既有 long-task 状态已分别承担运行恢复与语义恢复，额外的高频 git 状态只会制造噪声。

当前 surface 没有同 task 调度能力时，不能把“查看 agent 状态”伪装成 watchdog：状态只能说明 agent 活跃或终止，不能自行唤醒 supervisor 或解释终态是否已经路由。报告该 capability gap；不得声称计划会无人值守续跑。
