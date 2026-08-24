# 增强服务探活

后台增强服务（记忆捕获、通知投递、索引同步等）失效时，session 里往往没有可归因的证据——没有用户纠正、没有 agent 返工、没有工具失败。它们只能被**直接探活**发现。

探活查**产出**，不查进程。2026-08-02 的实例：claude-mem 的 worker 进程连续存活 6 天、HTTP health 端点稳定返回 200，而 observation 已 6 天零入库——任何基于进程或健康端点的检查都会报"正常"。

## 判据形态

每个条目给四样：

| 项 | 作用 |
|---|---|
| 产出信号 | 服务正常工作时会持续更新的可观测事实。给可直接执行的命令，不给描述 |
| 对照信号 | 证明这段时间本该有产出，排除"你只是没用它"。找不到真对照时，写明替代它的前提是什么 |
| 失效判据 | 两者的关系。**同时给全停与衰减两档**——只判全停会漏掉崖式衰减 |
| 归因线索 | 判为失效后才取，用于区分根因落点。非判据 |

**信号必须在待判定的 scope 上取**，而下面清单里的示例查询是全库的，照抄即得聚合读数。要回答"本 session 有没有被捕获"，先读下一段的**桥接失效**警告，再看这条查询：

```bash
SID=<content_session_id>   # 即 Claude Code 的 session id
sqlite3 -readonly "$DB/claude-mem.db" "
SELECT 'sdk_sessions', COUNT(*) FROM sdk_sessions WHERE content_session_id='$SID'
UNION ALL SELECT 'observations', COUNT(*) FROM observations o
  JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
  WHERE s.content_session_id='$SID'
UNION ALL SELECT 'user_prompts', COUNT(*) FROM user_prompts WHERE content_session_id='$SID';"
```

**桥接失效——上面 `observations` 那一支目前不可作为失效判据。** 该 JOIN 只保留 `memory_session_id` 在 `sdk_sessions` 里有对应行的 observation，而绝大多数行没有：2026-08-07 实测近 24h 共 2258 条，其中 **2061 条（91.3%）是孤儿**，JOIN 直接丢弃。同日一个真实 session 用该查询得 **3** 条，而按 project + 时间窗直查同期有数百条并可由 `files_modified` 与内容确证归属。于是它在"记忆真丢了"与"记忆好好的但落在孤儿行上"两种情况下都给出接近 0 的读数——不具区分力，**低计数不构成失效证据**。

因此：`observations` 计数为 0 或极低时，**不得据此判失效**，改用不依赖桥接的读法（按 `project` + 时间窗直查 `observations`，再用 `files_modified` 与内容确认归属；该口径会含同项目并发 session，是上界而非精确值），或退回全库聚合信号回答"服务整体还活着"。孤儿行的成因未查明，修好之前这条限制一直有效。

**受此影响的历史结论需重新标注**：本文此前记录的 2026-08-04「本 session 三项全 0，故记忆确实丢了」是用这条查询得出的，其阳性对照（换一个 session id 返回 11 条）只证明该查询**能**返回非零，不能证明 0 是真的丢——按今天的孤儿比例，那次的 0 同样可能是桥接丢弃。该结论现降级为**存疑**，不应再被引用为"曾经真的全丢过"的先例。

`sdk_sessions` 无行即"该 session 从未注册"，与"注册了但没产出"是不同结论——但注意，注册与否同样不能反推产出：孤儿行说明产出可以在没有注册行的情况下存在。`observations` / `session_summaries` 按 `memory_session_id` 索引、`user_prompts` / `sdk_sessions` 按 `content_session_id`，跨表本应经 `sdk_sessions` 桥接，而桥接正是上面失效的那一环；`user_prompts` 一支不经桥接，仍可用。这些服务多为全局单库，聚合读数由所有 session 共同支撑，因此"全库健康"与"本 session 全丢"可以同时成立——2026-08-04 实测即如此：全库 `last_24h=302`（均值 5.3 倍，报健康），而当次 session 的 `observations` / `user_prompts` / `session_summaries` 全为 0，连 session 注册行都不存在。要回答"本 session 的记忆有没有被捕获"，就必须按 session id 取数；按 project、按进程同理。聚合信号只能回答"这个服务整体还活着"，不能回答任何分片的问题，而后者往往才是决策所依赖的。

