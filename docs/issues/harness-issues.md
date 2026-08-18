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
- **Notes（2026-08-18，上游同步 commit `5fc1dfb`）**: 处境变了但结论不变。本轮纳入 `codex/bin/gen-agents-skills.py` 后，Codex 侧不再是"什么都没有"——它为标了该 frontmatter 的 command 生成带 `EXPLICIT INVOCATION ONLY` 与"仅当用户消息显式调用 `$custom-<x>` 时才继续"的 wrapper。但那仍是写进 prompt 的指令、不是机制，本条的"只有软约束"照旧成立。**验证**：`node codex/bin/gen-agents-skills.denylist.test.js`（该断言在内，随 `npm test` 28/28 通过）。

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

## [open] HARNESS-008 tt-web 子安装器失败会连带掐掉 statusLine 接线

- **Type**: bug
- **Priority**: low
- **Discovered**: 2026-08-09
- **Component**: `install.sh`（调 `tt-web/install.sh` 与 `wire_statusline_settings` 的先后）
- **Description**: tt-web 子安装器在 statusLine 写入之前被调用，且其失败会在 `set -euo pipefail` 下中止整轮。于是一个可选子项目（本地 dashboard）的失败，会让一个无关且更基础的步骤（statusline 接线）拿不到。
- **影响**: 采用者得到一个部分安装且没有 statusline 的环境，而失败原因来自他可能根本不打算用的组件。
- **候选优化**: 把子安装器调用包成"失败记 WARN 并继续"，或把 statusLine 接线移到它前面。

## [open] HARNESS-009 数处 reference 把 permission-gate 说成本仓在册闸，而本仓未收录它

- **Type**: bug
- **Priority**: low
- **Discovered**: 2026-08-18（上游同步后的复盘）
- **Component**: `claude/references/judge-gate-authoring.md`、`claude/hooks/lib/llm-judge.js` 头注
- **Description**: 这几处把 `permission-gate` 列为本仓现役判官闸之一（judge-gate-authoring 写"本仓现有 7 道"），而本仓经用户裁决未收录 permission-gate 全家，实为六道。上游侧这些陈述为真，是精选子集造成的单向漂移。
- **影响**: 按这些文档去数闸的读者会扑空（实为六道）。原先第三处残留 `claude/references/pattern-matching-scope.md` 与 `claude/CLAUDE.md`「模式匹配」节已随 scope 收窄整体移除（2026-08-18），现存残留只剩上列两处；`judge-gate-authoring.md` 是冻结的框架样本，按 `docs/scope-policy.md` 它引用上游专有物属刻意保留，本条实际只剩 `llm-judge.js` 头注这一处值得改。
- **候选优化**: 要么给这类陈述加"上游独有、本仓未收录"的条件式措辞（同 `docs/adr/README.md` 表前注记的做法），要么在同步时把这类计数句纳入第 4 步交叉引用审计的范围。判定前先确认上游是否愿意为子集消费者改写共享 reference。

## [open] HARNESS-010 run-tests.sh 不覆盖仓根 tests/，缺的那片在读数里没有痕迹

- **Type**: bug
- **Priority**: medium
- **Discovered**: 2026-08-18（对 `/routine:sync-from-upstream` 做 review-skill 时，契约预检 reviewer 读 run-tests.sh 的枚举逻辑发现）
- **Component**: `claude/hooks/run-tests.sh`（上游同名文件与本仓字节相同，同样受影响）
- **Description**: `run-tests.sh` 的覆盖面 = `claude/hooks/**` 与 `claude/bin/**` 下的 `*.test.js` + 4 份显式 js 套件 + 1 份 python（`claude/scripts/test_mcp_dedup.py`）。仓根 `tests/test_gen_agents_skills.py` 不在任何一条枚举里，而它测的 `gen-agents-skills.py` 正是上游同步最常波及的 Codex 适配层。
- **影响**: 该测试不跑，`npm test` 仍打印全绿——漏掉的这片覆盖在读数里没有任何痕迹（与已归档的 HARNESS-162 同形：没被跑与通过了在输出上完全同形）。本轮已在 `/routine:sync-from-upstream` 第 4 步把措辞改为「既有测试入口：`npm test` 与仓根 `tests/`」绕开，但入口仍是两个、需要执行者记得跑第二个。
- **同形的第二处（2026-08-18 补）**: `codex/bin/codex-hook-dispatch.edge.test.js` 同样跑不到——`run-tests.sh` 的 `find . ../bin` 根只覆盖 `claude/hooks` 与 `claude/bin`，而 `explicit_tests` 里的 codex 测试只列了 `gen-agents-skills.denylist` / `codex-compaction-hooks` / `codex-hook-parity` 三份。手维护的显式清单每加一份测试就漏一次，与已归档的 HARNESS-162/163 是同一根因。
- **候选优化**: 把仓根 `tests/` 与 `codex/bin/*.test.js` 并进 `run-tests.sh` 的枚举（或把 codex/bin 加进 find 根），让「仓内既有检查」重新只有一个入口可指；改动同时落在本仓与上游两份同名文件，需各自过 review gate。

