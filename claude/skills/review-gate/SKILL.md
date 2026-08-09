---
name: review-gate
description: Use when 一轮代码/脚本/常驻配置（hooks、zshrc、skill 等 artifact）的生成或修改已完成、准备宣告完成或 commit 之前——此时必须过生成后 review gate；也用于用户显式要求过 gate 时（如"审一下刚写的"）。无改动的轮（如纯问答）与多步流的中间 step（自身不 commit 时）不自动触发。本 gate 是完成前的强制底线：指令 artifact（skill / command / reference / principles / CLAUDE.md·AGENTS.md）的改动过本 gate 即含对应专项深审、不需另跑；其余对象不替代 review-pr 等专项深审，跑过通用 code-review 也不等于过本 gate。
origin: 2026-07-11（源：do-sleep 自查漏掉两个致命 bug 的 session）
---

# review-gate

骨架：触发与 review 对象（无改动 → 不触发）→ 定档（trivial → 免审声明即放行；改变面向人产物之结论者不落 trivial）→ 分档执行（指令 artifact → 专项路由到对应专项 command，其循环终止即放行、旁路 gate 裁决；改变面向人的终端输出 / 数据契约 / 告警 → 在档位表之上叠加对应专项 command；其余按档位表）→ gate 裁决（修复闭环 / waive / 放行）→ 输出。

## 为什么存在

作者自查 ≠ review。作者在同一 context 里带着"我知道它该干嘛"的确认偏误读代码，对「借来的语义」（复用他处函数的返回值/语义）类缺陷系统性失明——动机案例：`do-sleep` 复用 `check-caffeinate-status` 的返回码当"能否睡眠"的闸门，但该函数的语义是诊断"合盖会不会被钉住"，语义错配导致"该睡时永不睡"；`zsh -n` + 局部 dry-run 全绿，两个致命 bug 全靠事后显式 review 才暴露。作者不会问"这个返回值到底代表什么"——因为"复用它"正是作者自己刚做的决策。声明式规定不绑定到动作上就没有执行力，所以本 gate 绑定在"宣告完成 / commit"这一可识别动作上——这仍是声明式约束的最锐利形态，harness 级 hook 强制留作二期加固。

## 触发与 review 对象

绑定点：宣告完成 / commit 前，"一轮"以此为界——plan 等多步流的中间 step 不单独触发（该 step 自身 commit 则触发）；委派的 subagent / 后台任务的完成回报也不构成绑定点（委派产出中含 commit 的除外——commit 前须过 gate），由主 session 在最终动作前统一过 gate。无改动的轮 → 不自动触发。

review 对象 = 本轮实际编辑的全部改动。git 工作区 diff（含未跟踪新文件）是回收手段而非定义：交 reviewer 前逐文件确认归属，本轮未编辑过的整份剔除、编辑过的文件里非本轮的 hunk 同样剔除——这类外来 hunk 根本不进 review 对象，与「对抗启动面」那里作为只读 payload **被排除**、但仍随 prompt 交 reviewer 校验的 hunk 是两回事。剔除若只在"恰好注意到混入"时发生就会漏——live config 由运行中的工具自己重写、无关脏改动又按纪律保留，diff 带外来内容是常态而非例外；且外来 hunk 一旦被当作本轮改动，gate 的修复闭环会替它的真实作者改决定。非 git 环境用本轮编辑的旧/新内容合成。diff 不可得 ≠ 免审。对象归属拿不准：有人值守经 `AskUserQuestion` 对齐；无人值守流只审可确认为本轮的部分并在输出中注明——归属不明的改动留给用户处置，避免把非本轮内容卷入裁决。

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
- 改动无行为面（不改变执行语义的注释/文案；skill/hook 等指令性文本属行为面；面向人产物的文案改动，凡改变读者能得出的结论者同属行为面，见下）→ 乘数不适用，放大零仍是零

