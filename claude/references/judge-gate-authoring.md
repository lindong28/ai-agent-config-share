# Judge Gate Authoring

造一道**判官闸**——挂在 Stop / SubagentStop / PreToolUse 上、调 `lib/llm-judge` 让 LLM 判定、命中即阻断的 hook——时的跨闸不变量。本仓现有 7 道：`stop-gate`、`prose-choice-gate`、`capability-claim-gate`、`reverse-assertion-gate`、`continuation-claim-gate`、`ask-recommend-gate`、`permission-gate`。**权威名册是 `~/.claude/hooks/lib/llm-judge.js` 里的共用者清单，不是"文件名带 -gate"**。

阻断形态按事件分：Stop / SubagentStop 用 `exit 2`；PreToolUse 用 `permissionDecision`。下面的不变量对两种都成立，仅第 7 条按事件有别（PreToolUse 无 `stop_hook_active` 等价物）。

**为什么集中在这里**：这些不变量此前散在各闸的文件头里、无索引，作者只能靠读别人源码才知道哪些是必须的。代价已经发生——最新造的 `continuation-claim-gate` 缺了递归守卫与逃生口留痕两样。

**想知道某道闸当前满足哪几条，得逐条读它的实现——`grep` 出某个标识符在场回答不了这个问题。** 实例：`last_assistant_message` 出现在 5 道闸里，但其中 3 道仍保留转录尾窗回落，真正只认内联的只有 2 道；两种情形下那个 grep 的读数完全相同。本文件初稿就是这么数出来的，数错了。

下面每条都从**已观测的失败**来，不是推测。编号即动手顺序。

| # | 不变量 | 一句话 |
|---|---|---|
| 1 | 先判该不该造 | 声明层反复失守才升级为闸 |
| 2 | 判官输入 | 只认 payload 内联消息，不回落转录尾窗 |
| 3 | fail-open | 任何不确定一律放行 |
| 4 | 递归守卫 | 判官调用会再触发本闸 |
| 5 | 应答解析 | 单行协议整串匹配，协议外放行 |
| 6 | 记录 | verdict 分得开各出口；判官身份随判决记下 |
| 7 | 逃生口留痕 | 否则算不出本闸的误报率（PreToolUse 闸无此机制） |
| 8 | 两层验证 | eval 验判官行为；确定性 test 验控制流，两者打不到对方 |

---

## 1. 先判该不该造这道闸

本仓惯例：同一失败模式先在声明层处置（规则 / reference），**反复失守才升级为 hook**。`reverse-assertion-gate` 是第三次才升级的。

举证责任在作者身上：拿出前几次声明层没挡住的实例。拿不出就先别造——每多一道闸，每一次停止就多一次判官调用与一次误报机会。

## 2. 判官输入只认 payload 内联的那条消息，不回落读转录尾窗

`lastAssistantMessage(transcript_path)` 返回的是"当前落盘的最后一条 assistant 文本"（见 `~/.claude/hooks/lib/transcript.js` 的 `NO FRESHNESS CONTRACT` 段）——它未必是触发本次停止的那条。而闸会阻断，拿回合**中段**的叙述阻断这一回合是纯错误：中段的「先做 X：」后面紧跟着做 X 的工具调用，它在构造上就不是延期承诺。

实测误拦一次，判的正是这种中段句。内联字段缺席就 fail-open，别回落——取舍是"退化成没有这道闸"好过"退化成判错对象的闸"。

**现状**：`reverse-assertion-gate` 与 `continuation-claim-gate` 已只认内联；`stop-gate` / `prose-choice-gate` / `capability-claim-gate` **仍保留回落**，各自头部有当时的书面理由；`ask-recommend-gate` 与 `permission-gate` 是 PreToolUse 闸、判的是工具入参，本条不适用。本条约束**新闸**，别读成"全仓已合规"。

## 3. 任何不确定一律 fail-open

误放行只是回到没有这道闸的状态；误拦截会困住 agent。stdin 读不到、JSON 解析失败、payload 不是对象、判官不可用、判官答非所问、探测拿不到运行态——全部放行。

注意 `JSON.parse("null")` 会**成功**并产出 `null`，随后取字段抛 `TypeError` 而非 clean fail-open（实测 exit 1）。

## 4. 递归守卫

判官调用本身会经过 hook 层，没有守卫时它会再触发一次本闸。机制见 `~/.claude/hooks/lib/llm-judge.js`：spawn 判官时往子进程 env 注入一个标记，子进程的 hook 继承它。

