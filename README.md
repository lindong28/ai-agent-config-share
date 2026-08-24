# ai-agent-config-share

Claude Code 和 Codex CLI 的共享 agent 配置，包括 slash commands、行为指引、agent 定义、skill，以及 token usage dashboard（tt-web，可把多台开发机的用量汇总成一个视图）。安装脚本自动建好 symlink；`CLAUDE.md` / `AGENTS.md` / `config.toml` 三份配置留给你手动合并，它不动它们。

## 这套配置适合谁

它是一套**强观点**的个人配置：核心主张是"改动落地前先过 gate"——先写下可观察的验收标准再实现、代码 / 脚本 / 常驻配置类 artifact 在宣告完成或 commit 前过 review gate（trivial 可显式声明免审）、给用户的每组选项都必须带推荐项。它假定你愿意为质量付出更多轮次和 token，而不是让 agent 一把梭；想要轻量、少约束的配置，这套不合适。具体某个任务该走哪条流程（要不要 spec、要不要 plan、有没有 plan 时怎么监督）见 [docs/command-guide.md](docs/command-guide.md)，那里按场景分了流。

两套 harness 拿到的东西不同：**Claude Code** 拿到全部（commands、skills、hooks、agent 定义、statusline、tt-web）；**Codex CLI** 拿到共享的政策源（`codex/AGENTS.md` 是 `claude/CLAUDE.md` 的 symlink）、`config.toml`、agent 定义与全部 skill（装到 `~/.codex/skills/`），另外还有两层对等设施：`~/.codex/hooks.json` + `codex/bin/codex-hook-dispatch.js` 把 Claude 侧的闸映射到 Codex 的事件上（映射了哪些 handler 见 `codex/hook-parity.json`），`codex/bin/gen-agents-skills.py` 在 `~/.agents/skills/` 下生成 wrapper，使 `/custom:xxx` 在 Codex 侧以 `$custom-xxx` 可用。两侧的安装方式不同：Codex 那份 `hooks.json` 由 `install.sh` 直接 symlink 过去，Claude 侧的 hook 接线要你自己并进 `~/.claude/settings.json`（见下方安装 prompt 第 3 步）。

采用方式上，`install.sh` 是整体安装（symlink、npm 全局包、共享 venv、tt-web 与 ask-user-mcp 子安装器、Codex 侧 hook 层与 wrapper farm、statusLine 写入、PATH 追加），动作明细以脚本输出为准；`CLAUDE.md` / `AGENTS.md` / `config.toml` 三份手动 merge 的边界见首段，安装 prompt 第 2 步会走它。

安装器本身是按 macOS 写的：缺 `uv` 时它直接 `brew install uv`（没有 Homebrew 就会中断），缺 `jq` / `python3` 时会问你要不要 brew 装、拒绝也能继续。在 Linux 上跑之前先自己备好这三个。另外 `codeagent-wrapper` 只有 macOS-arm64 与 Linux-x86_64 两个预编译构建，本机对不上时 `install.sh` 与 `verify.sh` 都只报 WARN 继续。它的影响面比看上去大：`/custom:execute-plan`、`/custom:supervise`、`/custom:test-ux`、`/custom:execute-ux-contract`、`/custom:resolve-issues` 都靠它派后台 agent，`review-gate` 的高档评审与 `decision-review` 这两个 BINDING 环节也用它——没有它，这些要么用不了、要么退不到等效路径。

## 文档导航

