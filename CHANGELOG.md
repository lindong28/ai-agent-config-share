# Changelog

> Append-only（最新在前）。仅记录用户可感知的变更。

## 2026-08-18（scope 收窄）

- 变更：**本仓 scope 明确为两类读者**，判据与清单落 [docs/scope-policy.md](docs/scope-policy.md)——工作对象是**你在开发的产品**的内容跟进上游最新；工作对象是**harness 自身**的（审查 / 改进 / 评测 / 复盘 harness 的命令与其 meta-原则、判官闸调优场景集、harness 开发过程记录）只留冻结的框架样本。`/routine:sync-from-upstream` 加了一道 scope gate 执行它
- 移除：同日条目里的十个新命令中，`/custom:review-principles`、`/custom:review-patterns`、`/custom:review-hooks`、`/custom:review-session-efficiency` 四个已按上述 scope 移除（`review-agent-harness`、`fix-harness-from-session`、`find-claude-session`、`create-experience-from-journal`、`review-evangelism`、`review-llm-cost` 保留）；同批移除 `principle-review-principles.md`、`pattern-review-principles.md`、`pattern-matching-scope.md`、`enhancement-service-liveness.md`、`review-llm-cost-calibration.md`、`claude/rules/`、`claude/bin/gate-stats`、`claude/hooks/README.md`、`codex/prompts/`，以及 `claude/CLAUDE.md` 的「模式匹配只用于有 spec 的对象」整节与「服务可观测性」节里的探活段
- 移除：**全部判官闸 eval 场景集**（`claude/hooks/eval/`，含本仓早先就有的四个目录）。判官闸本体照常保留并跟进最新；场景集是打磨判官的过程产物，不在本仓 scope 内。install.sh / verify.sh 的 eval 安装与检查一并回收
- 移除：`docs/experiences/` 全部；`docs/adr/` 由 23 条收窄为 10 条——只留组件在本仓实际存在的那些，另 13 条（autopilot / permission-gate / run-program / wexin 等上游专有物的决策）不收录
- 变更：`review-skill` / `review-claude-md` / `review-agent-rules` / `review-session-skills` 与 `judge-gate-authoring.md` 回退到上次同步前的版本——它们是框架样本，此后不跟进上游迭代

## 2026-08-18

- 新增：七个 hook 纳入并接线 —— `stop-gate`（Stop / SubagentStop 的收尾判官闸）、`commit-discipline-gate` 与 `push-approval-gate` 与 `block-no-verify`（PreToolUse/Bash：commit 纪律、push 需显式许可、拦 `--no-verify` 绕过）、`memory-carrier-gate`（PreToolUse/Edit：拦"把跨项目规则写进 git 看不见的 auto-memory 文件"——长期方案该落 git-tracked 载体，memory 只留指针）、`teammate-reclaim-check`（UserPromptSubmit + SessionStart：把没回收的 teammate 摆出来）、`ghostty-tab-title`（终端 tab 标题随 busy/idle 变化——**只接在 Codex 侧**的 `codex/hooks.json`，Claude 的 `settings.json` 未接线，`verify.sh` 对它只查 symlink，所以 Claude Code 里 busy/idle 的标题循环不生效；例外是 ask-recommend-gate 放行时会直接调它发一次 alert 标记）。`claude/settings.json` 的接线从 11 条扩到 19 条 id，其中 `stop:stop-gate` / `subagent-stop:stop-gate` 与四个既有 judge gate 一样按 **opt-in** 处理（`verify.sh` 对未接的它们记 PASS）——它们每个回合到达 Stop 时各发一次判官调用。上游的 `permission-gate` 与 autopilot 经用户裁决**不纳入**本仓
- 新增：compaction 前后的状态保全 —— `claude/scripts/hooks/pre-compact.js`（PreCompact 侧的快照写入，目前只接在 `codex/hooks.json`；Claude 侧 settings.json 无 PreCompact 接线）与 `post-compact-restore.js`（SessionStart/compact，已接线为 required）。context 压缩会丢掉一批无法重新推导的事实（正在执行哪个 plan、哪些 teammate 还没回收），压缩之后 agent 不会知道自己丢了什么
- 新增：**Codex hook parity 层** —— `codex/hooks.json` + `codex/bin/codex-hook-dispatch.js` + `codex/hook-parity.json`（20 个 handler，按本仓实际接线的子集裁剪并重生成；parity 的含义是"用户可观察的策略 / 阻断 / 恢复 / 通知行为一致"，不是事件名或 payload 逐字节相同）。此前 `CLAUDE.md` 把若干 gate 写成两侧同等 BINDING，而 Codex 侧一条 hook 都没有——政策要求的强制层在那边根本不存在。`install.sh` 把 dispatcher symlink 到 `~/.codex/bin/`、hooks.json 装到 `~/.codex/`
- 新增：`install.sh` 接入 `codex/bin/gen-agents-skills.py` 生成 `~/.agents/skills` wrapper farm —— Codex 侧从此有 `$custom-<x>` 入口（`commands/custom/create-plan.md` → `$custom-create-plan`），命令不再只能靠"读那份 md 自己执行"。生成失败只 WARN、不中断安装，但 Codex 会一直缺这些 wrapper 直到重跑。`claude/CLAUDE.md`「Harness 适配」表的 skill / command 行相应改写
- 新增：命令十个 —— `/custom:fix-harness-from-session`（**由 `/custom:fix-skill-from-session` 重命名而来，旧名不再存在**，脚本或习惯里调旧名会招不到）、`/custom:review-agent-harness`（盘一遍本 session 还有哪些 harness 问题；`disable-model-invocation`，只能由用户点名）、`/custom:find-claude-session`（定位并 resume 别的 session，配套 `claude/scripts/find-claude-session.sh`）、`/custom:create-experience-from-journal`、`/custom:review-hooks`、`/custom:review-llm-cost`、`/custom:review-patterns`、`/custom:review-principles`、`/custom:review-evangelism`、`/custom:review-session-efficiency`
- 新增：references 九份 —— `coding-guidelines.md`、`pattern-matching-scope.md`（模式匹配只用于有 spec 约束产出方的对象；给自然语言分类归判官，因为正则在这类对象上不收敛且失败会伪装成成功）、`remote-web-delivery.md`（本地 web server 的链接怎么真正交付到用户机器上，含点击回执——那是唯一来自用户侧的正面证据）、`enhancement-service-liveness.md`（增强服务静默失效的清单与两步匹配，含"产出还在但质量变差"这一类）、`llm-cost-observability-principles.md`、`review-llm-cost-calibration.md`、`pattern-review-principles.md`、`principle-review-principles.md`、`evangelism-review-principles.md`
- 新增：`claude/bin/` 四个探针 —— `page-acceptance`（页面验收，明写不覆盖内容判断、出口指回 `web-ui-observation.md`）、`first-screen-density`、`page-repetition`、`gate-stats`（judge gate 的命中统计）。另新增 `claude/rules/`（Claude-only 的 authoring 标准，由 `~/.claude/rules` 条件加载）与 `claude/scripts/`（session 定位、MCP 去重、compaction hooks），`install.sh` / `verify.sh` 各增一层安装与检查
- 新增：`docs/adr/`（23 条决策记录）与 `docs/experiences/`（4 份 topic 档：git-worktrees / instruction-artifacts / review-and-judging / testing），并入 `docs/CLAUDE.md` 索引。ADR-010 已做主机名与内网 IP 脱敏
- 变更：`claude/CLAUDE.md` 大幅扩充 —— 新增「Git Push 需显式许可」「Commit 走 create-commit 逻辑」「服务可观测性与告警设计」「LLM 调用成本观测」「模式匹配只用于有 spec 的对象」「非功能属性不自行加码」（用户交代功能目标时，可用性 / 可恢复性 / 一致性范围 / 安全强度等沿用既有档位，要调高就得当作 choice 摆出来）「Harness 复盘请求的路由」等节；顶部新增**何时需要重新打开一份正文**的统一判据（判据是"它此刻在不在 context 里"，而 session 起始注入的那份不会随磁盘更新），以及 `disable-model-invocation` 的处置表（用户显式点名时读正文自己执行，把动作退还给用户是转嫁）。上游的「评测完整性」节与 `eval-identity` / `evaluation-integrity.md` 经用户裁决**不纳入**；`skill-review-principles.md` 维持本仓的 7 条子集（上游为 20 条）
- 变更：`install.sh` 的 hook 安装改为 glob 驱动（`claude/hooks/` 下的 `*.js` / `*.sh` 与 `lib/`、`eval/` 按目录扫描），新增 hook 不必再改脚本，也不会重演"装了但没验"的漏网；`verify.sh` 的 hook 接线检查扩到 19 条接线（覆盖全部 20 个 handler 命令；逐条核对 event + matcher + id + handler 命令），并补齐全部新脚本与 lib 的 symlink 检查
- 变更：`tt-web open` 打开页面前**先请求一次新 generation** —— 此前打开的是上一次的快照，页面上的数字看起来是"刚打开时的"其实可能是几小时前的；请求失败时明说"将打开现有数据、请点 Refresh 重试"而不是静默给旧值。同时 `tt-web` 脚本里全部 `curl` 加 `--noproxy '*'`（系统代理会让本机健康检查失败，表现为 tt-web"起不来"），`ip_check` 的两个信誉查询改为并行且区分连接 / 读取超时