**面向人产物的档位下限**：改动改变了读者据以判断"成功了吗 / 能用吗 / 要不要动手"的产物（面向人的终端输出、数据契约、服务告警）时，基础档至少中档。上两维考察后果与逻辑、不考察表达，两维皆低只说明它不会炸，不说明读者读得懂——这类缺陷对定档器不可见，故另立下限而非依赖它。判据是改动后读者能得出的结论会不会变；纯字面润色（错别字、标点、同义替换）不改变结论，仍按上两维走。

trivial 免审必须显式声明"本次免审，理由 X"——免审可见、可审计；静默免审即违反 gate。用户显式要求过 gate 时，仅免审声明不够——经 `AskUserQuestion` 确认后方可免审；无人值守流不免审，按中档审。

定档 borderline（含 trivial 边界拿不准）：有人值守经 `AskUserQuestion` 对齐；无人值守流宁按高一档过，不阻塞。

若改动隶属一份记录 rigor `(A,V)` 的 plan，读取 `~/.claude/references/rigor-tiers.md`，按其组合契约把本地定档与 plan `(A,V)` / override 逐维取高；本地定档是不可降低的 V floor，不因 plan tier 较低而降档。trivial 免审仍先于本组合（无行为面的改动 floor 不适用）；只有有行为面的 unit 按有效向量升档。

## 分档执行

专项路由（先于下表机制）：review 对象为指令类文件（skill / command / reference / principles / CLAUDE.md·AGENTS.md，下称**指令 artifact**）→ 中/高档不走下表，改为主 session 跑对应专项 command，按类型映射：**skill / command / reference → `/custom:review-skill`**；**CLAUDE.md / AGENTS.md（symlink 审其实际 source）→ `/custom:review-claude-md`**；**principles 文件 → `/custom:review-skill`**（与其余 reference 同一支：本仓未收录专审 meta-原则的 `/custom:review-principles`，所以 principles 只作为 reference 受审，「这套原则本身立不立得住」这一维度不被覆盖，reviewer 须按 review-skill 类型 gate 声明该维度未审）。review 范围限本轮 diff（作为 diff-focus 输入下达；多文件逐文件跑，交互可合并）。findings 裁决 / 修复 / 落地重跑按对应专项 command 自身工作流（含用户裁决 + 中立重跑），其循环干净终止（实际跑完并达到用户裁决）即本 gate 放行——此路由的**排除范围仅限**下方对抗式纪律的返回契约字段与 severity 定级 / 处置；「gate 裁决」其余各条（越权失效、审不了、独立 findings 去向）照常适用，其中依附 / 独立标注、以及新写入断言的读数核验（见「gate 裁决」的「修复轮不得引入未经测量的事实断言」），由主 session 在专项 command 的裁决处**逐条**给出——这一支的执行者是作者本人、比 reviewer 弱，但重跑一条命令是客观动作，不像"判自己漏没漏"那样受确认偏误支配——否则指令 artifact 的 review 恰好落在该机制的真空里。附加约束：

- **审不了 ≠ 审过 照常适用**：对应专项 command 未能实际完成（目标不可读 / subagent 失败 / 未达用户裁决）视同 gate 未过——不得以"循环形式上终止"当放行，处置按「gate 裁决」的该条（重试或交用户裁决）。
- **混合改动分流**：同轮既有指令 artifact 又有其它代码 → 指令 artifact 走本路由、其余走下表，两路都过才放行。
- **trivial 先于路由**：trivial 免审照常在路由前生效，免审即不进专项 command。
- **主 session 而非 headless**：对应专项 command 裁决层依赖 `AskUserQuestion`，headless 会砍掉用户终裁。无人值守流审查阶段照跑，至用户裁决处阻塞等待——沿用本 gate 不降级原则。

产出型专项审：「专项路由」按 review 对象是什么文件分派，本条按改动产出了什么分派。改动改变了读者据以判断"成功了吗 / 能用吗 / 要不要动手"的产物时——判据与「定档」的面向人产物档位下限同一条，但触发不以该下限是否 binding 为条件：基础档本就在中/高档的改动同样要跑，那正是 stakes 最高的一端——除档位表机制外另跑对应专项 command——面向人的终端输出 → `/custom:review-cli-output`；会被人读到字段名与值的数据契约 → `/custom:review-schema`；服务故障告警 → `/custom:review-alerting`。

