# Background Agent 与 Plan Supervisor 监控

主 session 用 `codeagent-wrapper`（`run_in_background`）委派长时后台任务、随后转入 idle 等待其完成回调时，按此协议保活。

前半段只管 **idle 等待期**——已 yield turn、靠完成回调唤醒的阶段；supervisor 仍在主动轮询后台任务输出（未 yield）时不适用。计划执行还要遵循后半段：它处理的不是进程挂起，而是 supervisor 在代理终态之后没有继续路由的失活。

## 为什么需要主动巡检

后台任务只在**进程退出**（完成或崩溃）时回调；**静默挂起**（进程存活、零输出、永不退出）不触发完成回调，idle 的 supervisor 对它有盲区，无主动巡检则挂起无上限空耗 wall-clock 不被发现。`Monitor` 工具能在运行期流式观察，但需你主动建立——这正是本协议要求的。

## 派发前自限（每次后台 codex/agent 派发都套）

巡检若只靠 supervisor 记得建立就不可靠；把第一道防线做成**派发命令自身的自限**，不依赖注意力——前两条是命令自身的属性、每次都套；第 3 条是长委派时一并写进 prompt 的损失上界：

1. **自限超时（最强）**：包硬 deadline 到点自杀，deadline 按"最坏合法时长"取、不按期望时长。经 `codeagent-wrapper` 派发时用其原生参数（单位均为**毫秒**）：`CODEX_INACTIVITY_TIMEOUT`（stdout 零输出即杀，默认 1800000=30min，`0` 关闭——对口静默挂起）+ `CODEX_TIMEOUT`（总时长上限，默认 21600000=6h）。非 wrapper 命令用 shell 包裹 fallback：`( cmd </dev/null & p=$!; (sleep <秒> && kill $p)& k=$!; wait $p; kill $k )`——它只保证杀直接子进程，cmd 自身 fork 的进程树需 `setsid` + `kill -- -<pgid>` 回收；需要 cmd 退出码时在 `kill $k` 前用 `rc=$?` 暂存。
2. **`</dev/null` 掐 stdin**：凡 prompt 走参数而非 heredoc/`-` 的派发（`codex exec` raw、`codeagent-wrapper --backend codex "<prompt>" <workdir>`）一律 `</dev/null` 重定向。后台派发时 stdin 是不 EOF 的空管道，进程会卡在读 stdin——`codeagent-wrapper` 甚至在启动 codex 之前就卡在读自身 stdin 组装 prompt（日志停在 `Reading from stdin pipe...`），此刻 `CODEX_INACTIVITY_TIMEOUT`（守的是 codex stdout）尚未 arm、救不了，只有 6h 总超时兜底——所以上条的原生超时对这种 pre-codex stdin 阻塞不适用（实测 raw `codex exec` 卡 `Reading additional input from stdin...` ~43min、wrapper prompt-as-arg 卡 ~20min 各一次，均靠人追问才发现）。heredoc/`-` 形态（`... - <workdir> <<'EOF' … EOF`）自带 EOF、不受影响，勿加 `</dev/null`（会顶掉 heredoc、prompt 读不到）。
3. **里程碑 checkpoint（派发超过约 20 分钟时）**：在 prompt 里要求被委派方在里程碑处落 checkpoint，使损失有界、resume 有接续点。**medium 按写权限选**：可写的委派写进度文件或 commit 到工作分支；`CODEX_SANDBOX=read-only` 的只读委派（本文件推荐的 reviewer 形态）两者都不可用，改用 `--progress`——它把里程碑打进 `.output`。