## 2026-08-09

- 新增：`claude/CLAUDE.md` 十节 BINDING —— 「取证的充分性」（拿一次检查支撑结论前先问它在结论为真和为假时输出会不会不同；反向断言尤其要过这关，因为正向误判迟早被下游打脸、反向误判没有下游能发现）、「非交互 Shell 里执行命令」（ssh / cron / launchd 拿到的 shell 在用户 rc 的「非交互立即 return」守卫之后，缺 `SSH_AUTH_SOCK`、PATH 段与代理变量，报出来的却是 `Permission denied (publickey)` / `command not found`，把人指向加 key、装包这些昂贵且方向错的处置）、「决策评审 Gate」（可陈述成"在 A 与 B 之间选了 A"的非平凡决策，按它动手之前先过 gate）、「Plan 创建路由」（要交接给别的 context 实施的方案走 `/custom:create-plan`，并说明为什么不能拿 harness 自带 plan 模式的审批出口代替——那类出口语义是"批准即开工"）、「线上故障优先级」、「跨仓库写入」（写到 cwd 之外的仓库前先读那个仓库的 CLAUDE.md/AGENTS.md，harness 只按 cwd 加载项目级规则）、「网页界面的观察与对比」、「面向人的终端输出」、「以用户名义代笔」、「数据契约 / Schema 设计」。另有三节就地更新（并发写入者隔离 / Harness Issue Capture / Surface Choices）与「Harness 适配」表新增「自带 plan 模式」一行——Codex 的 Plan Mode 与 `update_plan` 是两回事，在前者里调后者会被 harness 报错拒绝
- 新增：references 十一份 —— `evidence-sufficiency.md`（阳性/阴性对照怎么做、哪几类读数天然骗得过它）、`remote-command-execution.md`（换一种 shell 形态重跑比对，以及哪些情形会给假阴性）、`delegation-policy.md`（委派适格与 transport 纪律；被委派方可能 ssh 出去时，本机沙箱对远端零约束，只读纪律必须随 prompt 下达）、`durable-solution-carriers.md`（长期方案落在 git-tracked、覆盖全部消费者的最窄共享 scope，memory 只留指针）、`surface-choices-rubric.md`（合格的推荐标注形态与理由门槛，以及用户给条件式回答时哪些义务不能替他消解）、`cli-output-review-principles.md`、`human-facing-message-principles.md`（消息 / 字段名 / 值的通道无关判据，被 alerting、CLI 输出、schema 三处共用）、`schema-design-principles.md`、`ghostwriting-principles.md`、`web-ui-observation.md`（观察要覆盖「值 / 关系 / 结构」三层，只查值层会让用户第一眼看到的对齐与留白问题全部漏过；有参照时还要同条件成对测量与反向完备性）、`judge-gate-authoring.md`
- 新增：命令 `/custom:review-cli-output`（审 CLI / status / doctor / 安装器 / 部署脚本的人类可读输出并修复）、`/custom:review-schema`（审数据契约并修复）、`/custom:review-readme`
- 新增：`decision-review` skill —— 代码评审对"这个决定本身站不站得住"结构性失明：决策错误产出的代码通常完全正确地实现了那个错误。它在动手之前对决策本身起一次外部评审（Codex read-only，同步），平凡决策走声明式免审，结论连同作用域落 `docs/adr/`。与 `review-gate` 是两道分开的门，过了一道不抵另一道
- 新增：`web-visual-system` + `design-critique` 两个 skill —— 前者在写 CSS 之前定视觉系统参数（字阶与其配对行高、间距梯、层级、圆角族、动效、数字字形、交互态），后者做整体设计评审（视觉层次、信息架构、认知负荷、AI 味）。分工是「生成 vs 评判」：评判档能指认"这个不好"，给不出"好长什么样"，而缺参数的页面可以通过全部功能测试与 rubric 评分，仍然一眼看出不是设计过的
- 新增：四个确定性 hook —— `block-broad-kill`（拦 `pkill` / `killall`：它们按名字选中目标，一次调用会打到别的并发 agent session 的进程且调用方那侧毫无异常；实拍事故是调试一个卡死的 agent-browser daemon 时 `pkill -f agent-browser` 杀掉了机器上全部五个）、`writer-registry-gate`（并发写入者登记与重叠拦截，登记表放在 git common-dir 而非工作树内，因此跨 worktree 天然互相可见且不进版本控制）、`commit-message-language`（commit message 语言闸，纯字符扫描 + 读 git log）、`bg-shell-reclaim-check`（停止前把长时间没交代过的后台 shell 摆出来；实拍事故是三个 `until ! pgrep -f pytest` 循环因匹配到自身而空转 15 小时，期间 agent 反复宣告"清理完成、无待办"）。这几条按 README 安装 prompt **默认接**
- 新增：四个 LLM judge Stop gate，**opt-in** —— `continuation-claim-gate`（收尾说"接下来我做 X"但没有任何 task / monitor / subagent 在跑）、`prose-choice-gate`（把并列选项写成正文列表让用户挑，而没走 `AskUserQuestion`）、`capability-claim-gate`（宣称某具名工具本 session 不可用，而它从没真调过一次）、`reverse-assertion-gate`（交付一条反向断言，而支撑它的读数在结论为假时长得一模一样）。它们各补一块既有闸够不着的盲区，且都不是既有闸"漏看"而是各按自己的判据正确放行。代价是**每个回合到达 Stop 时各发一次判官调用**，所以 README 安装 prompt 把这四条连同代价列出来问、不替你决定，`verify.sh` 对没接的它们记 PASS 而非报警。每个 gate 附一套 eval 场景集（装到 `~/.claude/hooks/eval/<gate>/`，改完 rubric 用 `node run.mjs` 重测准确率——场景不随 hook 走就等于改完没法测）
- 新增：`run-with-flags.js` 分发器 —— 纯模块型的 hook（没有 `require.main` 直调入口，如 `block-broad-kill.js`）**必须**经它调起，直接 `node <脚本>` 会 exit 0 什么都不做、静默失效。目前 11 条接线里有 3 条走它（`writer-registry-gate` / `block-broad-kill` / `commit-message-language`），形如 `node "$HOME/.claude/hooks/run-with-flags.js" <id> <脚本>`，其余仍是直接调脚本——照仓库 `claude/settings.json` 抄，别自己改写调用形态。同时新增 `lib/hook-flags.js` / `lib/judge-log.js` / `lib/transcript.js`
- 新增：tt-web 跨机聚合 —— dashboard 跑在一台机器上、汇报你声明的每台机器的用量：经 SSH 让各远端导出自己的用量快照再合并，页面上的 `All` 指"当前被接纳的每台机器"并明说是哪些。`machines.json` 声明机器，新增 `tt-web machines accept <name>`（首次接触未见过的 SSH 目标默认拒绝：系统只能保证"和上次是同一台"，无法核实别名指向你以为的那台；之后 identity 变了则 fail closed）、`tt-web machines retire`（名字永不复用，退役后新机器不会继承它已发布的历史）、`tt-web export`。另新增的 `tt-web network` 不属跨机聚合——它是本机出口网络诊断的终端视图，与 /network 页同源，作用域只有本机。远端在产出快照的代码与其 HEAD 不一致时拒绝导出，而不是发布一份说不出代码版本的快照。页面首屏从不等网络：先渲染已有数据、标记同步中，拉到再更新，每台机器的卡片区分「现在连不上」与「数据陈旧」
- 变更：tt-web UI 整体重做 —— 首页 KPI 从一排平铺卡片改为分组（Spend / 配额等）并新增机器同步面板，Explore / Sessions / Network 页同步调整；`tt-web/install.sh` 增加 IBM Plex Sans/Mono woff2 字体下载（页面就是按这套字排的）。字体取不到时报 `degraded` 而**不**让安装失败——页面照常渲染，退回系统字体栈；下载走临时文件 + WOFF2 头部声明长度与实际大小比对后才就位，因为截断或损坏的字体比缺失更糟：浏览器静默回退，而下次安装的 `-f` 判断会把残骸当成已装
- 变更：**dashboard 上的历史成本数字会变**，两处口径修正所致 —— ① `pricing.json` 大面积重写——Opus 全系单价降到约三分之一（5 分钟 cache-creation 从 `0.00001875` 到 `0.00000625`），新增 1 小时档 `cache_creation_input_token_cost_above_1hr`，并补进多个此前没有价格的模型 key；② 跨文件去重键从 `(agent, session_id, message_id)` 改为 `(agent, message_id, request_id)`，Codex 侧的 `message_id` 也从 session_meta id 改成 rollout 文件名——resume 出来的会话此前会被重复计入，实测受影响的 Claude bucket 旧行读高约 9%。两项都只改口径、不动你的原始日志，但改完前后的数字不可直接比
- 新增：`tt-web rollup --check`（可加 `--json`）—— 只读地体检 rollup 数据库完整性。`status` 三态是 `safe` / `attention` / `indeterminate`，其中 `indeterminate` 明确**不构成** rollup 干净的证据；脚本必须解析 `status`，不能拿退出码为 0 或 `verdict: safe` 当作通过（`verdict` 只覆盖收缩守卫这一窄项）。文档同时写明遇到 `attention` 别用删库 / 删行 / 覆盖历史来"解决"——那正是这道守卫在保护的基线
- 变更：`codeagent-wrapper` 改为双平台（darwin-arm64 + linux-amd64），**由 install.sh 在安装期按本机选好平台并直接 link** —— 上游那个 run-time dispatcher 靠解析「自己所在目录的上两级」找仓库根，前提是 `~/.claude` 整体 symlink 到仓库的 `claude/`；share 是逐文件 symlink 模型，装过去后它会把仓库根解析成 `$HOME` 而失败。无对应平台构建时 install.sh 与 `verify.sh` 都报 WARN 而非 FAIL、其余照常安装，但受影响面不小：`execute-plan` / `supervise` / `test-ux` / `execute-ux-contract` / `resolve-issues` 五条命令，以及 `review-gate` 高档评审与 `decision-review` 这两个 BINDING gate 的外部评审腿，都靠它
- 新增：`claude/statusline-usage.py` —— Claude Code 只把 `five_hour` / `seven_day` 交给 statusline，按模型划分的配额窗口只存在于 `GET /api/oauth/usage`，想显示就得自己取。它后台单实例拉取并写缓存，`statusline-fields.py` 的每模型配额条读这份缓存；渲染从不等它，失败路径全静默——一次坏掉的刷新只该让状态栏停在上次的数字，不该拖慢或弄坏 session。OAuth token 只作为请求头使用，不进日志、不进 argv、不写缓存
- 新增：`claude/bin/active-plan` —— 让 agent 显式声明本 session 正在执行哪个 plan 目录。context 压缩后它丢失的恰是这个无法重新推导的事实，而扫 `plans/` 取最新 mtime 是错的（并发 session 可能几秒前刚碰过那些文件）。标记按 session id 隔离，并发 session 互不串读
- 变更：`create-commit` 的 commit 执行方式改为 `git add <具体路径>` + **`git commit --only <同一组路径>`** —— 此前只 `git add` 具体文件，读起来像范围声明、实际不是：`git commit` 落的是**整个索引**，包含开工前就躺在里面、别人 stage 的内容，而两者不一致时没有任何回显提示。`--only` 才让"这次只提交这几个文件"真正成立。代价是它提交路径的**工作树内容**、会盖掉你为这些路径 `git add` 过的版本，所以刻意用 `git add -p` 拆过的改动不能走它。同一轮还新增**作者身份核实**：读 `git config user.name` / `user.email` 本身与仓库预期身份核对，不拿 `git log` 的历史作者代替（连续用错身份时历史已被同一个错值填满、会自洽地"通过"）——身份错在本地能 amend，push 之后就是不可逆的公开归属错误，而 agent 侧全程零反馈信号
- 变更：`review-gate` 新增**产出型专项审** —— 此前按"改的是什么文件"分派，现在再按"改动产出了什么"叠加一层：改动改变了读者据以判断"成功了吗 / 能用吗 / 要不要动手"的产物时，除常规档位表外另跑对应专项 command（面向人的终端输出 → `/custom:review-cli-output`；会被人读到字段名与值的数据契约 → `/custom:review-schema`；服务故障告警 → `/custom:review-alerting`），且这些命令落地的代码要回灌常规对抗审，否则专项审新写的代码从此不进任何对抗审。配套新增「面向人产物的档位下限」：这类改动基础档至少中档——原有两维只考察后果与逻辑、不考察表达，两维皆低只说明它不会炸，不说明读者读得懂
- 变更：`/custom:create-plan` 的适用判据换了轴 —— 从「改动大小」改为**「方案要不要交给新的 implementer context 独立接手」**，单文件也可能要写 plan，方案本轮用完即弃就不写。这条同时改了它的 description，所以也改变了它被自动触发的时机；`docs/command-guide.md` 的对应行与工作流 B 一并对齐
- 变更：既有 command / reference / agent / hook 的一批实质更新（上游 156 个 commit 的其余部分）—— 影响面较大的几处：`desktop-notify` 与 `ask-recommend-gate` 两个默认接线的 hook 各有一轮行为修正（这两条每回合都会被撞到）；`background-agent-monitoring` 新增「中途终止」整章（后台任务 `status` 不是 `completed` 时怎么分流、为何要 `resume` 而非从零重派）；`docs-organization-protocol` 扩写 §4.13 与 issue lifecycle 归档规则；`create-plan` / `review-plan` / `execute-plan` / `supervise` / `test-ux` / `review-*` 系列多处对齐上述新 BINDING。逐条差异见 `git log`
- 变更：`verify.sh` 同步到上述改动 —— 新增 `statusline-usage.py` / `active-plan` / 全部新 hook 脚本与 lib 的 symlink 检查，hook 接线表新增 required/optional 列（optional 即那四个 opt-in judge gate，未接记 PASS）；接线表的字段分隔符从 `|` 改为 `^`，因为 writer-registry 的 matcher 自身是 `Edit|Write|MultiEdit|NotebookEdit`，按竖线切会把那一行切碎、转而去核对一个根本不存在的 hook 并报绿