适用与排除边界以该 command 自身 description 为准。放行与裁决接口沿用「专项路由」同款，含其附加约束（「混合改动分流」不适用：本路由本就与档位表并行）。**只有一处不同——本条是叠加而非替代**：那条路上专项 command 就是那次 review，本条的代码仍须经档位表对抗审；且这三个 command 都会落地代码改动（写入端校验、fire 判定、consumer 迁移），其落地物并入本轮 review 对象、按「修复闭环」回灌对抗审，否则专项审新写的代码从此不进任何对抗审。对象同时是指令 artifact 时，通用审那一半已由「专项路由」承担、本条不再重复要求；但落地物仍走「修复闭环」——它常落在被审的那个指令文件之外（专项 command 各有硬类型 gate，接不住），且只有「修复闭环」给了可执行的回传触发点。

范围与输入则要本条自己接住，`description` 不承载它们：这三个 command 的审查面都不是本轮 diff——`review-schema` / `review-alerting` 默认吃整对象或整项目，`review-cli-output` 则刻意只看输出、不读实现源码。不收窄它们的审查面，但本轮 diff 之外的 findings 按「独立 findings 须给出去向」处理、不进本轮修复闭环——否则 gate 会替那些改动的真实作者改决定。`review-cli-output` 另需真实输出 capture 与其类型要求的状态集，而 gate 侧没有任何环节产出它：由主 session 构造或向用户索取。**它对缺 capture 的处置是封锁全部、而非降级为 review-only**，所以取不到就是「审不了 ≠ 审过」，按该条处置（重试或交用户裁决），不得当作已审。

CLAUDE.md / AGENTS.md 对这三类各有一段 BINDING，但那里只约束动笔前读 principles 与审核义务本身，没有绑到任何可识别动作上；读过 principles 并手工对照不使本条已履行。

| 档位 | 机制 | 要点 |
|---|---|---|
| 中档 | 内置 Agent subagent（独立 context），**不传 `name`**——caller 要消费其 findings，按 `~/.claude/references/delegation-policy.md` §Harness transport 即不传；记录 spawn 返回的 `agentId` 供复核轮续用 | 快、零外部依赖 |
| 高档 | Claude Code：`CODEX_SANDBOX=read-only codeagent-wrapper --backend codex "<prompt>" <workdir> </dev/null`（prompt 走参数，`</dev/null` 掐 stdin 防后台派发卡在读 stdin，见 `background-agent-monitoring.md` §派发前自限）新 session；Codex：内置 collaboration agent，隔离与续用按 `$subagent-spawning` | 两侧都得到独立 Codex context；记录当前 transport 的 continuation handle 供复核轮续用；同步等待（超出 harness 前台时限时改后台派发 + 主动轮询等价同步，期间不派发其它工作） |

两档机制都要求把 review 交给独立 context。**是否获准委派属政策层，按 CLAUDE.md / AGENTS.md「Delegation Boundary」判，本 skill 不另设判据**——判定获准即照常委派，不进本条。判定确实不获准、或**实际拿不到**独立 context（调用失败；或产出取不回——常见成因是 `delegation-policy.md` §Harness transport 的 `name` 约束）时，同属「审不了 ≠ 审过」：先按「Resolve Blockers, Don't Bypass」经 `AskUserQuestion` 请用户解除；解除不了再交用户裁决该缺口。作者自审不是档位选项，如实声明自审也不使它成为档位。

