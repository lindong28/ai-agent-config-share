---
name: review-agent-harness
description: 任务完成后手动触发：基于本 session 的运行时证据复盘 agent harness，定位显著影响正确性 / 效率 / 安全性的问题，归因后路由到当场修复、issue 记账或经验沉淀——运行时经验驱动 harness 持续改进的入口，也是**整段 session 复盘**的入口——已点名的单个问题走 /custom:fix-harness-from-session，不走这里（review-session-skills 是它编排的检测层，单独跑只得 findings、不含归因路由与三路处置）。静态规则栈全量审计走 /custom:review-agent-rules；存量 issue 批量清理走 /custom:resolve-issues。
argument-hint: "[关注点描述，空=全量复盘本 session]"
disable-model-invocation: true
---

# review-agent-harness

## 定位与边界

**入口与路由层**——本命令不是检测器：问题检测与修复的判定逻辑住在被编排的子命令、或该路指定的判据里，本命令只负责证据盘点、按问题类型路由、汇总处置和闭环收尾。**本仓的例外是效率一路**——它在这里没有 owner，就地自审，但仍受 route ledger 的三态结算约束。检测判据以各子命令（或该路指定的 reference）原文为准，不在此复述。

| 不做 | 去处 |
|---|---|
| 存量 issue 批量 triage 与解决 | `/custom:resolve-issues` |
| 静态规则栈全量审计（冲突 / 死引用 / over-rigor / 权限过授） | 独立跑 `/custom:review-agent-rules` |
| 产品代码问题 | 项目自己的 review / issue 流程 |
| 正向经验捕获（session 顺利、想沉淀成功模式） | 有 plan journal 时 `/custom:create-experience-from-journal`；无 journal 按 `~/.claude/references/durable-solution-carriers.md` 定载体 |

## 证据盘点与 issue 复核

按实际可得取用，先输出覆盖说明与已知缺口，再进入路由：

- 本 session 对话中的用户反馈与纠正、agent 自纠与返工、失败 / 重试证据
- 本 session 新增的 `harness-issues.md` 条目（落哪个仓见 docs-organization-protocol §4.8 写入路由），逐条复核：
  - 当时判"不就地修"的理由现在还成立吗？不成立 → 升级为本轮候选观察
  - 与本轮其它候选观察同根因吗？是 → 合并归因，不重复处置
- （可得时）skill / knowledge 使用日志、plan 的 `state.md` / `journal.md`、委派任务的派发与回收记录
- 后台增强服务探活结果（见「编排流」第 2 步 2b）——这一类不来自 session 对话，只能直接探活；本环不取值，由 2b 产出后并入汇总

存量（本 session 之前已存在的）issue 条目不进本环；结束时如有相关存量积压，提示用 `/custom:resolve-issues` 批量清。

`$ARGUMENTS` 给了关注点时以它约束盘点与路由的重点，但不跳过覆盖说明。

## 问题类型 → 路由

候选观察按其性质路由；一个候选跨多行时按主要影响归位，归因时合并。标注为**固定路**的行不经候选观察命中，每轮固定发出。「定向」指按被调命令输入契约的定向模式只审涉事规则，不展开全量审计：

