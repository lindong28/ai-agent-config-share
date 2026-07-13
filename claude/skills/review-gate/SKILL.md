---
name: review-gate
description: Use when 一轮代码/脚本/常驻配置（hooks、zshrc、skill 等 artifact）的生成或修改已完成、准备宣告完成或 commit 之前——此时必须过生成后 review gate；也用于用户显式要求过 gate 时（如"审一下刚写的"）。无改动的轮（如纯问答）与多步流的中间 step（自身不 commit 时）不自动触发。本 gate 是完成前的强制底线：指令 artifact（skill / command / reference / principles）的改动过本 gate 即含对应专项深审、不需另跑；其余对象不替代 review-pr 等专项深审，跑过通用 code-review 也不等于过本 gate。
origin: 2026-07-11（源：do-sleep 自查漏掉两个致命 bug 的 session）
---

# review-gate

骨架：触发与 review 对象（无改动 → 不触发）→ 定档（trivial → 免审声明即放行）→ 分档执行（指令 artifact → 专项路由到对应专项 command，其循环终止即放行、旁路 gate 裁决；其余按档位表）→ gate 裁决（修复闭环 / waive / 放行）→ 输出。

## 为什么存在

作者自查 ≠ review。作者在同一 context 里带着"我知道它该干嘛"的确认偏误读代码，对「借来的语义」（复用他处函数的返回值/语义）类缺陷系统性失明——动机案例：`do-sleep` 复用 `check-caffeinate-status` 的返回码当"能否睡眠"的闸门，但该函数的语义是诊断"合盖会不会被钉住"，语义错配导致"该睡时永不睡"；`zsh -n` + 局部 dry-run 全绿，两个致命 bug 全靠事后显式 review 才暴露。作者不会问"这个返回值到底代表什么"——因为"复用它"正是作者自己刚做的决策。声明式规定不绑定到动作上就没有执行力，所以本 gate 绑定在"宣告完成 / commit"这一可识别动作上——这仍是声明式约束的最锐利形态，harness 级 hook 强制留作二期加固。

## 触发与 review 对象

绑定点：宣告完成 / commit 前，"一轮"以此为界——plan 等多步流的中间 step 不单独触发（该 step 自身 commit 则触发）；委派的 subagent / 后台任务的完成回报也不构成绑定点（委派产出中含 commit 的除外——commit 前须过 gate），由主 session 在最终动作前统一过 gate。无改动的轮 → 不自动触发。

review 对象 = 本轮实际编辑的全部改动。git 工作区 diff（含未跟踪新文件）是回收手段而非定义：diff 混入非本轮内容时剔除；非 git 环境用本轮编辑的旧/新内容合成。diff 不可得 ≠ 免审。对象归属拿不准：有人值守经 `AskUserQuestion` 对齐；无人值守流只审可确认为本轮的部分并在输出中注明——归属不明的改动留给用户处置，避免把非本轮内容卷入裁决。

用户显式要求过 gate 时，review 对象由其指认；未指认则取最近一轮改动。

重点审查面默认为全部改动——仅用户有提及但含混时对齐，未提及不问。

## 定档

三维评分（每维 低/中/高）：

| 维度 | "高"的信号（不限于此） | 角色 |
|---|---|---|
| 后果严重度 | 系统级操作（进程终结/电源/删除）、不可逆、安全敏感、硬件风险 | 定档 |
| 逻辑隐蔽度 | 时序/竞态、进程父子与信号语义、「借来的语义」、隐式状态、并发 | 定档 |
| 复用频率 | 常驻配置（zshrc/hooks/skill 等每次生效的 artifact）、被反复调用的工具函数 | 乘数（机制见下） |

先按后果严重度/逻辑隐蔽度判基础档，首中即停：

1. 该两维任一高 → 高档
2. 否则任一中 → 中档
3. 否则（两维全低）→ trivial 免审

复用频率是暴露面的乘数，不量缺陷概率，不直接定档：