## 2026-08-02

- 变更：`claude/skills/` 下的**全部** skill 现在同时装到 `~/.claude/skills/` 与 `~/.codex/skills/` —— 此前只有 `agent-browser` 双向 symlink，`create-commit` / `deep-discuss` / `review-gate` / `tdd-workflow` / `game-release-loop` 都只装给 Claude Code，于是 Codex session 里点名 `$game-release-loop` 无法识别，而 `CLAUDE.md` 又把 review-gate（完成前强制底线）与 create-commit（commit 唯一路径）写成两侧同等 BINDING——政策要求的东西在 Codex 侧根本不存在。`~/.codex/skills/` 是 Codex 自带 `skill-installer` 文档的 `$CODEX_HOME/skills` 位置
- 变更：`install.sh` 与 `verify.sh` 的 skill 处理改为按 `claude/skills/` 目录 glob 驱动，不再各自维护硬编码名单 —— 与两个脚本对 commands / references / agents 已有的做法一致。新增 skill 从此无需改脚本，也不会重演 `deep-discuss` 那种「install.sh 装了、verify.sh 没验」的漏网
- 修复：`install.sh` 的 `link_one` 在「目标已是普通目录且用户选择覆盖」时会让**整个安装器**中止 —— 该分支执行 `rm "$dst"`，而 `rm` 删不掉目录，脚本又是 `set -euo pipefail`，于是第一个这样的冲突就终止安装、后续步骤一条不跑。这不是边角情形：手动装过 skill 的用户，其 `~/.claude/skills/*` 正是普通目录。现改为把旧目录 `mv` 到 `~/.ai-agent-config-share-backups/<时间戳>/` 下（保留相对 `$HOME` 的原路径结构）再建 symlink——用户选的覆盖真的生效，且不删除任何内容、可自行恢复。备份**不能**留在原地叫 `<name>.bak`：那样它仍在 skill 扫描根内，Codex 会把 `<name>.bak/SKILL.md` 注册成第二个同名 skill（已实测），"覆盖"就变成了新旧两份并存。`[CONFLICT]` 提示也从固定的 "regular file" 改为按实际形态显示 directory
- 已知限制：`disable-model-invocation` 是 Claude 专属 frontmatter，**Codex 不认** —— 标了它的 `game-release-loop` 在 Claude Code 侧仍是硬强制（只在被点名时进入），在 Codex 侧降为软约束，由 `AGENTS.md`「Harness 适配」表的 skill 行承载。README、`docs/architecture.md` 中「非游戏项目零触发成本」的说法相应限定到 Claude Code 侧