| 想知道 | 看这里 |
|---|---|
| 最近改了什么 | [CHANGELOG.md](CHANGELOG.md) |
| 系统怎么组织的、模块职责、分层 | [docs/architecture.md](docs/architecture.md) |
| 为什么这套命令长成这个样子 | [docs/philosophy.md](docs/philosophy.md) |
| 有哪些命令、什么场景用、怎么组合 | [docs/command-guide.md](docs/command-guide.md) |
| 这个仓收什么、哪些是冻结的框架样本 | [docs/scope-policy.md](docs/scope-policy.md) |
| 某个设计当初为什么这么定 | [docs/adr/](docs/adr/) |

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
   - 以仓库 claude/settings.json 的 `hooks` 段为参考并入 ~/.claude/settings.json（缺 `hooks` 或其下对应事件的数组则创建，事件集以仓库 settings.json 现有的为准）。幂等键是 (event, matcher, id, command) 四项一起、不是只看 `id`：已有同 id 且四项都对就跳过；四项有任何不一致的（挂错 event / matcher，或 handler 命令有出入），先给我看 diff 再改对，别当作已存在而跳过——这两种状态 verify.sh 会分档报出，档位见下方验证 prompt。
   - **哪些默认接、哪些先问我，以 verify.sh 的 `HOOK_WIRING` 表为权威**（第 5 栏 `required` = 默认接；`optional` = LLM judge gate，**别替我决定**——把这些条目连同 settings.json 里各自的 `description` 和代价一起列给我，我选哪些就接哪些，没接的 verify.sh 不会报警）。每条干什么、matcher 是什么，读仓库 settings.json 同条的 `description`，别要我在这里复述。几个照抄时容易踩的点：`pre:edit:writer-registry-gate` 与 `pre:edit:memory-carrier-gate` 是**两条独立 stanza**（旧版曾是一条 stanza 挂两个 handler，已拆开）——writer-registry 那条的 matcher 是 `Edit|Write|MultiEdit|NotebookEdit|Bash`（含 `|Bash`：经 Bash 做的 commit / 写文件也要进登记表），memory-carrier-gate 单独一条、matcher 不含 Bash；两条的 matcher 都要整串照抄，别按「edit 闸只配 edit 工具」的直觉裁剪；`session-start:post-compact-restore` 的脚本在 `~/.claude/scripts/hooks/` 下、不在 `~/.claude/hooks/`；`pre:ask-user-question:recommend-gate` 是 required 里唯一调判官的（只在真的发起 AskUserQuestion 时付一次，无判官后端或超时则放行）；`optional` 档的 stop-gate 要接两处（Stop 与 SubagentStop 两条接线、同一个脚本），且这些 Stop 判官每回合到达 Stop 各发一次判官调用、`subagent-stop:stop-gate` 每个子代理结束各一次——这是"先问我"的原因。
   - 接线形态**逐条照抄仓库 settings.json 的 `command` 字段，不要自己改写**。哪条经 `run-with-flags.js` 分发、哪条直接 `node` 调，以 settings.json 为准、别按脚本长相自己推：分发器负责按 profile 开关决定该 hook 这次要不要跑，而走分发的脚本里有几个是纯模块、没有 main guard——直接 `node` 调会 exit 0 什么都不做，一道永不开火的闸，输出上与"开火了但放行"完全一样。
   - 把 env 里 `ECC_DISABLED_HOOKS` 设为 `stop:desktop-notify`（让本地 desktop-notify 取代 ECC 插件那个）。
   - 顺便检查我的 `HOOK_PROFILE` / `ECC_HOOK_PROFILE`：**如果它是 `minimal`，全部走分发器的闸会静默失效**——接线在、脚本在，但分发器在 `minimal` 下直接 exit 0 不调 hook（`verify.sh` 会把这个状态判成 FAIL）。没设过就是默认的 `standard`，不用动；已经是 `minimal` 的告诉我，由我决定是改成 `standard` 还是干脆不接那些闸。
   - 改 settings.json 前先给我看将写入的 diff。可选：desktop-notify 在非 Ghostty 终端的 fallback 需要 `terminal-notifier`（macOS `brew install terminal-notifier`），没有也不影响 Ghostty OSC9。

4. install.sh 输出里如有 [WARN] / [CONFLICT] / NOTE（典型：settings.json 已有 statusLine 但指向别处、codex CLI 未装、jq 未装、本机没有对应平台的 codeagent-wrapper 构建、`GITHUB_PERSONAL_ACCESS_TOKEN` 未设置——GitHub MCP 要它才能用），整理出来问我怎么处理。你在 stdout 上能看到的 [CONFLICT] 只有 statusLine 那一条，逐文件冲突在你那边表现为 `[SKIP — kept existing …]` 行——**把这些 SKIP 行汇总给我**，那才是"有位置没被接管"的信号。另外，如果某个冲突被覆盖而原位置是个真实目录（手动装过 skill 的话很常见），installer 会把它整个移到 `~/.ai-agent-config-share-backups/<时间戳>/` 下而不是删掉——出现过的 `[moved aside]` 行也一并汇总，我要知道有哪些东西被挪走了。
```

## 验证安装

装完后想确认所有东西都接上了，**把下面的 prompt 粘到 Claude Code**：

```
帮我检查这个仓库的 AI agent 配置是否完整安装、有无不一致。仓库路径是当前目录。

