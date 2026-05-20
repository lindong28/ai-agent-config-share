# ai-agent-config-share

Claude Code 和 Codex CLI 的共享 agent 配置，包括 slash commands、行为指引、agent 定义、浏览器自动化 skill，以及本地 token usage dashboard（tt-web）。安装脚本自动处理 symlink 和配置合并。

## 文档导航

| 想知道 | 看这里 |
|---|---|
| 为什么这套命令长成这个样子 | [docs/philosophy.md](docs/philosophy.md) |
| 有哪些命令、什么场景用、怎么组合 | [docs/command-guide.md](docs/command-guide.md) |

## 安装

1. **克隆到稳定路径**（installer 用 symlink 指向仓库内文件，仓库不能移动 / 删除）：

```sh
git clone git@github.com:Picnic-PGC/dongs-agent-config.git
```

2. **复制下面的 prompt 粘贴到 Claude Code 执行**（会运行 install.sh 安装 symlink、agent 定义和 MCP server 依赖，然后合并配置文件）：

```
帮我把这个仓库的 AI agent 配置安装到我的用户目录。

仓库路径是当前目录。先跑 ./install.sh，它会处理 symlink、codex agent 定义和 MCP server CLI 工具的安装。

然后需要合并配置文件：
- claude/CLAUDE.md → 合入 ~/.claude/CLAUDE.md
- codex/AGENTS.md → 合入 ~/.codex/AGENTS.md
- codex/config.toml → 合入 ~/.codex/config.toml

合并规则：保留我已有的内容，只补入仓库里有但我没有的部分。如果有同名但内容不同的 key 或 section，先给我看 diff 让我决定。

如果 install.sh 提示 GITHUB_PERSONAL_ACCESS_TOKEN 没设置，帮我确认一下环境变量配置。
```

## 用法

装完后在 Claude Code 中输入 `/custom:` 触发 slash command 选择器。具体工作流组合见 [docs/command-guide.md](docs/command-guide.md)。

## tt-web：本地 token usage dashboard

`tt-web/` 子目录是一个独立的 localhost-only Python web 应用，回顾 Claude Code / Codex 的 token usage、cost、project / model / session 明细。install.sh 会自动调 `tt-web/install.sh`（下载 Chart.js、symlink `tt-web` 入口到 `~/.local/bin/`）。详情见 [tt-web/README.md](tt-web/README.md)。

```sh
tt-web start    # 启动本地服务（默认监听 127.0.0.1:39001）
tt-web open     # 浏览器打开
tt-web stop
```

> install.sh 末尾若提示 `~/.local/bin not in PATH`，需要把它加到 shell rc 里才能直接敲 `tt-web`。

### 启用 Claude quota 卡片（statusline 数据源）

tt-web dashboard 上 "Claude 5h / 7d quota" 两张卡片数据来自 `~/.claude/tt-status.json`——这个文件由 `claude/statusline.sh` 在每次 Claude Code 启动时写入。install.sh 会 symlink 这个脚本到 `~/.claude/statusline.sh`，但**启用还得你手动改 `~/.claude/settings.json`**：

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/statusline.sh"
  }
}
```

需要 `jq` 在 PATH 上（macOS: `brew install jq`）。不启用的话，tt-web 上 Codex quota 仍能正常显示，只是 Claude 那两张是 `—` / `no data`。

## 运行依赖

`/custom:execute-plan` 要求两层外部组件，install.sh 不会替你装：

- `codeagent-wrapper`：仓库 `claude/bin/` 里携带的 **arm64 macOS** 二进制，install.sh 会 symlink 到 `~/.claude/bin/`。非 Apple Silicon Mac 上跑不起来
- Codex CLI：`codex` 在 PATH 上、已登录鉴权。需要自己装：见 [openai/codex](https://github.com/openai/codex)

不打算用 `/custom:execute-plan` 的话两者都可以跳过——其他 9 个 command 不依赖。

---

*Last synced from upstream: 2026-05-20 12:08 GMT+8*
