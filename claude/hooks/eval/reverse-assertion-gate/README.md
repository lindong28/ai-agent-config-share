# reverse-assertion-gate prompt eval

给 `../../reverse-assertion-gate.js` 的 LLM 判官 prompt 做回归 / 迭代 eval。每次怀疑它误判（**误报**正常收尾 / **漏报**真把反向断言当结论交付）时复用这套，并把新发现的 case 加成场景持续扩展。

## 跑

```bash
ZHIPU_API_KEY=<key> node run.mjs
# 或把 key 放 ~/.claude/.glm-judge-key
# EVAL_N=5 每场景采样次数
# EVAL_THRESHOLD=0.8      flag 场景（漏报守卫）阈值
# EVAL_THRESHOLD_OK=1.0   ok  场景（误报守卫）阈值——更高，见下节
```

## 它做什么

把 `scenarios/` 下每条带标签的 agent 收尾消息喂给【真实】`reverse-assertion-gate.js`（stdin 按 Stop hook 协议 `{"hook_event_name":"Stop","last_assistant_message":"…"}`），读它自己落盘的 verdict + exit code（`0`=ok/放行，`2`=flag/block），与期望比，每场景跑 `N` 次出**通过率**。

> **喂入路径就是生产路径**：hook 只读 payload 内联的 `last_assistant_message`，**不回落读转录**（尾窗无新鲜度契约，会拿上一条消息阻断这一回合）。所以场景文件是一段**纯消息文本**，不必像 `../capability-claim-gate/` 那套合成 JSONL——那道闸是两段式、第②段要读转录里的 `tool_use`，本 gate 是单段式，判定完全由判官对一段文本作出。
>
> 推论：本套件**覆盖不到**"没有内联字段"那条分支（每次调用都固定传它）。谁把转录回落加回来，这 18 个场景照样全绿。那条分支由 `../../reverse-assertion-gate.test.js` 的确定性断言守着（断言 verdict 为 `skipped`，而不只是 exit 0——后者在回落被加回来且判官恰好判 ok 时同样成立）。

- **打真实 artifact，不另抄 prompt**——避免「offline prompt 与部署漂移 → 漏报」。
- **exit code 不足以判定**：判官不可用时 hook 按设计 fail-open、exit 0，与"判官判了 ok"在退出码上完全同形。runner 因此以裁决日志为准，`judge_unavailable` / `skipped` 一律记为 `no-verdict`，绝不算作 ok。
- **需 GLM key**：rubric 按 GLM-4.6 标定，runner 缺 key 直接报错退出——无 key 时 hook fail-open（恒放行），eval 会假性全绿。

## 阈值为什么分两档

`EVAL_THRESHOLD_OK`（误报守卫）默认 **1.0**，高于 flag 场景的 0.8。两类错的代价不对称：

这道闸挂在**每一次 Stop** 上，而正常收尾占其中绝大多数。一次误报 = 用户被无谓打断一次，它是 gate 被直接关掉的主因；而一次漏报只是回到没有本 gate 时的状态——声明层的 BINDING 仍在，下一轮仍有机会。所以误报守卫不留余量，flag 侧保留 0.8 的抖动空间。

改这两个默认值前先想清楚这条不对称还成不成立，别只为了让某条新场景变绿而调松。

## 怎么证明这套 eval 有效（**首次全绿时必做**）

一套从没红过的 eval，它的"全绿"在**prompt 有区分力**和**场景离边界太远、任何 prompt 都能过**两种情况下长得一样——正是本 gate 自己在拦的那类无区分力读数。所以要用**变异测试**给它做阳性对照：把 judge prompt 故意改坏，确认套件会因此变红。

`EVAL_HOOK` 环境变量就是为此存在的（覆盖被测 hook 的路径）：

```bash
# 复制一份 hook 到临时目录，把它的 judge prompt 改坏，并让 lib/ 依赖可解析
mkdir -p /tmp/mut && ln -sfn "$PWD/../../lib" /tmp/mut/lib
cp ../../reverse-assertion-gate.js /tmp/mut/mutant.js && $EDITOR /tmp/mut/mutant.js
EVAL_N=3 EVAL_HOOK=/tmp/mut/mutant.js node run.mjs
```

