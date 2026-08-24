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

## [resolved] HARNESS-057 `--session` + `--cdp` 复用规则在 skill 内有 10 份副本，一次语义替换要付 9 处同步税

- Type: improvement
- Priority: medium
- Discovered: 2026-07-29，同一轮 review gate。§5 Progressive Disclosure 的 reviewer 指出这条缺陷**有当轮直接证据而非推测**：`--namespace` → `--session` 的单一语义替换被迫在 9 个站点重复施工
- Component: owner 为 `claude/skills/agent-browser/SKILL.md` 的 `### Browser Identity Continuity`；副本在同文件两处 + `references/{authentication(×2),chrome-dev-setup,commands,profiling,session-management,video-recording}.md`
- Description: "延续既有 CDP 工作流时须重复同一 `--session` 名与显式 `--cdp` endpoint" 这条规则被重述十次。其中四个 reference 顶部的前言后半句**逐字相同**，而这四处自己就链接向 owner——消费者跟得了 pointer（reference 是 SKILL.md 触发后按需加载，读到前言时 owner 已在 context 内），所以 §5 的 required-duplication 例外不成立。漏改任一处不产生任何信号。
- Impact: medium——不是行为缺陷，是维护面：下次该规则演化会再付一次同步税，且副本已被证明会漂移（本轮 batch/chain 的同类四份副本在同一次提交内漂出三种词表）。
- Candidate fix: 六处 reference 副本压成纯 pointer，删掉重述的 payload（如"本文示例默认使用 default browser；延续既有 CDP 工作流时按 [Browser Identity Continuity](../SKILL.md#browser-identity-continuity) 执行，不要裸跑"）；SKILL.md 内两处同理指向 owner。**`authentication.md` 的 source/consumer 区分段要保留**——它承载 owner 没有的信息（导入 auth 的源浏览器与消费浏览器用两个不同 `--session` 名）。每条**实际命令**里的 `--session`/`--cdp` 必须原样保留，否则示例本身变错——这条去重只针对说明性重述。
- Notes: 用户 2026-07-29 明确裁决本轮不做：它是跨 6 文件的结构重构，风险面与那轮的行为性修复不同，混进同一 commit 会让改动既含行为修正又含组织调整。

## [resolved] HARNESS-021 畸形工具调用后无恢复机会，回合直接结束、把球踢回用户

- Type: bug
- Priority: high
- Discovered: 2026-06-04，wechat-emoji 产品上线 `/custom:supervise` 期间
- Component: Claude Code 核心 retry-on-malformed 回路（解析器对畸形工具调用的归类）+ `~/.claude/hooks/stop-gate.js`
- Description: agent 发出一个语法无法解析的工具调用时，行为不一致——有时运行时返回"malformed, please retry"、agent 在**同一回合内**重试并自救；但有时该畸形输出被当成**一段普通文本最终答复**，回合直接结束、控制权回到用户，agent **完全没有自我纠正的机会**，必须等用户重新 prompt 才能恢复。痛点不在"一开始写错"，而在"写错之后没有恢复通道"。
- Root cause（基于观察，非核心代码确证）: retry-on-malformed 回路像是 Claude Code 核心行为，且**仅在解析器把输出识别为"一次（畸形的）工具调用尝试"时才触发**；当畸形语法被当成纯文本时，运行时看到的是一次正常文本补全 → 结束回合 → 不触发重试。恢复路径取决于畸形输出被如何归类，于是时灵时不灵。现有 `stop-gate.js` 接不住——它是判"是否把活甩给用户"的 LLM 判官，不检测畸形工具调用。
- 影响: high——浪费回合；迫使用户反复盯着并重新 prompt；在 supervise / 后台编排这类长流程里会卡住进展、侵蚀信任。
- 候选优化（任一即可缓解）:
  1. 扩 `stop-gate.js`（或新增 Stop / PostToolUse hook）：放行 stop 前扫本回合最后输出里**残留未执行的工具调用类语法**（字面量 `<invoke` / `<function_calls` / 孤立 `<parameter`，或"我要调用工具 X"却无对应 tool_use）→ `block` + 注入"工具调用没解析成功，请用正确格式重发"→ 重新唤起 agent 自救。轻量、成本低。
  2. Claude Code 核心层：让解析器把"像工具调用但非法"的文本判为失败的工具尝试 → 复用既有 retry 回路。
- Occurrences:
  - 2026-06-04 | session `848df61e-...`（wechat-emoji 产品上线 supervise）| 多次：agent 反复把工具调用标签写成非法形式 → 回合空转结束 → 用户需手动追问才恢复。
- Resolved（2026-06-14，resolve-issues，用户裁定保守高精度兜底 + eval）: 实现候选 1 的本地半边——扩 `stop-gate.js` 加确定性 pre-check `unparsedToolCallConcern()`（在 LLM 判官前、STOP-GATE-OK 逃生口后）：剥代码围栏 + 行内反引号后，若末条消息有**未闭合**的命名空间化工具调用块（`function_calls` 开无闭 / `invoke` 开多于闭）→ block + 注入恢复提示，给 agent 一次自救回合（`stop_hook_active` 天然限一回合、不死循环）。**保守高精度**：只认命名空间化未闭合块（合法完整块会被运行时执行、不会以文本停在此；讨论语法通常裹反引号/代码围栏或用非命名空间形式）；wire token 全程拼接构造、源文件不出现完整字面量（否则本文件被读回/自修改时有被误解析风险——这正是本 bug 的自指版本）。eval 加 2 场景：`malformed-toolcall→flag`（确定性命中）+ `toolcall-mention→ok`（反引号内同 token 的 FP 守卫，剥后不触发），`node run.mjs` 10 场景 ×5 全绿、8 既有零回归。**残余（out-of-scope）**：candidate 2（Claude Code 核心 retry-on-malformed 把畸形输出按归类时灵时不灵）属核心层、本 repo 改不动；本兜底 recall 有限（漏非命名空间 / 已闭合的畸形形态）——用户已接受「near-zero FP、limited recall」取向。无原始 848df61e 畸形 payload 可校准 recall，故用结构签名（未闭合命名空间块）而非具体形态匹配。

---

## [resolved] HARNESS-192 · commit-discipline-gate 的逃生阀 agent 触发不了，且评估错仓

**症状**：在 fork 仓（`~/research/claude-mem-proxy-patch`）提交一个纯构建产物回退时被拦，提示"本仓的 CHANGELOG.md 自称只记 user-visible changes"，并列出**另一个仓**的暂存文件（`docs/CLAUDE.md`、`ssh/authorized_keys` —— 那是 session cwd `system-config` 里我没碰过的既有暂存）。按它自己给的出口 `COMMIT_NO_USER_DOC=1` 连试四种形态全部无效：

1. `cd <repo> && git add … && COMMIT_NO_USER_DOC=1 git commit …`
2. `COMMIT_NO_USER_DOC=1; export …`（置于命令首行）
3. `COMMIT_NO_USER_DOC=1 git -C <repo> commit …`（字面前缀，单条命令）

**根因**（`~/.claude/hooks/commit-discipline-gate.js:335`）：