| 问题类型 | 路由 |
|---|---|
| 正确性 / 行为错误 / 漏 use case / 指令模糊致走偏 | `/custom:review-session-skills` |
| token / 执行效率 / 过度 review / 停滞 | gate：效率 smell（长 wall-clock、重复 review 轮次、支撑投入持续大于目标增量）成立才展开。本仓未收录专做效率审计的子命令，这一路**就地自审**：按本行括号里那三条 smell 各给一次读数与建议，并同样进下面的 route ledger 记三态 |
| 指令没被遵循 | **先分流再处置**：规则缺失 / 诱导错误 → 按上行走 review-session-skills；规则存在但疑似没加载 / 被遮蔽 / 路由不到 → 定向 `/custom:review-agent-rules` 验证加载关系；加载路由均正常、纯属反复失守 → 按 durable-solution-carriers 升级 enforcement 载体（hook 等），走当场修或记账出口。禁止用新增重复规则掩盖"模型没遵守"——那会让本命令自己成为指令冗余的来源 |
| 指令冗余 / 不一致（静态可判） | 定向 `/custom:review-agent-rules`。**别据这一路的空产出宣称冗余面 clean**：候选观察以运行时证据为主（例外只有「证据盘点」那条新记 issue 条目的复核，与 2b 固定路），而两条规则互相重复、孤儿 reference 这类静态冗余不会让任何一轮跑错，因此进不了候选——这一路只在冗余**恰好**以运行时症状暴露时才命中 |
| 后台增强服务静默失效（记忆未捕获、通知未投递等） | **固定路，不依赖候选观察命中**——每轮由编排流第 2 步发出。本仓未收录上游那份逐服务探活清单（它绑的是维护者自己那套增强服务），所以这一路要你按自己装的服务自建清单：每条给产出信号、对照信号、失效判据。结果直接进「三路出口」：能定位到本侧配置的走当场修，根因在第三方的走记账 |
| 安全性风险 | 运行时行为类（凭据入日志、blast-radius 操作）→ `/custom:review-session-skills` 归因；静态权限过授类 → 定向 `/custom:review-agent-rules`。两类在本命令的处置顺序中置顶，但不豁免被路由子命令的用户选择 gate |

artifact 维度以 review-session-skills 的审查对象为准，引用不复述。

## 编排流

