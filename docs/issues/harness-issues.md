# Harness Issues

> [Agent] Agent Harness 自身问题的 domain 跟踪文件——hooks（含 Stop Gate）、适配层、agent / skill 行为、settings / 权限等。产品代码 bug 不进此文件（走各 project 自己的 issue 跟踪）。

由 `~/.claude/CLAUDE.md`「Harness Issue Capture」规则驱动：发现 harness 自身值得优化、但本次不就地修的问题，按 `~/.claude/references/docs-organization-protocol.md` §4.8 追加一条。

**格式**：遵循 §4.8（`## [<status>] <title>` / Type / Priority / Discovered / Description / Notes）。Status：`open` / `resolved` / `wontfix`（后两者写明原因）。Type 枚举：`bug` / `improvement` / `note`。除 §4.8 标准字段外，本 domain 保留 `Component` / `Root cause` / `影响` / `候选优化` 等富字段（§4.8 允许按需追加）。`HARNESS-NNN` id 保留在标题中——条目间互相引用。

---

## [open] HARNESS-004 Codex 不认 `disable-model-invocation`，explicit-only 在 Codex 侧只有软约束

- **Type**: improvement
- **Priority**: medium
- **Discovered**: 2026-08-02
- **Component**: `claude/skills/game-release-loop/SKILL.md` / `claude/CLAUDE.md`「Harness 适配」表 skill 行
- **Description**: `disable-model-invocation: true` 是 Claude Code 专属 frontmatter。skill 现在双向安装到 `~/.codex/skills/` 后，Codex 会照常按 description 自动触发 `game-release-loop`——而该 skill 的设计意图（及 `docs/architecture.md` 的措辞）是"只在被显式点名时进入，非游戏项目零触发成本"。
- **Root cause**: 上游 `codex/bin/gen-agents-skills.py` 只对 **command wrapper** 生成两层 prose 护栏（description 前缀 `EXPLICIT INVOCATION ONLY — never auto-trigger.` + 正文显式调用段），其 `link_skills()` 对普通 skill 是无条件 symlink、不打护栏——因为上游 `claude/skills/` 下此前没有任何 skill 带这个 flag。`game-release-loop` 是第一个。
- **影响**: 非游戏项目的 Codex session 可能被这个重流程 skill 勾起。本轮的缓解是把等效约束写进 `CLAUDE.md`「Harness 适配」表（Codex 实际读的就是这份），但那是模型遵守的软约束，不是 loader 级禁止。
- **状态**: **本次按用户裁决只做软约束**。已评估但未采纳的两个硬化方案：把护栏 prose 写进共享 SKILL.md 正文（一处改动，Claude 侧冗余无害）；或给 Codex 侧生成独立 wrapper 目录（严格隔离，代价是多一份会漂移的生成物 + verify.sh 要改为验内容）。
- **候选优化**: 若要在 loader 层解决，需 Codex 自身支持等效 frontmatter；在此之前，上述两个方案中的第一个成本最低。
- **Notes**: 本轮实测:临时 CODEX_HOME 下 `skills/<name>/SKILL.md` 会进 model-visible prompt input；`skills/.<name>/`（点号前缀）不会。点号前缀因此是 Codex 侧可用的隐藏手段，但 Claude Code loader 是否同样跳过未实测，故 `link_one` 的备份改走 `~/.ai-agent-config-share-backups/` 这一 loader 无关路径。

## [open] HARNESS-002 `codeagent-wrapper … &` 会被 codeagent-stdin-guard 误拦

