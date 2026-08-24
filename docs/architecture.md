# Architecture

> Mutable snapshot. Update when structure changes.

## Overview

ai-agent-config-share 是一个 AI coding agent 的共享配置仓库，为 Claude Code 和 Codex CLI 两套工具链提供统一的行为指引、工作流命令、agent 定义、skill 和运行时可观测性。核心技术栈：Bash（安装 / 验证 / statusline 渲染）、Markdown（所有行为定义）、Python（statusline 解析 + 可观测性工具链）、Node（hooks 强制层）、TOML + JSON（工具配置）。

仓库不是一个"应用"——它是一个**人机协作协议层**，核心产出是一组声明式行为定义，通过 symlink 注入到用户 home 目录的 `~/.claude/` 和 `~/.codex/` 中生效。

宿主平台：macOS 是参照平台。平台判定只用在一件事上——挑哪个 `codeagent-wrapper` 预编译构建——由 `install.sh` 与 `verify.sh` 各自内联 `uname -s` / `uname -m` 得出（两处独立、无共享抽象层，改一处要记得改另一处），挑不到只警告并跳过那一条。除此之外安装器按 macOS 写：缺 `uv` 时无条件 `brew install uv`（脚本是 `set -euo pipefail`，没有 Homebrew 即中断），缺 `jq` / `python3` 则询问是否 brew 安装、拒绝仍可继续。

## Modules

### claude/ — Claude Code 行为层

为 Claude Code 提供行为指引和扩展能力。内容通过 `install.sh` symlink 到 `~/.claude/` 后被 Claude Code 运行时加载。