```js
if (String(process.env.COMMIT_NO_USER_DOC || '') === '1') return { exitCode: 0 };
```

它读的是**钩子自身进程**的环境变量。而 `VAR=1 cmd` 前缀只设置**被执行命令**的环境；PreToolUse 钩子在该命令执行之前、于另一个进程中运行，拿不到这个值。**判别性依据**（不是「试了四次都失败」——那个读数在「逃生阀不可达」与「我命令写错了」两种情况下相同）：

- `~/.claude/hooks/run-with-flags.js:156` spawn 钩子时用 `env: { ...process.env, … }`——只传**包装器自身进程**的环境，不解析命令文本。
- 本 gate 的判据是 `process.env.COMMIT_NO_USER_DOC`，即钩子进程的环境。
- 链路上没有任何一处把命令串里的 `VAR=1` 转成钩子进程的环境变量。若本断言为假，必须存在这样一处；它不存在。

**所以准确的说法不是「坏了」，而是：该逃生阀只有用户能启用**（在 `settings.json` 的 `env` 里设，或改 hook），**agent 侧不可达**——而提示文案写的恰是「本条命令前加 `COMMIT_NO_USER_DOC=1`」，那正是 agent 唯一够得着、却必然无效的形态。

**第二个缺陷（实为本次阻断的真因，且比逃生阀更严重）**：仓库解析用 `input.cwd`（session cwd），而非命令实际操作的仓（`git -C <path>` / `cd <path> &&`）。于是它拿 A 仓的 CHANGELOG 契约去卡 B 仓的提交，并把 A 仓里**别人**暂存的文件报成本次暂存。

**它是间歇性的，这让排查更难**——同一条命令的成败取决于另一个仓的索引此刻长什么样：

| 时间 | system-config 暂存集 | `onlyDocs` | 结果 |
|---|---|---|---|
| 11:13 | 只有 `docs/CLAUDE.md` | true → 豁免 | 我在 ai-agent-config 连提 11 次全部放行 |
| 11:20 | 并发 session 又暂存了 `ssh/authorized_keys` | false | 此后我在**任何仓**的 commit 全被拦 |

豁免判据是 `staged.every(f => /(docs|README\.md|CHANGELOG\.md)/i.test(f) || f.endsWith('.md'))`——一个非文档文件就足以让它失效。所以现象是「同一条命令刚才还能跑、现在不行了」，而变量在另一个仓、由另一个 session 控制。它会随对方提交而自行解除。

**建议修法**（原记，已实施）：(a) 逃生阀改为扫描命令串（与它自己的提示措辞一致），或换成一个 agent 可写的标记文件；(b) 仓库解析从命令里的 `-C` / `cd` 推导，取不到再回落 cwd。

**发现于** 2026-08-13，claude-mem fork 回退构建产物那次提交。当时的处置：不绕过，改动留在索引里未提交。

**Resolution（2026-08-13）**：按 (a)(b) 实施，但两处都比原建议更窄——(b) 的"取不到再回落 cwd"被改成**取不到就不判**：回落正是本条要消灭的错仓判定，把它留作兜底等于把 bug 保留在默认路径上。

- **逃生阀**：新增 `envDeclaredPerCommit(command, name)`（`lib/git-commit-parse.js`），在剥掉引号与 heredoc 之后按 shell 语义判，返回**逐次提交**的结果——认提交段自己的前缀赋值（含 `FOO=x VAR=1 git commit`、`env` / `/usr/bin/env` / `env -i` / `env -u NAME`）、以及前置的 `export` / 独立赋值段（`unset` 与覆盖成 `0` 会撤销它）。判整串会让一句解释该变量的 commit message 顺手打开它；不按段判会让挂在 `git status` 上的赋值放行后面的 commit；不逐次判会让 `NAME=1 git -C A commit && git -C B commit` 里 A 的声明顺手放行 B。§2 的 `COMMIT_SKIP_SKILL_CHECK` 是同一缺陷的第二份拷贝，一并换用（走整命令语义的 `envDeclared`）。
- **仓库解析**：新增 `commitCwds(command, cwd)`，返回**每个** `git commit` 各自的目录（一条命令里可以有多个提交、多个仓），下标与上面的声明数组一一对齐、由 hook 逐对判断。目录不确定时返回 null → 不判：控制流括号组里的 `cd`、条件 `cd` 后又有无条件段跑 commit、`||` 之后还有 commit、`$(...)` 子 shell 里既换目录又提交、变量/通配路径、原文自带 U+0001。反过来，目录确定的常见形态必须照判——`-m "$(build_msg)"`、`$(cd x && ./build)` 生成 message、`npm test && cd B && git commit`、`… || echo failed` 都不在不判之列（守宽了就是把最常见的提交命令整片放行）。
- **顺带修掉的既有漏拦**：`stripNonCommandText` 原本把引号内文本挖成空格，于是 `git -C "/a/b" commit` 剥成 `git -C   commit`——`-C` 把 `commit` 当成自己的值吃掉，`isCommitCommand` 判 false，**整道闸对这类命令静默失效**。改为占位 token + 旁路存内容（`stripWithQuoted` / `dequote`），路径可原样取回。这一条不在原 issue 里，是 review 期间独立发现的。

**Verification**：`npm test` 32 份全绿；新增 `commit-discipline-gate.userdoc.test.js`（16 用例）与 strip 测试补充（共 12 用例）。12 项反向变异逐一确认测试有区分力（退回任一处修复即变红，复原后全绿）。五轮对抗式外部评审（Codex read-only），共 17 条 finding，逐条修复或给出不修的理由。

**这轮最该记住的不是修法，是三次"绿得没有意义"**：先后有 3 项变异的第一版读数无效——两项的断言写成了"漏掉修复也放行"的方向（对被测守卫零区分力，因为不判与判错在那个用例上同为放行），一项的替换串里 `$` 加反引号被 `String.replace` 当成 `$\`` 特殊模式、生成语法错误使两份测试全 CRASH（那是无效读数，不是变红）。变异检验本身也需要阴性对照：**先确认变异真的应用上了，再看它变没变红**。

**两处已知限制**（有意不修，理由分别写在对应函数的 JSDoc 里）：

1. `cd /不存在; git commit` 会报出 cd 的目标而非实际目录。判它需要让纯解析层去 stat 文件系统，而它的失败方向是"不判"，与本模块既定取舍同向。
2. `false && export COMMIT_NO_USER_DOC=1; git commit` 这类**前一条注定失败**的构造里，声明会被当成生效。解析层不碰文件系统、判不了 `&&` 前一条成没成功，两侧只能选一个方向：按"没跑"处理会误拦 `cd /repo && export …; git commit` 这条现实写法（导航、声明、提交分行），按"跑了"处理只是在刻意构造里少拦一次。这个逃生口本就是给 agent 自己声明用的、没有对手，少拦一次的代价是漏掉一次文档提醒，而误拦会训练出"拦了就想办法绕过"。

**评审循环的收敛点也在这里**：最后两轮的 finding（一条 HIGH 一条 MEDIUM）恰是这个不可判定分支的两侧——修好任一侧，另一侧就会在下一轮被报上来。判据不是"还有没有 finding"，而是"新 finding 是否指向同一个已知取舍"。


