# ai-agent-config-share

Claude Code 和 Codex CLI 的共享 agent 配置，包括 slash commands、行为指引、agent 定义、skill，以及本地 token usage dashboard（tt-web）。安装脚本自动处理 symlink 和配置合并。

## 这套配置适合谁

它是一套**强观点**的个人配置：核心主张是"改动落地前先过 gate"——先写下可观察的验收标准再实现、代码 / 脚本 / 常驻配置类 artifact 在宣告完成或 commit 前过 review gate（trivial 可显式声明免审）、给用户的每组选项都必须带推荐项。它假定你愿意为质量付出更多轮次和 token，而不是让 agent 一把梭；想要轻量、少约束的配置，这套不合适。具体某个任务该走哪条流程（要不要 spec、要不要 plan、有没有 plan 时怎么监督）见 [docs/command-guide.md](docs/command-guide.md)，那里按场景分了流。

两套 harness 拿到的东西不同：**Claude Code** 拿到全部（commands、skills、hooks、agent 定义、statusline、tt-web）；**Codex CLI** 拿到共享的政策源（`codex/AGENTS.md` 是 `claude/CLAUDE.md` 的 symlink）、`config.toml`、agent 定义与 agent-browser skill，但 hooks 与 slash commands 是 Claude Code 专属。

采用方式上，`install.sh` 是整体安装：建 symlink、装 npm 全局包、创建共享 venv、跑 tt-web 与 ask-user-mcp 两个子安装器，并写 `settings.json` 的 statusLine（缺失就直接补，已指向别处则告警不覆盖）、在你同意后往 shell rc 追加 PATH。它**不**覆盖你已有的 `CLAUDE.md` / `AGENTS.md` / `config.toml`——那三个走手动 merge，合什么由你决定。

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
git clone git@github.com:lindong28/ai-agent-config-share.git
cd ai-agent-config-share
```

2. **在仓库根目录**（上一步 `cd` 之后）**复制下面的 prompt 粘贴到 Claude Code 执行**：

```
帮我把这个仓库的 AI agent 配置安装到我的用户目录。仓库路径是当前目录（先确认当前目录下有 install.sh，没有就先 cd 进仓库根目录）。

1. 跑 ./install.sh。脚本会自动处理 symlink、tt-web 子安装、ask-user-mcp 子安装（给 Codex 装 Claude 兼容的 AskUserQuestion MCP server，需 node/npm）、依赖检查、settings.json statusLine 写入；遇到交互式 [y/N] 提示按我意愿回答即可。statusline 的运行时依赖是 python3（JSON 解析都在 claude/statusline-fields.py 里）；jq 用于读写 settings.json——installer 靠它把 statusLine 字段并进我已有的配置，没装 jq 不影响 statusline 运行，但那一步要改成手动接线。

2. 合并配置文件——保留我已有的内容，只补入仓库里有但我没有的部分；同名但内容不同的 key/section 先给我看 diff 再问我决定：
   - claude/CLAUDE.md  → ~/.claude/CLAUDE.md
   - codex/AGENTS.md   → ~/.codex/AGENTS.md（仓库里它是指向 claude/CLAUDE.md 的 symlink——两个 harness 共用同一份政策源，所以这两次合并的来源内容完全相同，不需要在两份仓库文件之间做调和）
   - codex/config.toml → ~/.codex/config.toml

3. 接线 hooks 到 settings.json——share 不整体安装 settings.json，hook 脚本已由 install.sh symlink 到 ~/.claude/hooks/，但还需把三条接线并入我的 ~/.claude/settings.json：
   - 以仓库 claude/settings.json 的 `hooks` 段为参考，把这三条并入 ~/.claude/settings.json（缺 `hooks` / `PreToolUse` / `Stop` 数组则创建）。幂等键是 (event, matcher, id, command) 四项一起、不是只看 `id`：已有同 id 且四项都对就跳过；同 id 但 event / matcher / handler 命令与仓库版不一致，说明那条接了但不会触发（`verify.sh` 会判 FAIL），给我看 diff 再改对，别当作已存在而跳过：`pre:ask-user-question:recommend-gate`（PreToolUse / AskUserQuestion）、`pre:bash:codeagent-stdin-guard`（PreToolUse / Bash——拦住没有 stdin 来源的 codeagent-wrapper 派发，那种派发会静默挂起约 20 分钟且零输出；allow-biased，可用 `CODEAGENT_STDIN_GUARD=0` 关掉）、`stop:desktop-notify-local`（Stop / `*`）。
   - 把 env 里 `ECC_DISABLED_HOOKS` 设为 `stop:desktop-notify`（让本地 desktop-notify 取代 ECC 插件那个）。
   - 改 settings.json 前先给我看将写入的 diff。可选：desktop-notify 在非 Ghostty 终端的 fallback 需要 `terminal-notifier`（macOS `brew install terminal-notifier`），没有也不影响 Ghostty OSC9。