**长静默本地命令不进被监控任务**："多分钟、零 stdout、无模型往返"的本地命令（GB 级 DB 快照 / 迁移 / 全量验证，例见「卡死处置」），别作为被委派 codex 任务里的一步——codex 本身扛得住（实测单条 25min 静默命令 codex `exit 0`），当初 ai-radar 是被监控层误判挂起后外部 kill（exit 130，非 codex/websocket 死）。「卡死处置」的计算活性探针能挡住这类误杀，但**别把安全押在 supervisor 每轮都跑探针上**：改由 supervisor 自己 `run_in_background` bash 直跑，纯本地进程根本不在被监控的 codex 任务面上、也不横跨委派轮次的静默窗口，从源头免于误判。（留在 codex 任务里、单纯调大 `CODEX_INACTIVITY_TIMEOUT` 也救不了——它管 wrapper 自限超时、不管外部巡检。）跑完再把结果交给 codex 任务消费。

## 怎么巡检

- **机制**：cron 定时任务，或 `Monitor` 工具盯一个 staleness 条件；派发的同一轮就建立，不等转入 idle 后补。
- **看的信号**：后台任务的 `.output` 文件（`run_in_background` 对其 stdout+stderr 的捕获，spawn 时从后台 Bash 任务结果取得路径；**不是** wrapper banner 里 `Log:` 指向的 `codeagent-wrapper-<PID>.log`）——看其 mtime / 大小增长。**但输出停滞 ≠ 挂起**：GB 级快照 / 迁移 / 全量验证这类合法命令会几十分钟零 stdout。所以"进程存活 + 输出停滞"不足以判挂起，须再查一层计算活性（判据与 `task_computing` 探针见「卡死处置」）：输出停滞且计算/本地 IO 也停滞才算疑似挂起。
- **探针绑定到具体任务**：活性判定用派发时拿到的那个任务自己的句柄（后台任务根 pid、它的 `.output` 路径），不用全局的命令行模式匹配（`pgrep -f "codeagent-wrapper --backend codex"` 一类）判活——并发派发下全局匹配命中的是"任意一个同类进程"：命中非空 ≠ 被盯的还活着，它早退了也会因别的同类还在跑而被判健康，完成回报被拖到最后一个同类退出才发出。反向的"空匹配 ≠ 已退出"（根因是模式没写对，不是并发）与按 pid 的认领写法，见「卡死处置」的先认对进程。
- **间隔**：按该任务单步合法静默的最长时长取值（一个 20 分钟的生成步不该被当成挂起）；15 分钟是没有依据时的起点，不是应当留着的默认值。上调的理由不只是避免误报——**每次触发都是一个完整 turn，单次代价随 session context 单调增长**。实测一次 44.8 小时的 supervise：15 分钟间隔全程未调，跑出 296 个 turn、吃掉 167.3M context 令牌（该 supervisor 全部 context 预算的 28%），而全程 0 次探测到挂起（三次 kill 都是由完成回调发现的）。长任务上这项开销直接推高 compaction 概率，而 compaction 会逐出已读过的 BINDING reference。所以派发时就按任务形态定值，别留给"事后想起来再调"。

## 前台上限与等价同步等待

**触发**：一次本该**同步等待**的委派（gate 类 review、决策评审）——**一律适用，不预判这次会不会超时**。

「超出前台上限时才改后台」是行不通的写法：那个条件在**发起之前观测不到**，判"这次应该不会超"与"这次确实不会超"读数相同，于是整节连同下面的 record 取句柄、禁 pgrep 一并被跳过。已复现：评审仍在活跃读文件，却在 10.00 分钟被杀。事故经过与它换来的风险（漏轮询时的静默挂起，已知情接受）见 `~/research/ai-agent-config/docs/issues/harness-issues.md`「规则完备、却因入口挂在不可判条件上而从未被读到」。

**动作**：后台派发 + 主动轮询，等价保持同步语义。**后台派发规避前台击杀，主动轮询防静默挂起**——只派不轮询，等于把一个明确失败换成一个没人发现的挂起。两条约束缺一不可（它们各自管的不是发现挂起，别指望）：

- **期间不派发其它工作**——否则它不再是同步等待而是并发，调用方会在结果未定时继续推进，gate 的阻塞语义就没了。
- **不另建巡检**——主动轮询本身就是巡检。本文件开头那条巡检义务在 supervisor 仍在轮询、未 yield 时**不适用**（见「为什么需要主动巡检」那段的限定）；再建一层只是重复烧 turn，而每次触发都是一个完整 turn。