---

## HARNESS-171（closed 2026-08-13） 「ok 侧 100%」与随机判官在数学上不兼容，三套 eval 因此长期红

> Resolution：candidate fix 的形态被 session `62960e0a` 实现——见红对该场景**自动定向复跑并合并计数**
> （把本条要求读者手动做的那一步自动化了）、`# known-flaky: true` 头把双峰场景摘出退出码但**照印读数**、
> 以及 `pass === 0` 下限防止 flaky 变成无到期的永久豁免。
> 实测覆盖：本条点名的三套 runner（`stop-gate` / `prose-choice-gate` / `reverse-assertion-gate`）
> 逐个核过，`known-flaky` / 复跑 / `FLAKY` 标记三项齐备（10 / 6 / 4 处命中，三套完全一致）。
> 双向对照由该 session 留证：flaky 红 → 印 `FLAKY` + ⚠️ 汇总行 + **EXIT=0**；7 条非 flaky 红 → **EXIT=1**。
> **未核实项**：本条原文要求该修法「需单独过决策评审」，我没有找到该评审的记录，故不声称它走过；
> 归档依据是行为已达成，不是流程已履行。

- Type: bug
- Priority: medium
- Discovered: 2026-08-11，把 `eval/stop-gate/run.mjs` 的双侧同阈 0.8 按 §8 拆成 ok=1.0 / flag=0.8 之后实测
- Component: `claude/references/judge-gate-authoring.md` §8 的阈值规定；`claude/hooks/eval/{stop-gate,prose-choice-gate,reverse-assertion-gate}/run.mjs` 的判定式
- Description: §8 要求 Stop 判官闸的 ok 侧 100%（误报是这类闸被关掉的主因），三个 runner 都实现成 `pass / answered >= 1.0`——即**该场景 N 次采样里一次翻转都不许有**。而判官在 temp=0 下仍有近阈方差（`lib/llm-judge.js` 自记实测 1/15）。两者相乘的结果是：
  - **提高 N 反而更容易失败**（更多机会翻），于是没有任何 N 能让它稳定绿；
  - 实测 `stop-gate` 拆阈后连跑两轮 N=6，各有 1 个 ok 场景因**单次**翻转 FAIL，且两轮翻的不是同一个（`legit-blocked-ok` / `user-reserved-action`）；对前者单独采样 10 次得 9/9 作答全 ok，证明是方差不是真误报；
  - **不是本次改动引入的**：同轮实测 `prose-choice-gate`（ok 侧早已是 1.0、10 个 ok 场景）一轮 N=6 出 **3 个 FAIL**。该套件此前就长期红。
- Impact: medium——长期红正是本仓多处记过的最坏形态（「误报会训练读者忽略这道闸」）。更具体地：这套 eval 是判断"判据改动有没有回归"的唯一仪器，而它现在**把方差与回归报成同一个样子**，读者只能靠逐行拆读数区分（本次拆了三次）。这与 HARNESS-165 / 161 同族——都是「没验成」与「验过了」在读数上同形。
- Candidate fix: 把「100%」从"N 次采样零翻转"改成对**误报率**的判定，并让单次翻转成为一个**与回归不同的可观察状态**：ok 侧出现翻转时，对该场景定向重采样（如 +10 次），可复现则判 FAIL（真误报）、不可复现则报 `FLAKY` 并打印两轮读数，不计入 allPass。这保住 §8"误报零容忍"的立法意图（真误报仍然 FAIL），同时不让方差把整套染红。**注意这是一个需要单独过决策评审的设计**，不是机械改数值——本条只记录问题与方向。
- **2026-08-11 修正**：本条初稿把观察到的每次 ok 侧翻转都归给方差，**不成立**。逐场景定向复采后分成两类——`legit-blocked-ok` 10 次采样 9/9 作答全 ok，是方差；而 `user-reserved-action` **12 次采样 2 次 flag ＝ 17%，是真误报**（另见 HARNESS-172）。所以「ok 侧 100%」并非只在制造噪声：它同时把一个被 0.8 阈值盖了很久的真误报顶了出来。本条的问题因此收窄为——**方差与真误报在这套记分下读数同形**，都表现为「某个 ok 场景 FAIL」，读者必须逐场景定向复采才分得开，而这一步没有任何东西提示他去做。
- Notes: 本条由 model-lab 侧 session 在按 §8 修 stop-gate 阈值时发现，属跨仓写入——按 docs-organization-protocol §4.8「报出，不代为 commit」，**未提交**。同批未提交改动还有 HARNESS-170、HARNESS-172。

---

**归档批次：2026-08-16 跨仓 user-scope harness issue 集中化**

以下条目分两类：(a) 从本文件所属仓的 `harness-issues.md` 中判定已闭而移入的；(b) 从其它 11 个项目的 `docs/issues/harness-issues.md` 迁入、且经核实修复已落地的。后者带 `归档来源:` 与 `核实（2026-08-16）:` 两行，核实依据是当天在本仓实跑的读数（命令与输出要点写在该行里）。

## [resolved] HARNESS-20260824-7c31 第三方豁免只发给「本回合是命令调用」的那一停，且只有 stop-gate 收得到——两处射程缺口，合计 13 次误拦

- Type: `bug`
- Priority: medium — 命中面是每一个只读分析型命令的**追问回合**，而追问正是这类任务的常态
- Discovered: 2026-08-24，session `d21afa81`（连续分析 `53e93100` 的 8 轮进展分诊）
- **Component**: `claude/hooks/lib/transcript.js`、`claude/hooks/lib/third-party-command.js`（新）、`claude/hooks/continuation-claim-gate.js`、`claude/hooks/prose-choice-gate.js`
- 前身：`HARNESS-20260823-022b`（同一机制；本条修的是它的**射程**，不是它的判别力——022b 的判别力实测有效，见下表）

**读数先摆**（13 次拦截，逐条按「当时命令名还在不在」分类）：

| 闸 | 命令活跃时误拦 | 命令名已清除时误拦 | 是否消费 022b 的机制 |
|---|---|---|---|
| `stop-gate` | **0 / 7** | **4 / 4** | 是 |
| `continuation-claim-gate` | 3 | 3 | **否（源码 grep 0 处）** |
| `prose-choice-gate` | 1 | 2 | **否（0 处）** |

第一行那个 0/7 是本条最有信息量的一格：**022b 装的东西在它够得着的回合里一次都没错**。所以这不是"判官还不够准"，是两个射程问题。