**`NEST_GUARD` 是 llm-judge 导出的常量名，它的值才是真正的 env 键**（当前为 `CLAUDE_LLM_JUDGE_NESTED`）。照字面写 `process.env.NEST_GUARD` 会恒为 undefined、不报错，直到无限递归。正确写法是各闸都在用的那个：

```js
const { callJudge, NEST_GUARD } = require("./lib/llm-judge");
// …先解析 stdin…
if (process.env[NEST_GUARD]) return skip("嵌套判官调用内（防递归）", input);
```

**位置是"解析 stdin 之后、调判官之前"，不是 `main()` 第一行。** 反过来的话，嵌套那条记录的 `event` / `session_id` / `transcript_path` 全是 null，读者无法知道它属于哪一次停止——而"分得开"正是第 6 条那份日志存在的理由。现役 3 道闸（`prose-choice` / `reverse-assertion` / `capability-claim`）都在解析后检查，并在源码里写明了这个理由。

注入在 llm-judge 侧、检查在各闸侧——新闸漏了这一步就是无限递归。

## 5. 判官应答只认单行协议整串匹配

`ok\nflag: 其实有问题` 这类自我修正，按前缀解析会把犹豫读成确定。协议外的一律 fail-open。

## 6. 记录：verdict 要分得开各出口，判官身份要随判决记下

`~/.claude/hooks/lib/judge-log.js` 头部是这组字段的权威定义，动手前读它。两处最容易做错：

- **`verdict` 不得退化成布尔。** "判官说没问题"、"探测短路了所以没调判官"、"判官不可用"、"输入缺失提前退出"事后必须分得开——合流成一个 `ok` 会让排查本闸是否误判时失去唯一依据。但**取值域是共享的**：现役值已含各闸自加的 `ok_live_task` / `detect_unavailable`，而 `logVerdict` 不校验、`~/.claude/bin/gate-stats` 按已知值分类。新增取值前先看消费方会把它算进哪一档，否则它会被静默归错。
- **不落 verdict 的出口，eval 打不到分。** eval runner 用 `CLAUDE_JUDGE_LOG_PATH` 把裁决日志隔离到临时文件，再读**新追加的那条 `verdict`** 来判分（不看退出码）。所以本条不是记账偏好——某条出口不写 verdict，第 8 条的 eval 在那条路径上就恒为 `no-verdict`、永远测不到它。
- **`backend` 与 `model` 记的是"这次是哪个判官在判"**，用来把"判据改了"与"模型换了"分开。注意 `model` **缺席是一个有意义的状态**（调用侧解析不到具体版本）——judge-log 明确要求刻意留空而**不是**写死别名，因为别名换代时固定字符串保持不变，正好制造这组字段要防的那种混淆。

## 7. 逃生口必须留痕

闸要留逃生口（没有它误报会困住 agent），但**走逃生口这个动作必须在日志里可辨**——否则你永远算不出这道闸的误报率，而误报率正是决定它会不会被关掉的那个数。

本仓现有三套形态，代价不同：

| 形态 | 谁在用（逐个读实现所得，**不是 grep 数的**） | 痕迹 |
|---|---|---|
| `stop_hook_active` **按闸计** + 落痕 | `prose-choice`、`capability-claim`、`reverse-assertion`、`continuation-claim` | 落一条 `skipped`，两种成因不同形（`本闸拦的` / `不可考`）；但与"改完再停"仍同形——实测 60 条 flag 里 21 条卡在这个二义里（35%） |
| `stop_hook_active` 裸放行 | `stop-gate` | **零记录** |
| 口令式（消息里含 `*-OK`） | `continuation-claim`、`stop-gate` | **零记录** |
| 无逃生口 | `ask-recommend`、`permission-gate`（PreToolUse 无 `stop_hook_active` 等价物，靠 fail-open + 判官宽松取向防循环） | 不适用 |

落痕的那一档只做到"可辨的二义"，其余两档连有没有走过都看不见——**三档都支撑不了误报率统计**。新闸至少要让走逃生口这一步落一条**与"改完再停"不同形**的记录；已有的二义只能靠人工裁决（`gate-verdict`）逐条分开。