## 清单

**当前覆盖：claude-mem 记忆捕获、claude-mem 语义索引同步（chroma）两项。** 本文开头点名的通知投递尚未纳入——探活结果必须连同这句覆盖边界一起返回，否则"已纳入的都健康"会被下游读成"整个增强服务面无问题"。

### claude-mem（跨 session 记忆捕获）

产出信号：

```bash
DB="${CLAUDE_MEM_DATA_DIR:-$HOME/.claude-mem}"
NOW=$(( $(date +%s) * 1000 ))
sqlite3 "$DB/claude-mem.db" \
  "SELECT ($NOW - MAX(created_at_epoch))/3600000.0 AS hours_since,
          (SELECT COUNT(*) FROM observations
             WHERE created_at_epoch >= $NOW - 86400000) AS last_24h,
          (SELECT COUNT(*)/7.0 FROM observations
             WHERE created_at_epoch >= $NOW - 8*86400000
               AND created_at_epoch <  $NOW - 86400000) AS prior_daily_avg
   FROM observations;"
```

三列一律走 `created_at_epoch` 的滚动毫秒窗——`date('now','-1 day')` 那种日界写法会把前一天整天算进"今天"，实测能让一次 10 倍崩塌读作正常。

对照信号：

```bash
find ~/.claude/projects -name '*.jsonl' -mmin -1440 | head -1
```

**这一项在本探活的调用场景下恒真**——探活由活跃 session 派发，该 session 自己就在写 transcript。它在此是形式项，真正支撑单边判据的前提是：**observation 走 PostToolUse hook 实时入库，所以活跃 session 必然应当已有产出**。新增条目时不要照抄这个形态，要为你的服务找一个真能区分"没产出"与"没用它"的对照。

失效判据：

- **全停** — `hours_since > 24`
- **衰减** — `hours_since` 未超阈值，但 `last_24h` 低于 `prior_daily_avg` 的三分之一

**恢复期的已知形态**：服务从长断档恢复后的头 24 小时，`hours_since` 接近 0 而 `last_24h` 仍远低于均值，衰减档会触发。这不是误报——那个窗口的产出确实远低于正常——但它不 actionable。三个取值一起看即可分辨：`hours_since` 接近 0 说明此刻在产出，`last_24h` 偏低只是因为窗口里含着已结束的断档，两者同现记为 recovering、不记为 degraded。2026-08-02 那次恢复实测即为此形态（`hours_since`=0.001、`last_24h`=3、均值 61.4）。

两档都上报。只判全停会让崖式衰减读作健康：2026-07-27 当天产出从 404/天掉到 26/天后才归零，那一天全停判据仍报正常。阈值取三分之一而非一个数量级，是因为那次崩塌的实测比值是 0.097——卡在 1/10 边界上，用数量级做阈值等于没有余量。

归因线索（判为失效后取，用于区分两个故障点位）：

```bash
sqlite3 "$DB/claude-mem.db" \
  "SELECT ($NOW - MAX(created_at_epoch))/3600000.0 AS prompts_hours_since FROM user_prompts;"
cat "$DB/state/hook-failures.json"
```

`user_prompts` 与 `observations` 经同一条投递链写入，所以两个 `hours_since` 的差把根因分开。用 6 小时作界（远小于 24h 失效阈值、远大于正常写入间隔）：

| 差值 | 落点 |
|---|---|
| < 6h（两者同样陈旧） | 投递链断在 hook 客户端到 worker 之间；`consecutiveFailures` 非零可佐证 |
| > 6h（user_prompts 明显更新） | 投递链正常，observation 的生成侧死了——根因在第三方 |

**这张表只在单进程 scope 内成立**，因为它的前提是两个数出自同一条投递链。全库取数时它们可能来自不同的 claude 进程，差值就不再反映投递链状态而只反映"哪个进程最近活跃"——此时表会给出与事实相反的落点。2026-08-04 实测：project scope 下 `observations` 208.74h 对 `user_prompts` 61.74h，差 147h，按表读作"投递链正常、生成侧死、根因在第三方"，而真因恰恰是本进程投递链完全不通、那 61.74h 属另一个 session。用这张表前先确认两个数取自同一进程。