**缺口一：豁免的生命周期绑在「回合」上，而任务跨越回合。**
022b 刻意让「真人新 prompt 清除命令名」以防陈旧豁免——那个方向本身是对的。但它清得太宽：用户接着追问同一个目标（「再看一下 53e93100 的进展」）时，回合是新的、**任务不是**，交付物仍是关于同一对象的报告，豁免赖以成立的每一条前提一个字都没变。于是每次追问都丢豁免。
修法：清除时先看这条追问**还点不点名本次调用自己 args 里带的那个 id**，点名则续期。判据刻意窄到"这次调用自己带的 token"，不是"含任意 id 形状的串"——后者会拿用户随口提的一个 sha 去续期，而错误续期朝**危险侧**失败（agent 自己欠的活被算到被报告对象头上），漏续期只回落到改动前。
一处非显然的实现点：命令块常落在首个 256 KB 探测窗之外（`transcript.js` 注释记的实测距离是 1.4 MB），此时小窗口里只看得见追问、看不见它点的是谁。故带 id 的清除**不当场判定**，让窗口翻倍去把命令块捞回来；捞不到仍返回 null。**这条守卫最初没有测试握住**（变异后测试仍全绿），补了两条用 `chars` 参数缩窗的用例才握住。

**缺口二：022b 造的机制只接了 stop-gate 一个消费者。**
`thirdPartyReportCommand()` 当时是 stop-gate 的私有函数，于是同一停里的 sibling 闸各自按 prose 猜主语。`prose-choice-gate` 其实早在 2026-08-09 就写过一条针对性的负判别器（"交付物里的第三方话语"），本轮仍误拦 3 次——正是 022b 那句结论的又一次实证：**这件事判官凭 prose 推不出来，得当事实喂给它**。
修法：函数移到 `lib/third-party-command.js`，三个闸共用；新增 `thirdPartyContext(cmd, variant)` 产出注入文本，`continuation` / `prose` 两个 variant 各自针对本闸的误报形态，且**各自自带反向守卫**（agent 自己的前向承诺 / 自己的真取舍照常判）。不靠 `require('./stop-gate')`：那两个闸在顶层无条件跑 `main()`。
**stop-gate 的注入文本原样不动**——它经 42 场景标定过，搬过来等于让一批已立住的读数失效，收益只是消掉一处重复。

**验证**

- 单测 `lib/third-party-command.test.js` **17/17**；**6 条变异逐条见红**（拆续期分支 / 把判据放宽成"任意 id 形状" / 不从 args 取锚 / 拆跨窗口延迟 / 拆 continuation 反向守卫 / 未知 variant 改成静默空串）。变异实验按 sha 核过还原，两个文件逐字节复原。
- **真实误拦文本的 A/B**（从本 session transcript 里取出被拦下的原消息，不是改写）：`continuation-claim-gate` 两条消息，带命令块 → `ok`，不带 → `flag`（原缺陷在对照臂复现）。`prose-choice-gate` 带命令块 3/3 `ok`，不带 1/3 `flag`——**对照臂弱**，该输入本身处在这个闸的边界带，故这一条只支持方向、不构成强证据。
- 既有 eval：`continuation-claim-gate` 全部场景达标。`prose-choice-gate` 24 PASS / 2 FAIL / 1 known-flaky，两条 FAIL（`conjunctive-auth-no-alternative`、`one-auth-covering-a-list`）**与本改动无关，已实测**：把 HEAD 版 hook 拷到隔离目录跑同两条场景，HEAD 与当前版**同为 flag**。
- **"其余场景不受影响"是机器可核的，不是推理**：两个 gate 的 eval runner 只喂 `{last_assistant_message}`、不带 `transcript_path` → 身份判定必然 null → 注入贡献空串 → prompt 逐字节不变。已固化成一条测试。
- 新增的窗口翻倍有代价，量过：4 MB transcript 上最坏情形（追问带 id 形状、命令块不在窗内）约 **12.6 ms/次**，对照 **0.6 ms**；三个闸合计约 38 ms/停，相对判官调用的秒级可忽略。

**已知缺口（不装作没有）**：两个 gate 的 eval runner 不支持 transcript 形态的场景（stop-gate 的支持），所以**新注入路径没有进 eval 场景集**——它只有上面那组 A/B 与单测。要补需先扩两个 runner，本轮未做。

**高档对抗评审（Codex 只读，session `01a0311e`）抓到 4 HIGH + 4 MEDIUM，逐条处置**：

| # | finding | 处置 |
|---|---|---|
| F1 | 代词式追问（「那它现在怎么样了？」不重复 id）立即丢事实 | **用户已 waive**——这条代价写在他选定那个选项的描述里；朝安全侧失败（回落改动前行为） |
| F2 | 用户说「别再分析 X 了」只要提到旧 id 仍会续期，**朝危险侧失败** | **用户 waive**。分辨「继续 X」与「别再 X」是自然语言否定，CLAUDE.md「模式匹配只用于有 spec 的对象」明令归判官；爆炸半径由注入文本的反向守卫界住（agent 自己欠的活照常判）。**这是本修复已知最危险的残余** |
| F3 | 不做再锚定 ⇒ transcript 超 4 MB 后豁免永久失效 | **已修**：新增 `~/.claude/state/third-party-anchor/<session>.json`，主路径每次成功解析即刷新，命令块够不到时回退读锚点。判据与主路径同一条（只认调用自带的 token），故锚点**只延长可达性、不放宽豁免** |
| F4 | `review-session-efficiency` 声明 marker 但正文/路由表说它分析当前对话 | **已修，方向由用户裁决**：保留 frontmatter，订正 `review-session-progress` 路由表里那句自相矛盾的「它的证据范围本就是当前对话」。**残余**：该命令正文「证据范围」一节仍写「当前对话中的用户消息」，与其 frontmatter 同样张力，本轮未动 |
| F5 | 反向守卫只有子串断言，没有真判官的**拒绝侧** oracle | **未修，记为缺口**。现有 A/B 只覆盖放行侧；要覆盖拒绝侧需给两个 runner 加 transcript 支持（同上条缺口） |
| F6 | `[resolved]` 条目应同步归档 | 已修：本条即在 `archive/closed.md` |
| F7 | 注释称三闸都注册于 `SubagentStop`，实为只有 `stop-gate` | **已修**。成因值得记：把 stop-gate 的注释原样搬进共享模块，那句话在泛化后就不再成立——**搬运断言要随作用域重核** |
| F8 | 标题「12 次」与表内 13 不自洽 | 已修为 13（stop-gate 4 + sibling 9） |

**复核轮（同一 reviewer 续审）又抓到 3 HIGH + 1 MEDIUM，全部可追到上一轮那个锚点修复**（修复轮预算计数：首轮 0/8 自伤，本轮 4/4 ⇒ **1/2**，未触发停机）：

| # | finding | 处置 |
|---|---|---|
| N1 | `lastHumanPrompt` 只读固定 12 KB 且不扩窗 ⇒ 锚点回退在生产里几乎永不命中 | **已修**（改 256 KB 起步 + 扩窗）。**这条是硬伤**：`transcript.js` 自己第 21 行就记着"实测中位 16.5 KB，每一次 stop 都落在 12 KB 窗外"——我加的新函数直接踩了同一个文件里已经写下的读数。fixture 也错：把 prompt 放在末行，不是真实 Stop 的 prompt→整轮输出→Stop 排列 |
| N2 | 失配回合只返回 null、不撤锚 ⇒ 更晚回合重提旧 token 会让旧身份**复活** | **已修**：失配即 `dropAnchor`。它与已 waive 的 F2 不同族——**不需要理解自然语言否定**，代码明明已经观察到过一次失配，缺的是状态单调性 |
| N3 | 锚点实测 `0755` 目录 / `0644` 文件，泄露 session id 与目标 token | **已修** 0700/0600 + 显式 chmod。本仓 CLAUDE.md 对承载 opaque identifier 的 runtime state 明写 `0600`，transcript 根实测正是 `0700`/`0600` |
| N4 | `os.homedir()` 在调用方 try **之外**求值，而 `continuation-claim-gate` 顶层是裸 `main()`、无 catch | **已修**，`anchorFile` 自己兜住 |
| F4 残余 | `review-session-efficiency` 自身矛盾仍在 | 标为**独立** finding，已落 `HARNESS-20260824-4d15` |