**被杀之后**：先 `resume <session_id>` 续跑，**不要从零重派**——评审者已读过的文件会白读一遍，且新起的一轮在语义上不是续审。handle 取不到再重新发起。

**消费者**：`~/.claude/skills/decision-review/SKILL.md` 的「等待」条款与 `~/.claude/skills/review-gate/SKILL.md` 的高档档位各以一句指针引本节，不各自复述——三处曾各写一份且措辞已分叉（只有一份同时写全了上面两条约束）。

## 退出 ≠ 成功（干净退出的语义失败）

前述巡检防的是"该结束却没结束"（静默挂起）。另一个方向相反的盲区：**进程正常退出（exit 0）、输出/进度条一路正常，但结果在语义上整批失败**——典型是把失败记成**数据而非崩溃**的 stage（数据管线的门控/打标 stage 每行写 `<x>_status=failed` 仍 `exit 0`；缺 gated 权重 / 权限 / 配额 / 网络时整批 fail 而进程干净退出）。所以"进程已完成 + 退出码 0 + 输出文件已生成"都不是成功证据。此类失败是**暂时**的（授权/配额修好后可重试），不是终态判决——别把 errored 结果当定论落库。

- 盯后台 run 时，过滤器（`Monitor` 或轮询 grep）只匹配**终态**与**委派体级**失败签名：wrapper / harness 自身的错误（如 `codex_core::tools::router: error=`、可归到委派体的 `Traceback`、超时 / 取消）及最终报告里的失败标记；不匹配 per-command 的 `exit=N`，也不匹配裸 `failed|error:`。派发前按任务性质裁剪：TDD、重试循环和迭代类委派里的命令级非零退出是预期中间态，不是委派失败；把它放进 filter 等于每次 RED 都换一个完整 turn。反例：`exit=[1-9]` 在 TDD 委派上必然高频命中，还会用 `exit=1` 前缀误中 `exit=127`，派发时即可预见。收窄的是「什么算失败信号」，不是放弃 `silence is not success`：委派体级失败终态仍必须命中，失败一出现就报，而非只等成功标志或完成回调。
- 宣告"进度正常 / 已完成"前，查**结果的状态分布**（accepted/rejected/failed 计数），不只看退出码或输出文件是否生成。
- 一次早期抽查若显示"0/N 但进程存活"，顺手 grep 一次日志失败签名，而不是据此判"正常"。

## 中途终止（没有交回最终报告就结束）

**运行到一半被终止**：没有最终报告，而委派出去的活可能已经做了一大半。跨多个项目复现，非偶发。

### 先按 status + 退出码分流，别按日志措辞

`status` 只有三态、不足以定位终止来源——`failed` 一个状态就横跨自设超时、外部信号与进程自行失败。两者一起查表：

| `status` | 含义 | 下一步 |
|---|---|---|
| `completed` | 进程自行退出 0 | 走「退出 ≠ 成功」那一节 |
| `failed`，summary 带 **exit code 124** | wrapper 自己的超时到点（静默超时或总超时，两者同码；区分靠 record 的 `reason`） | 走下面「恢复」；预防见「派发前自限」 |
| `failed`，summary 带 **exit code 130**（或 128+N 的其它值） | 收到外部信号 | 走下面「恢复」 |
| `killed` / "was stopped" | **harness 主动终止**（回调本身不带退出码；wrapper 收到的仍是 SIGTERM/SIGINT，故 record 里是 130） | 走下面「恢复」 |
| `failed`，其它退出码（如 1） | wrapper 透传 backend 的退出码，可能是 backend 起来之后出事（OOM / 崩溃 / 中途错误退出 / 没产出最终消息），也可能压根没起来。**判据是 record 里有没有 `session_id`**，不是 `reason` 的措辞——同一个串两边都会出现（`<cmd> exited with status …` 是任何非零退出的通用透传，实测本机两份 exit-1 落的正是它、却都没有句柄） | **有 `session_id`**：已经开工过，走下面「恢复」。**没有**：读 `reason` / stderr 定位后重派。结果语义失败（跑完了但整批语义不对）的另见「退出 ≠ 成功」 |