1. 跑 ./verify.sh。脚本做机械检查：symlink 是否指向 repo（含各个 hook 脚本，避免出现"settings.json 里接了但脚本没 link"的静默空转 hook）、settings.json 的 hook 接线是否逐条与仓库版对得上、hook 运行环境状态（hook profile / DISABLED_HOOKS / lsof）、依赖（python3 / jq / codex / npm 包 / agent-browser）是否就位、~/.claude/settings.json 的 statusLine 是否接到本 repo、tt-web 是否装好、~/.claude/CLAUDE.md ~/.codex/AGENTS.md ~/.codex/config.toml 是否含必要锚点 section 与 MCP server 条目。

2. 解读输出：
   - [PASS] 不用处理。注意其中一类 PASS 值得看清楚：opt-in 的 LLM judge gate（verify.sh HOOK_WIRING 表里标 `optional` 的那些）如果我当初没选择接线，会记成 PASS 并注明是 opt-in——那是我自己的选择，不是漏装。
   - [FAIL]（symlink 缺失 / 该位置是普通文件且内容与 repo 不一致 / npm 包未装 / python3 不在 PATH / tt-web 没装成 / settings.json 或 statusLine.command 缺失 / 某个 hook 接进 settings.json 了但挂错了 event 或 matcher——那种接了也永不触发（handler 命令有出入但位置对的判 WARN，不在这档）、**部分 required hook 已接线而某个缺接**（settings merge 做过但掉了一条——verify 报 "NOT wired, while N other required hook(s) are"；注意与下一档的区分：一个 required 都没接是 merge 还没做的预期态、判 WARN，接了一部分缺一才判这档）/ effective hook profile 是 `minimal`、`DISABLED_HOOKS` 关掉了 required gate、或 `lsof` 缺失——这三类是环境状态问题，**重跑 install.sh 修不了**，要改 env 或装 lsof；内容与 repo 一致的普通副本算 PASS，不算遮挡）：每条说清原因，除环境状态那三类外问我要不要 ./install.sh 重跑。两点别照字面报：**npm 包那三项查的是 npm 全局树**，我用 pnpm / bun 装过的话会 FAIL 却照样能用。三项里只有 `agent-browser` 另有一条 `agent-browser-cli` 的能力检查可作旁证，另两个是 MCP server、没有对应的探测行，所以那两条 FAIL 只能靠我自己确认装没装；而 `~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`、`~/.codex/config.toml` **整份缺失**也判 FAIL，那三份是手动 merge 的、重跑 installer 不会创建它们——刚装完还没 merge 时必然是这个状态，去做第 2 步的 merge，不要拿它当装坏了。
   - [WARN]（statusLine 指向别处、CLAUDE.md / AGENTS.md / config.toml **已存在但缺锚点**、jq 未装、本机没有对应平台的 codeagent-wrapper 构建、`~/.local/bin` 或 codex / agent-browser / tt-web 不在 PATH、`GITHUB_PERSONAL_ACCESS_TOKEN` 未设、`ECC_DISABLED_HOOKS` 没设成 `stop:desktop-notify`（会重复弹通知）、~/.codex/config.toml 缺某个 MCP server 条目，以及**一个 required hook 都还没接进 settings.json**（刚装完、merge 步骤还没做时的预期态——全部 required 都未接才落这档；接了一部分缺一属上面的 FAIL 档）。jq 影响 installer 能否自动写 statusLine、以及 verify.sh 自己那些 settings.json / hook 接线检查能否做，statusline 运行本身不需要它）：先 diff repo 版与我本地版，再问我哪些要补。
   - [INFO]：仅信息，看完即可。

3. 脚本只能 grep 锚点 section 名，看不出语义漂移。请额外做一次 section / key 级 diff：
   - claude/CLAUDE.md  vs ~/.claude/CLAUDE.md
   - codex/AGENTS.md   vs ~/.codex/AGENTS.md
   - codex/config.toml vs ~/.codex/config.toml
   仓库有、本地没有的 section / key 列出来给我决定要不要补；同名但内容不同的先给我看 diff，不要自动动。前两项在仓库侧是同一份文件（codex/AGENTS.md 是 claude/CLAUDE.md 的 symlink），所以我本地两份如果内容不同，那是本地漂移，一并指出来。