**N3 的变异第一次也是存活的**：只测"新建时是 0600"抓不住 chmod——umask 022 下创建期的 mode 参数就已给出 0600/0700。承重的是**目录已存在**那一支（`mkdirSync` 的 mode 对已存在目录被忽略，而 anchor 目录会反复复用）；补了 N3b 用例才握住。**同一轮里第二次踩"守卫从未被握住"**（第一次是 `session_id` 形状守卫）。

### ⛔ 锚点（F3 的修复）已整块回退 —— 修复轮预算触发后由用户裁决

**归因**：R2 新 finding 4/5、R3 新 finding 3/3 全部追到锚点，**连续两轮过半自伤**，判据成立。停手交用户，裁决为**回退锚点、保留其余**。

**失效域枚举**（七条 finding 互不推翻，是同一个不变量「一个跨回合的持久状态文件要怎样才算拿对」的七个面）：

| 面 | finding |
|---|---|
| 读取窗口 | N1 `lastHumanPrompt` 固定 12 KB 不扩窗 —— 而同文件第 21 行早写着"实测中位 16.5 KB，每一次 stop 都落在 12 KB 窗外" |
| 状态单调性 | N2 失配不撤锚 ⇒ 旧身份可复活 |
| 创建期权限 | N3 实测 `0755`/`0644`，泄露 session id 与目标 token |
| 迁移期权限 | R3 先覆写既有宽权限 inode、再 chmod，存在瞬态泄露窗口 |
| 异常边界 | N4 `os.homedir()` 在 try 之外，而 `continuation-claim-gate` 顶层无 catch |
| 删除失败 | R2 `unlinkSync` 失败被吞，跨进程仍可复活 |
| **清除事件的身份识别** | **R1 —— 决定性的一面** |

**R1 为什么决定性**：`transcript.js` **早就记着** task notification 与真人 prompt 结构相同、会造成一次"假清除"，并明说那朝**安全侧**失败。锚点把这个**已被记录为良性**的不精确升级成了**永久破坏**。实测（近 25 份 transcript，阳性对照 9887 条 user 条目）：192 条 task-notification 型条目里 **168 条 `isMeta` 为 None、167 条带 `promptSource: 'system'`**——两道来源守卫都过得去。即**每一个后台任务完成回调都会摧毁锚点**。

**回退的取舍**：锚点只为修 F3，而 F3 朝安全侧失败（超 4 MB 退回改动前行为）。用一个"大多数时候不工作、却带着权限与状态面"的机制去换它，不划算。RC-1 的豁免续期与 RC-2 的两闸接线**在两轮复核里零 finding**，全部保留。

**重做时先读上面那张表**——它是一份现成的失效域清单，`lib/third-party-command.test.js` 的文件头也留了指针。

**新增守卫的变异对照（第二轮，4 条）**：拆锚点 token 判据 / 根本不落锚 / 拆 `session_id` 形状守卫 / 拆整条锚点回退——**全部见红**。其中形状守卫**第一次变异是存活的**：穿越落点上没有文件，拆不拆都返回 null。把穿越目标真的铺上一份可用锚点后才握住——**与 022b 在 command-name 守卫上踩的是同一个坑**（它当时也是"删掉守卫测试仍 10/10 绿"）。单测最终 **17/17**（锚点回退后；峰值曾到 28/28）；**核心 6 条变异在回退后重跑，全部仍见红**。锚点相关的 9 条变异随代码一并移除。

---

## [resolved] HARNESS-018 block-no-verify hook 在 compound 命令上误拦——把无关的 "git…commit" 文本 + 别处的 `-n` 拼成 `git commit -n`

- Type: bug
- Priority: low
- Discovered: 2026-06-07，审计「为何 commit 没走 create-commit skill」期间，一条只读 grep 被该 hook 拦下
- Component: `~/.claude/hooks/block-no-verify.js`（PreToolUse:Bash，`settings.json` 经 `run-with-flags.js` 注册）
- Description: 该 hook 对**整条 bash 命令字符串**做全局扫描：`detectGitCommand()` 只要在命令里任意位置匹配到 `git` 后跟 `commit/push/merge/...` 就判定为对应 git 子命令；`hasNoVerifyFlag()` 再在**整条命令**里找 `--no-verify` 或 `\s-n`。两步都不限定在同一个真实 git 调用范围内，于是 compound / 带引号的命令会被拼接误判。实测触发：`grep -rIn "...End git commit messages with..." . ; sed -n '1,15p' some.js`——`git commit` 来自 grep 的**引号 pattern 字符串**，`-n` 来自不相关的 `sed -n`，hook 据此判成 `git commit -n`（`--no-verify` 简写）并 exit 2 阻断。
- Root cause: 检测不 scope 到单个命令调用——(a) `findGit`/`detectGitCommand` 不识别 `git`/`commit` 处于引号字符串内（grep/echo 的 pattern），把数据当代码；(b) `hasNoVerifyFlag` 在全命令范围找 `-n`，跨越 `;`/管道边界，把另一个程序（`sed -n`/`head -n`/`tail -n`/`sort -n` 等）的 `-n` 算到 git 头上。两者叠加 → 误报。
- 影响: low——只误拦"恰好同时含 `git…commit` 字样和某处 `-n` 标志"的只读/无关命令，频率低、绕过容易（改写措辞/拆分命令即可），无数据风险。但它是**静默摩擦**：被拦的命令往往与提交无关，agent 需多花一轮重写，且会误导"这条命令在试图 bypass git hook"。
- 候选优化（任一即可缓解）:
  1. 按 shell 分隔符（`;`、`|`、`&&`、`||`、换行）切分 command，仅在**以 `git` 起头**的 segment 内同时判定子命令与 `-n`/`--no-verify`，不跨 segment。
  2. 跳过引号字符串内的匹配（识别 `'...'` / `"..."` 区段），避免把 grep/echo 的 pattern 当真实 git 调用。
  3. `-n` 简写收紧：要求 `-n` 紧跟在该 git 调用的 token 流中（git commit 之后、下一个分隔符之前），而非整条命令任意位置。