| 子模块 | 职责 |
|---|---|
| `CLAUDE.md` | 用户级行为指引入口，同时是 Codex 侧 `AGENTS.md` 的实体（手动 merge 到 `~/.claude/CLAUDE.md`，不 symlink）。它已不是规则正文，而是一张**路由表**：每个 BINDING 节只写触发判据 + 无路由时守住的硬规则，规则本身放在 `references/` 对应档里。这样规则可以长而不撑爆常驻 context，判据则必须短到每次都读得完 |
| `settings.json` | 环境变量、权限白名单、模型与 statusLine、hooks 接线（手动 merge 到 `~/.claude/settings.json`；MCP server 本身不在这里定义，只有 `enableAllProjectMcpServers` 开关） |
| `commands/custom/` | Slash command 定义（`/custom:create-plan`、`/custom:execute-plan`、`/custom:test-ux`、`/custom:create-ux-contract`、`/custom:execute-ux-contract`、`/custom:create-aigc-design`、`/custom:review-aigc-design` 等），是用户触发工作流的入口。仓内含一族 **peer session 观察 / 监督**入口——`review-session-progress`（从新 session 只读分析一个长任务 session 的进展与偏差；文件头那行"交付物是关于另一个执行体的报告"的 marker 被 stop-gate 经 `lib/third-party-command.js` 读走，把报告里的未完成项默认判给被分析对象）与 `supervise-session`（监督一个**不是自己启动**的 Claude Code session，Claude Code only）；另有 `map-program-architecture` / `create-delivery-report`（把 program 工作项落到模块的改造前后地图 / 给同事上手的交付报告，都是单文件 HTML）、`away`（用户离开时段的守望纪律）、`reuse-for-aigc`（管复用既有物产出 AIGC 内容的选定之后到产出那一段）。除产品向的工作流外还有一小族**指向 harness 自身**的命令——`review-agent-harness` / `fix-harness-from-session`（复盘本 session 暴露的 harness 问题，取证范围硬绑当前 session，所以要先用 `find-claude-session` 定位并 resume 才能盘别的 session）、`review-skill` / `review-claude-md` / `review-agent-rules` / `review-session-skills`。它们展示的是"harness 怎么自我迭代"这条回路的框架；这一层在本仓是**冻结的框架样本**、不跟进上游最新，判据与清单见 [docs/scope-policy.md](../docs/scope-policy.md) |
| `commands/routine/` | 日常运维命令（`/routine:session-export` / `/routine:session-import`） |
| `references/` | 被 CLAUDE.md 和 commands 引用的协议文档（plan 执行原则、skill 创建原则、UX 测试 patterns、ux-contract 审查原则等），是行为规则的 source of truth。`domain-registry.md` 注册产品类型（功能型 / 游戏）并路由到 `references/game/` 下的 domain 专属验收原则；`service-operations-protocol.md` 定义仓库服务统一动词脚本约定；`aigc-design-review.md` 是 AIGC 流水线的设计 / 评审共享底座（评审平面、硬纪律、rubric），被 `create-aigc-design` 与 `review-aigc-design` 两条命令共同引用。规则本身按**判据族**聚类而非按命令切分，这样一条判据只写一遍、被多个入口引用：**面向人的产物**族由 `human-facing-message-principles.md` 承载通道无关判据，`cli-output-review-principles.md`（终端输出）、`schema-design-principles.md`（字段名与值）、`ghostwriting-principles.md`（以用户名义发出的文字）、`web-ui-observation.md`（网页的值 / 关系 / 结构三层观察）各承载自己那一层，其中前两者各配一条 `review-*` 命令，`web-ui-observation.md` 无专属 review 命令但被 `test-ux` / ux-contract 系列与 design-critique / web-visual-system 两个 skill 共同消费，`ghostwriting-principles.md` 目前只由 CLAUDE.md 的 BINDING 节直接路由；**取证与执行环境**族由 `evidence-sufficiency.md`（检查在结论真假时是否给出不同读数）与 `remote-command-execution.md`（非交互 shell 的缺失如何伪装成权限 / 网络错误）承载，前者的判据同时由 `reverse-assertion-gate` 在 Stop 处强制；**委派与沉淀**族是 `delegation-policy.md`、`durable-solution-carriers.md`、`surface-choices-rubric.md`；`judge-gate-authoring.md` 是写 hook 判官 rubric 的标准，把强制层反向接回本层 |
| `agents/` | Claude sub-agent 定义：`doc-updater`（按 `docs-organization-protocol.md` 维护项目文档）被 `/custom:sync-docs` 及 execute 类命令的文档同步步骤 spawn；`general-purpose-readonly`（不带 persona、去掉 Edit/Write，契约全部由派发 prompt 承载）是 review-gate 中档 reviewer 的类型——它保留 `SendMessage`，因为作为具名 teammate 被派发时回复正文不会自动回到 caller，报告必须经该工具送回，否则 caller 只看到它 idle 且零产出 |
| `hooks/` | Node 写的强制层，`claude/settings.json` 的 `hooks` 段是活注册表（当前 24 条 handler），按**判断代价**分三类，而不是按拦什么分：① **PreToolUse gate**——只在对应的 tool call 真的发生时触发，多为纯确定性判断（`codeagent-stdin-guard` 无 stdin 来源的 wrapper 派发、`block-broad-kill` 按名字选中目标的 pkill/killall、`block-no-verify` 跳过 git hook 的 `--no-verify` 一类 flag、`push-approval-gate` 每次 push 都要当轮的显式许可、`commit-message-language` commit message 语言、`commit-discipline-gate` staging 纪律与 create-commit 是否真被调过、`writer-registry-gate` 并发写入者登记与重叠拦截——登记表放在 git common-dir 而非工作树，跨 worktree 才互相可见，matcher 含 Bash（经 Bash 命令做的 commit 与文件写入此前对登记表不可见）、`memory-carrier-gate` 拦下被写进 git 看不见的 auto-memory 的跨项目规则；另有三条**只注入警告、不阻断**的——`liveness-predicate-gate`（挂 Bash 与 Monitor 两个事件位：pgrep 式活性谓词回答不了"完了没有"、`while :` 头部词法上无限，两条警告独立报）、`guard-mutation-lint`（commit 时枚举本 diff 新增的 fail-closed guard，问"哪个 mutation 让它变红"——刚写好的 guard 默认无覆盖，套件加不加它都绿）、`in-turn-cadence-advisor`（同一形状 Bash 命令第 6 次时注入一次"先答委派与否"的提醒，每形状每 session 一次）；`ask-recommend-gate` 是其中唯一调判官的，但只在 AskUserQuestion 调用时才付这笔钱，无后端或超时即 fail-open）；② **LLM judge Stop gate**——每个回合到达 Stop 各发一次判官调用，代价按回合计，因此**默认不接**，由 README 安装 prompt 连同代价列给用户选（`stop-gate` 该做完却把回合交还用户、`continuation-claim-gate` 承诺了后续动作却无物在跑、`prose-choice-gate` 把选项写成正文列表而不走 AskUserQuestion、`capability-claim-gate` 宣称某工具不可用却从没调过、`reverse-assertion-gate` 反向断言而证据在结论为假时长得一样）；其中 `stop-gate` 同时挂在 `SubagentStop`——子代理带着没做完的活收尾，对 caller 的污染与主循环早停同类；③ **通知与回收**（`desktop-notify`、`bg-shell-reclaim-check` 停止前摆出长时间没交代的后台 shell、`teammate-reclaim-check` 挂在 `UserPromptSubmit` 与 `SessionStart(startup\|resume)`，把交完报告却没被回收的 in-process teammate 摆到下一轮开工之前）。`ghostty-tab-title.sh` 把「忙 / 停了但没看 / 已看过」三态写进终端 tab 标题——它不在本仓 `settings.json` 里注册（Claude 侧由用户自行接线），但被 `codex/hooks.json` 与 `ask-recommend-gate` 直接调用。`session-inbox.js` 同样不在本仓 settings.json 注册——它是 Stop 时投递 peer 监督消息的 best-effort 信箱（append-only JSONL、按 transport id 幂等、有未 ack 记录时 exit 2），被 `scripts/peer-session-watch.js` 的 enqueue 复用，是 supervise-session 监督回路的投递半边（ADR-20260823-dddf）——注意该 Stop 位尚未注册，Phase 2 只有 enqueue + 通知半边在跑，纠正信息尚不能注入目标 session 的 context。共享层在 `hooks/lib/`：`llm-judge`（分级后端）、`transcript`、`judge-log`、`hook-flags`（`HOOK_PROFILE` / `DISABLED_HOOKS` 开关）、`utils`，另有五个"同一份判断只许有一处实现"的抽出物——`session-tree`（本 session 进程树：两个 hook 曾各写一遍遍历、根进程判定不同，还各修对了对方的 bug）、`git-commit-parse`（`git commit` 命令行解析，供全部 commit 闸共用）、`codex-shell-read`（从 shell 命令里认出被读的 skill / agent 文档路径，供 Codex 侧 dispatcher 复用）、`session-id`（session UUID 与 `supervisor:<uuid>` 标签的规范正则，peer 监督回路与信箱共用）、`third-party-command`（"本回合交付物是否是关于另一个执行体的报告"的确定性读数，供 stop-gate 等 Stop 闸共用——该事实判官凭 prose 推不出，且它作为 stop-gate 私有函数时 sibling 闸拿不到同一份、各自猜主语合计误拦 9 次）。`run-with-flags.js` 是本仓库自己的分发器，负责按 flags 决定是否执行、并优先 in-process `require()` 调目标的 `run()`。24 条接线里 12 条走它（liveness-predicate-gate 占 Bash / Monitor 两条）、12 条直调；**别把"有没有 main guard"当判别式**——那 12 条（11 份脚本）里自带直调入口的有 5 份（`codeagent-stdin-guard` / `writer-registry-gate` / `commit-discipline-gate` / `commit-message-language` / `in-turn-cadence-advisor`；走分发是为了那道 profile 开关），另 6 份（`block-no-verify` / `block-broad-kill` / `push-approval-gate` / `memory-carrier-gate` / `liveness-predicate-gate` / `guard-mutation-lint`）是纯模块，直接 `node` 调会 exit 0 静默空转。哪条走哪条以 settings.json 为准，照抄不要改写。逐文件 symlink 到 `~/.claude/hooks/`（带 `.test.js` 的一并 link，装后仍可 `node --test` 复验），install.sh 已改为**glob 驱动**——手维护的名单每次 sync 都漂，唯一例外是 `run-tests.sh`（它的 `../../codex` 相对路径在 `~/.claude/hooks/` 下解析不到，只在仓库内跑）。激活靠 `settings.json` 的 hooks 段落手动 merge（`codeagent-stdin-guard` 另有 `CODEAGENT_STDIN_GUARD=0` kill switch，免改 settings.json 即可停用）。要问"哪个事件位挂了什么"，唯一权威是 `settings.json` |
| `hooks/run-tests.sh` + `package.json` + `tests/` | 测试入口。`run-tests.sh` 递归枚举 `claude/hooks/` 与 `claude/bin/` 两棵树的 `*.test.js` / `*.test.mjs`（单层 glob 曾让子目录整片漏跑，且失败形态是静默；`.mjs` 收漏时一道新写的闸曾因此从不执行），再显式补上 `claude/scripts/hooks/` 与 `codex/bin/` 下几份跨目录的，以及 python 侧的 `scripts/test_mcp_dedup.py`；一条失败即整体失败。它是 `package.json` 的 `npm test`——此前那里是 `exit 1`，等于测试写了却从不执行。枚举根停在 `claude/hooks` 与 `claude/bin` 而不上提到 `claude/`，是为了不吞进 `plugins/marketplaces/` 下的第三方插件测试（实测一次 226 份 / 33 失败）：恒红的套件训练出来的行为就是无视它。仓库根 `tests/` 目前只有 `test_gen_agents_skills.py`（Codex wrapper farm 生成器的 pytest） |
| `skills/agent-browser/` | 浏览器自动化 skill（agent-browser CLI 的用法、认证模式、模板脚本，以及 iOS Simulator / 云浏览器 / 替代引擎等目标平台的选择），被 `test-ux` / `execute-ux-contract` 等命令消费；随附 `check-links.py` 自查 SKILL.md 与 `references/` 之间的锚点引用是否仍成立 |
| `skills/create-commit/` | commit 工作流 skill（审查 working tree、生成 message、确认后 commit），被 `execute-plan` / `execute-ux-contract` 等六条走到 commit 那一步的命令委托 |
| `skills/deep-discuss/` + `skills/review-gate/` + `skills/decision-review/` | 三道动手前后的门，审的对象各不相同：deep-discuss 帮着想清 tradeoff（不产 plan.md）；decision-review 审**决策本身站不站得住**，在按决策采取任何行动之前跑（触发看"能否陈述成在 A 与 B 之间选了 A"，不看会不会产出 artifact）；review-gate 审**产物是否正确实现了决策**，在宣告完成或 commit 前跑，由 `claude/CLAUDE.md`「生成后 Review Gate」绑定、`execute-plan` §3.5 逐单元调用。两道 gate 都要过，过一个不抵另一个——决策错误产出的代码通常完全正确地实现了那个错误，代码评审对此结构性失明 |
| `skills/design-critique/` + `skills/web-visual-system/` | 网页视觉的判断侧与生成侧：design-critique 给评判（层级、信息架构、认知负荷、AI 味），web-visual-system 给参数（字阶与配对行高、间距阶梯、层次、圆角族、动效、数字体、交互态）。分成两个的理由是评判档只能指认"这个不好"、给不出"好长什么样"——缺参数的页面能通过全部功能测试与 rubric 评分，仍一眼看出没设计过。web-visual-system 随附两个浏览器端脚本：`probe-visual-system.js` 从**渲染后的页面**抽参数（用同一份视口 / 缩放 / 主题同时探参照产品与自己的页面，两份才可比），`validate-visual-system.js` 按参数校验页面，并把 PASS / FAIL / **UNCHECKED** 三态分开——没有样本可看的检查与看过且干净的检查输出不能长得一样。两者都以 `references/web-ui-observation.md` 为共同观察标准 |
| `skills/tdd-workflow/` + `skills/game-release-loop/` | tdd-workflow：测试先行的实现流程与覆盖率要求；game-release-loop：浏览器游戏的发布门（每条 P0 旅程在发布目标矩阵上通过、且无遗留 Critical/High/Medium 才算过）。game-release-loop 不新增一层，而是把已有件组合起来——判据锚在 `claude/skills/game-release-loop/references/game-profile.md` 配置档，测试与修复路由到 `test-ux` / ux-contract 三件套，domain 验收原则取自 `references/domain-registry.md`，回归证据取自 tdd-workflow。它标了 `disable-model-invocation`，在 Claude Code 侧只在被显式点名时进入，非游戏项目零触发成本；Codex 不认该 frontmatter，那边同等约束由 `CLAUDE.md`「Harness 适配」表的 skill 行承载（软约束） |
| `skills/precompact/` + `skills/im-notify/` | 两个运行时小件。precompact：compact / 上下文压缩前，把只活在 context 里、续跑要用的关键事实补进本 session 既有的台账——落点必须与 `post-compact-restore.js` 压缩后注入的恢复 briefing 严格同一份，否则写了也读不到；它不判断"该不该落盘"，用户触发就是信号。im-notify：经 `im-notify` CLI（feishu 起步、`--channel` 向其他 IM 扩展）把通知推到用户手机，用在"要他在另一台设备上动手"的交接点（扫码一类）——在请他回到电脑之前发出，而不是注意到验证码之后 |
| `bin/codeagent-wrapper-<os>-<arch>` | 包装 Codex / Gemini CLI 为统一接口的预编译二进制。调用面比"wrapper 型 supervisor 命令"宽：`execute-plan` / `supervise` / `test-ux` / `execute-ux-contract` / `resolve-issues` 五条命令，加上 `review-gate` 高档评审与 `decision-review` 两个 BINDING skill——缺它时受影响的不只是委派类命令，还有两道强制 gate 的外部评审腿。双平台构建（`darwin-arm64` / `linux-amd64`），**由 install.sh 在安装期选平台**并直接 link 成 `~/.claude/bin/codeagent-wrapper`；平台不匹配时只警告并跳过这一条 link，其余安装不受影响。上游另有一个在运行时才挑平台的同名 dispatcher，本仓库**不收录**：它靠 `<自身目录>/../..` 反推仓库根，前提是 `~/.claude` 整目录 symlink 到仓库 `claude/`，而本仓库是逐文件 symlink 模型，那个前提不成立。选择因此定死在安装期，少一层间接 |
| `bin/active-plan` | 声明 / 查询本 session 正在执行的 long-task plan.md 或 program ledger（`set <路径> [--type plan|program]`，marker 带 type 四态语义见 ADR-005；program 型 marker 被 post-compact-restore 的 program 分支与 create-handoff 的 program 分流消费——尽管发起 program 的 `run-program` command 本仓未收录，恢复与交接侧仍认得这类 marker）。存在的理由是 context compaction 后 agent 唯一无法重新推导的事实就是"我在哪个 plan 目录里"——扫 `plans/` 取最新 mtime 是错的（并发 session 可能刚碰过），只有 agent 自己知道，所以让它显式声明。标记按 session id 分键，并发 session 互不串读 |
| `bin/poll-progress.sh` | 增量读后台任务 `.output` 文件的轮询脚本，被三条 wrapper 型 supervisor 命令（`execute-plan` / `supervise` / `execute-ux-contract`）调用，替代原 TaskOutput 阻塞轮询 |
| `bin/` 下的五个探针 | 把"某类证据必须由程序取"落成 CLI，被 references 直接点名消费：`page-acceptance`（核验声明的主功能元素经全部祖先裁剪后仍进过视口且已就绪，明写它不等于"用户看得见"）、`page-repetition`（量同一段文字被复制了多少遍、占正文多少篇幅——通读读不出它，实测一页 74.2% 是重复文字）、`first-screen-density`（首屏装得下几条完整的、最高一条占几屏）、`visual-budget`（量页面尺度的**视觉用量**并与参照并排——同一角色刷了上千次、徽章上千个这类合成量，token 校验器按定义看不见；只报 outlier，见 ADR-028）、`interaction-latency`（量站内一次操作从动手到结果**看得见地**出现的等待——观察面绑在"打开一个 URL"上时，恰好漏掉用户实际抱怨的"从 A 切到 B"）。引用方各不相同（非穷举——以 `grep -rl` 现查为准）：`web-ui-observation.md` 点名 `page-repetition` / `first-screen-density` / `interaction-latency`；`page-acceptance` 另被 `evidence-sufficiency.md`、`remote-web-delivery.md`、`/custom:test-ux`、`web-visual-system` skill 与 `claude/CLAUDE.md` 引用；`visual-budget` 由 `web-visual-system` skill 与 `/custom:test-ux` 消费（ADR-028）。它们是程序而不是文档里的一段配方，因为同一段量法在 reference 里被写错过四次，四次都只有真实浏览器跑得出来 |
| `scripts/` | 不挂在 hook 事件上的辅助脚本：`find-claude-session.sh`（按关键词三级收敛定位 session UUID 供 `claude --resume`，用 stderr sentinel 让调用方分支，被 `find-claude-session` / `review-agent-harness` 两条命令消费）、`mcp-dedup.py`（跨 user / project / plugin / `--mcp-config` 四个来源按优先级合并 MCP 配置，仓内暂无调用方，是独立工具）、`peer-session-watch.js`（supervise-session 的确定性采样器：不做模型调用、健康样本留在进程内零输出，只有带类型的 wake 结果把控制权交回监督 session；经 `hooks/session-inbox.js` 的 enqueue 投递消息，从不 stop / resume / 编辑目标 session，6 小时硬超时）、`scripts/hooks/` 下的 compaction 恢复对——`pre-compact.js` 在 `PreCompact` 把最后一条用户消息、任务清单与最后一条 assistant 文本落到 `~/.claude/state/last-compact-snapshot.json`，`post-compact-restore.js` 在 `SessionStart(compact)` 读回并经 `additionalContext` 注入。拆成两份是因为 `PreCompact` 的 stdout **不进模型 context**，只有 SessionStart / UserPromptSubmit 能注入。**接线不对称**：本仓 Claude 侧 settings.json 没有 PreCompact 事件位——快照半边只接在 `codex/hooks.json`，Claude 侧只接了恢复半边（快照缺失时 post-compact-restore 静默无事发生）。另注：post-compact-restore 的 program 分支恢复文案会把读者指向 `run-program.md`，那是上游 command、本仓未收录 |
| `statusline.sh` + `statusline-fields.py` + `statusline-transcript.py` + `statusline-usage.py` | Claude Code statusline。`statusline-fields.py` 独占全部 JSON 处理：一次解析吐出 shell 赋值供 `statusline.sh` eval，并顺带完成同一份数据已能支撑的副作用——持久化 `~/.claude/tt-status.json`（供 tt-web 消费）、刷新按 session 分文件的 tok/s 速度缓存、转调 `statusline-transcript.py` 拿 session 级汇总。`statusline.sh` 只剩渲染多行状态栏。因此 jq 不再是 statusline 的运行时依赖，python3 是；解析失败时各字段退回脚本内的默认值，状态栏降级而非拖垮 session。`statusline-usage.py` 补的是 harness payload 里没有的东西——Claude Code 只把 `five_hour` / `seven_day` 两个窗口交给 statusline，按模型划分的配额只存在于 OAuth `GET /api/oauth/usage` 的 `limits[]`，想显示就得自己取。它由 `statusline-fields.py` detached 拉起、每台机同时至多一个实例（flock），结果落缓存；**渲染从不等它**，每次只画上一次成功抓到的数，因此慢或失败都零代价，失败路径全静默。token 只作请求头传，不进 argv、不落缓存、不写日志 |

