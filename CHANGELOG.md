# Changelog

> Append-only（最新在前）。仅记录用户可感知的变更。

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