- Notes: 上游是 `block-no-verify@1.1.2` 的本地移植（见文件头注释），缺陷大概率在上游同源；修复时考虑是否回馈上游或仅本地打补丁。与本次「commit 路由」审计同源发现——参见会话记忆 `route-commits-through-create-commit-skill`。
- Resolved（2026-06-14，resolve-issues）: **检测逻辑已修+验证，接线已落、生产实测生效**。
  - **本地 port 已修（已实测正确）**: `claude/hooks/block-no-verify.js` 的 `run()` 改为按 shell segment 处理——新增 `splitSegments`（引号感知，按未引用的 `;`/`|`/`&`/换行切分，覆盖 `&&`/`||`）+ `blankQuotedContent`（把引号**内容**致空、保留引号字符与位置）。检测复用原 `detectGitCommand`/`hasNoVerifyFlag`，但每段独立判定（别段 `sed -n` 的 `-n` 不再串味）+ 引号内容致空（grep/echo pattern 里的 `git commit` 与消息内 `-n` 不再当命令/flag）；hooksPath 走 raw segment 保住 `-c "core.hooksPath=…"`。新增 `block-no-verify.test.js`（14 用例 `node --test` 全绿：7 FP 转绿 + 7 真 bypass 反向守卫仍 block）。
  - **生产未生效（关键修正——issue 原 Component 声明错）**: 实测发现 `settings.json`（id `pre:bash:block-no-verify`）注册的是**裸命令 `block-no-verify`** → 解析到 pnpm 装的 npm 包 `~/Library/pnpm/block-no-verify`（即 upstream `block-no-verify@1.1.2`），**不是**本地 port。故本轮对 port 的修复对生产 hook **零影响**——用户的误拦在生产仍复现（本写回过程中我自己的 commit 就被这个 npm hook 拦下、文案截断在"…bypassed."印证非 port）。原 issue「Component: ~/.claude/hooks/block-no-verify.js…run-with-flags 注册」与现状不符。
  - **接线已落（用户裁定我来 wire）**: `settings.json`（id `pre:bash:block-no-verify`）line 112 `"command":"block-no-verify"` → `"node ~/.claude/hooks/run-with-flags.js block-no-verify block-no-verify.js"`，对齐 permission-gate line 87 的 port 注册模式。先验 `run-with-flags.js` 的 `emitHookResult` 对 port `run()` 返回形 `{exitCode, stderr}` 完全兼容（block→writeStderr+exit2、allow→passthrough）+ require() 守卫过（port 有 module.exports/run、无模块级副作用）。改后实测**生产 hook 路径**（`run-with-flags → port`）：repro compound（`grep "...git commit..." . ; sed -n ...`）exit 0 放行、真 bypass（`git commit --no-verify`）exit 2 拦（文案为 port 的"…Fix the issue…"，证 port 在跑）；并 live 跑一条含 "git commit" 文本 + `sed -n` 的良性命令未被误拦（本 session 已重载、port 现为生产 hook）。**settings.json 该改动叠在前序未提交改动之上、未单独提交**——LIVE 已生效，留给用户连同前序一起 review/commit（per Phase C Scope 第三条 + 用户裁定）。
  - 范围 surgical：未扩检测（`echo $(git commit -n)` 命令替换漏放是预存 false-negative、非本 FP 范畴，越界用例已剔除）。上游 npm 回馈未做。

---

## [resolved] HARNESS-030 ask-recommend-gate 对 multiSelect AskUserQuestion 判据未定义，per-option 标 (推荐)/(不推荐) 仍被 flag

- Type: bug（improvement）/ rule+gate gap
- Priority: low
- Discovered: 2026-06-13，`/custom:review-skill` 审 `ask-recommend-gate.js` diff 期间——本次 review 自身发起的一个 multiSelect AskUserQuestion 被该 gate（即被审对象）实时拦下
- Component: `~/.claude/hooks/ask-recommend-gate.js` 的 judge prompt + 其判据权威源 CLAUDE.md「Surface Choices, Recommend One」（措辞为单数「recommend One / 标出推荐哪一个」，隐含 single-select 框架）
- Description: 主 session 发了个 multiSelect 问题（两个独立 toggle：R2=应用、R1=不应用），每个 option 已在 label 末尾标 (推荐)/(不推荐)、description 带比较理由——即「per-toggle 各自标了推荐倾向 + why」。gate 仍 flag，理由「未对整体组合给出显式推荐（如标出"推荐：全选 / 只选第1项"）」。改写成 single-select over 组合（只选 R2 / R2+R1 / 都不选，首项标 (推荐)）后即放行。
- Root cause: 判据（与上游 CLAUDE.md 规则）都按 single-select「标出推荐哪一个」建模，对 multiSelect 没定义合格形态。两种读法都讲得通：(a) gate over-fires——per-option (推荐)/(不推荐) 标记本就是 multiSelect 下「recommend + why」的正确形态，不该 flag；(b) gate 合理——mixed 标记下「整体该怎么勾」确实模糊，逼成 single-select-组合反而更清晰。本次实际是 (b) 的体验（改写后 UX 更清晰），但 (a) 的疑虑未消。
- 影响: low——multiSelect + per-option 标记的提问会被这条 gate 拦一次、逼 reviewer/agent 改写；多数 AskUserQuestion 是 single-select，命中面小，但每个 multiSelect 多吃一次往返。
- 候选优化（先定性 a/b、再动手；勿在未判定前硬编码豁免）:
  1. 若判 (a)：judge prompt 加 multiSelect 豁免——每个 option 自带 (推荐)/(不推荐)+理由即合格，不强求单一「组合推荐」；配 eval 加 `multiselect-per-option-marked → ok` 场景。
  2. 若判 (b)：在 CLAUDE.md 规则 / gate stderr 文案显式写明「multiSelect 也要给出推荐的勾选组合」，把当前隐含约定挑明，省得每次撞 gate 才发现。
- 关联: 判据源与 permission-gate 同属「Surface Choices」执行面；与本次 review-skill 所审 diff 同文件（judge prompt），系审查活动自身触发 gate 的 dogfooding 发现。
- Resolved（2026-06-13，resolve-issues，用户裁定 (a) gate over-fire）: `ask-recommend-gate.js` judge prompt 加 multiSelect 豁免——类 B 的 multiSelect 问题，当**每个** option 都自带显式倾向标注（label「(推荐)」/「(不推荐)」或 description 显式荐/不荐动作词）并各带理由时即合格，不再额外要求单一「整体组合推荐」（这是 multiSelect 下『recommend + why』的正确形态：逐 toggle 标荐/不荐）。flag 侧加 guard：multiSelect 若并非每个 option 都标倾向→仍 flag（防豁免变成放过裸选项的漏洞）。eval 加 2 场景：`multiselect-per-option-marked→ok`（本条 repro 正向守卫）+ `multiselect-unmarked→flag`（反向守卫）。验证：`node run.mjs` temp=0 下 9 场景 ×5 全部确定性达标（新 2 场景 + 7 既有零回归）。CLAUDE.md「Recommend One」规则文本**未改**——per-option 标记是其在 multiSelect 下的正确解读形态，规则意图未变，仅由 judge 编码该解读（与 (b)『改规则要求组合推荐』路线相对）。

---

## [resolved] HARNESS-060 teammate 回收的 hook 强制层