### codex/ — Codex CLI 行为层

为 OpenAI Codex CLI 提供行为指引和扩展能力。结构与 claude/ 平行，通过 symlink 注入 `~/.codex/`。

| 子模块 | 职责 |
|---|---|
| `AGENTS.md` | symlink → `../claude/CLAUDE.md`：一份政策源同时服务两套 harness，结构上不可能分叉（此前是独立文件，实证会漂移——曾缺 4 个 BINDING 章节）。单一源的代价是政策文本里混着 Claude 专属入口，所以该文件顶部有一节「Harness 适配 (BINDING)」把能力名映射到两侧、并对 Codex 无对应物的项（`/custom:*`、hooks）给出明确处置——否则 Codex 会被 BINDING 要求调用不存在的东西。仍需手动 merge 到 `~/.codex/AGENTS.md`，只是与 Claude 侧 merge 的是同一份内容 |
| `config.toml` | Codex CLI 配置（模型、MCP server、agent 定义、安全策略、profile），手动 merge |
| `agents/` | Codex sub-agent 定义（explorer / reviewer / docs-researcher），每个 `.toml` 文件定义模型、sandbox 模式和 developer instructions |
| `hooks.json` + `bin/codex-hook-dispatch.js` | **hook parity 层**：Codex 事件位（PreToolUse / Stop / SubagentStart / SubagentStop / SessionStart / SessionEnd / PreCompact 等）统一打到一个 dispatcher，由它按 mode 复用 `claude/hooks/` 下**同一批 gate 脚本**——不是把 gate 重写一遍，路径直接 `require`/spawn 回仓库。`bash` mode 并发跑八道 PreToolUse Bash 闸，`stop` mode 跑六道 Stop 闸（有 active subagent 时跳过 `continuation-claim-gate`），`ask` mode 把 Codex 的 `mcp__ask_user__AskUserQuestion` 归一成共享闸认识的 `AskUserQuestion` 再调。dispatcher 自己负责 1 MiB 输入上限的处置（阻塞类 mode 超限即拒，非阻塞类只报未执行），并在 stop / permission 路径上转调通知与 tab 标题。dispatcher 里另有几个 mode（`permission` / `mcp-pre` / `mcp-post` / `skill-audit`）指向本仓未收录的上游脚本，`hooks.json` 也没有把它们接上，在本仓形态下不可达 |
| `hook-parity.json` | 与 `claude/settings.json#hooks` 锁等式的 parity manifest：24 条 handler 与活注册表一一对应，逐条写明 Codex 侧事件位、mode、验证档位（当前 18 条 fixture-verified、1 条 live-verified、5 条 `harness-specific-excluded`——`memory-carrier-gate` 拦的是 Claude 独有的文件式 auto-memory，两条 teammate-reclaim 读的是 Claude teammate 信箱，Codex 用原生 SubagentStart/Stop 跟踪；新增的 `monitor-liveness` 是 Monitor 事件位 Claude Code 专属，`in-turn-cadence-advisor` 是上游尚未定 Codex 映射、本仓不代上游决定而保持排除）。等式由 `bin/codex-hook-parity.test.js` 在测试里强制，所以 Claude 侧加一条 hook 而不在这里交代，测试直接红。parity 的语义写在文件里：**用户可观测的策略、阻断、恢复与通知行为一致**，不是事件名或 payload 逐字节一致 |
| `bin/gen-agents-skills.py` | 生成 `~/.agents/skills` wrapper farm，让 Codex 拿到 `$custom-<x>` 入口：`claude/skills/*` 与 `codex/skills/*` 逐个 symlink，`claude/commands/**` 每条生成一份带 GENERATED 标记、指回 command 文件的 wrapper SKILL.md（denylist 三条：Claude-only 的 `routine/allow.md`、canonical skill 的 legacy 别名 `tdd.md`，以及依赖 Claude Code transcript / session 语义的 `custom/supervise-session.md`）。先在 staging 目录建全再整体换入，中断不会留下半个 farm；重建只删自己拥有的条目（指回本仓 skills 的 symlink、带标记的 wrapper 目录），手装的第三方 skill 保留且在重名时胜出；`~/.agents/skills` 若是指向仓外的 symlink 则直接中止而不覆盖用户设置。由 install.sh 在安装末尾运行，失败只 WARN |
| `ask-user-mcp/`（仓库根） | MCP server（node），通过 MCP elicitation 给 Codex 提供 Claude 兼容的 `AskUserQuestion` 表单工具。由 `codex/config.toml` 的 `[mcp_servers.ask-user]` 注册 + `[approval_policy.granular] mcp_elicitations = true` 使表单浮现；install.sh 把它 symlink 到 `~/.codex/ask-user-mcp` 并装 node deps |