- 高 → 基础档升一档（trivial→中档、中档→高档）
- 中/低 → 不影响档位
- 改动无行为面（不改变执行语义的注释/文案；skill/hook 等指令性文本属行为面）→ 乘数不适用，放大零仍是零

trivial 免审必须显式声明"本次免审，理由 X"——免审可见、可审计；静默免审即违反 gate。用户显式要求过 gate 时，仅免审声明不够——经 `AskUserQuestion` 确认后方可免审；无人值守流不免审，按中档审。

定档 borderline（含 trivial 边界拿不准）：有人值守经 `AskUserQuestion` 对齐；无人值守流宁按高一档过，不阻塞。

## 分档执行

专项路由（先于下表机制）：review 对象为指令类文件（skill / command / reference / principles，下称**指令 artifact**）→ 中/高档不走下表，改为主 session 跑对应专项 command，按类型映射：**skill / command / reference → `/custom:review-skill`**；**principles 文件 → `/custom:review-principles`**（判据：主体即一套可审的评审原则、典型 `*-principles.md`；仅附带 Principles 段的 style/patterns 参考不算，归上一支）——principles 同时是 reference，按类型特异性取更具体的一支 review-principles。review 范围限本轮 diff（作为 diff-focus 输入下达；多文件逐文件跑，交互可合并）。findings 裁决 / 修复 / 落地重跑按对应专项 command 自身工作流（含用户裁决 + 中立重跑），其循环干净终止（实际跑完并达到用户裁决）即本 gate 放行——下方对抗式纪律的返回契约与「gate 裁决」severity 处置不适用于此路由。附加约束：

- **审不了 ≠ 审过 照常适用**：对应专项 command 未能实际完成（目标不可读 / subagent 失败 / 未达用户裁决）视同 gate 未过——不得以"循环形式上终止"当放行，处置按「gate 裁决」的该条（重试或交用户裁决）。
- **混合改动分流**：同轮既有指令 artifact 又有其它代码 → 指令 artifact 走本路由、其余走下表，两路都过才放行。
- **trivial 先于路由**：trivial 免审照常在路由前生效，免审即不进专项 command。
- **主 session 而非 headless**：对应专项 command 裁决层依赖 `AskUserQuestion`，headless 会砍掉用户终裁。无人值守流审查阶段照跑，至用户裁决处阻塞等待——沿用本 gate 不降级原则。

| 档位 | 机制 | 要点 |
|---|---|---|
| 中档 | 内置 Agent subagent（独立 context），spawn 时为实例命名，便于复核轮（见「gate 裁决」修复闭环）续聊 | 快、零外部依赖 |
| 高档 | `codeagent-wrapper --backend codex "<prompt>" <workdir>` 新 session，记录输出中的 session_id 供复核轮 resume | 独立新 session 对抗审，默认跨模型消同盲区；同步前台等，不用 run_in_background |

高档同步前台等的理由：gate 本身阻塞后续动作，后台化只会平添 Background Agent 巡检负担。backend 选择：默认 codex；review 对象强依赖仓内私有约定/大量本地上下文时改 `--backend claude`——缺上下文的对抗审只产噪音 finding，此时上下文完整性 > 跨模型性。中档用无 persona 的通用 subagent 类型（如 general-purpose）——带 persona 的 reviewer agent 类型自带 system prompt，会压过本 gate 随 prompt 下发的返回契约与对抗 framing。

对抗式纪律（两档通用，reviewer prompt 按此构造）：

- **喂什么**（发起 review 前逐项核对）：
  - 改动目标——表述在预期行为/结果层，不含实现选择
  - review 对象的 diff（取得方式见「触发与 review 对象」）
  - 改动所在根目录的绝对路径（git 仓库根；非 git 则覆盖全部改动文件的最小公共父目录）——即高档命令的 `<workdir>`
  - （如有）与用户对齐的重点审查面
  - 环境事实——按「reviewer 无法自行取得、且缺了会误判」筛入，其余明确指示 reviewer 自行追读 diff 所引用/复用的函数、配置、文件的源定义："必要事实"由作者筛选会把作者盲区一并滤进去