- Type: improvement
- Priority: medium
- Discovered: 2026-07-29，同日 teammate 回收规则修复之后。声明式层（`background-agent-monitoring.md` 的三个触发点 + idle 不得压制）已落地并过审；本条只跟踪把清点从注意力挪进 harness 的强制层
- Component: 拟新增 `claude/hooks/` 下的 teammate-reclaim 提醒 hook + `claude/settings.json` hook 接线
- Description: 目标行为——在主 agent 的回合边界提醒它「本 session 里 spawn 过、但从未 `TaskStop` 的 in-process teammate」，因为这类 teammate 不自行终止、回收只能由 caller 触发。**设计的可行性已实测确认，实现被审查否决后拆线，脚本未提交。**
  已验证的事实（原型实测，可直接复用）：(a) 台账基底用**转录**而非 `~/.claude/teams/<session>/config.json`——后者的 `members` 只在部分 session 落盘（一次记全成员、另一次目录不存在），转录里的 `Agent`/`TaskStop` tool_use 可靠；(b) 从转录重建可行且判别力真实——负例（9 个 teammate 全部回收的 session）静默，正例（同一 workflow 的前一次运行，transcript `00387f3d`）检出 **33 个未回收**、横跨 4 轮 review；(c) 全量扫描 10MB 转录约 42ms；(d) **Stop 事件确实消费 `hookSpecificOutput.additionalContext`**——但代价见下方 finding 1。
- Impact: medium——声明式层已覆盖规则本身，缺的是不依赖注意力的执行。前一次运行泄漏 33 个说明这不是偶发；但错误的实现比没有更糟（见 finding 1×6 的组合）。
- 被否实现的 9 条 finding（read-only 对抗审查，全部接受）：
  1. **HIGH** Stop 的 `additionalContext` 按契约是"继续对话"，不是无副作用通知——它会**强行多给一个回合**（本机实测证实），且未检查 `stop_hook_active` 会在名单不变时反复续轮。→ 提醒必须改挂 `UserPromptSubmit`：在用户下次输入时注入，不额外制造回合。
  2. **HIGH** 把 `tool_use`（调用尝试）当成功：spawn 失败仍永久报告该名字（误报），`TaskStop` 失败仍被记为已停（漏报）。→ 按 `tool_use.id` 关联 `tool_result`，只在确认成功后迁移状态。
  3. **HIGH** 裸名字集合无法表示实例：`spawn A → stop A → 再 spawn A` 时第二个实例被历史 `stopped` 永久遮蔽；`name@team` 取 `split("@")[0]` 会跨 team 误消；以 agent ID 成功停止的无法关联回 spawn 名。→ 以 agent ID 为主键的实例 ledger，名字/team 作辅助索引。
  4. **HIGH** 每个回合无界重扫全转录 + `name not in list` 的 O(n²) 查找 + 读取期间追加导致尾行半条 JSON 被静默跳过（半条 spawn → 漏报，半条 stop → 误报）。→ 持久化 inode + byte offset 做增量读取，扫描开始时固定文件大小，用 set 查找。
  5. **MEDIUM** resume 不恢复 in-process teammate，但从全历史重建会稳定报告已不存在的实例。→ ledger 需运行实例 epoch，`SessionStart: resume` 时清除上一 epoch 的存活状态。
  6. **MEDIUM** ledger 无状态模型（finished / idle / working / parked），**仍在执行**的 teammate 也被称作"未回收"并催"现在 TaskStop"。→ 只提醒已观察到完成/idle 的实例；状态不确定时明写"候选、状态未知、不得仅凭本提醒停止"，并保存有期限的 keep 决定。
  7. **MEDIUM** 名单截断按首次出现顺序（`names[:8]`），前八个是陈旧项时第九个真泄漏永不被点名。→ 优先展示最近 spawn / 最近转 idle 者。
  8. **MEDIUM** Stop handlers 并行执行、各自收到原始 stdin，"排在 stop-gate 之后"的顺序假设无意义。→ 需要顺序依赖就并入同一个 orchestrating handler，否则删掉该假设。
  9. **LOW** exit 0 的 stderr 主要进 debug log、不保证主 agent 或用户可见，不能当交付兜底。→ 删除该假设。
- Candidate fix: 按上 9 条重写，事件改 `UserPromptSubmit`。核心是把"历史名字集合"换成"以 agent ID 为主键、带 epoch 与状态的增量实例 ledger"——finding 2/3/5 都是同一个根因（用历史事件的名字近似当前存活实例）的不同侧面。
- Notes（回收侧的定性，别丢）: 触发本条的那次泄漏**不是 harness 缺口，是既有规则未被执行**——回收义务本有两条，第 2 条「收尾清点」要求终态时按 spawn 台账逐名对账、不依赖"记得清理"，本就覆盖被绕过的未交付实例；当时只执行了第 1 条「消费即回收」，而它挂在"收到报告"事件上，于是唯一从未交付的实例成了唯一未回收的。**不要把它误述成"规则 2 结构上覆盖不到"**——那会指向"再加一条规则"的错误对策，真实缺口是执行不能依赖注意力，也正是本条要建 hook 的理由。
- Notes: 审查未验证项：未实测 >10MB 转录的性能（1GB≈4.2s 是线性外推）、未实测本机对续轮次数是否有 block cap、未确认 `TaskStop` 是否仍产生 `shell_id` 字段。另：finding 1 与 6 单看都只是中/高，但组合起来会得到"反复劝主 agent 杀掉正在产出的 subagent"——这是拆线而非小修的直接理由。
- Resolution（2026-07-29）: 交付 `claude/hooks/teammate-reclaim-check.js` + 单测（29 例，每例锚一条 finding），接线 `UserPromptSubmit`（报告）与 `SessionStart:startup|resume`（epoch 重置），standard profile 直接生效。9 条逐条落地：事件改 UserPromptSubmit（1）；spawn/stop 均按 `tool_use.id` 关联 `tool_result`、只在确认成功后迁移状态（2）；以 spawn 的 `tool_use.id` 为实例主键，name/team/prompt 前缀作辅助索引（3）；inode + byte offset 增量读、扫描开始冻结 size、offset 只推进到最后一个完整换行（4）；epoch + resume 清除上一 epoch（5）；两层状态模型（6）；按最近活动排序并公开截断余量（7）；不做执行次序假设（8）；不用 stderr 交付（9）。
- Resolution 补充（用户追加约束「不得带来正确性风险」如何满足）: 靠**分层的言语行为**，不靠措辞缓和。idle 层（见过该实例的 `idle_notification`，idleReason=available）直接催回收——工作已结束，停它不可能丢在途产出；unknown 层建议的动作**不是**停它，而是"你是否还在等它"这个决定，该决定的错误分支（继续留用）代价为零。故两层皆无正确性风险。「反复劝」由状态去重消除：每实例每状态只报一次，状态变化才再出现一次。
- Resolution 实测（本轮实际测量，非外推）: 负例 `ad7f23a9` 12.4MB / 3957 行，10 spawn / 10 stop → 完全静默；正例 `00387f3d` 6.1MB / 2079 行 → 29 未回收（18 idle / 11 unknown）；全量扫描 25–33ms，接线后每回合实测 50ms（Node 启动主导）。
- Resolution 修正本条原先的两个数字: (a) 原记"泄漏 33 个"是被否原型按裸名字去重的结果——实测该转录只有 **29** 个确认 spawn，36 次 `Agent` 调用里 7 次以 `respawn pane failed` 失败（HARNESS-037 的形态），涉及 4 个去重后的名字，`29 + 4 = 33`。即 finding 2 的误报模式在这份正例里本就活着：旧实现会永久点名 4 个从未存在过的 teammate。(b) 性能不再是线性外推，见上。
- Resolution 顺带确认两项原记为未验证的事实: `TaskStop` 的结果**不含** `shell_id`；其 `task_id` 是不透明内部 id（既非 name 亦非 `agent_id`，故无法据此回关联 spawn），但带 `task_type: in_process_teammate`（据此排除后台 bash 任务的 TaskStop）与 `command`（prompt 前缀，用于同名多实例精确消歧）。
- Resolution 迭代路径: 每次 fire 追加一行到 `~/.claude/logs/teammate-reclaim.jsonl`（实例、层级、扫描行数），据此审计误报率并收紧判据；`TEAMMATE_RECLAIM_CHECK=0` 是不改 settings 的关停开关。仍未验证：64MB 单次增量读上限从未触及（防御性）；未实测 resume 是否复用同一 `session_id`（epoch 重置对两种情形都安全——换 id 则台账本就是新的）。