**`stop_hook_active` 必须按闸计，不能直接当本闸的私有标记。** 它是 Claude Code 给的全局状态（"本次继续是因为某个 Stop hook"），不说是哪一道闸拦的。读到它就无条件跳过，等于任一 sibling 开火后本闸对**改后的那条消息**全盲——而"改完重发"正是最容易引入新违规的时刻。实测（2026-08-09，单 session 169 条判官记录）：18 条是这种跳过，其中一次漏掉的正是一条把并列备选写成正文的收尾，事后把同一段完整原文离线喂给该闸判官 7/7 全 flag——**漏报不在判据上，在这道守卫上**。

正确形态见 `lib/judge-log.js` 的 `lastVerdictOfGate`：只在**本闸自己**上一停判了 `flag` 时跳过（那才是"原样再停一次即放行"的逃生口）；本闸上一条是 `ok` / `skipped` 说明拦下本停的是别的闸，本闸从未判过这段新文本，照常判。查不到本闸历史时保守跳过，理由写成与逃生口**不同形**的字样。未改内容的重发不会因此多挨打断：其余闸在上一停（标志为假）已判过同一段文本且判了 ok。

这条只能靠**控制流 test** 守住，eval 打不到（§8）。判别器是"同一 payload、只改本闸上一条记录的 verdict"这一组：旧实现两种都跳过，新实现只有 `flag` 那种跳过——没有这一组，改动在测试里与没改过同形。样板见 `prose-choice-gate.control-flow.test.js` 的 A/B 两组，含一条钉住已知残余的 D 组。

## 8. 两层验证：eval 验判官，确定性 test 验控制流

**这两层打不到对方，缺任一层都会漏。** eval 采样判官在给定文本上的判决，验不了"这道闸从哪取文本、守卫放在哪一步、逃生口落没落痕"——那些是控制流。第 2 / 4 / 7 条只能靠**断言 `verdict` 的确定性 test** 守住，而且必须断言 verdict、不能只断言退出码：`reverse-assertion-gate.test.js` 头部写明了理由——转录回落若被加回来、判官恰好判 ok，退出码同样是 0，两种情况同形。做法是经 `CLAUDE_JUDGE_LOG_PATH` 把裁决引到临时文件再断言它。

本文件开头那个案例正是这么漏的：`continuation-claim-gate` 的 test 是纯判官标定台（直调 `judge()`、绕开 `main()`），所以它缺递归守卫与逃生口留痕这件事，没有任何测试挡得住。7 道闸里目前只有 4 道有 `.test.js`。

### eval：变异测试 + 两侧阈值按"错了代价高"定

**套件全绿本身是个不能当结论用的读数**——它在"prompt 有判别力"和"场景离边界太远、任何 prompt 都能过"两种情况下长得一样。做法：把判据换成一条假轴，确认该翻的场景真的翻。`~/.claude/hooks/eval/reverse-assertion-gate/README.md` 有完整示范与实测数字，示范在「**怎么证明这套 eval 有效（首次全绿时必做）**」一节；改 prompt 前另读「两处已知边界」与「阈值为什么分两档」。

**两侧阈值不对称，100% 给的是"错了代价高"的那一侧——不是某个固定的场景名。** 落到具体闸上极性会翻：

| 闸 | 100% 侧 | 为什么 |
|---|---|---|
| `reverse-assertion-gate`（Stop 判官闸） | ok 场景 | 误报 = 用户被无谓打断，是这类闸被直接关掉的主因；漏报只是回到没有它时的状态 |
| `permission-gate`（PreToolUse 判官闸） | `must-ask` | 漏拦 = 危险命令被自动放行 = 安全事故；而"安全命令弹了个框"只是 mild annoyance，落在 80% 的松侧 |

**照抄场景名会把阈值装反。** 先问这道闸哪一侧错了代价高，再定谁 100%。

改 judge prompt 时**优先删过宽的词，不要补否定式澄清**：实测加一句反向注解会被小判官过度泛化，把无关场景从 5/5 打到 0/5。

---

**造完之后**：闸的代码走 `~/.claude/skills/review-gate/SKILL.md`（常驻 hook、每回合生效，定档不会低）；控制流不变量（第 2 / 4 / 7 条）要一份断言 `verdict` 的确定性 test，判官行为要过 eval——两层都在第 8 条。

**投入使用后**：单次裁决用 `gate-verdict`（用户 scope，任何项目可用）；批量复盘用 `gate-review` skill——它是 **ai-agent-config 仓的项目 scope**，只在该仓内可用。