### tt-web/ — 可观测性 Dashboard

独立的 Python web 应用，提供 token usage / cost / session 明细的可视化 dashboard。运行期与配置层的耦合点是 `~/.claude/tt-status.json`（由 statusline 链路写入）；另有一处测试期耦合——`tests/test_statusline_*.py` 直接按路径加载 `claude/statusline-*.py`，所以改 statusline 会波及 tt-web 的测试。视野已从"本机"扩展到**一组机器**：每台机各自解析本地日志，再把汇总跨机拉到一处看。

| 子模块 | 职责 |
|---|---|
| `server.py` | ThreadingHTTPServer，提供 REST API（`/api/overview`、`/api/pivot`、`/api/pivot-filters`、`/api/sessions`、`/api/session/<id>`、`/api/network`、`/api/health`、`/api/sync-status`、`/api/timezone`、`/api/restart`、`/api/account-memory/remove`），overview / pivot 接入 rollup |
| `state/account_memory.json`（账号记忆）+ 配额按账号归组 | 配额按**账号**计量而不按机器（ADR-024 修的 bug：三台机登同一 Claude 账号报的是同一个计数器、各取最新即对；两台机登不同 Codex 账号是两个独立池、各取最新是抛硬币）。各机导出包 `meta.rate_limits` 块随代际准入入库，`/api/overview` 的 `rate_limits` 按 live 准入现算；账号记忆把读数归属到账号并标注 plan——展示的 `account_plan` 须与旁边的 `reading_plan` / `credential_plan` 对一致（ADR-20260822-586a），记录带时间不变量与并发写 epoch（ADR-026 / 027），删除经 `/api/account-memory/remove` 走 epoch 校验 |
| `parsers/` | 日志解析器（claude.py / codex.py / claude_status.py），从 `~/.claude/projects/` 和 `~/.codex/sessions/` 读取 JSONL |
| `aggregators.py` | 数据聚合层（pivot、指标提取、按时间 / 项目 / 模型分组） |
| `rollup.py` + `state/rollup.db` | 成本历史持久层：把每日 cost/usage 滚动汇总写入 SQLite（WAL），支持最长约 2 年的成本历史；raw-log 保留期可短于 rollup 历史。可选 `com.ttweb.rollup` LaunchAgent 每小时刷新（默认不装，`./tt-web/install.sh rollup-daemon` 显式开启） |
| 跨机聚合：`machines.json` + `machine_config.py` + `exporter.py` + `sync.py` + `generation.py` + `project_alias.py` + `rollup_identity.py` | 把多台机器的用量看成一份数据。`machines.json` 是机器名单（含 `retired_names`，退役名不可复用），`machine_config.py` 校验并给出配置指纹；`exporter.py` 从本机 rollup 打出带 manifest 的导出包（schema 版本、来源主机身份、行数与指标合计、逻辑摘要与传输摘要）；`sync.py` 经 ssh/scp 拉各机导出包并校验后入库（BatchMode、远端临时目录带 reaper 兜底清理）；`generation.py` 管代际与退役账本，保证"哪一批数据来自哪些机器"可判定；`project_alias.py` 解决跨机同名项目的归一——两台机上路径相同却其实是两个项目时要求 git remote 佐证，拿不出就报冲突而不是悄悄合并；`rollup_identity.py` 是身份阻塞的排查与显式解绑 CLI（被阻塞的源保留已有行、但不再写入新用量）。用户入口是 `tt-web machines accept|retire`（名单本身直接编辑 `machines.json`，没有列表子命令）、`tt-web export`、`tt-web network`，身份排查那支挂在 `tt-web rollup` 下 |
| `network_report.py` | `/network` 页面那份出网快照的终端版。数据取自 tt-web 自身：server 在跑就走 `/api/network` 复用同一份缓存，不在跑就在进程内调同一个函数——两条路共用一套错误分类，而不是长出第二套 |
| `cache.py` | 文件级缓存（mtime + size 变更检测，避免重复解析大量 JSONL） |
| `pricing_fetcher.py` + `pricing.json` | 模型定价数据 |
| `web/` | 前端静态文件（HTML + JS + CSS），Chart.js 驱动的图表 |
| `ip_check/` | 网络诊断子模块（DNS / IPv6 / 公网 IP / 代理检测），独立 CLI `ip-check` |
| `tests/` | pytest 测试套件 |
| `start.sh` / `stop.sh` / `status.sh` / `uninstall.sh` | tt-web 生命周期脚本，遵循 `service-operations-protocol.md` 统一动词约定，包装 tt-web dispatcher。**注意 `start.sh` / `stop.sh` 只作用于 web server**：它们不解析服务名参数，`./tt-web/stop.sh rollup-daemon` 会去停 web server 并 exit 0 报成功。rollup daemon 的生命周期入口是 `./tt-web/install.sh rollup-daemon` 与 `./tt-web/uninstall.sh rollup-daemon` |
| `docs/` | tt-web 子项目自有文档：`contracts/ux-contract.md`（UX 验收契约）、`operations/services.md`（运维说明，含 rollup daemon 纳管）、`issues/`（按 domain 分文件的 issue 跟踪，含 ux-contract 演化项） |

