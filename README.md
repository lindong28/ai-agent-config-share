# ai-agent-config-share

Claude Code 和 Codex CLI 的共享 agent 配置，包括 slash commands、行为指引、agent 定义、skill，以及 token usage dashboard（tt-web，可把多台开发机的用量汇总成一个视图）。安装脚本自动建好 symlink；`CLAUDE.md` / `AGENTS.md` / `config.toml` 三份配置留给你手动合并，它不动它们。

## 这套配置适合谁

它是一套**强观点**的个人配置：核心主张是"改动落地前先过 gate"——先写下可观察的验收标准再实现、代码 / 脚本 / 常驻配置类 artifact 在宣告完成或 commit 前过 review gate（trivial 可显式声明免审）、给用户的每组选项都必须带推荐项。它假定你愿意为质量付出更多轮次和 token，而不是让 agent 一把梭；想要轻量、少约束的配置，这套不合适。具体某个任务该走哪条流程（要不要 spec、要不要 plan、有没有 plan 时怎么监督）见 [docs/command-guide.md](docs/command-guide.md)，那里按场景分了流。

两套 harness 拿到的东西不同：**Claude Code** 拿到全部（commands、skills、hooks、agent 定义、statusline、tt-web）；**Codex CLI** 拿到共享的政策源（`codex/AGENTS.md` 是 `claude/CLAUDE.md` 的 symlink）、`config.toml`、agent 定义与全部 skill（装到 `~/.codex/skills/`），但 hooks 与 slash commands 是 Claude Code 专属。

采用方式上，`install.sh` 是整体安装：建 symlink、装 npm 全局包、创建共享 venv、跑 tt-web 与 ask-user-mcp 两个子安装器，并写 `settings.json` 的 statusLine（缺失就直接补，已指向别处则告警不覆盖）、在你同意后往 shell rc 追加 PATH。它**不**覆盖你已有的 `CLAUDE.md` / `AGENTS.md` / `config.toml`——那三个走手动 merge，合什么由你决定。

安装器本身是按 macOS 写的：缺 `uv` 时它直接 `brew install uv`（没有 Homebrew 就会中断），缺 `jq` / `python3` 时会问你要不要 brew 装、拒绝也能继续。在 Linux 上跑之前先自己备好这三个。另外 `codeagent-wrapper` 只有 macOS-arm64 与 Linux-x86_64 两个预编译构建，本机对不上时 `install.sh` 与 `verify.sh` 都只报 WARN 继续。它的影响面比看上去大：`/custom:execute-plan`、`/custom:supervise`、`/custom:test-ux`、`/custom:execute-ux-contract`、`/custom:resolve-issues` 都靠它派后台 agent，`review-gate` 的高档评审与 `decision-review` 这两个 BINDING 环节也用它——没有它，这些要么用不了、要么退不到等效路径。

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

1. 跑 ./install.sh。脚本会自动处理 symlink、tt-web 子安装、ask-user-mcp 子安装（给 Codex 装 Claude 兼容的 AskUserQuestion MCP server，需 node/npm）、依赖检查、settings.json statusLine 写入；注意逐文件冲突的 [y/N] 提示直接读写 /dev/tty，**不会出现在你能捕获的输出里**。你那边没有真正的终端时，它要么读失败、当成 "N"（保留我原有的文件、不覆盖），要么干脆卡住等一个永远不来的输入——两种都不要报成"用户选择了保留"。所以：别声称我做过任何选择；如果有位置需要覆盖，单独列给我，我自己在终端里跑一次。statusline 的运行时依赖是 python3（JSON 解析都在 claude/statusline-fields.py 里）；jq 用于读写 settings.json——installer 靠它把 statusLine 字段并进我已有的配置，没装 jq 不影响 statusline 运行，但那一步要改成手动接线。

2. 合并配置文件——保留我已有的内容，只补入仓库里有但我没有的部分；同名但内容不同的 key/section 先给我看 diff 再问我决定：
   - claude/CLAUDE.md  → ~/.claude/CLAUDE.md
   - codex/AGENTS.md   → ~/.codex/AGENTS.md（仓库里它是指向 claude/CLAUDE.md 的 symlink——两个 harness 共用同一份政策源，所以这两次合并的来源内容完全相同，不需要在两份仓库文件之间做调和）
   - codex/config.toml → ~/.codex/config.toml

