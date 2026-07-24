# Changelog

> Append-only（最新在前）。仅记录用户可感知的变更。

## 2026-07-24

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