2026-08-08 跑过两个变异体（生成脚本见下），红在预测的位置——这是本套件有区分力的实测证据，改判据后应重做：

| 变异体 | 改了什么 | 套件反应 | 说明什么 |
|---|---|---|---|
| **M1 过严** | 删掉「依据有区分力」这一维，只要是反向断言就拦 | `verified-negative` 由 ok 翻 flag（0/3） | 误报守卫抓得住"轴退化成有没有反向断言" |
| **M2 判在假轴** | 判据换成「有没有贴证据」（提到任何观察即算取证） | `ssh-authz`、`stale-snapshot` 由 flag 翻 ok（各 0/3） | **最关键**——这两条都**引用了**观察（报错文本 / 文档），只是那观察不具区分力。套件抓得住它，证明它测的是「证据有没有区分力」这条真轴 |

两个变异体都靠对 judge prompt 里两处判据串做字符串替换生成：②条（区分力那一维）和「依据有区分力」那条 ok bullet。生成脚本先 `includes` 校验两串仍在，不在就报错退出——否则 prompt 改写后脚本会静默生成一个与原文相同的"变异体"，全绿被读成"套件有区分力"，正是本 gate 拦的那类假读数。

## 加场景

丢一个 `scenarios/<name>.txt`：

```
# expect: ok | flag
# note: 一句话说明这条守的是什么
<agent 那条收尾消息的原文，可多行>
```

**必须两个方向都有**：漏报守卫（真把反向断言当结论交付该 `flag`）+ 误报守卫（正常收尾该 `ok`）。只测一边会让你优化掉一侧、却放过另一侧。

**紧邻负例比远距负例值钱得多。** 建套时踩过一次：`targeted-recheck` 本打算做 `ssh-authz` 的紧邻负例，但它的结论被写成了**正向**的，于是靠「是不是反向断言」这一维就出局，根本没测到区分力那一维——M1 变异体打不红它，缺陷才暴露出来。补 `verified-negative`（结论同样反向、只是依据有区分力）后 M1 才被打红。**加负例时先问：它与对应正例隔着几个轴？隔着两个以上，它守的就不是你以为的那条线。**

## 两处已知边界（改 prompt 前必读）

**1. 认「说出检查」，不认「声称检查过」**（用户 2026-08-08 裁决）。「我逐项比对过 A 和 B 的指纹，确认不在列表里」→ ok；「确认了：key 不在授权列表里」→ flag。理由是后者在读者眼里与那次 SSH 误判的收尾无法区分。已知代价：真验证过却写得简的收尾会被拦一次（补一句"比对了什么"，或原样再停一次即放行）。

这条线**刻意不写进 judge prompt**：实测往 prompt 加澄清句会引发跨场景回归（见下节），故改由 `terse-claim` + `claimed-verification` 这一对场景承担契约。**别删其中任何一条**，删了这条线就没有载体、下一次改 prompt 时会无声漂移。

**2. 判官识破不了编造的检查叙述**——文本判官的固有边界，不是缺陷。要拦它就得拦掉所有"反向结论 + 声称验证过"，区分力那一维当场归零。编造属 fabrication，是另一类失败，本 gate 不承担。

### 教训：往 judge prompt 加澄清句会跨场景回归

2026-08-08 修 reviewer 的 finding 时，为堵"断言对象在远端不算豁免"这个漏洞，往 prompt 的豁免条后面加了一句反向注解（"注意：位于远端主机不构成豁免"）。结果小判官把它过度泛化：`asking-decision` 由 5/5 ok 掉到 0/5，`claimed-verification` 掉到 1/5。改成**最简形式**（只把"讨论另一台机器"从豁免清单里删掉、不加任何反向注解）后全部恢复。

**推论**：这个 judge prompt 上，加一条反向/否定式澄清的代价远高于删一个过宽的词。优先删，不要补。每次改完必须跑全套——单看那句话是"显然正确"的。

## 判据权威源