## 2026-07-30

- 新增：`game-release-loop` skill —— 浏览器游戏的发布闭环（能力门 → 授权门 → 旅程 × 目标覆盖账本 → READY / PARTIALLY VERIFIED / NOT READY 结论），复用 test-ux / create-review-execute-ux-contract / domain-registry / tdd-workflow；附 `claude/skills/game-release-loop/references/game-profile.md` 空白配置档模板（每款游戏在自己仓库里填一份）。带 `disable-model-invocation`，只在被显式点名时运行，非游戏项目无触发成本。install.sh 自动 symlink 到 `~/.claude/skills/game-release-loop`
- 新增：命令 `/custom:create-aigc-design` + `/custom:review-aigc-design` 与 reference `aigc-design-review.md`，由 `claude/CLAUDE.md` 新 BINDING「AIGC 视觉效果设计先行」绑定 —— 合成 / 编辑 / 后处理 / 多来源接合 / 多步生成类效果在实现前先写设计并循环审查、过 blocker gate；触发判据是改动性质（有无断层 / 鬼影 / 可见重复等视觉工程痕迹类失败模式）而非大小或时机，调试中途新增的「小 tweak」照样触发
- 新增：hook `codeagent-stdin-guard`（PreToolUse / Bash）—— 拦截没有 stdin 来源的 `codeagent-wrapper` 派发：wrapper 在启动 backend 前先读自己的 stdin，后台派发时那是个不 EOF 的空管道，于是静默挂起约 20 分钟、零输出、不触发完成回调。allow-biased（任何 `<`、help/version flag、以及一切有歧义的 shell 形态都放行），`CODEAGENT_STDIN_GUARD=0` 可关停。需按 README「安装」prompt 接进 `~/.claude/settings.json`——hook 接线数从两条变三条
- 新增：`claude/CLAUDE.md` 顶部新增「Harness 适配 (BINDING)」—— `codex/AGENTS.md` 变成 symlink 后两侧读同一份政策，而政策里混着 Claude 专属入口（`/custom:*`、hooks、多数 skill），Codex 侧会被 BINDING 要求调用不存在的东西。该表把能力名映射到两侧，并对 Codex 无对应物的项给出明确处置：读那份 command / SKILL.md 自己执行，确实做不到就告知用户该步依赖 Claude Code，不得臆造完成或静默跳过。表内每条都对着本仓 `install.sh` 的实际安装面核过（未照搬上游版本——上游那张表有数行对本仓为假）
- 变更：principles 文件的审查路由改指 `/custom:review-skill` —— 本仓从未收录专审 meta-原则的 `/custom:review-principles`，但 12 处强制路由指向它（含 review-gate、review-plan、review-spec、review-ux-contract、sync-docs、execute-plan），改 principles 文件时 gate 招不到入口、而其自身规则又规定「审不了 ≠ 审过」，消费者会被卡死。现统一改指 `/custom:review-skill`（已放宽为接受 principles 文件），并在其类型 gate 声明一次能力缺口：principles 只作为 reference 受审，「这套原则本身立不立得住」这一维度不覆盖，reviewer 须明确声明该维度未审
- 变更：`install.sh` 新增 python3 依赖检查 —— statusline 的 JSON 解析全在 `statusline-fields.py`，缺 python3 时状态栏各字段静默变空、`tt-status.json` 停更（正是改用 python 想消除的那种静默降级），此前安装器对此无任何检查
- 新增：`claude/CLAUDE.md` BINDING「Harness Issue Capture」—— 发现 harness 自身值得优化、但本次不就地修的问题时，按 docs-organization-protocol §4.8 记入 `docs/issues/harness-issues.md`。本仓一直在发 `docs/issues/harness-issues.md` 与其 README，两者都声称由这条规则驱动，但规则本身此前没随精选子集进来，于是那份 tracker 没有驱动者、只会空着
- 新增：`claude/CLAUDE.md` BINDING「并发写入者隔离」—— 把 `concurrent-plan-isolation.md` 接上自由 session 的主路径（此前它只被 execute-plan 引用，而自由 session 恰是最需要它的场景）
- 变更：`statusline.sh` 不再需要 jq —— 全部 JSON 处理移入新的 `claude/statusline-fields.py`（单次解析取代 20+ 次 jq 调用）。旧版在没有可用 jq 的主机上会静默清空每一个字段。jq 因此从「statusline 运行时必需」降级为「读写 settings.json 时使用」——install.sh 靠它合并 statusLine，`verify.sh` 自己那几项 settings.json / hook 接线检查也靠它：`verify.sh` 对 jq 从 FAIL 降为 WARN，并新增 python3 的 FAIL 级检查 + hook 脚本 symlink 检查（防止 settings.json 里接了线而脚本从未 link 的静默空转）
- 变更：`codex/AGENTS.md` 改为指向 `claude/CLAUDE.md` 的 symlink —— 它此前已漂移约两个半月（内联一份旧 Stop Gate、缺 4 节 BINDING）。单一政策源后两侧不可能再分叉，README / install.sh 的两次「合并到 ~/.codex/AGENTS.md」从此来源相同
- 变更：`claude/settings.json` 从 permissions.allow 移除 `mcp__github__*` 与 `mcp__memory__*` —— GitHub 写操作（建 PR / 删分支）对外且不可逆，不应默认免提示；`mcp__memory__*` 是已弃用 server 的残留。副作用：GitHub MCP 的读操作也会开始弹权限提示。新增 env `CODEAGENT_LITE_MODE` / `CODEAGENT_OPEN_BROWSER`
- 变更：`claude/skills/agent-browser` 默认模式从「一律 `--headed`」改为 **headless 默认** —— 浏览器自动化不再默认弹出可见窗口；需要用户亲眼看到或亲手操作的场景改由一张模式选择表路由到「可见 GUI 浏览器 + CDP」，并须过新增的 Visible Browser Evidence Gate（能力不可得时报 `Blocked` 或标 `uncovered`，不得静默降级成 headless 模拟）。同时 SKILL.md 1167→835 行，低频内容下沉到 reference（新增 `references/platforms.md`：iOS 模拟器 / 云 provider / 引擎选择），新增 `check-links.py` 自检脚本；另修掉两个行为性缺陷：`Never re-snapshot the same page.` 这条错误的全称禁令（照它执行会拿失效 ref 去点击）改为条件式，stale-daemon 复位此前要求确认 PID 却没给方法（盲杀会打到别的进程）改为从 `doctor` 输出取 pid
- 变更：`review-gate` —— severity 须与本 unit 的 stakes 相称（触发前提超出现实包络的 finding 至多 MEDIUM，防对抗式 framing 逐轮把 exotic 场景升档成新 HIGH 而失去收敛点），新增「不成比例」裁决腿；「已验证」事实的准入要求取证路径与真实执行路径同构；中档 reviewer 改用新增的 `general-purpose-readonly` agent（无 persona 且移除 Edit/Write；它保留 Bash 以便跑真实实验，所以"不改动自己正在评审的文件"是它必须守的契约、不是 harness 物理阻断的墙）
- 变更：`create-commit` —— commit 粒度 = 一次任务执行，不按 artifact 类型拆（代码 / 测试 / 文档进同一个 commit）；message 默认全英文并列出例外；新增两条可推导性判据（复述自己刚写的注释即可推导，但行为变更即使可推导也保留一条）
- 变更：`background-agent-monitoring` —— 新增「退出 ≠ 成功」节（进程 exit 0、进度正常，但结果整批语义失败；监控过滤器必须覆盖失败签名而非只等完成回调）；teammate 回收从两条扩为三条机制（消费即回收 / 绕过即回收 / 收尾清点），新增运行中活性判据与 transport 失败降级路径；`</dev/null` 从一条通则改为按 prompt 传递形态区分（参数形态必须加，heredoc 形态不能加）
- 变更：`concurrent-plan-isolation` 新增「执行中提升」节 —— 判据是当前是否有第二个**决策者**在改这棵工作树（不是第二个写入者，hook / formatter 改写自己的 edit 不算），给出四条反证并区分「同一棵工作树被共享」与「只是同一 repo 被共享」；新增部署耦合豁免（经 symlink 从主 checkout 部署的仓库，其 live 验证在 worktree 里会静默测到另一份文件）
- 变更：`execute-plan` / `review-alerting` / `alerting-review-principles` 新增「真实数据接地」—— 依赖真实生产输入的 verify，合成输入的 PASS 不算通过（真实输入不可取得时 DEFER 不 CLOSE）；告警侧对应新增原则 P9「依赖基线的告警必须验证基线在部署真实产出」（fire 逻辑再对，前提在生产被饥饿就永不上膛，比误报更隐蔽，并区分「被饥饿」与「本就不该有」）。`execute-plan` 另加工作单元一致性 gate（plan 把多个可独立验收 phase 延后到一次最终 review / commit 时不得静默选择）
- 变更：`review-agent-rules`（edit 前风险检查 + 实际落地 diff 复查纳入控制骨架）、`sync-docs`（分类判据落在每支候选修复而非整条 finding 上，一条 finding 多支修复处置不同时「选哪一支」作为真取舍上交）、`test-ux`（后台 codex session 加 `CODEAGENT_OPEN_BROWSER=false`，不把浏览器弹到桌面）、`service-operations-protocol` §6（允许仓库统一约定把轻量服务也纳入可选服务门控）、`codex/config.toml`（新增 `respect_system_proxy = true`）
- 修复：README 安装第一步 —— clone 地址从私有的 `Picnic-PGC/dongs-agent-config` 改为公开的 `lindong28/ai-agent-config-share`（照旧地址走，公开读者在第一步就没有权限），并补上 clone 后缺失的 `cd`（`git clone` 不改变当前目录，而紧接着的 prompt 声称"仓库路径是当前目录"，照字面执行会在错的目录跑 installer）
- 修复：README 对 tt-web 的监听描述 —— 实际默认绑 `0.0.0.0:39001`（有意如此：用户浏览器常在另一台设备上），此前写成"localhost-only / 默认监听 127.0.0.1"，会让读者误判暴露面；现说明同网段可达、`TT_WEB_BIND=127.0.0.1` 可改回，并补上 `git pull` 后如何让常驻进程加载新代码（`tt-web start` 遇已在运行会 no-op 继续跑旧代码，用 `tt-web open` 自动检测重启或 `tt-web restart`）
- 变更：`verify.sh` 新增 hook **接线**检查 —— 此前只验证 hook 脚本有没有 link，而 hook 需手动 merge 进 `settings.json` 才生效，于是"已 link 但未接线"的完全失效状态会验成全绿；现逐个核对三个 hook 的 event + matcher + id + handler 命令是否指向预期脚本（只核 id 会让「同 id 但落在错误 event / 命令陈旧」的失效配置验成 PASS），`ECC_DISABLED_HOOKS` 改为精确 token 比对（子串匹配会把 `stop:desktop-notify-old` 误判为已禁用）。同时补上此前漏查的 `deep-discuss` / `poll-progress.sh` symlink
- 修复：README / `docs/architecture.md` / `docs/command-guide.md` 的陈旧或错误陈述 —— `verify.sh` 的 exit 0 只代表无 FAIL、不代表无 WARN（jq 降级后更容易撞上）；UX 修复闭环实际覆盖可即时修复的 Critical/High/**Medium** 而非只 Critical/High；`execute-plan` 的 issue 回灌路由到"实现该改动所在工作单元的 implementer handle"而非同一个 session；Stop Gate 是**六**项（漏了「文档同步已处理」）；`create-*` / `fix-*` 内置 review 循环并非全都有（`create-handoff` / `create-eval-harness` 就没有）；补上此前未索引的 `/routine:session-export` / `session-import`
- 修复：`desktop-notify` hook 在 tmux / 远程 session 下丢通知 —— 改为直接写 tmux 各 attached client 的 tty 而非走 tmux passthrough（passthrough 受 pane 可见性门控，恰好丢掉「你没在看那个 pane」时最该发的通知），并按 session id 定位 client（避免 session detached 时把项目名与消息摘要投递到无关终端）；tty 探测改判字符设备而非匹配 `ps` 的 "no tty" 标记字符串（该标记在 macOS 是 `??`、Linux 是 `?`，旧写法在 Linux 上返回假路径 `/dev/?` 并静默丢掉每一条通知）

## 2026-07-24

- 新增：`tdd-workflow` skill —— TDD 的 RED→GREEN 纪律（先写会失败的测试再实现至通过），被 `execute-ux-contract` 的 fix session 引用作回归测试约束。install.sh 自动 symlink 到 `~/.claude/skills/tdd-workflow`
- 新增：命令 `/custom:review-alerting`（审服务告警设计质量并修复）、`/custom:review-claude-md`（审单个 CLAUDE.md / AGENTS.md 指令文件）、`/custom:review-session-skills`（审当前 session 触发的 skill）、`/custom:review-agent-rules`（审 agent 规则栈：加载关系 / 冲突 / 能力最小权限）、`/custom:review-memory`（审跨 session 记忆）
- 新增：references `rigor-tiers.md`（plan 严谨度按 (A,V) 正交分层）、`concurrent-plan-isolation.md`（并发 plan 隔离协议）、`background-agent-monitoring.md`（后台 agent 巡检 + teammate 回收）、`alerting-review-principles.md`（告警设计质量原则）、`claude-md-review-principles.md`（CLAUDE.md 写作原则）——补齐 create-plan / execute-plan / review-gate / service-operations-protocol 的引用依赖
- 变更：`codex/config.toml` 默认模型 `gpt-5.5`→`gpt-5.6-sol`（reasoning effort `xhigh`→`high`）；`[mcp_servers.ask-user.tools.AskUserQuestion] approval_mode = "approve"`；移除已弃用的 `[mcp_servers.memory]` 与 `[mcp_servers.sequential-thinking]`。install.sh / verify.sh 同步移除这两个 npm 包的安装与检查
- 变更：`execute-ux-contract` 升级 —— test 阶段可按依赖分组并行（`max-parallel`，默认 5）；§3 收尾从内联 commit 改为「文档同步 recipe → Commit」；可即时修复范围含 Medium；fix session 引入 tdd-workflow 的回归测试 RED→GREEN 约束；获批准的 ux-contract 修正走独立 session + 独立 commit
- 变更：`claude/skills/agent-browser` 更新到上游最新 —— 纠正「stale daemon」处置指南（`agent-browser close` 不 kill daemon）、新增 `chrome-dev-setup.md` 与 cookie 提取/注入模板
- 变更：tt-web —— 刷新走 `/api/health?asset_watch=1` 资产监视；KPI 卡片区分「Claude 5h / 7d」与「Codex 7d」quota；新增 Codex rate-limit 解析测试
- 变更：`claude/CLAUDE.md` Long-Task Protocol 增补「执行中提升」判据（跨 session / context compaction 时判断是否提升为 long-task mode）；`supervise` 增补「判据不可降级」处置腿；多个 command / reference（create-plan / review-plan / review-skill / docs-organization-protocol / skill-review-principles 等）对齐同步

## 2026-07-12

- 新增：`ask-user-mcp/` —— 给 Codex 提供 Claude 兼容 `AskUserQuestion` 的 MCP server（MCP elicitation 在 Codex TUI 弹原生表单）。install.sh 把它 symlink 到 `~/.codex/ask-user-mcp` 并装 node deps；`codex/config.toml` 新增 `[mcp_servers.ask-user]` + `[approval_policy.granular] mcp_elicitations = true`（替代旧 `approval_policy = "never"`，保持自动批准同时让表单浮现）
- 新增：`review-gate` skill —— 生成 / 修改代码 / 脚本 / 常驻配置后、宣告完成或 commit 前的强制质量门（trivial 可声明式免审）。由 `claude/CLAUDE.md`「生成后 Review Gate」BINDING 绑定，`execute-plan` §3.5 逐工作单元调用（commit 粒度 = review 粒度 = 工作单元）
- 变更：`/custom:update-docs` → `/custom:sync-docs` —— 合并旧 update-docs + review-docs：给改动描述则补该改动的文档、空参数则审查修全部；新增文档 / README 审查腿（`docs-review-principles.md` / `readme-review-principles.md`）
- 新增：命令 `/custom:create-refactor-plan`（系统化重构 plan）、`/custom:absorb-skill`（把外部 skill 内容合并进本地）、`/custom:anatomize-llm-workflow`（拆解 LLM 工作流为质量诊断地图）、`/custom:borrow-design`（产出 borrow checklist）、`/custom:create-eval-harness`（给判定 prompt 建回归 eval）
- 变更：`references/docs-organization-protocol.md` + `docs-format-templates.md` + `doc-updater` 新增**可选** `data/` 文档类型（`sources.md` 外部数据源能力 / 可信度分级；`inventory.md` 物化数据盘点 / 权威清单，大 store 靠 regen 命令生成）
- 变更：`plan-execution-principles.md` Stop Gate 新增第 6 项「文档同步已处理」（任务 / plan 完成类 stop 前须执行 docs 同步或声明无可同步项）

## 2026-06-20

- 新增：tt-web cost-history / rollup —— `rollup.py` 把每日 cost/usage 滚动汇总持久化到 `state/rollup.db`（SQLite WAL），支持最长约 2 年的成本历史；overview/pivot/filter API 接入 rollup，raw-log 保留期可短于 rollup 历史。新增**可选** `com.ttweb.rollup` macOS LaunchAgent（默认不装，`./tt-web/install.sh rollup-daemon` 显式开启，每小时刷新）
- 变更：tt-web Explore 页的 agent / project / model 筛选从多选改为**单选下拉**，高基数分组**折叠为 top-12 + Other**
- 新增：`claude/CLAUDE.md` BINDING「本地 Web Server 绑定 0.0.0.0」—— 给用户在浏览器查看的本地临时 web server 必须监听 `0.0.0.0` 而非仅 `127.0.0.1`（用户浏览器常在远程 / 同网另一设备上）
- 变更：`execute-plan` / `supervise` 监督模型增强 —— 新增「以工作单元为界复用 / 轮换 session」（单元内 resume 同 session、单元边界默认启新 session 防 context 膨胀）、「周期性 FYI 进度汇报」（≤30min，单向不打断）、「AIGC / 语义质量任务的监督升格」（supervisor 亲自抽看产物 + 品味工件设计权归 supervisor + 先诊断再派活）
- 变更：`references/docs-organization-protocol.md` + `docs-format-templates.md` 新增 `experiments/` 文档类型（优化 baseline / 结果快照，供后续优化轮在同一测量协议下对比）+ closed-issue 归档约定（issue 判定 resolved/wontfix 时整条移入 `docs/issues/archive/closed.md`，domain 文件只留 open）
- 变更：`codex/config.toml` `plan_mode_reasoning_effort` high→xhigh；bundled 插件 `browser-use` → `browser` + 新增 `chrome`
- 变更：`references/skill-review-principles.md` substitution-path 测试扩展到覆盖 deletions（删除也隐含"保证在别处存续"的断言，需核实）
- 变更：`statusline.sh`、hooks（ask-recommend-gate / desktop-notify / llm-judge）、`create-commit` skill 及多个 review/create command、references 的对齐同步

## 2026-06-09

- 新增：`deep-discuss` skill — 在动手前一起把 tradeoff 想清，但不产出 plan.md；遵循 `references/deep-discuss-style.md`，install.sh 自动 symlink
- 新增：Claude hooks 子系统（首次纳入 share）——`ask-recommend-gate`（PreToolUse 门控 `AskUserQuestion`：选项缺明确推荐 + 理由时 block，分层 LLM 判官 GLM → Anthropic API → `claude -p` 订阅，fail-open）+ `desktop-notify`（Stop 时桌面通知：Ghostty OSC9 点击聚焦原 tab、其余终端 terminal-notifier fallback）。install.sh 按文件 symlink hook 脚本（不覆盖既有 `~/.claude/hooks`）；settings.json 接线（两条 hook + `ECC_DISABLED_HOOKS`）走 README「安装」prompt 手动合并
- 变更：UX 契约同步集成进 `create-plan` → `execute-plan` 流水线 —— create-plan 新增「UX 契约影响」facet（把用户可感知变更投影到 `ux-contract.md` 对应 section，进 plan 的 user-facing surface）；execute-plan §4 UX gate 重构为 4a 应用契约 / 4b 契约驱动验证 / 4c 探索式 test-ux；`docs-organization-protocol.md` §4.6 拆为主路径（契约随实现 apply + 测试）/ fallback（issue 间接路径）
- 变更：tt-web 时间戳改按机器系统时区渲染（带 UTC 偏移标签，服务端 `/api/timezone` 每次实时解析 `/etc/localtime`，不随浏览器陈旧时区漂移）；支持 Tailnet 远程访问（SSH 下 `tt-web open` 输出可点击的 tailnet URL）；新增 `tt-web/NETWORK-REMEDIATION.md` 网络风险修复 runbook（IPv6 泄漏 / CN DNS / 时区不一致），install 末尾仅在 `ip-check` verdict=high 时提示、不阻断安装
- 变更：`create-commit` skill 支持 `revert` type，流程开头加 `git branch --show-current`
- 变更：supervisor 三命令（`execute-plan` / `supervise` / `execute-ux-contract`）的 Codex spawn 加 `CODEX_TIMEOUT=21600000` 前缀、后台 timeout 提到 21900000（容纳更长任务）
- 变更：`bin/codeagent-wrapper` 二进制更新——新增 watchdog（盯静默挂起的 agent）、claude backend 的 resume、browser opt-out 开关、并 bump spawn timeout，修复若干 wrapper 执行问题（skip-permissions exec 等）；影响上述三个 supervisor 命令的可靠性
- 变更：`settings.json` 允许 `Monitor` 工具
- 变更：`references/plan-review-principles.md` 新增 Principle 15「UX Contract Sync Coverage」；`references/skill-review-principles.md` 新增「provenance 交叉引用」检测项

## 2026-06-04

- 新增：`references/docs-organization-protocol.md` + `references/docs-format-templates.md` — 项目文档组织协议（BINDING），定义 7 类文档、三层消费者（User / Developer / Agent）、task 产物 → 项目文档的提升机制与各文档统一格式模板；由 `claude/CLAUDE.md`「Docs Organization Protocol」绑定加载
- 新增：`doc-updater` agent + `/custom:update-docs` 命令 — 按文档组织协议维护 `docs/` 与根目录 README/CHANGELOG，被 execute 类命令的文档同步步骤及手动 `/custom:update-docs` 调用
- 新增：`/custom:resolve-issues` 命令 — 基于目标的批量 issue 解决，含 consumer 范围 triage、依赖序派发、新 issue 闭环回灌
- 新增：游戏 UX 验收扩展 — `references/game/ux-contract-review-principles.md` 新增 G0 规格锚定（Spec Anchoring）原则，`references/game/ux-test-patterns.md` 新增 GP4（行动反馈出屏 / 结果埋深）、GP5（核心玩法承诺落空 / 失败条件缺失）测试 pattern
- 变更：`/custom:test-ux` 执行模型从 subagent 迁移到 codeagent-wrapper codex session，支持早停后 resume 续测，结构化的启动 / 等待 / 裁决流程
- 变更：`/custom:review-skill` optimize 模式细化为基于 wrapper-vs-program 边界的精简检测
- 变更：`install.sh` / `verify.sh` 覆盖 `claude/agents/` 目录（doc-updater 等 sub-agent 定义）
- 修复：`/custom:supervise` 移除 `disable-model-invocation` frontmatter 标志，恢复命令可被模型调用

## 2026-06-02

- 新增：`poll-progress.sh` — 后台任务进度增量轮询脚本，被 supervisor 三命令（`execute-plan` / `supervise` / `execute-ux-contract`）使用，替代原 TaskOutput 阻塞轮询；install.sh 自动 symlink 到 `~/.claude/bin/`
- 新增：`references/domain-registry.md` — 产品类型 domain 注册表（功能型 / 游戏），`create/review/execute-ux-contract` 三命令按 L1 产品类型路由加载 domain 专属验收原则（`references/game/ux-contract-review-principles.md`、`references/game/ux-test-patterns.md`）
- 新增：`references/service-operations-protocol.md` — 仓库服务统一动词脚本（install/uninstall/start/stop/status）运维约定
- 新增：`tt-web/{start,stop,status,uninstall}.sh` — tt-web 生命周期脚本，遵循服务运维协议
- 新增：根目录 `requirements.txt` + 共享 uv venv（`.venv/`）— install.sh 新增 `brew install uv` + venv 创建块；ip-check / tt-web Python 依赖改由共享 venv 提供，替代原 `pip install --user`
- 变更：supervisor 轮询机制改为增量读 `.output`（全量兜底），消除阻塞等待
- 变更：`create/review/execute-ux-contract` 三命令支持 domain 路由扩展，游戏类产品加载专属验收原则
- 变更：`claude/settings.json` 移除三个遥测/隐私抑制开关（DISABLE_TELEMETRY / DISABLE_ERROR_REPORTING / CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC），遥测与错误上报恢复为 Claude Code 默认行为
- 变更：`claude/CLAUDE.md` "Clarification First" 段更名并扩展为 "Surface Choices (Real Ones), Recommend One (BINDING)"，新增 "Present Multimodal Content for User Review (BINDING)" 约定

## 2026-05-29

- 新增：`execute-ux-contract` 命令，由 supervisor 驱动 Codex 基于已审过的 ux-contract 跑端到端 UX 测试与修复闭环，直到 Critical/High issue 清零；补全 ux-contract 工作流（create → review → execute）
- 新增：`create-commit` skill，审查 working tree、生成 commit message、用户确认后执行 commit；`execute-plan` 的 commit 步骤改为委托此 skill。安装与验证脚本同步覆盖该 skill
- 变更：`create-ux-contract` 的 handoff「执行测试」下一步从 `/test-ux` 改为 `/custom:execute-ux-contract`，并新增 contract 审查环节与「流程走通 vs 静态观察」的验收指引
- 变更：Review 命令（`review-plan`、`review-skill`、`review-spec`、`review-ux-contract`）审查阶段改为分组/逐原则并行 subagent 架构，新增 `max-principle-per-subagent` 参数控制每条原则获得的注意力
- 修复：`session-export` / `session-import` 命令内自引用命名空间从 `/custom:session-*` 更正为 `/routine:session-*`
- 移除：`ux-test-protocol.md` 参考文档，由 ux-contract 工作流与 `ux-test-patterns.md` 取代

## 2026-05-26

- 新增：`review-ux-contract` 命令，审查并迭代 UX contract 定义
- 新增：`session-export` / `session-import` routine 命令，支持跨机器 session 迁移
- 变更：Plan/spec 归档目录命名从 `<name>-<date>` 改为 `<date>-<name>`，便于按时间排序
- 变更：Issues 文件结构统一（`docs/contract` → `docs/contracts`，`observed-issues.md` → `docs/issues/general.md`）
- 变更：Review 命令（`review-plan`、`review-skill`、`review-spec`）改为编辑后重新 spawn subagent 并增加 principles meta-review

## 2026-05-21

- 新增：`supervise` 命令，包装后端 agent 的监督执行与质量管控
- 新增：`create-ux-contract` 命令，基于真实产品行为引导建立 UX 测试契约
- 新增：UX 测试协议参考文档（`ux-test-protocol.md`），定义基于契约的 UX 测试流程
- 新增：tt-web 网络诊断功能（IP 检查），含独立 web 页面（`/network.html`）

## 2026-05-20

- 新增：tt-web — 本地 Python web dashboard，回顾 Claude Code / Codex 的 token usage、cost、session 明细
- 新增：`execute-plan` 命令，按 long-task protocol 执行实施计划
- 新增：`test-ux` 命令（替代 `simulate-user-test`），基于契约的端到端 UX 测试
- 新增：Statusline 脚本（`statusline.sh`、`statusline-transcript.py`），为 tt-web 提供 Claude 5h/7d quota 卡片数据
- 新增：`verify.sh` 安装后验证脚本（检查 symlink、依赖、配置一致性）
- 新增：共享 `settings.json`，预配置权限白名单和环境变量
- 变更：安装脚本新增自动依赖检查（jq、npm 包、agent-browser）和 statusline 接入
- 移除：`simulate-user-test` 命令（由 `test-ux` 替代）

## 2026-05-15

- 新增：Codex CLI 配置（`AGENTS.md`、`config.toml`、agent 定义），支持单 prompt 安装流程
- 新增：`agent-browser` skill，含参考文档（认证、命令、性能分析、代理、session 管理、snapshot refs、录屏）和 shell 模板
- 新增：设计哲学文档（`docs/philosophy.md`），阐述 agent-人交互协议的设计立场
- 变更：安装流程简化为单 prompt，同时覆盖 Claude Code 和 Codex CLI

## 2026-05-13

- 新增：首次发布 — Claude Code 和 Codex CLI 的共享 agent 配置
- 新增：安装脚本，支持 symlink 管理和交互式覆盖提示
- 新增：9 个 slash command：`create-handoff`、`create-plan`、`create-skill-from-workflow`、`create-spec`、`fix-skill-from-session`、`review-plan`、`review-skill`、`review-spec`、`simulate-user-test`
- 新增：参考文档：deep-discuss 风格、long-task protocol、plan/skill/spec 创建与审查原则
- 新增：README 和命令指南（`docs/command-guide.md`）