3. 接线 hooks 到 settings.json——share 不整体安装 settings.json，hook 脚本已由 install.sh symlink 到 ~/.claude/hooks/，但还需把接线并入我的 ~/.claude/settings.json：
   - 以仓库 claude/settings.json 的 `hooks` 段为参考并入 ~/.claude/settings.json（缺 `hooks` / `PreToolUse` / `Stop` 数组则创建）。幂等键是 (event, matcher, id, command) 四项一起、不是只看 `id`：已有同 id 且四项都对就跳过；同 id 但 event / matcher / handler 命令与仓库版不一致，说明那条接了但不会触发（`verify.sh` 会判 FAIL），给我看 diff 再改对，别当作已存在而跳过。
   - **默认接这几条**（PreToolUse 的只在对应 tool call 真的发生时才触发；两条 Stop 的每回合都跑，但都是确定性判断、不调判官）：`pre:ask-user-question:recommend-gate`（PreToolUse / AskUserQuestion——**这条会调判官**，但只在我真的发起 AskUserQuestion 时才付这一次，无判官后端或超时则放行）、`pre:bash:codeagent-stdin-guard`（PreToolUse / Bash——拦住没有 stdin 来源的 codeagent-wrapper 派发，那种派发会静默挂起约 20 分钟且零输出；allow-biased，可用 `CODEAGENT_STDIN_GUARD=0` 关掉）、`pre:bash:block-broad-kill`（拦 pkill / killall —— 它们按名字选中目标，会连带杀掉别的并发 agent session 的进程且不报告）、`pre:bash:commit-message-language`（commit message 语言闸）、`pre:edit:writer-registry-gate`（PreToolUse / `Edit|Write|MultiEdit|NotebookEdit`——并发写入者登记与重叠拦截）、`stop:desktop-notify-local`（Stop / `*`）、`stop:bg-shell-reclaim-check`（停止前把长时间没交代的后台 shell 摆出来）。
   - **这四条是 LLM judge gate，问我要不要接**：`stop:continuation-claim-gate`、`stop:prose-choice-gate`、`stop:capability-claim-gate`、`stop:reverse-assertion-gate`。它们各拦一类"输出上看不出来"的失败（承诺了后续动作但没有东西在跑 / 把选项写成正文列表而不走 AskUserQuestion / 宣称某工具不可用却从没调过 / 交付一条反向断言而证据在结论为假时长得一样）。代价是**每个回合到达 Stop 时各发一次判官调用**，所以默认不替我决定——把这四条连同代价一起列给我，我选哪些就接哪些，没接的 `verify.sh` 不会报警。
   - 接线形态**逐条照抄仓库 settings.json 的 `command` 字段，不要自己改写**：11 条里只有 3 条（`pre:edit:writer-registry-gate`、`pre:bash:block-broad-kill`、`pre:bash:commit-message-language`）走 `node "$HOME/.claude/hooks/run-with-flags.js" <id> <脚本>` 分发，其余 8 条是直接 `node "$HOME/.claude/hooks/<脚本>"`。这不是风格差异：分发器负责按 profile 开关决定该 hook 这次要不要跑，并优先以模块方式调目标；其中 `block-broad-kill.js` 是纯模块、没有 main guard，直接 `node` 调它会 exit 0 什么都不做——一道永不开火的闸，输出上与"开火了但放行"完全一样。所以哪条走分发、哪条直调，以仓库 settings.json 为准，别按脚本长相自己推。
   - 把 env 里 `ECC_DISABLED_HOOKS` 设为 `stop:desktop-notify`（让本地 desktop-notify 取代 ECC 插件那个）。
   - 顺便检查我的 `HOOK_PROFILE` / `ECC_HOOK_PROFILE`：**如果它是 `minimal`，上面那三条走分发器的闸会全部静默失效**——接线在、脚本在、`verify.sh` 也曾照报 PASS，但分发器在 `minimal` 下直接 exit 0 不调 hook。没设过就是默认的 `standard`，不用动；已经是 `minimal` 的告诉我，由我决定是改成 `standard` 还是干脆不接那三条（现在 `verify.sh` 会把这个状态判成 FAIL，不会让它蒙混过去）。
   - 改 settings.json 前先给我看将写入的 diff。可选：desktop-notify 在非 Ghostty 终端的 fallback 需要 `terminal-notifier`（macOS `brew install terminal-notifier`），没有也不影响 Ghostty OSC9。