**`consecutiveFailures` 单独不足以判定**：它在收到任何 HTTP 响应时即归零，包括错误响应。2026-07-27 起的那次故障里，前 5 天投递链正常（user_prompts 持续写入），该计数器全程读作 0，完全没有指示价值；只有最后约 19 小时投递链本身也断了，它才开始累积。


**两档只看 observation 绝对量，对"转化率崩塌"失明**。2026-08-20 实测：当日写入数百条 observation（两档均判健康），同时约一千条 observation 类消息卡在 `pending_messages` 且**其中每一条都带 `last_failure_code`**（当日失败面：`[PARSER] non-XML/empty response`、`FAILED_BATCH code=INVALID_RESPONSE`）。候选补充信号——两个数一起看才有区分力：

```bash
sqlite3 "$DB/claude-mem.db" \
  "SELECT (SELECT COUNT(*) FROM pending_messages
             WHERE message_type = 'observation'
               AND last_failure_code IS NOT NULL
               AND created_at_epoch >= $NOW - 86400000) AS failed_24h,
          (SELECT COUNT(*) FROM observations
             WHERE created_at_epoch >= $NOW - 86400000) AS obs_24h;"
```

`message_type` 过滤不可省：`summarize` 等其它类型也会带 `last_failure_code`，不过滤则分子混入非 observation 消息，而本信号要判的恰是 observation 的转化率。

**别把 pending 行整体读成失败积压**——「成功即删行，所以留下的都失败过」**不是表级不变量**：新入队、尚未尝试的行同样是 pending 且 `last_failure_code` 为 NULL（现场复验 18355 行中 16062 行为 NULL）。有区分力的只有**经 `last_failure_code IS NOT NULL` 过滤出来的那批**，上面的 SQL 正是这么写的。

尚未定阈值——它需要一段正常期的基线才能定，本条只登记信号与它要捕捉的形态。**注意 `started_processing_at_epoch` 不具区分力**：实测全库每一行都是 NULL，该列在当前版本不被写入，不能用它反推"消息有没有被 claim 过"。

**孤儿行的一个已查明成因**（此前记为"成因未查明"）：`[ERROR] [SDK ] Context overflow — cleared memorySessionId so next spawn starts fresh` 会把该 session 先前那批 observation **当场打成孤儿**。实测同一 session 的桥接查询在十几分钟内由 `observations_joined=14` 变成 `2`，期间没有任何删除操作。所以桥接查询的读数在长 session 上会随 context overflow 事件跳变，取数时点要记下来。

### claude-mem 语义索引同步（chroma）

**上游一断，失明的只有 `ratio` 这一档。** 它以"当日 observation 数"为分母，条目 1 全停时分母为 0，该档随即退化为「未能判断」，**不是健康**。

**`behind_h` 与结构化 CHROMA 失败日志都不受影响，照常判。**`behind_h` 是两侧历史最大时间戳之差，不除以当日量；`behind_h >= 6` 独立成立"全停"。把它一并降为未知，会吞掉一个已经在场的 stale-index 阳性信号——比如上游停写前 chroma 已漏写 6 小时，而 `?deep=1` 仍能查旧向量返回 `ok/done`：那正是 `behind_h` 唯一判得出、别的档都判不出的情形。2026-08-06→08-19 那次断档就处于这个状态：chroma 侧当时另有 `[CHROMA_MCP] Connection attempt failed Executable not found in $PATH: "uvx"`（与条目 1 的 `claude` 缺失同属一次 PATH 故障），而写入支路当时给不出任何读数。

**判定顺序：先判条目 1；它全停时，只把 `ratio` 记为「未能判断（当日无 observation）」并写明这是结构性盲区，不要报健康。**其余三个信号照跑：`behind_h`、`?deep=1` 的 probe（不依赖该分母，`probe.ok != true` 或 `stage != done` 足以独立判失效）、以及结构化 CHROMA 失败日志。所以该状态下的正确结论形态是**逐信号给**，不是把整个条目、也不是把整条写入支路短路成一句「未能判断」——每短路一个仍判得出的信号，就吞掉一次它本可报出的阳性。

失效形态是**退化而非中断**：`SearchManager` 的检索有三条路径——Chroma 命中即用、Chroma 抛错回退 FTS5、Chroma 未初始化直接走 FTS5。所以同步停了不会报错，语义检索会安静地变成关键词检索，"想起以前解决过同类问题"这个能力消失而无任何提示。

