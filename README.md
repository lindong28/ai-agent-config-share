# ai-agent-config-share

Claude Code 和 Codex CLI 的共享 agent 配置，包括 slash commands、行为指引、agent 定义、skill，以及本地 token usage dashboard（tt-web）。安装脚本自动处理 symlink 和配置合并。

## 文档导航

| 想知道 | 看这里 |
|---|---|
| 最近改了什么 | [CHANGELOG.md](CHANGELOG.md) |
| 系统怎么组织的、模块职责、分层 | [docs/architecture.md](docs/architecture.md) |
| 为什么这套命令长成这个样子 | [docs/philosophy.md](docs/philosophy.md) |
| 有哪些命令、什么场景用、怎么组合 | [docs/command-guide.md](docs/command-guide.md) |

## 安装

1. **克隆到稳定路径**（installer 用 symlink 指向仓库内文件，仓库不能移动 / 删除）：

```sh
git clone git@github.com:Picnic-PGC/dongs-agent-config.git
```

2. **复制下面的 prompt 粘贴到 Claude Code 执行**：

```
帮我把这个仓库的 AI agent 配置安装到我的用户目录。仓库路径是当前目录。

1. 跑 ./install.sh。脚本会自动处理 symlink、tt-web 子安装、依赖检查、settings.json statusLine 写入；遇到交互式 [y/N] 提示按我意愿回答即可。

2. 合并配置文件——保留我已有的内容，只补入仓库里有但我没有的部分；同名但内容不同的 key/section 先给我看 diff 再问我决定：
   - claude/CLAUDE.md  → ~/.claude/CLAUDE.md
   - codex/AGENTS.md   → ~/.codex/AGENTS.md
   - codex/config.toml → ~/.codex/config.toml

3. install.sh 输出里如有 [WARN] / [CONFLICT]（典型：settings.json 已有 statusLine 但指向别处、codex CLI 未装、GITHUB_PAT 未设置），整理出来问我怎么处理。
```

## 验证安装

装完后想确认所有东西都接上了，**把下面的 prompt 粘到 Claude Code**：

```
帮我检查这个仓库的 AI agent 配置是否完整安装、有无不一致。仓库路径是当前目录。

1. 跑 ./verify.sh。脚本做机械检查：symlink 是否指向 repo、依赖（jq / codex / npm 包 / agent-browser）是否就位、~/.claude/settings.json 的 statusLine 是否接到本 repo、~/.claude/CLAUDE.md ~/.codex/AGENTS.md ~/.codex/config.toml 是否含必要锚点 section。

2. 解读输出：
   - [PASS] 不用处理。
   - [FAIL]（symlink 缺失 / 普通文件遮挡 share 版 / npm 包未装）：每条说清原因，问我要不要 ./install.sh 重跑（会出 [CONFLICT] 让我决定是否覆盖）。
   - [WARN]（statusLine 指向别处、CLAUDE.md / AGENTS.md / config.toml 缺锚点）：先 diff repo 版与我本地版，再问我哪些要补。
   - [INFO]：仅信息，看完即可。

3. 脚本只能 grep 锚点 section 名，看不出语义漂移。请额外做一次 section / key 级 diff：
   - claude/CLAUDE.md  vs ~/.claude/CLAUDE.md
   - codex/AGENTS.md   vs ~/.codex/AGENTS.md
   - codex/config.toml vs ~/.codex/config.toml
   仓库有、本地没有的 section / key 列出来给我决定要不要补；同名但内容不同的先给我看 diff，不要自动动。

不要自动改任何文件，所有改动前都要先和我确认。
```

`./verify.sh` 也可以直接跑（不用 Claude）：exit code 等于 FAIL 条数，0 = 干净。

## 用法

装完后在 Claude Code 中输入 `/custom:` 触发 slash command 选择器。具体工作流组合见 [docs/command-guide.md](docs/command-guide.md)。

## tt-web：本地 token usage dashboard

`tt-web/` 子目录是一个独立的 localhost-only Python web 应用，回顾 Claude Code / Codex 的 token usage、cost、project / model / session 明细。详情见 [tt-web/README.md](tt-web/README.md)。

```sh
tt-web start    # 启动本地服务（默认监听 127.0.0.1:39001）
tt-web open     # 浏览器打开
tt-web stop
```

Dashboard 上 "Claude 5h / 7d quota" 两张卡片的数据来自 `~/.claude/tt-status.json`——这个文件由 `claude/statusline.sh` 在每次 Claude Code 启动时写入。上方安装 prompt 会替你把 statusline 接到 `~/.claude/settings.json`，没启用时这两张卡片显示 `—` / `no data`，其它卡片不受影响。

---

*Last synced from upstream: 2026-05-29 10:36 GMT+8*
