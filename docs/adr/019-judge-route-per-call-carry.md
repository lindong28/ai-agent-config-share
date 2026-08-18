# ADR-019：判官路由由调用方逐调用显式携带，模块级「最近一次」状态退役

- 状态：已采纳（2026-08-17）
- **refines ADR-005**：该 ADR 把 `logVerdict` 的「可选第 5 参」分配给 `judged_text_sha256`（状态：已采纳、尚未实施）。本 ADR 不推翻它，只把那个位置的**形态**定为元数据袋，使两个逐调用事实共用一个参数位。ADR-005 的决策内容与字段语义原样成立，其文件不动。
- 决策评审：`decision-review` gate。**三轮完整全审 + 六轮窄复核**；前两轮方案被整体否决（5 / 6 个 blocker），第三轮起核心决策未再被否，其后四轮争的全部是附加的观测设施。**判据 7 最终由用户显式 waive**（见下「被 waive 的不成立项」）。
- 影响面（清单，不给数）：
  - `claude/hooks/lib/llm-judge.js`（新增 `judgeWithRoute` 与调用计数器；退役 `lastRoute` / `lastJudgeRoute`）
  - `claude/hooks/lib/judge-log.js`（`logVerdict` 增元数据袋参数；解除对 `llm-judge` 的 require）
  - 写裁决日志的六道闸：`stop-gate`、`prose-choice-gate`、`capability-claim-gate`、`reverse-assertion-gate`、`continuation-claim-gate`、`ask-recommend-gate`
  - `claude/bin/gate-stats`（一处失效注释的事实订正；新增一个纯信息计数）
  - `claude/references/judge-gate-authoring.md`（新闸模板 + §7 表中 `stop-gate` 一行的事实订正）
  - `claude/hooks/eval/continuation-claim-gate/run.mjs`（一处注释订正，判分逻辑不变）
  - 运行期日志 `~/.claude/logs/judge-gate.jsonl`（轮转建语义分界；该文件不在版本控制内）
  - **不触碰**：`claude/hooks/permission-gate.js`

## 问题

`llm-judge.js` 用一个模块级 `lastRoute` 表达「这次判决由哪个判官作出」，其自述前提是「各 hook 每进程至多调一次判官」。该前提**已被 `stop-gate` 破坏**：它一个进程里调两次判官（policy 判官经 `commitDecisionParkedConcern` 先跑，主判官后跑）。于是走 `commitParked` 那条确定性 flag 分支时，日志里的 `backend` / `model` 描述的是 policy 判官，而读者会自然归因给主判官。完整现象与影响见 HARNESS-314。

它同时是判官可观测性任何后续改造的**前置**：把新字段挂在同一个「最近一次」状态上，会原样继承张冠李戴。

## 决策

**路由身份由调用方逐调用显式携带，模块级「最近一次」状态退役。** 具体：

1. **加法式迁移**。新增 `judgeWithRoute(prompt, temperature, opts) → { text, route }`；`callJudge` 的签名与返回类型**一个字不动**，改为 `judgeWithRoute(...).text` 的薄包装。消费者全部迁移后，同一次编辑内删除 `lastRoute` 与 `lastJudgeRoute`。
2. **`logVerdict` 第 5 参是元数据袋** `{ route?, judged?, judgedTextSha256? }`，而不是裸 route。`judgedTextSha256` 本次不实现，留位给 ADR-005。
3. **四态归属契约**：

   | 情形 | 计数器 | 调用方传入 | 落盘 |
   |---|---|---|---|
   | 未经判官（判官前早退） | 0 | 不传 | `backend`/`model` 两键缺席 |
   | 本次裁决由判官作出 | >0 | `{ route }` | 正常写两键 |
   | 本进程判过判官，但本裁决非判官所出 | >0 | `{ judged: false }` | 两键缺席 |
   | **调用方漏传归属声明** | >0 | 皆未传 | 额外写 `judge_attribution_missing: true` |