产出信号（两支，缺一不可）：

**为什么必须两支**：chroma 有两个存储段——`METADATA`（sqlite）与 `VECTOR`（hnsw-local-persisted）。第一支数的 `embeddings` 表**只承载 METADATA 段**——建库以来 228822 行全部属该段，VECTOR 段按设计持久化到 `chroma/<segment-id>/*.bin`，从不进这张表（这是不变量，不是某个时窗的观测）。两条路径节奏也独立：2026-08-12 00:17 时 `chroma.sqlite3` 刚更新，而 hnsw 的 `data_level0.bin` 停在前一日 22:52。向量段失效时第一支照常增长并报健康，而 `SearchManager` 已在 query 侧回退 FTS5——正是本条目开篇点名的那类失效。第二支是唯一穿过 query 路径的信号，一次往返实测 40–58ms（数十毫秒量级，不承载判据）。

**第一支：写入路径**

```bash
DB="${CLAUDE_MEM_DATA_DIR:-$HOME/.claude-mem}"
python3 - "$DB" <<'EOF'
import sqlite3, sys, datetime
db = sys.argv[1]
o = sqlite3.connect(f"file:{db}/claude-mem.db?mode=ro", uri=True)
e = sqlite3.connect(f"file:{db}/chroma/chroma.sqlite3?mode=ro", uri=True)
# doc_type 过滤不可省：embeddings 混着 observation / session_summary / user_prompt
# 三类文档，不过滤则 prompt 仍在嵌入就足以让指标恒健康（见「判据踩过的三个坑」）
OBS = ("FROM embeddings e JOIN embedding_metadata m ON m.id = e.id"
       " WHERE m.key = 'doc_type' AND m.string_value = 'observation'")
p = lambda t: datetime.datetime.strptime(t.replace("T", " ").replace("Z", "")[:19], "%Y-%m-%d %H:%M:%S")
behind = (p(o.execute("SELECT MAX(created_at) FROM observations").fetchone()[0])
          - p(e.execute(f"SELECT MAX(e.created_at) {OBS}").fetchone()[0])).total_seconds() / 3600
od = dict(o.execute("SELECT substr(created_at,1,10),COUNT(*) FROM observations"
                    " WHERE created_at >= date('now','-2 day') GROUP BY 1").fetchall())
ed = dict(e.execute(f"SELECT substr(e.created_at,1,10),COUNT(*) {OBS}"
                    " AND e.created_at >= date('now','-2 day') GROUP BY 1").fetchall())
day = max(od) if od else None
n_obs = od.get(day, 0)
ratio = (ed.get(day, 0) / n_obs) if n_obs else None
verdict = []
if behind >= 6: verdict.append("全停")
if ratio is not None and ratio < 3.0: verdict.append("衰减")
state = " + ".join(verdict) if verdict else ("健康" if ratio is not None else "未能判断(当日无 observation)")
print(f"behind_h={behind:+.2f} day={day} obs={n_obs} ratio={ratio and round(ratio,2)}")
print(f"write_path={state}")
EOF
```

**第二支：query 路径往返**

```bash
curl -s --noproxy '*' --max-time 20 'http://127.0.0.1:37701/api/chroma/status?deep=1'
```

对照信号：**内建在 `ratio` 的分母里**。当日没有 observation 时 `ratio` 为 `None`，输出 `未能判断` 而非 `健康`——"没数据"与"健康"是不同结论。不需要另找对照，也不要照抄 claude-mem 条目那个恒真的形式项。

失效判据（三档并列，任一成立即判失效）：

- **全停（写入路径）** — `behind_h >= 6`
- **衰减（写入路径）** — `ratio < 3.0`
- **检索失效（query 路径）** — `probe.ok != true` 或 `probe.stage != "done"`

阈值依据（2026-08-12 实测全史 61 天，`doc_type='observation'` 过滤后）：**`ratio < 3.0` 在这 61 天里零次触发**，最小余量 1.70×（全史 min 5.10，2026-07-09）。这是取 3.0 的**唯一**依据——它保证不误报，仅此而已。