### 安装与验证

| 文件 | 职责 |
|---|---|
| `install.sh` | 主安装脚本：symlink 创建 + npm 全局包安装 + 依赖检查 + settings.json statusLine 写入 + tt-web 子安装 + 共享 uv venv 创建（`brew install uv` → `.venv/`，供 ip-check / tt-web 使用）。交互式冲突解决（y/N/a/s）。**安装期做平台决策**：内联 `uname` 选中对应的 codeagent-wrapper 构建再 link，不把选择留到运行时。hook 脚本与其 `.test.js` 按 glob 逐文件 link，但**只 link 不接线**——接线是 settings.json 的手动 merge，由 README 安装 prompt 走。jq 只服务于安装期的 settings.json merge（`verify.sh` 那几项 settings.json / hook 接线检查同样用它）——缺它只影响自动接线与那些检查，不影响 statusline 运行 |
| `verify.sh` | 只读验证脚本：检查各 symlink 是否指向本 repo（含逐个 hook 脚本，以及 hook 是否真的接进 settings.json——只 link 不接线是静默 no-op；目标位置若是内容与 repo 一致的普通副本则记 PASS，内容不一致才 FAIL）、依赖是否就位（python3 缺失为 FAIL，jq 缺失只 WARN）、settings.json 是否接好、手动 merge 文件是否含必要锚点。codeagent-wrapper 那条按本机平台去比对应的构建，无构建的平台记 WARN。hook 接线检查带**必接 / 可选**两档：五个 Stop 判官 gate（stop-gate 含 SubagentStop 接线共六条 optional 接线）未接记 PASS（不接是合法配置；`ask-recommend-gate` 虽也调判官，但按 tool call 计费，属必接一档），其余 hook 未接才告警——这是"有代价所以 opt-in"与"该接却没接"的区别，混成一档就等于劝人无视告警。exit code = FAIL 数 |
| `requirements.txt` | 仓库根共享 Python 依赖（requests / colorama），由 install.sh 用 uv 安装到 `.venv/`（uv-managed CPython 3.13）。ip-check 和 tt-web 原 `pip install --user` 改由此 venv 提供 |