### 权威证据是持久 record，不是临时日志

「中途终止」各节关于 wrapper 的所有契约断言**以其源码为准**（源码位置、两层行为的分工与重建流程，见 `ai-agent-config/README.md` 的「平台支持」一节中 `codeagent-wrapper` 那几段）——wrapper 改了这里就会过期，判因前先确认版本。

wrapper 在**单任务派发的每次非零退出**时写一份持久记录（`--parallel` 不写），位置在 `$CODEAGENT_STATE_DIR` → `$XDG_STATE_HOME/codeagent-wrapper` → `~/.local/state/codeagent-wrapper` 下的 `results/codeagent-wrapper-<PID>.result.json`，保留 14 天；路径以 `  Result: <path>` 打在 stderr（后台派发时即在任务 `.output` 里）。它含：

| 字段 | 用途 |
|---|---|
| `exit_code` | 判因的权威依据，取值见上表 |
| `session_id` | **resume 句柄**（见下）。backend 一旦报告过 session，此后所有退出路径都保留它；在此之前就失败的（配置错误、命令不存在）没有——所以它在也是判据：区分「起来了才出事」与「根本没起来」 |
| `reason` | 具体原因串：`<cmd> inactivity timeout: no output for <N>s` / `<cmd> execution timeout` / `execution cancelled; …` —— 区分静默超时与总超时靠它，退出码两者相同 |
| `log_path` | 指向那份临时日志 |

**别把临时日志当第一证据**：它在系统临时目录，下次 wrapper 启动会清理已死 PID 的日志，OS 也会扫。实测同一台机器 **29 份持久 record vs 7 份存活日志**——多数终止事件的日志早已不在，而 record 还在。真要读日志时，取**最后一条 ERROR 记录**而非最后一行：取消行后面还会跟一行 `parseJSONStream completed: …`，`tail -1` 永远取不到它。

`SIGKILL` 下没有取消行、没有 record、没有 resume 句柄，判因与恢复都失去依据；只剩那份临时日志：本次 run 不会删它（只有干净成功才删自己的日志），但**下一次 wrapper 启动就会回收已死 PID 的日志**——窗口到此为止，要用就立刻取。此时下面**整套从事实重建状态的判据**比任何其它分支都更承重，且两条各管一半：`git log` / `git diff` 是唯一不依赖那份日志的依据，而某条命令有没有真的跑完只能从日志读——所以先抢日志，再对账。

### 恢复：resume，不要从零重派

```bash
codeagent-wrapper --backend <原 backend> resume <session_id> - <workdir> <<'EOF'
<续做指令>
EOF
```

`-` 是"从 stdin 读任务"的标记而非占位符，**必须配 heredoc**（漏掉即卡在读 stdin，机制见「派发前自限」第 2 条）；`--backend` 默认 `codex`，原任务若是别的 backend 必须显式带上。`<workdir>` **三个 backend 都承重**（codex 经 `-C`，claude / gemini 经进程 cwd）。漏掉它不是中性的：被续跑的 agent 会静默继承调用方的 cwd 且不报错——**委派目标是 git worktree 时这意味着它跑到主 checkout 上去**。

从零重派会丢掉被委派方已积累的全部定向——读 plan、读代码、实测参照物都要重来。

**拿不到 `session_id` 时**（被终止在 backend 报告 session 之前；`--parallel` 会在汇总里打 `Session:`，但不写持久 record）：没有 resume 路径，按下面重建状态后**从最近 checkpoint 重派**，并在新 prompt 里写明哪些已完成、不要重做。

**resume 必须串行**：wrapper 对同一 `session_id` 的第二次 resume 既不拒绝也不排队（无跨调用序列化），两个进程各自从 resume 前的同一状态分叉、同时写同一棵工作树，且彼此看不到对方的改动——症状是同一文件归属混合、先前的全绿测试证据失效、工作树在观察窗内持续变化。它不像并发 spawn 那样显眼：每次 resume 看起来只是"再补一条指令"，而追加指令的冲动恰好发生在前一次还没回来的时候。所以对同一 session 的下一条指令一律等完成回调后再发。