**比值不是结构常数，别把它当常数用**：全史区间 [5.10, 8.40]（剔除建库首日 2026-05-29 的 49.45——那天一次性回填了全部历史，是 seed 而非常态），与当日 observation 量弱正相关，低量日（obs<50，n=14）均值 6.14 而高量日（obs>=300，n=23）均值 8.82。按 `field_type` 拆开可见成因：每条 observation 产 1 篇 narrative + 若干条 fact，而抽出几条 fact 是内容属性、逐日浮动。所以**不要**据此声称"一条 observation 固定拆成 N 份"。用绝对带而非滚动基线的理由与比值稳不稳定无关，只是：滚动基线会被跨窗口的长期故障吸收成新基线，届时两档一起静默。

**检测灵敏度随当日比值浮动，须连同结论一起报**：触发需掉量 `1 - 3.0/当日基准比值`，即**低比值日 41%、中位日 55%、高比值日 64%**。换言之**保证能发现的下限是 64% 掉量**，更小比例的部分失效（例如某一类 field 停止嵌入）本判据可能看不见，需靠第二支或逐文档对账。任何"低于基线三分之一"式阈值同理——它论证的是"不误报"，不是"报得出来"，两者必须分开陈述。

`behind_h` 正常 ≈ 0（写入延迟实测 median 0.00 min、max 1.16 min，n=79499），取 6h 留有充分余量。注意 `behind_h` 在停摆下的取值取决于停摆起点与检查时刻的相对位置，没有固定值。

**判据踩过的三个坑（均由对抗性检验发现，不是设想）**：

1. **分子不按 `doc_type` 过滤会让全停档永不触发**。`embeddings` 混着 observation 181832 / session_summary 35079 / user_prompt 11911 三类，分母却只有 observations。不过滤时 `MAX(embeddings)` 取到的是 user_prompt 行——构造验证：observation 索引死 3 天、prompt 仍写入 → `behind=-0.90`，全停档永不触发。初稿把这个负值误解释为"chroma 在回填旧 observation"；实测写入延迟 median 0.00 min、源条目早于 1 小时的占比 0.0%，**没有回填**。
2. **给当日设最小样本闸门会把失明放回来**。初稿用 `obs >= 50` 筛合格日，当日不足则整日剔除、回退到上一个健康日并打印健康。构造验证（当日全停 + obs=40）：两档全灭报健康。现在不设闸门——比值在低量日同样成立，且分桶按 UTC 而宿主 +08，每天本地 08:00–12:00 的当日桶天然稀薄。
3. **日比值取两侧日期交集会在失效时失明**。同步一停，当天从 chroma 侧消失、被交集剔除。必须由 observations 侧驱动、chroma 缺席记 0。

**第三个信号：直接的失效日志（比上面两支都直接，但只在故障期存在）**

```bash
grep -cE '^\[[0-9-]+ [0-9:.]+\] \[(WARN |ERROR)\] \[CHROMA' "$DB/logs/claude-mem-*.log"
```

`ChromaSync.addDocuments` 写入失败时记 `[WARN] [CHROMA_SYNC] Batch add failed — watermark will not advance for this batch`，连接侧退避时记 `Backfill failed for project: X — chroma-mcp connection in backoff`。**结构化前缀 `^\[时间\] \[LEVEL\] \[SCOPE\]` 不可省**：claude-mem 会把 agent 执行过的 Bash 命令原文也写进同一份日志，裸 grep 关键词会命中你自己刚敲的检索命令（实测踩过）。

2026-08-11 08:56:53–08:57:25 有一次真实事件：worker 启动后对 56 个项目发起 backfill，而 chroma 连接尚在退避期，56 个项目**全部失败**。该事件确认了两件事——写入路径失败时 observations 照常写入（结构性论证在生产环境成立），以及失败后水位不推进、随后重试补齐。当日比值 7.03 判健康，**这是真阴性而非漏报**：瞬时自愈事件本就不该被日粒度判据标记。

归因线索（判为失效后读第二支的返回体）：

`probe.stage` 只有三个取值 `list` / `query` / `done`（**没有 `connect`**——连接失败由 `ensureConnected` 从 `callTool` 内部抛出，被列集合那一步的 catch 接住，同样报 `list`）。所以：`list` = chroma-mcp 起不来**或**集合不可读，两者靠 `probe.error` 文本再分（含 `connection in backoff` / `timed out` 即连接侧）；`query` = 能列集合但检索失败。端口若变，用 `lsof -nP -iTCP -sTCP:LISTEN | grep bun` 找。