4. install.sh 输出里如有 [WARN] / [CONFLICT] / NOTE（典型：settings.json 已有 statusLine 但指向别处、codex CLI 未装、jq 未装、`GITHUB_PERSONAL_ACCESS_TOKEN` 未设置——GitHub MCP 要它才能用），整理出来问我怎么处理。
```

## 验证安装

装完后想确认所有东西都接上了，**把下面的 prompt 粘到 Claude Code**：

```
帮我检查这个仓库的 AI agent 配置是否完整安装、有无不一致。仓库路径是当前目录。

1. 跑 ./verify.sh。脚本做机械检查：symlink 是否指向 repo（含各个 hook 脚本，避免出现"settings.json 里接了但脚本没 link"的静默空转 hook）、依赖（python3 / jq / codex / npm 包 / agent-browser）是否就位、~/.claude/settings.json 的 statusLine 是否接到本 repo、~/.claude/CLAUDE.md ~/.codex/AGENTS.md ~/.codex/config.toml 是否含必要锚点 section。

2. 解读输出：
   - [PASS] 不用处理。
   - [FAIL]（symlink 缺失 / 该位置是普通文件且内容与 repo 不一致 / npm 包未装 / python3 不在 PATH；内容与 repo 一致的普通副本算 PASS，不算遮挡）：每条说清原因，问我要不要 ./install.sh 重跑（会出 [CONFLICT] 让我决定是否覆盖）。
   - [WARN]（statusLine 指向别处、CLAUDE.md / AGENTS.md / config.toml 缺锚点、jq 未装——jq 影响 installer 能否自动写 statusLine、以及 verify.sh 自己那项 settings.json 检查能否做，statusline 运行本身不需要它）：先 diff repo 版与我本地版，再问我哪些要补。
   - [INFO]：仅信息，看完即可。

3. 脚本只能 grep 锚点 section 名，看不出语义漂移。请额外做一次 section / key 级 diff：
   - claude/CLAUDE.md  vs ~/.claude/CLAUDE.md
   - codex/AGENTS.md   vs ~/.codex/AGENTS.md
   - codex/config.toml vs ~/.codex/config.toml
   仓库有、本地没有的 section / key 列出来给我决定要不要补；同名但内容不同的先给我看 diff，不要自动动。前两项在仓库侧是同一份文件（codex/AGENTS.md 是 claude/CLAUDE.md 的 symlink），所以我本地两份如果内容不同，那是本地漂移，一并指出来。

不要自动改任何文件，所有改动前都要先和我确认。
```

`./verify.sh` 也可以直接跑（不用 Claude）：exit code 等于 FAIL 条数。注意 exit 0 只代表没有 FAIL，不代表没有 WARN——脚本自己会把这两种情形分别报成 `Clean install.` 与 `Functional, but N warning(s)`，看这一行比看 exit code 准。

## 用法

装完后在 Claude Code 中输入 `/custom:` 触发 slash command 选择器。具体工作流组合见 [docs/command-guide.md](docs/command-guide.md)。

skill 大多由模型按场景自动触发，无需你记住；`game-release-loop` 是唯一刻意只在被点名时才跑的（它标了 `disable-model-invocation`）。它与 `deep-discuss` 的用途见 [docs/command-guide.md](docs/command-guide.md)。

## tt-web：本地 token usage dashboard

`tt-web/` 子目录是一个独立的本地 Python web 应用，回顾 Claude Code / Codex 的 token usage、cost、project / model / session 明细。详情见 [tt-web/README.md](tt-web/README.md)。

```sh
tt-web start    # 启动本地服务（默认监听 0.0.0.0:39001）
tt-web open     # 浏览器打开；顺带检测服务是否在跑旧代码，是则自动重启
tt-web restart  # 显式重启（git pull 后让常驻进程加载新代码）
tt-web stop
```

**默认监听 `0.0.0.0` 而非仅回环**，因为你的浏览器常不在跑服务那台机上（远程开发机 / 同网另一设备）。代价是同网段内可达——上面是你的 token 用量与成本明细，介意就用 `TT_WEB_BIND=127.0.0.1 tt-web restart` 改回只绑回环（要用 `restart`：服务已在跑时 `start` 直接 no-op、不会重绑）。

服务是常驻进程，启动时就把代码**冻结**在内存里：`git pull` 之后 `tt-web start` 会因为"已在运行"直接 no-op、继续跑旧代码。`tt-web open` 会主动检测这种情况并自动重启，或者直接 `tt-web restart`。

Dashboard 上 "Claude 5h / 7d quota" 两张卡片的数据来自 `~/.claude/tt-status.json`——这个文件由 `claude/statusline.sh` 在每次 Claude Code 启动时写入（JSON 解析都在同目录的 `statusline-fields.py` 里，所以这条链路要求 python3，不要求 jq）。上方安装 prompt 会替你把 statusline 接到 `~/.claude/settings.json`，没启用时这两张卡片显示 `—` / `no data`，其它卡片不受影响。

---

*Last synced from upstream: 2026-07-30 19:47 GMT+8*
