# Architecture

> Mutable snapshot. Update when structure changes.

## Overview

ai-agent-config-share 是一个 AI coding agent 的共享配置仓库，为 Claude Code 和 Codex CLI 两套工具链提供统一的行为指引、工作流命令、agent 定义、skill 和运行时可观测性。核心技术栈：Bash（安装 / 验证 / statusline）、Markdown（所有行为定义）、Python（可观测性工具链）、TOML + JSON（工具配置）。

仓库不是一个"应用"——它是一个**人机协作协议层**，核心产出是一组声明式行为定义，通过 symlink 注入到用户 home 目录的 `~/.claude/` 和 `~/.codex/` 中生效。

## Modules

### claude/ — Claude Code 行为层

为 Claude Code 提供行为指引和扩展能力。内容通过 `install.sh` symlink 到 `~/.claude/` 后被 Claude Code 运行时加载。

| 子模块 | 职责 |
|---|---|
| `CLAUDE.md` | 用户级行为指引入口（手动 merge 到 `~/.claude/CLAUDE.md`，不 symlink） |
| `settings.json` | 环境变量、权限白名单、MCP server 列表、模型选择（手动 merge 到 `~/.claude/settings.json`） |
| `commands/custom/` | Slash command 定义（`/custom:create-plan`、`/custom:execute-plan`、`/custom:test-ux` 等），是用户触发工作流的入口 |
| `commands/routine/` | 日常运维命令（session 导入 / 导出） |
| `references/` | 被 CLAUDE.md 和 commands 引用的协议文档（plan 执行原则、skill 创建原则、UX 测试协议等），是行为规则的 source of truth |
| `skills/agent-browser/` | 浏览器自动化 skill（agent-browser CLI 的用法、认证模式、模板脚本），被 `test-ux` 等命令消费 |
| `bin/codeagent-wrapper` | arm64 macOS 二进制，包装 Codex / Gemini CLI 为统一接口，被 `execute-plan` 和 `supervise` 命令调用 |
| `statusline.sh` + `statusline-transcript.py` | Claude Code statusline 脚本：解析运行时 JSON 输入，渲染多行终端状态栏 + 持久化 `~/.claude/tt-status.json` 供 tt-web 消费 |

### codex/ — Codex CLI 行为层

为 OpenAI Codex CLI 提供行为指引和扩展能力。结构与 claude/ 平行，通过 symlink 注入 `~/.codex/`。

| 子模块 | 职责 |
|---|---|
| `AGENTS.md` | 用户级行为指引（手动 merge 到 `~/.codex/AGENTS.md`） |
| `config.toml` | Codex CLI 配置（模型、MCP server、agent 定义、安全策略、profile），手动 merge |
| `agents/` | Codex sub-agent 定义（explorer / reviewer / docs-researcher），每个 `.toml` 文件定义模型、sandbox 模式和 developer instructions |

### tt-web/ — 可观测性 Dashboard

独立的 Python web 应用，提供本地 token usage / cost / session 明细的可视化 dashboard。与配置层的唯一耦合点是 `~/.claude/tt-status.json`（由 statusline.sh 写入）。

| 子模块 | 职责 |
|---|---|
| `server.py` | ThreadingHTTPServer，提供 REST API（`/api/overview`、`/api/pivot`、`/api/sessions`、`/api/network`） |
| `parsers/` | 日志解析器（claude.py / codex.py / claude_status.py），从 `~/.claude/projects/` 和 `~/.codex/sessions/` 读取 JSONL |
| `aggregators.py` | 数据聚合层（pivot、指标提取、按时间 / 项目 / 模型分组） |
| `cache.py` | 文件级缓存（mtime + size 变更检测，避免重复解析大量 JSONL） |
| `pricing_fetcher.py` + `pricing.json` | 模型定价数据 |
| `web/` | 前端静态文件（HTML + JS + CSS），Chart.js 驱动的图表 |
| `ip_check/` | 网络诊断子模块（DNS / IPv6 / 公网 IP / 代理检测），独立 CLI `ip-check` |
| `tests/` | pytest 测试套件 |

### 安装与验证