**`?deep=1` 不可省。** 不带它时该端点只做浅层检查，返回 `{"status":"healthy","connected":true,…,"details":"chroma-mcp is responding to tool calls","deep":false}`——它确实调用了工具，但不走语义检索往返，与本文开头那个"health 端点稳定 200 而实际零入库"同款。

**本条目的验证状态**（「新增条目」节要求"只写已验证过判据确实反映真实状态的服务"。本条目**逐档标注取证强度**而非笼统声称已验证——三档的证据强度不同：query 档有真实诱发对照，写入两档只有合成对照加一次生产事件旁证）：

- **阳性侧**——21 天逐日读数见上；`created_at` 是写入时刻而非抄自源，判别证据是 schema 的 `created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`（仅看逐日读数无法区分这两种可能，故必须引 schema）。第二支实测 `stage:done, queryLatencyMs:42`。
- **阴性侧**——合成库对「正常 / 当日 emb 为 0 / 比值 0.6」三种输入分别判健康 / 全停+衰减 / 衰减；真实数据仍判健康。该对照三次推翻本条目的判据（上述三个坑），价值不在"验过了"而在"改掉了什么"。
- **结构性论证已两侧闭合**——源码侧：`ChromaSync.addDocuments` 的 catch 分支不增加 `written`、且水位仅在 `cursor <= writtenDocs` 时推进，作者的日志文案即"watermark will not advance for this batch"；生产侧：2026-08-11 08:56–08:57 的真实事件（56 个项目 backfill 全部失败于连接退避）确认了失败时 observations 照常写入、水位不推进、随后重试。该论证只覆盖**整体中断**，不覆盖 doc_type 级或向量段级的局部失效——后者正是第二支存在的理由。
- **query 路径已做真实诱发对照**——2026-08-12 02:0x 实测：健康态 `status=healthy ok=True stage=done`；SIGKILL 掉 chroma-mcp 后立即复测得 `status=unhealthy ok=False stage=list error="chroma-mcp connection in backoff (10s remaining)"`；退避期满后 12s 自愈回 `ok=True stage=done`（首次往返 271ms，随后回落 51ms）。**同一时刻写入路径一支仍报健康**（`behind_h=+0.00 ratio=7.03`）——这正是两支并存的意义：秒级中断只有 query 支看得见，日粒度的写入支看不见也不该看见。该实验同时印证了上面归因表的修正：连接失败报的是 `stage:list` 而非 `connect`。
- **写入路径的真实诱发仍未做**——需同时满足"持续阻断 chroma-mcp"与"observation 活跃流动"，而 2026-08-12 01:00–01:20 三次采样 observation 速率为 0，无法制造背离。该支的阴性侧目前靠合成库对照（三种输入判定正确）加上面的生产事件（08:56 那次 56 项目 backfill 全失败）支撑，未做端到端诱发。

## 新增条目

一个服务够格进这份清单的条件是：**它失效时不留下能指向它的证据**。"能指向"指现象本身就说明是哪个组件坏了（工具报错、构建失败、明确的错误码都算）；用户察觉"结果不对"却无从判断该怪谁，**仍属此类**——不论这个"不对"是他主动查询时当场看到的，还是事后才发现的。两种形态都属该类：产出缺失（没记住、查不到、没送达），**以及产出仍在但质量退化到不可用**（检索返回一堆不相关结果、摘要变成空话）。间歇性或阈值触发的阻断不改变这一点——claude-mem 自己在 stock 配置下失败 3 次就会阻断工具调用，但它的失效主体仍然是长期静默丢数据，落在证据之外。判据是"多数失效有没有留下 session 证据"，不是"它会不会阻断"。

条目只写已验证过判据确实反映真实状态的服务——未经验证的探活命令比没有更糟，它会用一个"检查过了"的假信号盖住真问题。

**判据分多档时，可逐档标注取证强度**（真实诱发 / 合成对照 / 结构性论证 / 生产事件旁证），但**不得笼统声称"已验证"**——哪一档没验到就写哪一档没验到。形态见 chroma 条目的「本条目的验证状态」。这条例外只对"部分档已验证"开口，不对"一档都没验"开口。

**先读「判据形态」节，四件套缺一不可**；对照信号尤其不要照抄现有条目的形式项——claude-mem 那条的对照信号在本探活的调用场景下恒真，是历史包袱不是范例。