4. **调用计数器**只表达「本进程调用过判官没有」这一**进程级事实**，不参与身份归属，故不复制本 ADR 要修的那个错误。它唯一的用途是让「漏传」与「未经判官」在日志里分得开。
5. **`backend` 存在性语义收窄**：由「本进程未调用过判官」收窄为「这条裁决未经判官」。相应地把 `judge-gate.jsonl` 轮转为 `judge-gate.jsonl.legacy-20260817`、主日志从空开始，使活日志内每条记录语义一致（与该文件 2026-08-08 那次分界同形）。**排空顺序**：先落代码 → 待旧 hook 进程排空 → 再轮转。
6. **`permission-gate` 不动**：它不写裁决日志（HARNESS-315），拿到 route 也无处可用，改它是纯风险无收益。
7. **不做告警**。`gate-stats` 只加一个**纯信息计数**（有多少条 `judge_attribution_missing`），**无 fire / resolve 语义**。

## 逐出口传播矩阵

归属由**执行顺序**决定，不逐条拍板：`main()` 持 `let route = null`，本闸自己的 `judge()` 返回时赋值，其后所有 `logVerdict` / `skip()` 一律往下传。

| 闸 | 出口 | 传入 |
|---|---|---|
| `ask-recommend` | autopilot 段各出口（全在判官之前） | 不传 |
| | 判官后三个出口 | `{route}` |
| `capability-claim` | `skip()` 判官前的各处调用 | 不传 |
| | **`skip()` 判官后的两处**（`有能力断言但无 transcript_path`、`转录读不全`） | `{route}` |
| | 判官后四个出口 | `{route}` |
| `continuation-claim` | 探针段与 `stop_hook_active` 段各出口（全在判官之前） | 不传 |
| | 判官后三个出口 | `{route}` |
| `prose-choice` / `reverse-assertion` | `skip()` 各处（全部调用在判官之前，已逐行核） | 不传 |
| | 判官后三个出口 | `{route}` |
| `stop-gate` | `skip()` 判官前各处 | 不传 |
| | policy 判官自己的 `mark()` | `{route: policyRoute}` |
| | 未闭合工具调用 / 声明不需回应两条确定性 flag（在 `commitDecisionParkedConcern` **之前**，计数器仍为 0） | 不传 |
| | **「把要不要提交交回用户」那条确定性 flag** | **`{judged:false}`** |
| | 判官后三个出口 | `{route: mainRoute}` |

**需要显式 `{judged:false}` 声明的出口，全仓只有 `stop-gate` 那一条**（policy 判官已在其上游跑过，但该裁决由模式匹配作出）。其余出口由执行顺序自动落对。

## 验证设计

`claude/rules/common/hook-authoring.md` 的触发条件（新增或修改判据、改守卫或短路顺序、改取文本来源、改逃生口）**均未命中**，故不触发 eval 要求。判官行为不变，改的只是元数据归属。

三个判别器，互相独立：

- **入口 A**（有 HTTP key，policy 判官答 `silent`）：断言 policy 记录带 policy route、那条确定性 flag **两键皆缺且无异常标记**。这是修复前后的直接判别器，**不依赖两个 route 取值不同**。
- **入口 B**（无 HTTP key + `CLAUDE_CLI_PATH` 指向秒回 stub）：policy 判官记录 verdict=`judge_unavailable`、route=`{backend:"none"}`；主判官记录 route=`{backend:"claude-cli"}`。两个取值不同，满足 `docs/autopilot-phase1-remediation.md` 记载的「必须人为注入两个不同 route」。用 stub 而非真实 `claude -p`：后者 25s 内部上限对 28s hook 上限只剩约 3s，做不了稳定判别器。
- **入口 C（负向对照）**：人为拿掉那唯一一处 `{judged:false}`，断言 `judge_attribution_missing` 出现。**没有它，「计数为 0」在「真的没漏」与「检测根本没生效」两种情况下同形。**

## 被否决的备选