已经并发了：这些**都是本 session 自己派生的写入者**，按 `concurrent-plan-isolation.md`「执行中提升」对派生写入者的例外，由本 session 自己收回、不交用户（交用户那一支管的是不受本 session 控制的第二决策者）。

**找哪个还在跑，别找 record**：持久 record 只在非零退出后才写（见「权威证据是持久 record」），`.output` 也只有 `run_in_background` 派发才有——**都识别不了一个仍在运行的重复 resume**。活着的 wrapper 各有 `$TMPDIR/codeagent-wrapper-<PID>.log`，而清理只删已死 PID 的日志，所以此刻存在的临时日志恰好就是还在跑的那些。据此定位、`TaskStop` 或 `kill` 掉多余的那个：这里不套「卡死处置」的挂起判据与其 `AskUserQuestion`——那条管的是"疑似挂起"、且一个正常在跑的重复写入者永远不满足它，而这里授权停它的是上面那条派生写入者例外。停完按「最危险的是它留下的半成品自称完成」的重建步骤对账改动归属。

### 最危险的是它留下的半成品自称完成

被中途终止的 agent 可能已写下**面向用户、且用完成时态陈述**的产物——CHANGELOG 条目、契约更新、状态表——而它计划稍后才执行的验证/条件步骤根本没跑。实测：一次被终止的委派已在 `CHANGELOG.md` 写上两项"已完成"，实查发现核心改动确实落了，但**用户批准该改动时附带的性能护栏一次都没执行**。

所以恢复前**从事实而非产物重建状态**：

- `git status` **加** `git log` / `git diff <派发前的 ref>`——只看 `git status` 会漏掉被委派方已 commit 的 checkpoint（干净工作树会被误读成"什么都没做"）；文件 mtime 经任何 checkout / stash 即失真。
- 判断某个要求过的验证命令**是否真的跑完**：判据是**完成**而非出现。日志里每条命令先出 `item.started`（`"exit_code":null`）、完成后才出 `item.completed`；`--progress` 下则是 `[PROGRESS] cmd_done cmd="…" exit=0`。被信号打断的那条恰恰是"出现了但没跑完"的，而它正是最可能被中断的一条。

与「退出 ≠ 成功」同族但更隐蔽：那里至少有退出码和完整日志，这里产物读起来很完整、而它描述的是意图。

## 卡死处置

零增长疑似挂起时，先判 hung vs 仅是慢，**判据必须确定性、不靠肉眼看 stdout 静默**（stdout 静默是头号误判源）：

**先认对进程**：任务进程按派发时拿到的 pid 加 `pgrep -P` 逐层下降认领（下方探针用的就是这个写法），**不按命令行模式匹配**。`pgrep -f '<猜的命令行>'` 匹配为空**不构成**"进程已退出"的证据——它同样可能只是模式写错了：backend 二进制可能是 vendored 路径、被 wrapper 换过 argv、或经 shell function 转发。这是个反向断言，一旦说出口就删掉了后续检查的对象，而它误判的代价是杀掉一个正在干活的任务、或据此重派制造出第二个并发写入者。要确认某个 pid 是否还在，用 `kill -0 <pid>`；要确认它是否还在干活，用下方探针。

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

**计划已到终态**时删除巡检（尤其 durable cron），避免空转泄漏。判据是计划终态，不是任务终态：**某个被委派任务完成、或此刻看不见活跃后台任务，都不是终态**——那一支按「watchdog 唤醒时先判谁会去看结果」分流，别在那里删。

## Teammate 运行中活性

`running` / `alive` 只证明 in-process teammate 尚未终止，不等于任务仍在推进。需要持续等待 teammate 时，在调用方已有的轮询或 plan watchdog 每次唤醒时比较阶段、当前命令和可观察进度，不为此另建第二套调度；当前 surface 无法可靠唤醒同一 task 时，按「Plan supervisor watchdog」的 capability-gap 规则报告，不得承诺无人值守监控。