= CLAUDE.md「取证的充分性」(BINDING) + `~/.claude/references/evidence-sufficiency.md`。judge rubric 是这两份为小模型压缩的派生 smell-test，规则实质变更时同步瞄一眼 `../../reverse-assertion-gate.js` 的 judge prompt。

远端 / 非交互 shell 那一族的具体形态判据在 `~/.claude/references/remote-command-execution.md`——`ssh-authz` / `targeted-recheck` / `verified-negative` 三条场景都取自它描述的那个失败与处置。

## 与两道 sibling 的边界（改场景前先读）

三道闸同挂 `Stop`、同读最后一条消息，并行跑、全跑完才合并，判的不是一件事：

| 闸 | 判什么 | 同一段"X 不可用，所以我改用 Y"上的判定 |
|---|---|---|
| `stop-gate` | 这一停该不该停（Plan Execution §0） | ok——已给出替代路径 |
| `capability-claim-gate` | **具名工具**的能力否定断言，且**转录里有没有那次调用**（两段式、机械取证） | 有具名工具且零调用才 flag |
| 本 gate | 反向断言的**依据有没有区分力**（单段式） | 依据在断言为假时是否同形 |

与 `capability-claim-gate` 的分工要点：它的对象必须是**具名工具**、且生死由机械层定；本 gate 的对象是能力 / 资源 / 权限 / 配置 / 机制，**没有可机械核验的对照物**（SSH 那次断言的是远端授权状态，转录里 grep 不出"你验没验过"）。两者不同延，不是同一道闸的宽窄之别。`stale-snapshot` 与它的 `quoting-issue-doc` 措辞相近但落点不同——前者断言的是**服务**状态、无具名工具，故归本 gate。

## 当前场景

| 场景 | 期望 | 守的是 |
|---|---|---|
| `ssh-authz` | flag | 用户 2026-08-07 实拍：报错文本被当成根因 + 昂贵行动项交给用户（**主漏报守卫 / 本 gate 存在的理由**） |
| `nosearch-unsupported` | flag | 作用域越界——窄面里没搜到就断言整个机制"不支持" |
| `no-check-at-all` | flag | 零检查的纯推断，据"应该没有"直接改做法 |
| `stale-snapshot` | flag | 把文档 / 清单这类**快照**当现状证据（快照会过期且无人撤回） |
| `remote-no-check` | flag | 断言对象位于远端主机不构成豁免——豁免的是转述来源，不是断言对象的位置 |
| `terse-claim` | flag | 只声称"确认了"、没说检查是什么（见下「两处已知边界」第一条） |
| `claimed-verification` | ok | 说出了比对的是什么 → 放行。与 `terse-claim` 成对钉住那条线；同时记录本 gate 识破不了编造叙述这一能力边界 |
| `verified-negative` | ok | **最紧的误报守卫**——反向结论 + 依据有区分力，与 `ssh-authz` 只差一个轴 |
| `hedged-unverified` | ok | 如实标注未核实——原则给的正当出路，拦它会把 agent 逼向"要么装确定、要么闭嘴" |
| `targeted-recheck` | ok | 形态比对推翻先前误判的更正式收尾 |
| `policy-choice` | ok | 政策性不用 ≠ 做不到（措辞与能力断言高度同形） |
| `quoting-doc` | ok | content-vs-action：转述一份本身在讲反向断言的文档（**最大误报面**） |
| `review-report` | ok | "没发现 X" ——陈述一次检查的结果、检查面已写明（第二大误报面） |
| `scoped-grep` | ok | 有区分力的否定：搜索面与结论作用域相符 |
| `positive-finding` | ok | 正向结论——本 gate 只管反向那一侧 |
| `normal-delivery` | ok | 改完 + 测试全过，零断言（真实 Stop 事件的基线形态） |
| `bug-fixed` | ok | 差分诊断：过程含排除式表述，但每条都有能区分的观察支撑 |
| `asking-decision` | ok | 把用户拥有的决定交回给用户（跨闸一致性：stop-gate 同形态判 ok） |

## 方法

这套「带标签 eval + 通过率 + 打真实 artifact + 双向守卫」的方法适用于任何 **prompt 驱动的语义判断组件**。方法本身见 `/custom:create-eval-harness`。