4. `~/.codex/hooks.json` 与 `~/.codex/bin/codex-hook-dispatch.js` 两条 symlink 由 verify.sh 检查；`~/.agents/skills/` 的 command wrapper farm 也在其检查范围内（`agents-skills-farm` 一档：期望集全量比对 + 逐 wrapper 的 generator marker，缺失或 marker 不符会 FAIL 并给出重跑命令）。它过期时 Codex 侧是静默降级：`$custom-<x>` 提示不存在，Claude 侧一切照常——verify.sh 报出后再重跑 `python3 codex/bin/gen-agents-skills.py`。

不要自动改任何文件，所有改动前都要先和我确认。
```

`./verify.sh` 也可以直接跑（不用 Claude）：exit code 等于 FAIL 条数（上限 255）。注意 exit 0 只代表没有 FAIL，不代表没有 WARN——脚本自己会把这两种情形分别报成 `Clean install.` 与 `Functional, but N warning(s)`，看这一行比看 exit code 准。

## 用法

装完后在 Claude Code 中输入 `/custom:` 触发 slash command 选择器。同一批命令在 Codex 侧以 `$custom-<名字>` 出现（`~/.agents/skills/` 下由 `gen-agents-skills.py` 生成的 wrapper，分隔符从 `:` 换成 `-`，例如 `/custom:create-plan` ↔ `$custom-create-plan`）；新增或改名命令之后重跑一次 `install.sh` 或 `python3 codex/bin/gen-agents-skills.py`，wrapper 才会跟上。具体工作流组合见 [docs/command-guide.md](docs/command-guide.md)。

skill 大多由模型按场景自动触发，无需你记住；`game-release-loop` 是唯一刻意只在被点名时才跑的（它标了 `disable-model-invocation`）。注意这条只在 Claude Code 侧是硬强制——Codex 不认这个 frontmatter，那边靠 `AGENTS.md`「Harness 适配」表里的对应条目约束，属软约束。它与 `deep-discuss` 的用途见 [docs/command-guide.md](docs/command-guide.md)。

## tt-web：token usage dashboard

`tt-web/` 子目录是一个独立的本地 Python web 应用，回顾 Claude Code / Codex 的 token usage、cost、project / model / session 明细。详情见 [tt-web/README.md](tt-web/README.md)。

```sh
tt-web start | status | open | restart | stop
```

各子命令的行为细节（绑定地址、端口、`open` 的快照与热更新检测）见 [tt-web/README.md](tt-web/README.md)。

**多台开发机的用量可以汇总到一台 dashboard 上**（前置条件与接纳流程见 [tt-web/README.md](tt-web/README.md) 的 Machines 节）。**一个 clone 下来就会踩的坑：`tt-web/machines.json` 在仓库里带着维护者自己的机器清单**——先把它改成你自己的机器（单机就只留本机并标 `self: true`）**并 commit**，否则 dashboard 会去连你没有的主机，而未提交的改动会让导出被拒、连本机用量都取不到。

tt-web 还带一个**可选**的 `com.ttweb.rollup` 后台守护（长期不开页面时按小时兜底刷新成本历史，默认不装）。装卸、状态与排查见 [tt-web/docs/operations/services.md](tt-web/docs/operations/services.md)；改了它的 plist 或间隔要重跑一次它的 install 才生效。

Dashboard 上 "Claude 5h / 7d quota" 两张卡片的数据来自 `~/.claude/tt-status.json`——这个文件由 `statusline-fields.py` 在**每次状态栏渲染**时重写（所以这条链路要求 python3，不要求 jq）——卡片数据旧了不是重启 Claude Code 能解决的，那说明 statusline 没在跑。上方安装 prompt 会替你把 statusline 接到 `~/.claude/settings.json`，没启用时这两张卡片显示 `—` / `no data`，其它卡片不受影响。

状态栏本身还会显示**按模型划分**的配额（Claude Code 只把 5h / 7d 两个窗口交给 statusline，模型级的窗口要另外去取），不需要你配置。这条链路失败时是**静默**的：取数失败就沿用上次的数字，缓存超过 6 小时则那几条配额直接不显示——刚装完还没成功取过时也是这样，所以看不到模型配额未必是坏了。

---

*Last synced from upstream: 2026-08-24 20:18 GMT+8*