### docs/ — 项目文档

项目级持久化知识，按 docs-organization-protocol 组织。索引见本目录的 [CLAUDE.md](CLAUDE.md)。

## Layers

仓库的分层不是传统的 presentation / business / data，而是围绕**行为定义的生命周期**组织：

```
┌─────────────────────────────────────────────────────────┐
│  用户交互层                                               │
│  install.sh / verify.sh / README.md                     │
│  用户与仓库的接触面：安装、验证、阅读使用说明                     │
├─────────────────────────────────────────────────────────┤
│  行为定义层                                               │
│  commands/ + references/ + CLAUDE.md + AGENTS.md        │
│  声明式的工作流、协议、规则——agent 在运行时读取并遵循              │
├─────────────────────────────────────────────────────────┤
│  强制层（仅 Claude Code）                                 │
│  hooks/ + settings.json 的 hooks 段落                     │
│  tool call 前 / Stop 时的拦截：BINDING 规则的 harness 侧兜底 │
├─────────────────────────────────────────────────────────┤
│  能力层                                                   │
│  skills/ + agents/ + bin/（wrapper / active-plan / poll） │
│  被行为定义层引用的具体能力——浏览器自动化、sub-agent、跨工具适配     │
├─────────────────────────────────────────────────────────┤
│  可观测性层                                               │
│  statusline.sh + statusline-*.py + tt-web/               │
│  运行时数据采集 → 持久化 → 可视化                             │
├─────────────────────────────────────────────────────────┤
│  配置层                                                   │
│  settings.json + config.toml                             │
│  工具级配置：权限、模型、MCP server、环境变量                    │
└─────────────────────────────────────────────────────────┘
```