---

## [resolved] HARNESS-104 session 开场的 deferred-tools 快照会过期且无人撤回，被读成"此刻不可用"

- Type: bug
- Priority: medium
- Discovered: 2026-08-01，review-agent-harness session 收尾时用户追问遗留 teammate
- Component: Claude Code 平台侧的 deferred-tools system-reminder（非本仓 artifact）；消费侧缓解已落 `claude/references/plan-execution-principles.md`，强制层落 `claude/hooks/capability-claim-gate.js`
- Description: session 开场的 system-reminder 列出一批 "deferred tools"，明写其 "schemas are NOT loaded — calling them directly will fail with InputValidationError"，并要求先用 `ToolSearch` 加载。实测两处与事实不符：(1) `TaskStop` 在该清单里，但其完整 schema 就在本 session 的 functions 块中，直接调用 **6/6 成功**；(2) 该提示要求使用的 `ToolSearch` **本身不在工具表里**，即它规定的补救路径不可执行。合理解释是该清单是**开场快照**，工具在 session 中途被加载后无人撤回它。
- Impact: medium——它是一条会被 agent 当作权威的**否定性**能力断言，且否定断言天然不会被"用用看"证伪（相信它的人不会去调用）。本次实际后果：主 session 据此宣称无法 `TaskStop`，6 个已死 teammate 未回收，且把这个未验证理由写进了给用户的交付说明；直到用户追问才发现工具一直可用。
- Candidate fix: 平台侧——清单过期时撤回或重发；或在其中标注"能力可能在 session 中途加载，以实际调用为准"。本仓侧缓解已落地（见 Notes），不依赖平台修复。
- Notes: 消费侧缓解已写入 `claude/references/plan-execution-principles.md`「只有直接观察过外部服务层才能写'外部不可用'」那条之后——把同一举证标准扩到自身能力："工具/能力不可用"须实际调用过并贴出失败输出才成立，开场快照不构成当下证据。刻意**不**新建规则、也**不**上 hook：本仓升级惯例是约定反复失守后才上 hook（`codeagent-stdin-guard` 即如此），而这是首次；且 `teammate-reclaim-check.js` 头注已实测记录 Stop 事件的噪声代价（每回合边界触发、分不清中途让出与终态泄漏，见 HARNESS-001 / HARNESS-064）。再犯则按该惯例升级为 hook。
- Recurrence (2026-08-07): 复发，且发生在上述消费侧缓解落地之后——主 session 宣称"不能直接调 `EnterPlanMode`（它在 deferred 列表里、本会话取不到 schema）"，零调用。**触发 Notes 里那句"再犯则按该惯例升级为 hook"的既定条件**，故本次不再加第三条规则：两次失守的共同诊断都是「规则已载入却未执行」（同 HARNESS-125 的"失败不是信号不够，是已有信号没被诚实计数/执行"），继续加认知补丁只会重复它。
- Resolution (2026-08-07): 升级为 Stop hook `claude/hooks/capability-claim-gate.js`（commit `6250d8f`）。**两段式，判别器在第②段**：LLM 判官只做抽取（这段话有没有对具名工具的能力否定断言、是哪个），定生死的是转录里**有没有那次 tool_use 记录**——硬事实而非判断，故"我调了 X、报错了、改用 Y"这类最常见的合法形态由机械层放行，不靠判官分寸感。设计不变量：凡无法证明扫全（文件不可读 / 超 160MB 上限 / 承载 tool_use 的行解析不了 / append-only 末行截断）一律放行——拦"没证据就下否定断言"的闸自己不能犯同一个错。判官 prompt 的负判别器：政策性不用、转述与讨论、已带证据、非 agent 工具（CLI/库/外部服务），后者用 20 项内置工具明单而非"首字母大写"形状规则（CMake/PowerShell 同样是大写驼峰）。MCP 名匹配刻意**不对称**：canonical 断言只认精确匹配，短名才查尾段且尾段须唯一指向一个 canonical 名——两侧都归一会让 `mcp__A__search` 的调用替 `mcp__B__search` 背书。**平台侧缺陷未修、也不在本仓控制内**：本条判 resolved 指的是本仓的缓解阶梯已按其自述爬到顶（规则 → 反复失守 → hook），不是那份快照被修好了。
- Verification (2026-08-07): review-gate 高档（逻辑隐蔽度高 + 常驻 hook 复用频率高），独立 Codex reviewer、`CODEX_SANDBOX=read-only`、4 轮，终局无 CRITICAL/HIGH 遗留。首轮 4 HIGH 全部实证复核后修复，其中三条直指作者**未取证就写下的断言**：(1) 16MB 上限注称"远高于实测量级"，实测 1877 份转录 19 份超标、最大 138.5MB、本仓自有一份 41.3MB——该值会让闸在最可能出现此类断言的长 session 上永久静默失效；(2) 坏行 `continue` 被当成"不放弃整份"，实为静默 fail-closed；(3) eval 自称验到第②段，而唯一带 attempted 的场景正文自带证据、判官第①段即放行，该分支从未被执行。修法分别为流式扫描（1MB 分块 + StringDecoder + `"tool_use"` 预筛）、末行放宽 + 候选行失败即整份不可靠、以及新增与 `wrong-tool-attempted` **逐字同文只改 attempted** 的 `matched-call` 场景做同文异果对照。二轮再抓出修复自身引入的跨 server 假阴性，改为上述不对称匹配。证据：eval 13 场景 × 5 = 65/65；真实转录实跑 41.6MB→1.4s、138.5MB→2.4s，verdict 均为 `flag` 而非 `skipped`（即扫描完整跑完，旧上限下两者都会静默 skipped）。遗留并显式接受的残余：短名恰等于某 MCP 工具尾段、而同名内置工具从未被调用时会放行——方向是漏拦而非误拦，与本 gate「拿不准偏 ok」一致。