| 观察 | 处置 |
|---|---|
| 阶段、命令输出或计算 / IO 有进展 | 继续等 |
| 超过该步骤最长合法静默窗口仍无变化，且可定位进程树 | 沿「卡死处置」复用计算 / IO 活性与环境争用判据 |
| 无法定位进程树 | 向原 teammate 索取一次定向进度证据；到下一个合法巡检窗口仍无回复或新证据时，携停滞时长与不可观测边界交用户裁决，不得声称已证实挂起或 silent kill |

不得因 agent 状态仍为 running 而无限等待，也不得仅因一轮无消息就 kill。

**「输出文件不再增长」不是完成信号，把它当成完成信号会杀掉正在工作的 agent。** in-process 委派的 `.output` 文件是**完整 JSONL transcript 的 symlink**（实测 `lrwxr-xr-x` → `subagents/agent-*.jsonl`）。**禁的是整份读入**——那会撑爆 context；`stat` 看 mtime/size、有界 `tail`、按字段筛选都可以，排查停滞时它们往往是唯一能看到进度的东西。**但这些读数只说明它在动，不能证明它完成**，它的增长受 transcript 落盘节奏支配，与"任务推进到哪一步"没有固定关系：一个正在读大文件、正在算、或正在等子进程的 agent 可以数十秒不产生新行。于是"mtime + size 连续 N 秒不变"在**已完成**与**仍在工作**两种情况下给出同一个读数——它测的是磁盘，不是任务。

实测：一次 review 委派因输出文件稳定 60 秒被判为"已完成但静默不回传"，据此 `SendMessage` 索取一次、无果后 `TaskStop`；事后查该 agent 的 sidechain，它在被杀那一刻仍在连续读文件与检查，最后一条是 `[Request interrupted by user]`。**代价还不止一次误杀**：由此得出的"该 agent type 的返回契约有缺口"是个反向断言，它当场把真正的原因从检查范围里删掉了，后续的调查全部走错方向。

所以：完成只认**完成回调**（harness 的 task notification）或 agent 自己发来的报告；两者都没有时，走上表——按**阶段与可观察进度**判，而不是按文件是否长大。自建的"稳定即完成"探针属于「派发前自限」明确点掉的那类不可判条件，别再造。

## Teammate 生命周期与回收义务

**先判该不该走本节**：本节只管以 `name` spawn 的 in-process teammate。这类子代理的最终报告**不作为工具结果回流**，事后 mailbox 索取也不可靠（见 `delegation-policy.md` §Harness transport），所以 caller 依赖返回内容时正确做法是一开始就**不传 `name`**——那样产出随工具结果回流、子代理自行终止，本节的回收义务与下方索取路径都不适用。下面这些只服务两种情形：caller 不消费其产出的长驻实例，以及**已经传了 `name`** 之后的止损。下文把 execute-plan 的 implementer / reviewer / UX agent 列作例子，是因为它们历史上以 `name` spawn；按上述判据，凡 caller 要消费其 findings 的（reviewer 尤其如此）都应改为不传 `name`，其回收随之退化为普通返回值消费。

in-process teammate（Agent tool 委派、以 name 寻址的子代理，含 execute-plan 的 implementer / reviewer / UX agent 等）完成最终报告后**不会自行终止**——按观测到的 harness 行为（非文档契约，变化时以实际语义为准），它保持 idle-alive 以便续聊、不触发完成回调，并会阻塞 renderer / session 收尾、随 spawn 数量累积。回收只能由 caller 触发，且不能靠"记得清理"——绑定到下列可识别动作；用户自行 spawn、或明确要长驻续聊的 teammate 不在回收义务内：