**层间依赖规则**：

- 行为定义层引用能力层（commands 调用 skills 和 codeagent-wrapper）
- 行为定义层引用配置层（commands 依赖 MCP server 和权限设置）
- 强制层不被引用、只被触发：hooks 挂在 harness 的 tool-call / Stop 生命周期上，不出现在任何 command 的调用链里，兜的是行为定义层里 agent 可能漏掉的 BINDING 项。因为它只存在于 Claude Code 一侧，两侧共同的 invariant 必须写在政策源或 reference 里，不能只靠 hook 实现承载
- 强制层与行为定义层之间是**双向**的、且只在文本层面：每条 hook 声明自己兜的是哪条 BINDING（`settings.json` 的 `description` 就是这个用途），而判官型 hook 的 rubric 反过来受 `references/judge-gate-authoring.md` 约束。仍然没有代码依赖——hook 不 import references，references 也不 import hook
- 强制层内部按代价分档，这条分档一路贯到安装与验证：PreToolUse gate 默认接、未接是缺陷；Stop 判官 gate 每回合都付一次判官调用，因此安装时问、未接不算缺陷。判据是"代价按什么计"（按 tool call 还是按回合），不是"重不重要"
- 可观测性层独立于行为定义层（statusline 和 tt-web 不依赖 commands / references）
- 用户交互层里的 install.sh / verify.sh 实际横切所有层（同时处理 symlink、npm 包、settings.json、子安装器），它们在图里画在最上面只是因为那是用户的接触面；平台判定只发生在这里（挑哪个 codeagent-wrapper 构建），其余层对宿主平台无感

**跨工具共享**：`claude/skills/` 下的每个 skill 都同时 symlink 到 `~/.claude/skills/` 和 `~/.codex/skills/`——install.sh 与 verify.sh 都按该目录 glob 驱动、不各自维护名单，所以新增 skill 无需改脚本，也不会出现"装了但没验"（deep-discuss 曾如此）。政策层不再靠"两份文件引用同一批 references"维持一致——`codex/AGENTS.md` 直接是 `claude/CLAUDE.md` 的 symlink，一份文件同时服务两套 harness，共享的 `references/`（plan-execution-principles.md、long-task-protocol.md 等）由这一份政策源统一引用。单一源的代价由该文件顶部的「Harness 适配 (BINDING)」表消化：它把能力名映射到两侧，并对 Codex 无对应物的项（`/custom:*`、`hooks/`）写明处置——读那份 command 文件自己执行，做不到就告知用户该步依赖 Claude Code，不得臆造完成；以及对 Codex 不认的 Claude 专属 frontmatter（`disable-model-invocation`）写明等效约束。该表映射的不止工具名，还包括**语义相近却不等价**的 harness 机制——例如两侧各自的"plan 模式"：Claude 的 `EnterPlanMode` / `ExitPlanMode` 与 Codex 的 Plan Mode 出口语义不同，不写明就会出现"拿一个'批准即开工'的出口去审批一份过渡稿"这类偷换。

## Key Abstractions

### Command 三级结构

仓库的核心工作流是 **spec → plan → execute** 三级流水线，体现了"plan 阶段深度对齐、execute 阶段自主收敛"的设计哲学：

- **create-spec**：与用户对齐产品定位和验收标准（L1 产物 + L2 用户视角 verify）
- **create-plan**：将 spec 转化为可实施的 plan（L3 设计决策 + 内部 verify）
- **execute-plan**：Claude 作为 supervisor 启动 Codex 实施 plan，按 Stop Gate 收敛 + 可选 UX 验收闭环

每一级产出的 verify 步骤是下一级的输入契约——spec verify 约束 plan verify，plan verify 约束 execute 的完成判定。

### ux-contract 工作流三件套

与 spec → plan → execute 平行的另一条 verify 驱动流水线，专注产品上线前的 UX 验收：

- **create-ux-contract**：从已部署产品出发访谈用户，写出 ux-contract（L1 产品全貌 + L2 用户视角 verify + 验收侧重），内部串 review-ux-contract 循环至收敛
- **review-ux-contract**：按 `ux-contract-review-principles.md` 审查契约完整性
- **execute-ux-contract**：supervisor 把已审过的 ux-contract 翻译为 test plan，驱动 Codex 跑端到端 UX 测试 + 修复闭环，直到**可即时修复的** Critical/High/Medium issue 清零（需显式设计 / 产品决策的不建 Fix Task，经 AskUserQuestion 交用户裁定）

ux-contract 是契约的锚点——execute 阶段不可自行修改它（发现矛盾时 AskUserQuestion 上升给用户），与 spec → plan → execute 中 verify 贯穿不变是同一设计立场。它与 `test-ux` 是两条独立入口：`test-ux` 从自由文本 / PRD 做一次性 ad-hoc 模拟测试；`execute-ux-contract` 以已审契约为基准做带修复闭环的系统性验收。

### 设计先行 gate（create-aigc-design / review-aigc-design）

第三条 verify 驱动的命令对，针对失败模式在视觉感知层的生成 / 合成流水线：`create-aigc-design` 在实现前写 L1/L2/L3 设计，`review-aigc-design` 按 `aigc-design-review.md` 的 rubric 审查，循环到 blocker 清零才允许实现。与 spec → plan → execute 的分工是评审平面不同——软件可维护性走 create-plan，视觉工程痕迹（断层 / 鬼影 / 孔洞 / 可见重复 / 漂移）走这一对。

触发判据挂在改动的性质而非规模上（由 `claude/CLAUDE.md` 的 BINDING 章节强制），因为这类失败模式最常从"看着像小 tweak"的改动里溜进去。

### Supervisor 模式

`execute-plan`、`supervise`、`execute-ux-contract`、`supervise-session` 四个命令实现了 Claude-as-supervisor 的编排模式：