4. install.sh 输出里如有 [WARN] / [CONFLICT] / NOTE（典型：settings.json 已有 statusLine 但指向别处、codex CLI 未装、jq 未装、本机没有对应平台的 codeagent-wrapper 构建、`GITHUB_PERSONAL_ACCESS_TOKEN` 未设置——GitHub MCP 要它才能用），整理出来问我怎么处理。你在 stdout 上能看到的 [CONFLICT] 只有 statusLine 那一条，逐文件冲突在你那边表现为 `[SKIP — kept existing …]` 行——**把这些 SKIP 行汇总给我**，那才是"有位置没被接管"的信号。另外，如果某个冲突被覆盖而原位置是个真实目录（手动装过 skill 的话很常见），installer 会把它整个移到 `~/.ai-agent-config-share-backups/<时间戳>/` 下而不是删掉——出现过的 `[moved aside]` 行也一并汇总，我要知道有哪些东西被挪走了。
```

## 验证安装

装完后想确认所有东西都接上了，**把下面的 prompt 粘到 Claude Code**：

```
帮我检查这个仓库的 AI agent 配置是否完整安装、有无不一致。仓库路径是当前目录。

1. 跑 ./verify.sh。脚本做机械检查：symlink 是否指向 repo（含各个 hook 脚本，避免出现"settings.json 里接了但脚本没 link"的静默空转 hook）、依赖（python3 / jq / codex / npm 包 / agent-browser）是否就位、~/.claude/settings.json 的 statusLine 是否接到本 repo、~/.claude/CLAUDE.md ~/.codex/AGENTS.md ~/.codex/config.toml 是否含必要锚点 section。

2. 解读输出：
   - [PASS] 不用处理。注意其中一类 PASS 值得看清楚：四个 opt-in 的 LLM judge gate（`stop:continuation-claim-gate` / `stop:prose-choice-gate` / `stop:capability-claim-gate` / `stop:reverse-assertion-gate`）如果我当初没选择接线，会记成 PASS 并注明是 opt-in——那是我自己的选择，不是漏装。
   - [FAIL]（symlink 缺失 / 该位置是普通文件且内容与 repo 不一致 / npm 包未装 / python3 不在 PATH / tt-web 没装成 / settings.json 或 statusLine.command 缺失 / 某个 hook 接进 settings.json 了但 event、matcher 或 handler 命令与仓库版对不上——那种接了也永不触发；内容与 repo 一致的普通副本算 PASS，不算遮挡）：每条说清原因，问我要不要 ./install.sh 重跑。两点别照字面报：**npm 包那三项查的是 npm 全局树**，我用 pnpm / bun 装过的话会 FAIL 却照样能用。三项里只有 `agent-browser` 另有一条 `agent-browser-cli` 的能力检查可作旁证，另两个是 MCP server、没有对应的探测行，所以那两条 FAIL 只能靠我自己确认装没装；而 `~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`、`~/.codex/config.toml` **整份缺失**也判 FAIL，那三份是手动 merge 的、重跑 installer 不会创建它们——刚装完还没 merge 时必然是这个状态，去做第 2 步的 merge，不要拿它当装坏了。
   - [WARN]（statusLine 指向别处、CLAUDE.md / AGENTS.md / config.toml **已存在但缺锚点**、jq 未装、本机没有对应平台的 codeagent-wrapper 构建、`~/.local/bin` 或 codex / agent-browser / tt-web 不在 PATH、`GITHUB_PERSONAL_ACCESS_TOKEN` 未设、`ECC_DISABLED_HOOKS` 没设成 `stop:desktop-notify`（会重复弹通知），以及**该接的 hook 已 link 但没接进 settings.json**——那种 hook 脚本在位却永不触发。jq 影响 installer 能否自动写 statusLine、以及 verify.sh 自己那些 settings.json / hook 接线检查能否做，statusline 运行本身不需要它）：先 diff repo 版与我本地版，再问我哪些要补。
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

skill 大多由模型按场景自动触发，无需你记住；`game-release-loop` 是唯一刻意只在被点名时才跑的（它标了 `disable-model-invocation`）。注意这条只在 Claude Code 侧是硬强制——Codex 不认这个 frontmatter，那边靠 `AGENTS.md`「Harness 适配」表里的对应条目约束，属软约束。它与 `deep-discuss` 的用途见 [docs/command-guide.md](docs/command-guide.md)。