1. 证据盘点与 issue 复核，输出覆盖说明。
2. 按路由表把检测**并行委派**，每一路各 spawn 一个隔离 readonly reviewer——通道按 `~/.claude/references/delegation-policy.md` §Transport selection 判，走 in-process 时才用只读 agent type。这是初次派发就要做的选择，不是某一路失败后才换。

   **prompt 必须要求返回各路契约规定的逐条结果本身**（2a 各路即逐条 finding 含证据、影响与最小修法；2b 按其契约逐条给取值与判定），不是它们的摘要——第 4 步要按条分派，据摘要分派等于替那条 finding 的作者改决定。这不是表述偏好：各路都是只读 reviewer，其返回文本**就是**交付物——全文虽也留在该 subagent 自己的 transcript 里，但那要按 session id 反查 `subagents/` 才捞得回，而 caller 在拿到摘要时并不知道自己少了什么。**「返回文本」专指该 subagent 这一轮的最终回复正文**：`SendMessage` 的 `success` 只表示入队、不表示被谁读到，且单层委派下 `team-lead` 这个收件人不对应任何会读它的角色——用它投递逐条结果时，subagent 侧看到成功回执、caller 侧只拿到摘要，两侧都没有证伪信号。prompt 里要把这一点写给 subagent，否则它会按通用的 teammate 回报习惯投进一个没人读的收件箱。

   **2a 子命令检测路**：每个命中的子命令一个（**不带 `name`**——caller 要消费其返回内容，判据见 `~/.claude/references/delegation-policy.md`「Named delegation」），prompt 给足以下几样——该子命令文件路径（读取并按原文执行其检测流程；`disable-model-invocation` 不影响文件读取，这也是绕开其不可 Skill 调用的机制）、本 session transcript 路径（证据源；主 context 在 session 末尾常已 compaction，transcript 原文为准，subagent 可据它补充或**反驳**路由 packet）、路由 packet（候选观察含合并成员、证据缺口、关注点）。transcript 按 **session id** 定位，不按内容、不按 mtime：id 取 `$CLAUDE_CODE_SESSION_ID`（Claude Code 导出的当前 session id，本仓 `claude/bin/active-plan` 用的就是它），路径用 `ls ~/.claude/projects/*/<session-id>.jsonl` **跨 project 目录 glob**——不要自行拼"项目路径连字符化"，那条派生规则在本仓文档里自述为观测所得而非官方契约，且同一项目按子目录 cwd 启动会派生出不同的 project 目录。命中恒为 1 或 0；**取不到 id、或 0 命中，就停下如实报告，不要退回猜测**。
   两条不要用的判据及其原因：**mtime**——并发 session 会指错；**"本对话独有字符串" grep**——内容派生的判据不可判定，实测一个自认独有的串同时命中 5 个 transcript，而该判据从未规定"命中最多者胜"。同理**不要**拿"读首行 `sessionId` 字段确认"当校验：实测 222/222 的 basename 与首行 `sessionId` 恒等，所以 id 拿错时它照样通过——这一步在真正的风险上没有判别力。
   **以下取证形态只在实际要考察委派行为时用得上，但须随 prompt 下发**：委派静默挂起、返回契约没被遵守，正是主线程在 session 末尾看不见、要靠 transcript 才浮出来的一类——候选观察里没有它不等于本轮没有，按 packet 预先裁掉，subagent 撞见时手上就没有下面这段。**委派证据不在这份文件里，且分两处存**：主 transcript 不含 sidechain 记录。**无名委派**的 transcript 存于 `~/.claude/projects/*/<session-id>/subagents/`（每次委派落**两个文件**：一个 `.jsonl` 加一个 `.meta.json`，meta 字段为 `{agentType, description, toolUseId, spawnDepth}`）。**委派次数按 `.meta.json` 计**（`ls .../subagents/*.meta.json | wc -l`）——数目录里的文件总数会得到 2 倍值，而"文件数"与"委派数"这两个量在该目录下永远差一个常数因子，光看数字分不出你数的是哪一个；**具名委派**（传了 `name`）不进该目录，而是各自另存为同 project 目录下的**独立 top-level session 文件** `~/.claude/projects/*/<uuid>.jsonl`。按其行内的 `agentName`（= spawn 时传入的 name）与 `teamName`（实测形如 `session-<caller session id 前 8 位>`）与 caller 配对；**不要用时间戳**——同一 caller 可在数十秒内 spawn 多个，时间戳分不开而这两个键是精确的。配对时 grep **必须带 JSON 键锚点**（`'"teamName":"session-<前8位>'`）**并排除 caller 自己的 session 文件**：caller 的 transcript 会把含该字面量的命令与 prompt 原样记下来，裸字面量匹配因此恒中自身，在"有具名 teammate"与"一个都没有"两种情况下都返回 ≥1。两条探针都取空时，结论是**本轮无具名委派**——不是"记录缺失 / 通道故障"；后者是反向断言，要下它得另有能区分两者的证据。凡要考察委派行为，证据源须**两处都含**；只看 `subagents/` 会在被考察的委派恰好具名时得出"无痕"的错误结论（实测发生过：13 次委派中 4 次具名，`subagents/` 只有 9 份，据此判"零审计痕迹"，而那 4 份完整记录就在兄弟 session 文件里）。取证形态实测于 CLI 2.1.220、本机 76/76 份带 `teamName` 的文件同时带 `agentName`；`spawnDepth>1` 的再委派与 resume 续跑等形态未测，别据此外推。子命令的判定门在 subagent 内照原文执行；其用户选择 gate 与修复交接按其各自文内的委派条款由主线程承接，不聚合、不代答、不降配。
   **2b 增强服务探活路**（固定发出，与 2a 并行）：先枚举本机实际在跑的增强服务——枚举起点是 `~/.claude/settings.json` 的 hooks 段与 README 安装 prompt 第 3 步列出的可选集成，不要只凭印象想到几个——再对每条自建判据（产出信号 / 对照信号 / 失效判据）逐条探活，返回每条的产出信号取值、对照信号取值、按失效判据得出的判定，失效时附该条目规定的归因线索，并声明本清单当前的覆盖边界（已纳入哪些服务、已知存在但未纳入哪些）。该路无子命令，判据以本轮自建的探活清单为准；其余约束（只读、独立 context、不带 `name`）与 2a 同。