| 备选 | 否决理由 |
|---|---|
| `callJudge` 直接改成返回 `{text, route}` | `~/.claude` 直链工作树，编辑期间 hook 可能加载「新 llm-judge + 旧 gate」，此时 `/^flag/i.test(对象)` 恒不匹配 → 该闸**静默恒判 ok**。非原子部署无法规避 |
| 模块级状态按调用点 key | 仍是「用模块级状态表达逐调用事实」，把「每进程至多一次」换成「每调用点至多一次」，同类前提 |
| out-param / judge 工厂对象 | 管线负担与前者相同或更大，本库无先例 |
| 让 policy 判官不写 `lastRoute` | 直接错：policy 判官自己那条出口需要它自己的 route，同进程两条日志各需一个不同 route |
| 只改注释不改实现 | `judge-gate-authoring.md` §6「判官身份随**这次**判决记下」仍做不到 |
| route 放第 6 参、第 5 参留给 ADR-005 | 两个可选位置参并列时，漏传哪一个在调用点上看不出来 |
| 告警的四个版本（全量非零即提示 / 活日志边界 / 近期窗口 / `(gate,reason)` 配对） | 逐版被否，理由依次为：永久黏住无 resolve 通道（违反 `alerting-review-principles.md` P7）→ fire/resolve 由文件大小驱动、且未修复时轮转会造成假恢复 → 任何有限窗口都以**缺席**为 resolve 依据而缺席不等于健康，且 `--days` 参与生命周期后算子可制造假恢复 → `(gate, reason)` 不能普遍代表出口（`judge_unavailable` 与 `ok` 的 `reason` 同为 `null` 会互相错误 resolve），且该论证**预设了被检测的故障不会发生** |

## 被 waive 的不成立项（判据 7：错误多久发现、回退成本）

**gate 未判此项消解，由用户显式 waive 后放行。**

缺口：将来新增或修改的闸若漏传归属声明，日志会写出 `judge_attribution_missing`，但——

1. **本仓没有 CI**。`claude/hooks/run-tests.sh` 头注原文即写明「package.json 的 test 脚本是 `exit 1`，也没有 CI」；仓内无任何 CI 配置。
2. **工作树存盘即生效**（`~/.claude` 直链），真实 hook 会在任何测试运行之前执行新代码。
3. 守零断言**只能覆盖测试实际执行到的分支**。现有四套判官闸测试全部设 `NEST_GUARD`、在判官之前短路，故「跑完全套测试后异常计数为 0」是**空断言**——计数器恒为 0，该断言在「检测器正常」与「检测器根本没接上」两种情况下都通过。守零因此收窄到入口 A/B/C 三个判别器自己的隔离日志上。
4. 此外不存在套件级隔离日志：各测试各自把 `CLAUDE_JUDGE_LOG_PATH` 指向自己独占的临时文件。

waive 理由：能产生漏传的只有本仓自己新增或修改的闸，而该缺口守的是一个**当前零实例**的错误；关闭它需要稳定的机器可读出口标识（新 schema 字段）与不随 `KEEP_ARCHIVES` 淘汰丢失的告警状态存储，那是一个独立项目，其规模已超过它所保护的修复本身。

## 作用域

本决策**只**作用于裁决日志中 `backend` / `model` 两键的归属、`logVerdict` 第 5 参的形态、一次日志轮转、以及上列文档的事实订正。

**不覆盖**：HARNESS-315（`permission-gate` 不写裁决日志）、HARNESS-316（服务端换 thinking 模型时的应答解析）、以及「把服务端回报的模型记进裁决日志」这一新字段——后者以本决策为前置，需另走 gate。

超出范围会怎样：把本 ADR 读成「判官可观测性已完备」是错的。它只让身份**归属**正确，没有增加任何新的观测量。

## 已知未验证项

- 上述传播矩阵由**执行顺序推出**，尚未逐个跑通。
- 入口 A/B/C 三个判别器尚未实现、尚未运行。
- 未实测轮转后 `gate-stats` 与 `gate-verdict` 的全期读数与轮转前可比（两者的归档正则均已核实接受 `legacy-<数字>` 形态，但未跑过前后对比）。
- 日志轮转会让**轮转瞬间正在进行中、且已被本闸 flag 过**的 session 读不到自己的历史（`lastVerdictOfGate` 只读活日志），其逃生口在该窗口内失效。**用户已知情接受**。暴露面实测：活日志 2872 个 (闸, session) 对中「最近一条 = flag」者 430 个，但其中 `ts >= 2026-08-17T05` 者仅 3 个——其余 session 早已结束。
- `~/.claude/logs/judge-gate.jsonl` 的 `KEEP_ARCHIVES = 3` 会淘汰更老的归档，未被消费的历史异常最终会随之消失。本 ADR 不处理。