高档同步等待的理由：gate 本身阻塞后续动作，真后台化只会平添 Background Agent 巡检负担；harness 前台上限（如 Claude Code Bash 单命令 10 分钟）内无法完成时，用后台派发 + 主动轮询保持同步语义，不额外建巡检。高档通用路由的 reviewer 一律是 Codex，不按主 session、改动作者或上下文依赖切换 backend；Codex harness 走原生 transport，避免嵌套 supervisor 与重复上下文摄入，其委派和等待遵循 `$subagent-spawning`。中档用 `general-purpose-readonly`：无 persona，且移除 Edit/Write。无 persona 是因为带 persona 的 reviewer agent 类型自带 system prompt，会压过本 gate 随 prompt 下发的返回契约与对抗 framing；移除写工具是因为 reviewer 的产出契约就是「报告 findings、不改代码」，而通用 `general-purpose` 会让它有能力改动自己正在评审的文件——在共享宿主 / 并发 session 下，这与高档的只读 sandbox 保护强度倒挂。该类型仍保留 Bash（reviewer 的价值来自跑真实实验），所以写入是被契约约束、不是被 harness 物理阻断。高档 codex reviewer 走 `CODEX_SANDBOX=read-only`（least-privilege：reviewer 只读+报告、不改文件，故用只读 sandbox 拒写/kill；codex exec 非交互，拒写即失败不挂起）——两档同向降低共享宿主 / 并发 session 的 blast-radius。

对抗启动面（仅下表代码路由；指令 artifact 走专项路由、不经此分区）：多-hunk diff 施加中/高档对抗前，作者按 `~/.claude/references/rigor-tiers.md`「对抗审查只施于定义或修改 authority 的 unit」一条划出 authority hunk，把分区（入对抗的 hunk / 作为冻结-authority 机械·只读 payload 排除的 hunk 及理由）写进 gate 开场并随下方「喂什么」交 reviewer。reviewer 对 authority hunk 做深度对抗，并**必须**对每个被排除 hunk 廉价校验"是否实际改动 authority"；判定实改则并入对抗深审、按返回契约照常报 finding（reviewer 对被排除 hunk 的逐条 disposition 义务见下方返回契约）——分区是作者自评、正落在本 gate 所防的确认偏误面，须经对抗复核、不得只对用户可见而逃过。反向对称是 gate 开场自检、非 reviewer 事后补报：未分区就对多数只读·机械的整包发起深度对抗即 over-rigor 漏项，由作者/主 session 显式自检（同 trivial 免审的可审计要求），先分区再发起。分区只收敛对抗施加面，不下调任何 hunk 的 floor 与 plan override。

对抗式纪律（两档通用，reviewer prompt 按此构造）：

- **喂什么**（发起 review 前逐项核对）：
  - 改动目标——表述在预期行为/结果层，不含实现选择
  - review 对象的 diff（取得方式见「触发与 review 对象」）——所附 diff 即 review 对象的全部；workdir 里的其它改动不属本轮，不得据以立 finding，觉得异常则计入「未能核实项」
  - 改动所在根目录的绝对路径（git 仓库根；非 git 则覆盖全部改动文件的最小公共父目录）——即高档命令的 `<workdir>`
  - （如有）与用户对齐的重点审查面
  - （如有）改动已声明的 threat model（含 trust boundary，下同）——plan、spec 或 artifact 自身明文排除的攻击者能力与信任边界；喂明文原句摘录 + 来源路径，不转述——这份输入将获得压 severity 的裁决权，转述失真不可追溯；有而不喂，reviewer 会把前提被排除的 finding 当必须修复的缺陷反复上报
  - 本 unit 的 stakes 锚点——授予压 severity 裁决权的是 plan 记录的 `(A,V)` 或（自由 session）本 gate 定档结论（两者皆可审、不可由 reviewer 或作者在审时随手放宽）；随附的现实运行包络（部署实际面对的输入 / 时序 / 攻击者能力上界）只帮 reviewer 判断触发前提落点，不单独构成 hard cap 依据。供 reviewer 按返回契约 Proportionality 上限校准 severity
  - 环境事实——按「reviewer 无法自行取得、或仅能靠昂贵复现（构建/渲染/实跑）取得，且缺了会误判」筛入；作者已实测验证的行为结果属之（其复核即重新实跑），喂入时标注"已验证"并附验证方式与关键结果摘录。标注"已验证"的准入是取证路径与交付时的真实执行路径同构——证据来自真实执行本身，或复刻了同一宿主入口与包装层（宿主程序实际的命令行包装、而非文档描述的语义）；按文档语义另行搭建的"等价"模拟不合格——等价性判断恰是作者盲区，此类结果只能作为普通环境事实喂入并注明与真实路径的差异。其余明确指示 reviewer 自行追读 diff 所引用/复用的函数、配置、文件的源定义："必要事实"由作者筛选会把作者盲区一并滤进去
  - （多-hunk 且已做对抗分区时）被排除的 hunk 及排除理由——reviewer 的校验与逐条 disposition 义务见「对抗启动面」与返回契约