- **Type**: note
- **Priority**: low
- **Discovered**: 2026-07-30
- **Component**: `claude/hooks/codeagent-stdin-guard.js`
- **Description**: guard 把独立的 `&` 当语句分隔符移除，于是 `codeagent-wrapper --backend codex "prompt" /repo &` 被判为无 stdin 来源并 exit 2 拦下。但非交互 shell 的后台命令已隐式获得 `/dev/null`，本来不会挂——所以这是一次 false block。
- **影响**: 该 hook 在每次 Bash 调用上运行，误拦会打断真实有效命令。恢复成本一个 flag（加 `</dev/null`）。
- **状态**: **本次 waive**。guard 的文件头注释已把这一形态列为**已接受的残留**（"a backgrounded `… &` whose implicit /dev/null stdin the guard can't see — adding `</dev/null` is harmless"），且上游记录了多轮 Codex 审查的结论：每加一层 lexing 都引入自己的 false block（该文件自身对轮次数的两处表述不一致，故此处不引具体轮数）。在 share 单方面"修好"很可能造出上游正在规避的误拦。
- **候选优化**: 归属上游（`ai-agent-config`）。若要修，应识别作用于 wrapper statement 的异步 `&` 并放行，同时补一条精确的回归用例——现有测试只覆盖了"前一个命令后台、wrapper 前台"。


## [open] HARNESS-005 install.sh 在没有 Homebrew 的主机上会中途整体中断

- **Type**: bug
- **Priority**: medium
- **Discovered**: 2026-08-09
- **Component**: `install.sh`（uv 依赖那一段）
- **Description**: 缺 `uv` 时该行是无守卫的 `command -v uv >/dev/null 2>&1 || brew install uv`，而脚本开头是 `set -euo pipefail`。没有 Homebrew 的主机（多数 Linux）上 `brew` 不存在，这一行非零退出即中止整轮安装——且它排在 statusLine 写入之前，所以那一步也拿不到。README 现在明说"在 Linux 上跑之前先自己备好这三个"，属文档缓解，不是修复。
- **影响**: 本轮把 codeagent-wrapper 扩到 linux-amd64、README 也开始把 Linux 当受支持宿主，这条就从"理论问题"变成了新受众第一次跑就会撞上的问题。
- **候选优化**: 缺 brew 时降级为 `[WARN]` 并跳过 uv（venv 相关功能随之标 skipped），而不是让整轮安装失败；或在脚本开头就做一次平台/包管理器探测，把所有"macOS 专属"步骤统一走 skipped 分支。

## [open] HARNESS-006 ask-recommend-gate 依赖一个本仓不提供、也不检查的脚本

- **Type**: bug
- **Priority**: low
- **Discovered**: 2026-08-09
- **Component**: `claude/hooks/ask-recommend-gate.js`
- **Description**: 该 hook 引用 `ghostty-tab-title.sh`，而本仓不收录它、`install.sh` 不装它、`verify.sh` 也不查它。
- **影响**: 采用者装完后这条路径取不到该脚本。gate 主体功能不受影响，但存在一条永远走不通的分支。
- **候选优化**: 要么把该脚本纳入收录范围并进安装/验证清单，要么把这条依赖从 hook 里摘掉。判定前先确认它在上游承担什么职责。

## [open] HARNESS-007 create-eval-harness 指向本仓不存在的 eval 目录

- **Type**: bug
- **Priority**: low
- **Discovered**: 2026-08-09
- **Component**: `claude/commands/custom/create-eval-harness.md`
- **Description**: 该 command 引用 `claude/hooks/eval/stop-gate/` 作为范例，但本仓未收录 `stop-gate.js` 及其 eval 目录（本轮收录的是 capability-claim / continuation-claim / prose-choice / reverse-assertion 四套）。
- **影响**: 按该 command 去找范例的读者会扑空。
- **候选优化**: 把范例改指本仓实际存在的四套之一（`reverse-assertion-gate` 的场景集最完整，18 条）。

## [open] HARNESS-008 tt-web 子安装器失败会连带掐掉 statusLine 接线

- **Type**: bug
- **Priority**: low
- **Discovered**: 2026-08-09
- **Component**: `install.sh`（调 `tt-web/install.sh` 与 `wire_statusline_settings` 的先后）
- **Description**: tt-web 子安装器在 statusLine 写入之前被调用，且其失败会在 `set -euo pipefail` 下中止整轮。于是一个可选子项目（本地 dashboard）的失败，会让一个无关且更基础的步骤（statusline 接线）拿不到。
- **影响**: 采用者得到一个部分安装且没有 statusline 的环境，而失败原因来自他可能根本不打算用的组件。
- **候选优化**: 把子安装器调用包成"失败记 WARN 并继续"，或把 statusLine 接线移到它前面。