| 文件 | 职责 |
|---|---|
| `install.sh` | 主安装脚本：symlink 创建 + npm 全局包安装 + 依赖检查 + settings.json statusLine 写入 + tt-web 子安装。交互式冲突解决（y/N/a/s） |
| `verify.sh` | 只读验证脚本：检查所有 symlink 是否指向本 repo、依赖是否就位、settings.json 是否接好、手动 merge 文件是否含必要锚点。exit code = FAIL 数 |

### docs/ — 项目文档

项目级持久化知识，按 docs-organization-protocol 组织。详见 `docs/CLAUDE.md`（索引）。

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
│  能力层                                                   │
│  skills/ + agents/ + bin/codeagent-wrapper               │
│  被行为定义层引用的具体能力——浏览器自动化、sub-agent、跨工具适配     │
├─────────────────────────────────────────────────────────┤
│  可观测性层                                               │
│  statusline.sh + statusline-transcript.py + tt-web/      │
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
- 可观测性层独立于行为定义层（statusline 和 tt-web 不依赖 commands / references）
- 安装层横切所有层（install.sh 同时处理 symlink、npm 包、settings.json）

**跨工具共享**：agent-browser skill 同时 symlink 到 `~/.claude/skills/` 和 `~/.codex/skills/`。CLAUDE.md 和 AGENTS.md 虽然分属两个工具，但通过引用相同的 `references/` 文件（plan-execution-principles.md、long-task-protocol.md 等）保持行为一致性。

## Key Abstractions

### Command 三级结构

仓库的核心工作流是 **spec → plan → execute** 三级流水线，体现了"plan 阶段深度对齐、execute 阶段自主收敛"的设计哲学：

- **create-spec**：与用户对齐产品定位和验收标准（L1 产物 + L2 用户视角 verify）
- **create-plan**：将 spec 转化为可实施的 plan（L3 设计决策 + 内部 verify）
- **execute-plan**：Claude 作为 supervisor 启动 Codex 实施 plan，按 Stop Gate 收敛 + 可选 UX 验收闭环

每一级产出的 verify 步骤是下一级的输入契约——spec verify 约束 plan verify，plan verify 约束 execute 的完成判定。

### Supervisor 模式

`execute-plan` 和 `supervise` 两个命令实现了 Claude-as-supervisor 的编排模式：

- Claude（主 session）通过 `codeagent-wrapper` 在后台启动 Codex / Gemini / Claude 实例
- 后台 agent 执行任务，主 session 通过 `TaskOutput` 轮询进度
- 主 session 按 Stop Gate 判定后台 agent 是否真正完成，未完成则 resume 同一 session
- `execute-plan` 额外支持 UX 验收闭环：完成后自动 `test-ux`，将 Critical/High issue 回灌给同一 Codex session

### Stop Gate

贯穿整个执行体系的收敛机制。任何 agent 想要停止执行都必须通过五项检查：必要性已证明、归因已分层、替代路径已尝试、verify 已拆分、交接可执行。这个机制同时约束 Codex（被监督的 agent）、Claude（supervisor）、以及 UX 修复循环。

### Reference 文件 vs Command 文件

行为规则分两层存储：

- **commands/**：面向触发的入口文件，定义"什么时候触发、输入输出是什么、主流程怎么走"
- **references/**：面向引用的协议文件，定义"规则本身"（plan-execution-principles.md、deep-discuss-style.md 等）

commands 引用 references，但 references 不引用 commands。这种分离让多个 commands 可以共享同一套规则，且规则的 source of truth 唯一。

### Symlink 安装模型

配置不是复制到 home 目录，而是 symlink 到 repo 内文件。这意味着：

- `git pull` 即升级——所有 symlinked 文件实时生效
- 仓库路径不能移动或删除（symlink 会断）
- CLAUDE.md / AGENTS.md / config.toml 三个文件例外——因为用户有自定义内容，只能手动 merge

### 可观测性数据流

```
Claude Code 运行时
    ↓ JSON（stdin of statusline.sh）
statusline.sh
    ├→ 终端渲染（stdout，5 行状态栏）
    └→ ~/.claude/tt-status.json（原子写入）
          ↓
    statusline-transcript.py（解析 transcript JSONL，提供 session 级汇总）
          ↓
    tt-web server.py
        ├→ parsers/（解析 ~/.claude/projects/ 和 ~/.codex/sessions/ 的 JSONL）
        ├→ aggregators.py（pivot / 指标提取）
        └→ web/（前端渲染 Chart.js 图表）
```