- **不喂什么**（复核轮同样适用；误报争议轮除外——按该条条款处置）：作者的实现思路或自辩——防 anchoring；reviewer 必须自己回答"这个返回值/这个函数的语义是什么"。
- **执行约束**（随 prompt 下达；复核/续审 prompt 同此）：reviewer 不得靠复现（构建/渲染/实跑）重新推导已标注"已验证"的事实——复现它只烧预算不增信息；质疑某条已验证事实的结论，附依据列入「未能核实项」。
- **对抗 framing**：要求"找出会让它失败的输入/时序/状态"，不是"确认它没问题"。
- **返回契约**：结构化返回 severity + 具体失败场景；severity 定级判据随 prompt 附上并以此为准——CRITICAL/HIGH = 真实使用中会产生错误行为/数据损失/安全风险，MEDIUM = 质量隐患但不改变行为，LOW = 风格。**severity 须与本 unit 的 stakes 相称**：一个阻塞性 CRITICAL/HIGH 实质是要求本 unit 硬化到扛住该失败场景——要求低 stakes unit 扛住其现实 `(A,V)` / 运行包络根本不会遭遇的时序或攻击者能力，正是 rigor-tiers「Proportionality invariant」判的 over-rigor（对 A0/V0 对象索取 V2 级硬化）。故触发前提超出本 unit 现实包络的 finding——机制真实、但本部署不会遭遇（如对可逆 / 低 stakes unit 施加蓄意进程冻结、PID 复用、运行中替换信任路径）——至多 MEDIUM（报告保留，不阻塞放行）；没有这条上限，对抗 framing 会驱动 reviewer 逐轮把更深的 exotic 场景升档成新 HIGH，review 循环失去收敛点。上限**相对 stakes、不是"场景少见"**：A2/V2 unit（生产切流 / 安全边界 / 零容忍）现实上就面对对抗场景，其此类 finding 仍 HIGH，降档才是 under-protect。每条 CRITICAL/HIGH 的「具体失败场景」须写明触发前提，供 gate 裁决核验现实性（处置见「gate 裁决」不成比例条）。threat model 明文排除是本上限里 provenance 更严的具名子情形（显式排除授予自足 hard cap，故有下述所附摘录纪律）：前提被本 prompt 所附 threat model 明文排除的 finding 同样至多 MEDIUM。「所附」指随 prompt 单独附上的明文摘录，threat model 文本仅出现在 diff 内不算；未附时本条不适用，照常定级，reviewer 亦不得自行从 workdir 采认 threat model——压 severity 的裁决权只随 prompt 摘录授予。reviewer 另须列出「未能核实项」——未能核实的引用/复用语义及原因（源不可达、不在 workdir 等），以及按执行约束附依据质疑"已验证"事实的项。（本轮做了对抗分区时）reviewer 还须对每个被排除 hunk 逐条给出 disposition：确认冻结-authority payload（机械·只读性质经复核成立→其 LOW/风格观察记入本 disposition、不另立 finding；MEDIUM 及以上仍照报）/ 重判为 authority（并入对抗、按上述定级报 finding）/ 无法核实（计入「未能核实项」）；缺项或未逐条覆盖即返回契约不完整，按「gate 裁决」的「审不了 ≠ 审过」处置——堵住静默跳过被排除 hunk 校验的路径。每条 finding 另须标注**是否依附于本轮 diff**：撤回 review 对象后即不再成立者为依附，离开本轮 diff 仍独立成立者（其它文件的既有缺陷、缺失的权威契约、被推翻的环境断言）为独立；跨两半的 finding 拆成两条分别标注，不整条二选一。缺标注同属返回契约不完整，按同上处置。信息优势在 reviewer 侧——它才知道哪条是脱离 diff 独立确证的，标注成本近乎零；留给事后的作者则是把判定交给本 gate 所防的那一方（专项路由无此字段时由主 session 依报告逐条判定）。**复核轮另加一项必填**：修复 diff 里新写入、且断言对象在本次编辑之外、真值可由一条本地命令当场判定的事实断言（计数、集合的组成或命名、来源归因、有无其它调用方一类），逐条给出「已附读数 / 未附」；已附的须当场重跑那条命令并报告是否一致——此类读数复现成本以秒计，本项不受上面「执行约束」不得复现条的限制，只做存在性检查等于不验真值，而那正是这项要防的。未附即按「审不了 ≠ 审过」的补喂复审支处置；缺项同属返回契约不完整，按同上处置。检出方必须是 reviewer 而非作者——漏附的正是作者本人，而 reviewer 手上就是那份 diff。

