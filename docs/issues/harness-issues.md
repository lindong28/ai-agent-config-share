# Harness Issues

> [Agent] Agent Harness 自身问题的 domain 跟踪文件——hooks（含 Stop Gate）、适配层、agent / skill 行为、settings / 权限等。产品代码 bug 不进此文件（走各 project 自己的 issue 跟踪）。

由 `~/.claude/CLAUDE.md`「Harness Issue Capture」规则驱动：发现 harness 自身值得优化、但本次不就地修的问题，按 `~/.claude/references/docs-organization-protocol.md` §4.8 追加一条。

**格式**：遵循 §4.8（`## [<status>] <title>` / Type / Priority / Discovered / Description / Notes）。Status：`open` / `resolved` / `wontfix`（后两者写明原因）。Type 枚举：`bug` / `improvement` / `note`。除 §4.8 标准字段外，本 domain 保留 `Component` / `Root cause` / `影响` / `候选优化` 等富字段（§4.8 允许按需追加）。`HARNESS-NNN` id 保留在标题中——条目间互相引用。

---

## [open] HARNESS-002 `codeagent-wrapper … &` 会被 codeagent-stdin-guard 误拦

- **Type**: note
- **Priority**: low
- **Discovered**: 2026-07-30
- **Component**: `claude/hooks/codeagent-stdin-guard.js`
- **Description**: guard 把独立的 `&` 当语句分隔符移除，于是 `codeagent-wrapper --backend codex "prompt" /repo &` 被判为无 stdin 来源并 exit 2 拦下。但非交互 shell 的后台命令已隐式获得 `/dev/null`，本来不会挂——所以这是一次 false block。
- **影响**: 该 hook 在每次 Bash 调用上运行，误拦会打断真实有效命令。恢复成本一个 flag（加 `</dev/null`）。
- **状态**: **本次 waive**。guard 的文件头注释已把这一形态列为**已接受的残留**（"a backgrounded `… &` whose implicit /dev/null stdin the guard can't see — adding `</dev/null` is harmless"），且上游记录了多轮 Codex 审查的结论：每加一层 lexing 都引入自己的 false block（该文件自身对轮次数的两处表述不一致，故此处不引具体轮数）。在 share 单方面"修好"很可能造出上游正在规避的误拦。
- **候选优化**: 归属上游（`ai-agent-config`）。若要修，应识别作用于 wrapper statement 的异步 `&` 并放行，同时补一条精确的回归用例——现有测试只覆盖了"前一个命令后台、wrapper 前台"。

## [open] HARNESS-003 CLAUDE.md 并发隔离节的入口句仍绑在 "执行 plan" 上

- **Type**: bug
- **Priority**: medium
- **Discovered**: 2026-07-30
- **Component**: `claude/CLAUDE.md`「并发写入者隔离」/ `claude/references/concurrent-plan-isolation.md`
- **Description**: 该节第一句只覆盖「多个 agent session 可能并发在同一 repo 上执行 plan 时」，但它引的 reference 首行已经改成「多个决策者可能并发写同一个 repo 时」——protocol 治理面比路由句宽。两个普通的无 plan session 并发改同一棵工作树，按路由句读不到隔离义务，只能等出现外部修改反证后补救。
- **影响**: 最需要这条协议的恰是自由 session（上游 CHANGELOG 记录的真实事故就是一个自由 session 把并发写入者约 110 行改动一并 commit）。
- **状态**: **本次 waive**，因为该段在 share 是逐字节同步上游的；单方面改会造成需长期手工调和的分叉。
- **候选优化**: 归属上游。上游 commit `02a2adf` 标题即 "key concurrent-writer isolation on state, not on being in a plan"——它改了 reference 却漏了 CLAUDE.md 的路由句。入口条件应改成「多个决策者可能并发写同一 repo 时」，把执行 plan 仅列为常见实例。

## [open] HARNESS-001 "单文件改动要不要 plan" 在规则栈内有两种说法

- **Type**: bug
- **Priority**: low
- **Discovered**: 2026-07-30
- **Component**: `claude/commands/custom/create-plan.md` / `docs/command-guide.md`
- **Description**: `create-plan.md:3` 的 description 明确写「单文件改动或已存在 plan 的场景**不用**」；而 `docs/command-guide.md:73`（工作流 B「不需要 spec 的快速 plan」）把「单文件改动」列为该流程的**典型适用**场景，`:127` 又说「单文件 trivial 改动直接做」。三处对同一判据给出不同答案。
- **影响**: description 决定该 command 会不会被模型自动触发，所以这不只是文档不一致——agent 读到哪一份就走哪条路。
- **候选优化**: 统一判据。description 是更强的载体（它进 skill 索引、影响触发）；若真实意图是「单文件但非 trivial 仍值得 quick plan」，应改 description，而不是让 command-guide 单方面扩张适用面。
- **Notes**: 本次上游同步中 README 新增「这套配置适合谁」时撞上此冲突——原稿据 `create-plan.md` 写成"单文件改动不用"，被 review 指出与 command-guide 冲突，最终改为 README 不复述该判据、只指向 command-guide，把冲突留在此处待裁。
