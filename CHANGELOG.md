# Changelog

> Append-only（最新在前）。仅记录用户可感知的变更。

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