## gate 裁决

- **CRITICAL/HIGH**（定级见「分档执行」返回契约）：修复、或用户经 `AskUserQuestion` 显式 waive 之前，不得宣告完成、不得 commit。
- **MEDIUM/LOW**：列给用户，采纳与否用户定，不阻塞放行。
- **误报争议**：有具体依据认定 finding 不成立时，不先动代码——附依据把 修复 / waive / 撤回（认定误报）经 `AskUserQuestion` 交用户；无人值守流先回传 reviewer 反驳一轮，仍不收敛则阻塞等待用户裁决。
- **不成比例**：CRITICAL/HIGH 经核验触发前提超出本 unit 现实 stakes 包络（机制真、非 finding 不成立，与「误报争议」区分）时，按「返回契约」Proportionality 上限作 MEDIUM 处置（不阻塞、报告保留）；落点拿不准经 `AskUserQuestion` 交用户，无人值守流先回传 reviewer 一轮，仍不收敛则阻塞等待用户裁决。
- **修复闭环**：修复 → 修复 diff 回传原 reviewer（修复改动了 threat model 来源文时，按现行原文重新摘录随传，任何续审路径同此。中档：按 spawn 返回的 `agentId` 用 SendMessage 续聊；高档 Claude Code：`CODEX_SANDBOX=read-only codeagent-wrapper --backend codex resume <session_id> "<复核任务>" <workdir> </dev/null`（`</dev/null` 同上；`<workdir>` 与原审同值——它决定复核轮在哪棵树上看 diff，写错不报错，worktree 隔离下就是对着另一个 checkout 复核）；高档 Codex：按 `$subagent-spawning` 续用原 collaboration reviewer。对应 handle 提取不到即按不可续。任一档不可续时按原 transport 新起 reviewer，prompt 至少含：原 finding、修复 diff（复核对象）、原 diff（仅背景，勿全审）、返回契约（含定级判据）与原审「喂什么」其余各项（diff 项以本条角色为准；threat model 按当前声明状态摘录，修复轮新声明的也算），workdir 同原审，对抗 framing 换成复核两问：修复是否成立、有没有引入新问题；误报争议轮原 reviewer 不可续时同此模板，争点对象换成原 finding + 反驳依据）→ 只答此两问——不重开全审：复核对象是修复本身，全审会重新 anchoring 已裁决的 findings 且拖长闭环 → 复核发现的新 findings 同样按本节裁决；不成立则回到修复。修复若需改动本轮 review 对象之外的共享语义（被复用函数/配置的对外行为），先经 `AskUserQuestion` 对齐修法，无人值守流选波及面最小者并注明。多轮不收敛时 `AskUserQuestion` 交用户裁决。
- **修复轮不得引入未经测量的事实断言**：为关闭 finding 而新写进注释 / 文档 / 本 gate 输出 / commit message 的事实断言，凡断言对象在本次编辑之外、且真值可由一条本地命令当场判定的（计数、集合的组成或命名、来源归因、有无其它调用方一类），先跑出那个读数再落笔。该断言落笔时复核轮还在的，把命令与关键结果摘录随修复 diff 附给它——reviewer 侧的核验义务写在「返回契约」里，那才是它收得到的地方；落笔时复核轮已终结的（gate 输出、commit message，以及不触发复核闭环的修复），读数与该断言一并呈现。读数在本机拿不到、而该断言又是关闭 finding 所必需时（破坏性、需生产凭据、绑特定主机），走「审不了 ≠ 审过」的交用户支裁决，不得直接删句了事——那是静默降级，且会为合规稀释精度。加轮次治不了它：约束点在被审方，实测读数见 `docs/issues/harness-issues.md` 的同源条目。
- **reviewer 越权即结果失效**：只读 reviewer 出现对 repo、memory 或其他持久路径的写入尝试（无论成功与否），该份 review 结果作废，按下条「审不了 ≠ 审过」新起 reviewer；重复出现交用户裁决。写入尝试证明该 reviewer 未按只读行为契约运行，其结论的独立性已不可信。证据方向同样要守住：patch 上下文不匹配**不是** sandbox 拒写的证据，日志里只出现前者时，不得宣称只读边界已经生效。（若要用 canary 实证拒写，须由具体 transport 的权威契约定义，并在**不承载 review 结果**的一次性 preflight context 里跑——在承载结果的 context 里跑 canary，它自己就是写入尝试，按本条会使该结果失效。）
- **审不了 ≠ 审过**：review 无法完成（调用失败/超时/结果无法解析）视同 gate 未过——重试或沿原路由重新发起（专项路由重跑对应 command；中档新 spawn；高档新起 codex reviewer），仍不行则交用户裁决；reviewer 报告的「未能核实项」同此处置——补喂对应环境事实复审该项或交用户，不得计入放行（质疑"已验证"事实的项，补喂 = 重验并附新证据，重申原断言不算）；补喂的复审证据须满足"已验证"的同构准入（见「喂什么」环境事实条）；无法同构取证（如真实执行受环境阻塞）时，经 `AskUserQuestion` 显式交用户裁决该缺口是阻塞还是接受——在完成报告里披露缺口不构成处置；禁止静默降级为自查或免审。
- **独立 findings 须给出去向**：reviewer 标注为独立的条目，在本轮的任何终局（放行 / waive / review 对象被撤回）下都不随之消失，须逐条给出去向——按 `~/.claude/references/durable-solution-carriers.md` 的载体表选落点（落 issues/ 时其 domain 分流与条目形态见 `docs-organization-protocol.md`「issues/ — 问题跟踪」；环境 / 拓扑类事实落 experiences 或记忆指针）；确需就地修的按「修复闭环」的跨对象纪律走；判定无需处置的显式写明并附一句理由。给出去向即完成，**不阻塞本轮任何终态**。撤回的是 review 对象，不是审查取得的认识。
- **放行**：无 CRITICAL/HIGH 遗留（修复复核通过、已 waive、或经误报争议撤回），且无未处置的「未能核实项」→ gate 通过，输出裁决后方可宣告完成 / commit。

