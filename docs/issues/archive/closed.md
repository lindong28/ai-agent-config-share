# Closed Issues (Archive)

> [Agent] 已判定 `resolved` / `wontfix` 的 issue 归档——翻状态的同一步从各 domain 文件（`harness-issues.md` / `general.md` 等）整条移入，条目格式不变（见 `~/.claude/references/docs-organization-protocol.md` §4.8）。
>
> 单一扁文件、不按 domain 分（archive 无按 domain 处理的 consumer）。**只 grep 查史，不通读**——定位 open issue 请回各 domain 文件；triage 用的 `docs/issues/*.md` 是非递归 glob，天然不扫本目录。

---

## [resolved] HARNESS-003 CLAUDE.md 并发隔离节的入口句仍绑在 "执行 plan" 上

- **Type**: bug
- **Priority**: medium
- **Discovered**: 2026-07-30
- **Resolved**: 2026-08-09
- **Component**: `claude/CLAUDE.md`「并发写入者隔离」/ `claude/references/concurrent-plan-isolation.md`
- **Description**: 该节第一句只覆盖「多个 agent session 可能并发在同一 repo 上执行 plan 时」，但它引的 reference 首行已经改成「多个决策者可能并发写同一个 repo 时」——protocol 治理面比路由句宽。两个普通的无 plan session 并发改同一棵工作树，按路由句读不到隔离义务，只能等出现外部修改反证后补救。
- **影响**: 最需要这条协议的恰是自由 session（上游 CHANGELOG 记录的真实事故就是一个自由 session 把并发写入者约 110 行改动一并 commit）。
- **状态**: **本次 waive**，因为该段在 share 是逐字节同步上游的；单方面改会造成需长期手工调和的分叉。
- **候选优化**: 归属上游。上游 commit `02a2adf` 标题即 "key concurrent-writer isolation on state, not on being in a plan"——它改了 reference 却漏了 CLAUDE.md 的路由句。入口条件应改成「多个决策者可能并发写同一 repo 时」，把执行 plan 仅列为常见实例。
- **Notes**: 2026-08-09 的上游同步中由上游修复并随之带入，原「本次 waive、等上游改」的处置随之作废（waive 的理由正是不愿单方面分叉，上游改了即自动解除）。现 `claude/CLAUDE.md`「并发写入者隔离」首句为「多个决策者可能并发写同一个 repo 时」，并把「多个 agent session 并发执行 plan」降为「最常见的入口」——恰是本条候选优化提的改法。同节还新增了「执行中提升」段（列出三类反证）。**验证**：`grep -A4 "并发写入者隔离" claude/CLAUDE.md`。

## [resolved] HARNESS-001 "单文件改动要不要 plan" 在规则栈内有两种说法

- **Type**: bug
- **Priority**: low
- **Discovered**: 2026-07-30
- **Resolved**: 2026-08-09
- **Component**: `claude/commands/custom/create-plan.md` / `docs/command-guide.md`
- **Description**: `create-plan.md:3` 的 description 明确写「单文件改动或已存在 plan 的场景**不用**」；而 `docs/command-guide.md:73`（工作流 B「不需要 spec 的快速 plan」）把「单文件改动」列为该流程的**典型适用**场景，`:127` 又说「单文件 trivial 改动直接做」。三处对同一判据给出不同答案。
- **影响**: description 决定该 command 会不会被模型自动触发，所以这不只是文档不一致——agent 读到哪一份就走哪条路。
- **候选优化**: 统一判据。description 是更强的载体（它进 skill 索引、影响触发）；若真实意图是「单文件但非 trivial 仍值得 quick plan」，应改 description，而不是让 command-guide 单方面扩张适用面。
- **Notes**: 本次上游同步中 README 新增「这套配置适合谁」时撞上此冲突——原稿据 `create-plan.md` 写成"单文件改动不用"，被 review 指出与 command-guide 冲突，最终改为 README 不复述该判据、只指向 command-guide，把冲突留在此处待裁。
- **归档补注（2026-08-09）**: 上述处置至今有效（README 仍不复述该判据）。本轮上游同步解除了这个冲突，且解法与本条的候选优化一致——改的是 description 而非扩张 command-guide 的适用面。上游把判据整个换了轴：不再按「改动大小」判，而按「方案要不要交给新的 implementer context 独立接手」判，于是"单文件"不再是判据的一部分，三处说法失去冲突的对象。同轮 `docs/command-guide.md` 的 create-plan 行与工作流 B 一并改写为同一判据。**验证**：`sed -n '3p' claude/commands/custom/create-plan.md` 与 `docs/command-guide.md` 的 create-plan 行、工作流 B「适用」句。

## [resolved] HARNESS-006 ask-recommend-gate 依赖一个本仓不提供、也不检查的脚本

- **Type**: bug
- **Priority**: low
- **Discovered**: 2026-08-09
- **Component**: `claude/hooks/ask-recommend-gate.js`
- **Description**: 该 hook 引用 `ghostty-tab-title.sh`，而本仓不收录它、`install.sh` 不装它、`verify.sh` 也不查它。
- **影响**: 采用者装完后这条路径取不到该脚本。gate 主体功能不受影响，但存在一条永远走不通的分支。
- **候选优化**: 要么把该脚本纳入收录范围并进安装/验证清单，要么把这条依赖从 hook 里摘掉。判定前先确认它在上游承担什么职责。
- **Resolution（2026-08-18，上游同步 commit `5fc1dfb`）**: 三项条件本轮全部满足——`claude/hooks/ghostty-tab-title.sh` 已收录；`install.sh` 的 hook 安装改为 glob 驱动（`find hooks -maxdepth 1 \( -name '*.js' -o -name '*.sh' \)`），该脚本随之进安装清单；`verify.sh` 的 symlink 检查同步 glob 化，覆盖它。**验证**：`./verify.sh | grep ghostty` 输出 `[PASS] hooks/ghostty-tab-title.sh …`。注意用 `grep ghostty-tab-title.sh verify.sh` 查覆盖会误判——glob 化后脚本里不再出现该字面名，那条 grep 在"覆盖了"与"没覆盖"两种情况下读数相同。

## [resolved] HARNESS-007 create-eval-harness 指向本仓不存在的 eval 目录

- **Type**: bug
- **Priority**: low
- **Discovered**: 2026-08-09
- **Component**: `claude/commands/custom/create-eval-harness.md`
- **Description**: 该 command 引用 `claude/hooks/eval/stop-gate/` 作为范例，但本仓未收录 `stop-gate.js` 及其 eval 目录（本轮收录的是 capability-claim / continuation-claim / prose-choice / reverse-assertion 四套）。
- **影响**: 按该 command 去找范例的读者会扑空。
- **候选优化**: 把范例改指本仓实际存在的四套之一（`reverse-assertion-gate` 的场景集最完整，18 条）。
- **Resolution（2026-08-18，commit `d91673f`）**: 由 scope 收窄解除，而非补上目录。本仓不收录判官闸的场景集（见 `docs/scope-policy.md`），`create-eval-harness.md` 的 worked example 相应改为通用形态（`<组件目录>/eval/<组件名>/`）并注明"本仓不收录判官闸的场景集"，不再点名任何具体 eval 目录，扑空的对象消失。**验证**：`grep -n "hooks/eval" claude/commands/custom/create-eval-harness.md` 无命中；`claude/hooks/eval/` 已整体移除。
- **一段插曲**: 本条曾在同日先被判为"已纳入 eval/stop-gate 故 resolved"，那份证据被随后的 scope 收窄作废（目录被移除）；归档条目已按当前事实重写。