## 怎么用这份清单

拿到一个疑似失效，**匹配分两步，缺一不可**：

1. **问"哪个可观测产出坏了"**定出失败面——记忆没被记住 → 记忆捕获；语义检索查不到或结果明显变差 → 语义索引同步。
2. **核对产出这个失败面的服务与条目所属服务是否同一个**。条目按「服务 + 失败面」组织，同名失败面常来自别的系统：自建 Wiki 的"索引同步"、Spotlight 的全文索引，都不是 claude-mem 的那个。

两步都对上，按该条目的判据探活。**任一步对不上——问不出产出、映射到的失败面无条目、或服务不同一——都报 coverage gap**：向本轮的调用方（主 session 的用户或 parent agent）说明"该失败面无可用探针"，然后**照常用常规手段继续排查**。报 gap 是说明这份清单帮不上忙，不是叫你停下；此处唯一禁止的是临时发明一个未经验证的探针。

**判为失效之后、展开归因之前，先读一遍已知风险档。** 本机它在 `~/research/ai-agent-config/docs/references/known-risks.md`（随 ai-agent-config 走，**不要去当前仓里找同名文件**——别的仓没有它，"grep 不到"不等于"不是已知风险"；找不到就直接进条目自己的归因线索）。它多为"修好又会坏回去"的条目（上游 regression 要本机重打的补丁、重装会静默丢弃的状态），也收 fresh-host 首次 bootstrap 没走完那一类；文件很短，按组件名与症状两条线扫一遍即可，每条自带检测命令。

排在归因之前而不是判据之前：不对健康的服务乱打补丁。但要排在**分层归因之前**——归因表回答的是"链路断在哪一段"，回答不了"这是不是一个已经记录在案、连修法都写好了的老毛病"，而这类复发的症状与首次发生**完全同形**。实测代价：2026-08-11 一次 claude-mem 失效从零重新定位根因，结论与该档「claude-mem 后台总结全部 403」那条（记于 2026-06-06；其所述的上游 regression 本身可追到 2026-04）所记的根因一致，连它给的直连 403 探针都没用上。

**排查完了要回流。** 若这次最终定位了根因、且产出信号可复现，按「新增条目」把该失败面补进清单（一时补不了就留一条 git-tracked 待办）。gap 报过即忘，这份清单会永远停在当前覆盖——它自己在「清单」节承认通知投递尚未纳入，而缺口的发现机制（报 gap）明明已经存在，两者不相连就是白报。

## 已知环境陷阱：代理劫持回环流量

2026-08-02 的那次故障，根因是 Claude Code 在代理模式下运行时 `http_proxy` / `https_proxy` 被 hook 进程继承，于是它连 `127.0.0.1:37701` 的本机 worker **也走了代理**并失败——服务端一切正常，客户端全盘不可达。修复在 `~/research/system-config`（`69cd92e`：wrapper 为 `127.0.0.1,localhost,::1` 设 `no_proxy`）。

这对探活本身有两条直接影响：

- **探活命令必须自己绕过代理**，否则会得出与被测组件相反的结论。诊断那次故障时，`curl --noproxy '*' .../health` 返回 200 而同一时刻 hook 判定不可达——差别只在 `--noproxy`，而这恰好把真因屏蔽掉了，导致误判为"请求送达但响应回不来"。查本机端口时一律显式绕代理。
- **worker 这类常驻进程继承的是它被拉起那一刻的环境**。修好 wrapper 后，修复前启动的 worker 仍带着坏环境运行，必须重启才继承新值；判定服务是否已恢复时，先确认被测进程的启动时间晚于环境修复。
- **同一条对客户端进程成立，且后果更重**。修复落在 shell rc 的函数里，生效面只是"新 shell + 新 launch"；挂在长寿 tmux pane 里的 claude 进程内存中始终是旧函数，能带着坏环境跑上数天。2026-08-04 实测：出问题的 session 其 claude 进程比修复 commit **早 62 分钟**启动，`no_proxy` 全程缺失，而同机一个晚于修复启动的 claude 进程用同一 worker、同一 DB 入库正常——根因锁在 per-process 继承的环境，与插件、worker、DB 全无关。因此判恢复时要确认的是**被测的那个客户端进程**（连同 worker）晚于修复，只看 worker 会得出"已恢复"的错误结论。