| 机制 | 类型 | 触发 → 处置 |
|---|---|---|
| 消费即回收 | 即时钩子 | 最终报告被消费、裁决后不再需要它（无 closure / 续聊计划）→ 同一轮 `TaskStop <name>` |
| 绕过即回收 | 即时钩子 | 决定不再等它——换 transport 重做、判它失败、放弃该维度 → 同一步 `TaskStop`。绕过通常发生在终态之前，立即回收才免它在余下流程里继续占用 |
| 收尾清点 | 终态兜底 | 工作流到达终态（不再有待消费的 teammate 工作、即将交出可能是最后一轮的回复）→ 按 spawn 台账逐名对账回收 |
| 容量即回收 | 前置钩子 | spawn 因容量失败（`no space for new pane` 等）→ 按台账回收**全部**已消费实例再重试；回收未清空前不对回收机制本身下结论 |

计划续用的（如 reviewer 等 closure 复核）在 closure 完成的那一轮回收。收尾清点不依赖"最终 handoff / 宣告完成"等仪式性措辞出现（被打断的工作流在恢复轮补做）；其台账覆盖本 session 内嵌套 command / 子流程 spawn 的 teammate（嵌套调用把记名义务随之传递），缺失时用 harness 提供的 running-teammate 枚举兜底。

**容量是 session 级共享的（含嵌套 command spawn 的），而报错不告诉你占用多少、被谁占着。** 分波派发的长 session 迟早撞到硬失败，此时手上唯一的证据"没空间"同时兼容「回收无效」与「回收不够」——实测是后者（停 16 个仍失败、再停 12 个即成功）。所以回收到台账清空再重试，才有资格判断回收机制是否失效；在此之前既不得据此报 blocked，也**不得为迁就容量而降级委派设计**（把本该独立的 subagent 合并、跳过要求的重跑）——那是拿一个看得见的失败换一个看不见的降级。

配套：teammate 已 idle 而报告未回传时，先一次 `SendMessage` 索取（常见于报告成文未发送），收到后按上表回收；索取无果即按「绕过即回收」换 transport。**不要压制 idle 通知**：它是持续推送的存活信号，要求 teammate 停发等于亲手拆掉清点的兜底；每条都当一次廉价判定"这个还需要吗"——否则当轮回收，是则记明留用理由。台账别指望磁盘：`~/.claude/teams/session-<id>/config.json` 的 `members` 只在部分 session 落盘（实测同一 workflow 一次记全成员、另一次整个目录不存在），故台账须在 spawn 当时自己记。

## Teammate transport 失败时的降级路径

teammate 基础设施会整片不可用（实测在一次 20-agent fan-out 内三重故障叠加：`respawn pane failed: fork failed: Device not configured` → `no space for new pane` → 全部 `session limit` 击穿），催报也存在**催了完全不交付**的残余情形。别临场摸索，按下表降级；换 transport 即触发上表「绕过即回收」，同一步回收原实例。

| 症状 | 处置 |
|---|---|
| 报告未回传 | 先一次 `SendMessage` 索取。**催一次无果即换 transport**，不反复催 |
| spawn 失败（fork / pane / session limit） | 直接换 transport，不重试同一路径 |
| teammate 发 `SendMessage` 给 `"main"` 被拒 | 先按寻址错误处置：spawn prompt 里就要求它回复 **team-lead**，而非 `"main"`。但更正收件人是**必要非充分**——实测更正后 teammate 收件箱被清空（已读）而 caller 收件箱仍恒为 0，此时判为通道不通，按上一行换 transport，别再催 |

降级 transport（按实测可靠性排序）：

```bash
# 首选：独立 codex session。实测同期 4 次派发全部首次即完整交付
CODEX_SANDBOX=read-only ~/.claude/bin/codeagent-wrapper --backend codex - <workdir> <<'EOF'
<prompt>
EOF

# 次选：无头 claude。绝对路径是硬要求——用户 shell 的 `claude` 是 wrapper 函数，
# 非交互子进程里缺 `_agent_cwd_exec` 会直接 command not found
/opt/homebrew/bin/claude -p "<prompt>" --allowedTools "Read,Grep,Glob,Bash" > report.md
```