- **不喂什么**（复核轮同样适用；误报争议轮除外——按该条条款处置）：作者的实现思路或自辩——防 anchoring；reviewer 必须自己回答"这个返回值/这个函数的语义是什么"。
- **对抗 framing**：要求"找出会让它失败的输入/时序/状态"，不是"确认它没问题"。
- **返回契约**：结构化返回 severity + 具体失败场景；severity 定级判据随 prompt 附上并以此为准——CRITICAL/HIGH = 真实使用中会产生错误行为/数据损失/安全风险，MEDIUM = 质量隐患但不改变行为，LOW = 风格。reviewer 另须列出未能核实的引用/复用语义及原因（源不可达、不在 workdir 等）。处置上本 gate 对 HIGH 从严于 `~/.claude/rules/common/code-review.md` 的 Review Severity Levels（那边 HIGH 仅 WARN 不阻塞）。

## gate 裁决

- **CRITICAL/HIGH**（定级见「分档执行」返回契约）：修复、或用户经 `AskUserQuestion` 显式 waive 之前，不得宣告完成、不得 commit。
- **MEDIUM/LOW**：列给用户，采纳与否用户定，不阻塞放行。
- **误报争议**：有具体依据认定 finding 不成立时，不先动代码——附依据把 修复 / waive / 撤回（认定误报）经 `AskUserQuestion` 交用户；无人值守流先回传 reviewer 反驳一轮，仍不收敛则阻塞等待用户裁决。
- **修复闭环**：修复 → 修复 diff 回传原 reviewer（中档：SendMessage 续聊；高档：`codeagent-wrapper resume <session_id> "<复核任务>" <workdir>`，session_id 提取不到即按不可续。任一档不可续时新起 reviewer——中档新 spawn / 高档新调用，prompt 至少含：原 finding、修复 diff（复核对象）、原 diff（仅背景，勿全审）、返回契约（含定级判据）与原审环境事实，workdir 同原审，对抗 framing 换成复核两问：修复是否成立、有没有引入新问题）→ 只答此两问——不重开全审：复核对象是修复本身，全审会重新 anchoring 已裁决的 findings 且拖长闭环 → 复核发现的新 findings 同样按本节裁决；不成立则回到修复。修复若需改动本轮 review 对象之外的共享语义（被复用函数/配置的对外行为），先经 `AskUserQuestion` 对齐修法，无人值守流选波及面最小者并注明。多轮不收敛时 `AskUserQuestion` 交用户裁决。
- **审不了 ≠ 审过**：review 无法完成（调用失败/超时/结果无法解析）视同 gate 未过——重试或换 backend，仍不行则交用户裁决；reviewer 报告的「未能核实项」同此处置——补喂对应环境事实复审该项或交用户，不得计入放行；禁止静默降级为自查或免审。
- **放行**：无 CRITICAL/HIGH 遗留（修复复核通过、已 waive、或经误报争议撤回），且无未处置的「未能核实项」→ gate 通过，输出裁决后方可宣告完成 / commit。

无人值守流：条内已给默认的按条内执行（误报争议先回传反驳、修法对齐选波及面最小）；需用户裁决而无默认的（waive、多轮不收敛、审不了的最终处置）阻塞等待，不得以无人应答为由降级放行。「触发与 review 对象」与「定档」两节的无人值守默认见各节。

## 输出

定档结论一句话（trivial 时即免审声明）+ findings + gate 裁决；findings 过长时完整版落 scratchpad 并给出路径。

## 不做

- 指令 artifact 之外不替代 review-pr 等专项深审——gate 是完成前的强制底线，不是最深的审。指令 artifact 上 gate 经对应专项 command（review-skill / review-principles）执行（见「分档执行」专项路由），过 gate 即本轮 diff 已过对应专项审，不就同一 diff 重复跑。
- 不经由 review-selector / review-evaluator 选 reviewer，也不做 reviewer 打分/评测——二者质量未经检验，用户已裁决不依赖。