## tt-web：token usage dashboard

`tt-web/` 子目录是一个独立的本地 Python web 应用，回顾 Claude Code / Codex 的 token usage、cost、project / model / session 明细。详情见 [tt-web/README.md](tt-web/README.md)。

```sh
tt-web start    # 启动本地服务（默认绑 0.0.0.0，端口从 39001 起，被占用则自增）
tt-web status   # 在不在跑、跑在哪个端口
tt-web open     # 浏览器打开；顺带检测服务是否在跑旧代码，是则自动重启
tt-web restart  # 显式重启（git pull 后让常驻进程加载新代码）
tt-web stop
```

**默认监听 `0.0.0.0` 而非仅回环**，因为你的浏览器常不在跑服务那台机上（远程开发机 / 同网另一设备）。代价是同网段内可达——上面是你的 token 用量与成本明细，介意就用 `TT_WEB_BIND=127.0.0.1 tt-web restart` 改回只绑回环（要用 `restart`：服务已在跑时 `start` 直接 no-op、不会重绑）。

服务是常驻进程，启动时就把代码**冻结**在内存里：`git pull` 之后 `tt-web start` 会因为"已在运行"直接 no-op、继续跑旧代码。`tt-web open` 会主动检测这种情况并自动重启，或者直接 `tt-web restart`。

**多台开发机的用量可以汇总到一台 dashboard 上**：声明各机器后，跑 dashboard 的那台经 SSH 拉取其余各台的用量快照并合并。**注意 `tt-web/machines.json` 在仓库里带着维护者自己的机器清单**（三台，其中一台标了 `self`），clone 下来它就是你的默认配置——只用一台机器的话，把它改成只剩你这台并标 `self: true`，否则 dashboard 会去连几台你没有的主机。**改完要 commit**：它被算进导出版本指纹，工作树里留着未提交的改动会让导出被拒，连你自己这台的用量都取不到。要开跨机汇总，前置条件（免密非交互 SSH、每台都装好 `tt-web`）与 `tt-web machines accept` 的接纳流程见 [tt-web/README.md](tt-web/README.md) 的 Machines 节。

tt-web 还带一个**可选**的 `com.ttweb.rollup` 后台守护：成本汇总本来在你打开 dashboard 时就会被节流刷新，这个守护只是每小时兜一次底，让你长期不开页面时历史也不断档。它是 macOS LaunchAgent，默认不装：装用 `./tt-web/install.sh rollup-daemon`，卸用 `./tt-web/uninstall.sh rollup-daemon`，查状态用 `./tt-web/status.sh rollup-daemon`（会打印 interval、pid 与上次退出码）。它由 launchd 按小时拉起，所以没有单独的 start / stop；改了它的 plist 或间隔要重跑一次 install 才生效。服务清单与排查见 [tt-web/docs/operations/services.md](tt-web/docs/operations/services.md)。

Dashboard 上 "Claude 5h / 7d quota" 两张卡片的数据来自 `~/.claude/tt-status.json`——这个文件由 `statusline-fields.py` 在**每次状态栏渲染**时重写（所以这条链路要求 python3，不要求 jq）——卡片数据旧了不是重启 Claude Code 能解决的，那说明 statusline 没在跑。上方安装 prompt 会替你把 statusline 接到 `~/.claude/settings.json`，没启用时这两张卡片显示 `—` / `no data`，其它卡片不受影响。

状态栏本身还会显示**按模型划分**的配额（Claude Code 只把 5h / 7d 两个窗口交给 statusline，模型级的窗口要另外去取），不需要你配置。这条链路失败时是**静默**的：取数失败就沿用上次的数字，但缓存超过 6 小时就整条作废、那几条配额直接不显示——刚装完还没成功取过时也是这样。所以看不到模型配额未必是坏了。要区分"没配额可显示"和"一直取不到"，看缓存 `~/.claude/statusline-cache/.usage.json` 里的 `fetched_at`（上次成功取到的时刻）与 `attempted_at`（上次尝试的时刻）：只有 `attempted_at` 在动就是一直失败。手动跑那个脚本看不出问题——它的每条失败路径都是静默的。

---

*Last synced from upstream: 2026-08-09 15:44 GMT+8*