两者都不占 tmux pane、走独立子进程额度、保持审查者相互独立；后台派发时 `</dev/null` 与巡检义务照上文各节。

## Plan supervisor watchdog

`execute-plan` 的 supervisor 必须持续消费 implementer、reviewer 与 UX agent 的终态；"某个 agent 已结束"不是计划完成。仅当当前 Codex surface 的已验证调度契约同时保证回到**同一 task**，并能由该 task 重新发现和取消 schedule 时，启动 plan 才建立间隔不短于 5 分钟的 watchdog（间隔按上文「怎么巡检」的「间隔」条推导，下界 5 分钟）；本计划完成或通过 Stop Gate 合法 blocked 时取消它。

watchdog 每次恢复同一 task 后，读取该 task 的现有上下文与计划状态（long-task 时包括 `state.md` / `journal.md`），判断终态是否已被路由：合格结果进入下一 gate，finding 按 `execute-plan` 的 closure contract 路由修复、再由受影响 reviewer 复核，未满足 Stop Gate 的停止继续执行。它不新建项目运行账本；线程持久上下文和既有 long-task 状态已分别承担运行恢复与语义恢复，额外的高频 git 状态只会制造噪声。

当前 surface 没有同 task 调度能力时，不能把"查看 agent 状态"伪装成 watchdog：状态只能说明 agent 活跃或终止，不能自行唤醒 supervisor 或解释终态是否已经路由。报告该 capability gap；不得声称计划会无人值守续跑。

### watchdog 唤醒时先判谁会去看结果

只写"读后台任务输出、然后汇报"的巡检提示词，默认了后台永远有任务在跑。而 supervisor 亲自动手的阶段恰恰没有：前半句落空，整轮退化成"只汇报"，**而汇报天然像个终点**。实测后果：一次 supervisor 刚把验收消息发进真实群、正等着看结果，巡检醒来、发了汇报、然后停了——既没看结果，也没留任何会把自己叫回来的机制，用户以为还在跑。

判据：**那件在飞的事，它的结果会不会被送到一个必然去处理它的地方**。绑在那件事上的东西才算——后台任务的完成回调带着它的产出把你唤醒，算；对方会主动把结果发回来（人会回消息、服务会回调），算。周期性巡检**不算**：它只是到点叫醒你，不携带那件事的结果，也不保证下一次醒来的你会想起去看。

按此判据，无活跃后台任务时分流：

- **有在飞的事，而没有任何东西会把它的结果带回来**——已发出待观察的动作、验收/实测未收口，或计划未完成却停在半路（上一轮没派出任何东西）。**本轮就把它推进到下一个可观察结果，或派发成一个带回调的任务**，再汇报；汇报不是这段工作的终点，也不得因"看不见后台任务"就删巡检。
- **确已到终态**——计划完成，或按 Stop Gate 合法停止。汇报并按「删除巡检」处理。

结果会被带回来（在等人回消息、等外部服务回调）时两支都不落——但先确认那条回来的路真的存在，"我以为对方会回"不算。这一支按有没有新事实分两种收尾：**有新事实**（对方回了、条件变了、等待中出现异常）就汇报，写明在等谁、解除条件是什么；**没有**就只巡检、不汇报——等人可以等很久，实测一夜之间 19 次唤醒发出逐字相同的"仍在等你完成 X"，而重复汇报既不推进也不通知，用户早看过一模一样的那条。两种收尾都不删巡检（删除只由上面「确已到终态」那一支授权，机制见「删除巡检」）。静默的那种要在 `state.md` / journal 留一次打点：一个完全不出声的 watchdog 回合，在用户侧与"watchdog 已经死了"不可区分。

这两条判据与分流本身要写进巡检提示词，不能只留在这里：巡检触发时 reference 未必还在 context 里（compaction 会逐出读过的 reference，见「间隔」条）。

条件触发的巡检（`Monitor` 盯 `.output`）还要多一层：唤醒条件本身不得以"存在活跃后台任务"为前提，否则它在这一支根本不会醒，提示词写什么都救不了。