3. **route ledger（进汇总前必须结清）**：每一路（2a 的每个命中 route、固定发出的 2b、以及命中时就地自审的效率路）记三态之一——`complete`（成功、可解析，且是非缺口终态）／`gap`（可解析，但结论是证据不足、未决，或停在等用户裁决处）／`incomplete`（失败、超时、空输出、不可解析）。非 `complete` 的 route 必须用同一输入重试（2a 为路由 packet，2b 为本轮自建的探活清单）——可换 transport（如从内置 subagent 改走 Codex），但要保住只读与独立 context；重试后仍非 `complete` 的，在输出里如实标注其状态并交用户裁决。禁止省略该 route、由主线程自审顶替、或据其空产出/缺口结论宣称该面 clean——未有效完成的 route 与"审了没发现"在下游同形，这是本命令唯一的检测覆盖保证。2b 按契约必然声明清单覆盖边界，该声明本身不构成 `gap`——只有清单内条目取值缺失或判定未决才记 `gap`。只有全部 route 为 `complete`、或 `gap` 已被用户明确接受，才进入第 4 步。
4. 按各路返回的逐条结果汇总，经 `AskUserQuestion` 呈现选择（承接各子命令的用户选择 gate），逐 finding 按「三路出口」分派：用户选中修的 → `/custom:fix-harness-from-session`；值得修但本轮不修 → 记账（按既有 BINDING 自主落账）；跨 artifact 教训 → 沉淀（写入共享载体前经 `AskUserQuestion` 确认，独立项批量并为一问）。
5. 全部分派完成后按「三路出口」逐项核对无遗漏，进入收尾。

## 三路出口

每个 finding 必须落进且仅落进一路。子命令判定不成立、或该 finding 本就不经子命令判定（如 2b 探活路的产出），而证据仍可信的（典型：整体缺失能力，无归属 artifact 可指），由本命令按下表条件直接裁决落点（无归属 artifact 时通常落记账）——这里解除的只是子命令判定门，**是否执行仍走第 4 步的 `AskUserQuestion`**：

| 出口 | 条件 | 载体 |
|---|---|---|
| 当场修 | 归属 artifact 明确且本轮可修 | `/custom:fix-harness-from-session` 的 source-level edit；review-agent-rules 定向 finding 的修复按其「决策、修复与复验」（保其规则栈 regression 检查） |
| 记账 | 值得修但本轮不修 | `harness-issues.md`，按 docs-organization-protocol「issues/」（§4.8）——落哪个仓按其「harness-issues.md 的写入路由」 |
| 沉淀 | 教训跨 artifact、不归属单个文件 | 按 `~/.claude/references/durable-solution-carriers.md` 定 git-tracked 载体；memory 只留指针 |

## 关键不变量

- **fix ≠ memory**：修复落 source artifact，不绕道 memory / instinct。
- **证据范围是当前 session**：复盘历史 session 先用 `/custom:find-claude-session` 定位后 resume，不在本命令内跨 session 取证。
- **易失状态不靠记忆过 compaction**：候选观察与 route ledger 三态丢失后，"未结清"与"审了没发现"在下游同形——这属于 `~/.claude/references/long-task-protocol.md`「执行中提升」的可恢复性风险，按该节判断与处理，不在本命令内另设持久化机制。

## 输出

- 证据覆盖说明与缺口
- findings 与处置路由汇总（每项：观察 → 归因 → 走了哪路出口）
- 当场修的落点与验证结果（来自子命令的审核循环）
- 记账与沉淀清单（新增 / 升级的 issue 条目、经验载体落点）
- 未解决项与建议
- 本轮动过规则文件（CLAUDE.md / references / rules / 被规则栈 route 进的 command·skill）时，提示用户跑一次 `/custom:review-agent-rules` 全量审计。静态冗余进不了本命令的候选（见路由表该行），而它恰恰随每一次这类改动累积——不提示就没有任何一处会提起它