无人值守流：条内已给默认的按条内执行（误报争议先回传反驳、修法对齐选波及面最小）；需用户裁决而无默认的（waive、多轮不收敛、审不了的最终处置）阻塞等待，不得以无人应答为由降级放行。「触发与 review 对象」与「定档」两节的无人值守默认见各节。

## 输出

定档结论一句话（trivial 时即免审声明）+ findings + gate 裁决 + 独立 findings 的逐条去向（记录位置 / 就地修 / 判定无需处置及理由；无独立项则显式写"无"——同 trivial 免审：不可见即不可审计）；findings 过长时完整版落 scratchpad 并给出路径。

## 不做

- 指令 artifact 之外不替代 review-pr 等专项深审——gate 是完成前的强制底线，不是最深的审。指令 artifact 上 gate 经对应专项 command（review-skill / review-claude-md）执行（见「分档执行」专项路由），过 gate 即本轮 diff 已过对应专项审，不就同一 diff 重复跑。走产出型专项审的对象**不**享有这条豁免：那个 command 只覆盖该产物那一维，其余仍不替代 review-pr 等深审；只是同一 diff 不重复跑它自己。
- 不经由 review-selector / review-evaluator 选 reviewer，也不做 reviewer 打分/评测——二者质量未经检验，用户已裁决不依赖。