- Claude（主 session）通过 `codeagent-wrapper` 在后台启动 Codex / Gemini / Claude 实例
- 后台 agent 执行任务，主 session 通过 `poll-progress.sh` 增量读 `.output` 文件轮询进度（全量兜底），替代原 TaskOutput 阻塞轮询
- 主 session 按 Stop Gate 判定后台 agent 是否真正完成，未完成则 resume 同一 session
- `execute-plan` 额外支持 UX 验收闭环：完成后按 plan 声明做 UX 验收，把 Critical/High/Medium issue 回灌给**实现该改动所在工作单元的那个 implementer handle**——按 issue 定位到对应单元，未必是最新 handle，因为 session 以工作单元为界轮换
- `execute-ux-contract` 把已审过的 ux-contract 翻译成 test plan，再用独立的 test session + fix session（各自独立 Codex session）跑测试-修复循环，直到可即时修复的 Critical/High/Medium issue 清零；commit 步骤委托 create-commit skill
- `supervise-session` 监督的是**不是自己启动**的 Claude Code session（`supervise` 管自己经 wrapper 启动的）——不起 wrapper，而是 `scripts/peer-session-watch.js` 确定性采样目标 session，结构化异常或终态候选时深审（复用 `review-session-progress` 的深审契约），纠正信息经 `hooks/session-inbox.js` enqueue 并在对方 Stop 时 best-effort 投递——**Phase 2 现状：Stop 位未注册**（见 ADR-20260823-dddf），消息进收件箱、尚不注入目标 session。Claude Code only：依赖 Claude 的 transcript / session 语义，Codex wrapper farm 的 denylist 不为它生成入口

### Stop Gate

贯穿整个执行体系的收敛机制。任何 agent 想要停止执行都必须通过六项检查：必要性已证明、归因已分层、替代路径已尝试、verify 已拆分、交接可执行、文档同步已处理。这个机制同时约束 Codex（被监督的 agent）、Claude（supervisor）、以及 UX 修复循环。最后一项把文档同步纳入"完成"的定义——只交付代码、不交付文档同步的完成不算 done。

### Judge Gate：判不出来的失败怎么拦

有一类失败在输出上看不出来——承诺了后续动作而其实没有东西在跑、宣称某工具不可用却从没调过、交付一条反向断言而"证据"在结论为假时读数完全相同。它们的共同点是**正确与错误的产物长得一样**，正则匹配不到、单测断言不了，所以强制层为此长出第二种形态：Stop 时把本回合的输出交给一个 LLM 判官，按 rubric 判要不要拦。

这带来三个连锁结构，缺一不可：

- **rubric 是被维护的资产**，写法由 `references/judge-gate-authoring.md` 统一约束，而不是各 hook 自由发挥
- **rubric 的改动要能被度量**，所以每个 judge gate 在上游都配一套正反例场景集，改一个字就重跑、看 precision/recall 有没有漂。**本仓不收录这些场景集**（它们是打磨判官闸的过程产物，属上游的 harness 开发层，见 [scope-policy.md](scope-policy.md)）——所以在本仓改 rubric 时，这条度量线要你自己补
- **代价必须显式**：Stop 判官按回合计费，所以这类 gate 一路 opt-in 到底——README 安装 prompt 连同代价列给用户、verify.sh 对未接的记 PASS。按 tool call 触发的 gate 没有这个问题，因此没有这套配套

### Reference 文件 vs Command 文件

行为规则分两层存储：

- **commands/**：面向触发的入口文件，定义"什么时候触发、输入输出是什么、主流程怎么走"
- **references/**：面向引用的协议文件，定义"规则本身"（plan-execution-principles.md、deep-discuss-style.md 等）

主方向是 commands 引用 references，让多个 commands 共享同一套规则、规则的 source of truth 唯一。反向引用存在但只用于**路由**——不少 reference 会点名"这件事用哪条命令做"（审这份产物走哪个 `review-*`、这类任务走哪个工作流命令），它们引的是入口而非规则，所以不构成循环依赖。

### Symlink 安装模型

配置不是复制到 home 目录，而是 symlink 到 repo 内文件。这意味着：

- `git pull` 即升级——所有 symlinked 文件实时生效
- 仓库路径不能移动或删除（symlink 会断）
- 逐文件 link（而非把 `~/.claude` 整目录指向仓库）是这套模型的关键选择，代价是任何"靠自身路径反推仓库根"的运行时脚本在这里都失效——codeagent-wrapper 的平台选择因此挪到安装期
- CLAUDE.md / AGENTS.md / config.toml / settings.json 四个文件例外——因为用户有自定义内容，只能手动 merge（其中 AGENTS.md 在仓库内已是 CLAUDE.md 的 symlink，两侧 merge 的是同一份内容；settings.json 只有 statusLine 那一项由 install.sh 自动写入，hooks 接线仍靠手动 merge）

### 可观测性数据流

```
Claude Code 运行时
    ↓ JSON（stdin of statusline.sh，原样 pipe 给下一步）
statusline-fields.py（唯一解析口：一次 pass，输出 shell 赋值）
    ├→ statusline.sh eval 后渲染（stdout，多行状态栏）
    ├→ statusline-transcript.py（解析 transcript JSONL，提供 session 级汇总）
    ├→ ~/.claude/statusline-cache/.speed-<session>.json（tok/s 缓存）
    ├⇢ statusline-usage.py（detached、每机单实例；缓存过期时才拉起，取 OAuth /api/oauth/usage 的 limits[]）
    │      ↓ 写 ~/.claude/statusline-cache/.usage.json（每模型配额）
    │      └→ 下一次渲染读它；渲染从不等待，失败全静默
    └→ ~/.claude/tt-status.json（原子写入）
          ↓
    tt-web server.py
        ├→ parsers/（解析 ~/.claude/projects/ 和 ~/.codex/sessions/ 的 JSONL）
        ├→ aggregators.py（pivot / 指标提取）
        ├→ rollup.py ⇄ state/rollup.db（每日汇总持久化，成本历史超出 raw-log 保留期）
        ├→ web/（前端渲染 Chart.js 图表）
        ↑
   sync.py ← ssh/scp ← 各远端机器的 exporter.py 导出包（manifest 校验后入库）
        （machines.json 定名单，generation.py 管代际，project_alias.py 归一跨机项目）
```
