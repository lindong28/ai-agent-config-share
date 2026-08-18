# Delegation Policy

委派用于隔离高噪声、可独立、批量型工作，让主线程保留需求、决策与最终验收的语义连续性。

## Eligibility

- 只有任务边界明确、无需共享写入且可以独立验证时才委派。
- 短任务、单次查询、强耦合修改或需要完整语义连续性的工作不委派。
- 独立性或写入边界在执行中失效时，立即停止该子任务并交回主线程。
- 主 harness 自身工具层故障（如 hook 拦死 Read/Edit）使文件工具链退化、且本 session 内不可修复时，规格明确的批量编辑单元转为优先委派对象，而不是降级为 shell 层 patch 脚本硬扛；transport 选择见「Harness transport」。

### Codex 适配性：按校验成本判

决定该不该交出去的是**两个成本的比值**，不是这件事重不重要：自己做的成本（Ci）与**校验它做完的成本**（Cv）。`Cv ≪ Ci` 就交，`Cv ≈ Ci` 就自己做——后者交出去等于付两次钱：要发现"看起来合理但错了"，你必须把它的推理链重建一遍，而那正是你想省掉的部分。优先级不是判据，它与这个比值不相关。这与上面「只有…可以独立验证时才委派」是同一个轴，但那是**门槛**、这是**比较**：能验证不等于验证便宜。

| `Cv ≪ Ci` → 交出去 | `Cv ≈ Ci` → 自己做 |
|---|---|
| 规格已固化的批量改造——编译器 / 测试就是审稿人 | 跨异质证据的综合判断——对不对只能靠重做一遍 |
| 广度枚举取证——完整性比判断重要，漏没漏看得出来 | 定验收标准、给问题定框——错了会静默判死整条路 |
| 独立第二意见 / 对抗性评审——不带本线程前提正是价值 | 交付物是**一个决定**而非一件产物 |
| 有确定性 oracle：测试过 / schema 通过 / 能编译 | 失败形态是"合理但错"的叙事，没有 oracle 报得出来 |

**Ci 本来就低时左列不适用**——不是 Cv 低就交，是 Cv **相对 Ci** 低才交。上面第二条（短任务、单次查询）正是这一格：一次三分钟的跨文件 grep 校验起来几乎不要钱，但自己做同样不要钱，比值不成立，派发与回收的开销纯亏。

**两个成本都高时最危险**：几十分钟对几天的诱惑最大，而你既没建立心智模型、又要面对同样昂贵的校验。这一格先把 Cv 压下来（写下不变量、建 oracle、先定 spec）再交，压不下来就自己做。反过来，**Cv 是可以投资降低的**——一次性建的测试 / oracle / spec 会把该类任务永久移进左列。

**Cv 是被交换出去的成本，不是被消掉的**：判了 Cv 低就得真去付它。没付那次校验的委派拿不到本节承诺的质量等价，只是把风险改成了不可见——而"我判过 Cv 低"恰恰是最容易顺手把校验一起省掉的那一步。

**判不准、或一个单元里两种形态都有时**：先拆分单元分别判（下面 2026-08-17 那条就是这么拆的——枚举归左、综合归右）；拆不动就按 `Cv ≈ Ci` 办，自己做。

**校验证据不会自发出现，必须在 prompt 里点名要。** 显式 delegation contract **不改变正确率**，只改变**可评审性**：residual-risk 与 reviewer checklist 仅在被要求时出现，known-limitations 0%→80%，changed-files 列表 7%→93%，evidence sufficiency +0.83（5 分制，p<0.0001）；代价约 +13% token、+38% wall-clock，且**模型越弱增益越大**。下面「Return contract」那几项就是这条结论的落地，不是客套。**证据强度**：arXiv 2606.17099，64 次运行、两个模型档、10 个任务——但它是 preprint（0 引用、独立研究者）、自述 pilot study，环境是一个合成的小型 TypeScript API，作者自己把结论限定在"small tasks with capable models"。方向与本节其余判据一致，但别当成已复现的定论；真正支撑"点名要证据"这条的是它与我方实测的同向（见下）。

本节判据随实测更新——新读数直接追加于此并注明出处：

- 2026-08-17：一次 Codex 主导的长调研（4.5 天 / 320 个派生 context / 15.7 亿 input token）**枚举质量高、综合失手**：28 条路线逐条阳/阴对照、诚实标注 `not_observed`，但自设了一条与任务目标互斥的验收 gate 并据此判死唯一可行路线，且决定性证据已在 context 里仍未推翻既有框架。按本节：枚举那半 Cv 低、交得对；综合那半 Cv 高、不该交。

## Parallel-write runtime isolation

- 多个写委派之间该不该串行，合法理由是两类：**任务依赖**，与**不可复制的共享资源**（LLM 配额、限流、单点账号一类，照 `concurrent-plan-isolation.md`「外部不可复制资源」协调）。两者都不在、只因共享**可复制**运行时（同一棵 worktree、同一个服务实例 / 端口 / DB）而被迫串行时，正确动作不是接受串行，而是给每个并行写委派**主动构造隔离运行时**——独立 worktree、可变状态副本、隔离服务实例，三层形态照 `concurrent-plan-isolation.md` 的三层结构隔离表；隔离由本 session 构造、用完按 `concurrent-plan-isolation.md`「完工清理」回收。前提是各委派的**文件面互不重叠**——重叠的重新划分或串行；这也是「Eligibility」那句"无需共享写入"在多写委派下的读法：隔离运行时 + 不重叠文件面 = 各自独立的写入边界。写入者登记在无 hook 的 transport 上不会自动发生——登记纪律随 prompt 下达，或指明 `concurrent-plan-isolation.md`「写入者登记」路径要它读。
- 判据与"只读可并行"同源：把**共享了什么**、而不是任务像不像，当作串行与否的判据。"上次并行出过半成品树误判"这类教训指向的是共享运行时，不再构成串行理由——但隔离救不了认错树：多树并存下的取证纪律照 `concurrent-plan-isolation.md`「代码层的块内 cwd 自证」。

## Main-thread ownership

- 主线程拥有需求解释、用户决策、跨任务取舍和最终验收。
- 子代理只处理其明确边界内、可独立验证的工作；探索、批量生成、测试或日志分析是典型场景。
- 完整测试只证明它实际运行的代码快照；后续代码变化后，重跑受影响验证。

## Return contract

子代理返回结构化摘要与可复核证据：

- 输入、来源或代码版本。
- 结果与结论。
- 未验证边界与不确定性。
- 执行过命令时，提供命令与退出状态。
- 生成了产物或日志时，提供其位置。

**产出先落盘，再回报**：凡委派会产生可复用产物（调研结论、生成的文件、分析结果），prompt 里指定一个系统临时目录之外的落盘路径，要求子代理先写文件、再返回摘要与该路径。文件才是交付物，返回文本只是它的索引。子代理没有 Write 类工具时，落盘手段在 prompt 里点明（有 `Bash` 即可用 heredoc 写）。

有一类委派**刻意**限制写入能力——reviewer 就是，为的是让它改不了自己正在评审的文件（各档实际强度差别很大，见「Reviewer isolation」；别假定所有 reviewer 都不可写）。豁免按**实际能力**判、不按角色：确实没有安全落盘路径的，才以返回文本为唯一交付物；写得动、只是不许碰被审对象的，仍要把报告写进 caller 指定、在被审对象可写边界之外的持久路径。不要为了落盘去换 agent type 或放宽 sandbox：它的返回文本就是交付物，落盘义务转由 caller 在收到报告后履行。

**报告缺失时先去捞，再决定重派**：这是上一条在 caller 侧的另一半——报告未到或不完整时，先读 prompt 里约定的那个路径把产出取回。少了这一步，产物写在磁盘上也没人去拿，caller 的默认动作仍是重派或判失败，落盘等于白做。

理由不限于某一条通道坏掉：返回文本只在一次工具结果里存在，**任何一种中断都会把它一起带走**——回传通道失败（已实测两类：具名委派见「Named delegation」，嵌套委派见「Nested delegation」）、子代理被 API 错误中途终止、caller 自己 context 压缩。文件不随这些消失。实测发生过两次：一个二级子代理完成整份调研、未写任何文件、回传失败，内容仅因偶然落到主线程的任务通知里才没蒸发；另一个后台 agent 被连接错误终止，事后核查现场才发现它已完成的工作远多于它最后一句自述。

## Harness transport

按 user-scope `Harness 适配` 表的 `子代理委派` mapping 选择 context boundary。

| Target context | Prompt requirements |
|---|---|
| 不继承 user/project rules | 传入完成任务所需的规则子集，并补充 role、task scope、输入快照、返回契约等必要上下文 |
| 已继承 user/project rules | 不重复整段规则；至少补充 task-specific role、scope、输入快照与返回契约，并按任务补充其他必要上下文 |

### Transport selection

本节定的是一次委派走哪条 transport。术语：**caller** = 发起这一跳委派、并消费其返回的 session 或 agent；**consumer** = 拥有该派发点的 command / skill；**用户 gate** = 必须由 caller 向用户取得输入或裁决的点。**本节假定 caller 是 Claude Code**；Codex caller 按 `CLAUDE.md`「Harness 适配」走内置 collaboration，别嵌套 wrapper。

**先过委派前置 gate**——与选哪条 transport 无关，两条都过不了：这个单元要用的 caller 状态，能不能冻结成稳定快照交出去？判的是交出去的那份**副本**是否字节稳定、边界完整；追加型日志（session transcript 一类）截到某个字节 / 整行边界再复制就满足，源在不在写无关。冻不住就自己在主线程做，或拆成多段——caller 每取得一次新状态就冻结一次再派下一单元。用户 gate 同理（别默认被委派方能问用户），把单元切在 gate 上。两条 transport 都不继承 caller 的**对话状态**；其它自动注入的东西——已继承的 user/project rules、agent definition——按上面的 context boundary 表判。

过了才选 transport。两条的能力面：

| transport | 结果回流 | 写入约束 | 网络 | 计量池 |
|---|---|---|---|---|
| Claude Code in-process（`Agent` 工具） | 不传 `name` 时随工具结果回流；传了就不回流（见「Named delegation」） | 以所选 agent type 的实际 catalog 为准（`tools:` 或派发时查），查不到即视为不具备 | 同上 | 当前 Claude Code caller 的认证池 |
| Codex（`codeagent-wrapper --backend codex`） | 前台从命令结果返回；`run_in_background` 由**进程退出**触发回调——静默挂起不回调（见 `background-agent-monitoring.md`「为什么需要主动巡检」），退出也不等于交回了最终报告（同文件「中途终止」） | `read-only` 禁写全机；`workspace-write` 仅允许 workspace 内写入——精确边界见 `codeagent-wrapper --help` | `read-only` 禁网；`workspace-write` 通 | Codex CLI 当前认证的独立池 |

**逐个委派单元判定**，不按整条 command 判：

1. **初始化候选集**——consumer 有权威 transport 规定的，用它**收窄**候选集（不是跳过后面的筛选）；没有就两条都在。consumer 只点名 agent type 不算规定 transport，那是 in-process 时选谁。
2. **能力筛选**（所有候选都要过）——这个单元要什么：活服务 / 内网探活、跑命令、写文件、某个 MCP、对被审对象的物理拒写？Claude 侧对照所选 agent type 的实际 catalog；Codex 侧 `--help` 只声明 sandbox / 写入 / 网络，**工具与 MCP 面没有可查的 catalog**——需要特定工具或 MCP 时，要么由 consumer 显式验证过再声明，要么就把 Codex 剔除，别拿"查不到"当已具备。两种"只读"别混：要**全机零写入**只有 `read-only`，而它禁网；只要**改不了被审对象**，`workspace-write` 也行，但条件是被审对象的 realpath **不在** workspace 可写根之下——"workdir 不是那个对象"不够（`/repo` 作 workdir 时 `/repo/a.md` 仍可写），派发前比一次两棵路径树。活服务还有一条出路：caller 预先测好写进共享快照，该单元就不再需要网络。筛完：零候选 → 报告不可委派，别硬派；剩一个 → 就它；两个都在 → 进第 3 步。
3. **Codex 优先默认**——两条 transport 都通过能力筛选时，规格可固化的数据分析或代码实现默认优先 Codex，即使只有单个工作单元；caller 主线程保留决策、品味工件与用户 gate。**这条默认不得越过第 2 步**：单元依赖 Codex 未验证具备的特定 MCP 时仍剔除 Codex、保留 Claude；caller 也可先冻结该 MCP 的输入，再把不再依赖它的纯分析单元交给 Codex。
4. **规模与形态**——不属于上条默认时，fan-out（多个并行、互不依赖的单元）→ Codex；上下文大、预计长跑、或失败后要能独立续跑 → Codex；都不满足的单个单元 → in-process。**fan-out 判不准就按 fan-out 办**。

fan-out 默认走 Codex 是为了把批量工作与 caller 的认证池隔离：额度在中途耗尽时，在途单元成批失败，而恢复要从同一个已耗尽的池子里取——堵死恢复路径的正是造成失败的那件事。**"两个池子相互独立"是实测观察，没有接口契约背书**（`--help` 不声明计量归属）；认证形态（订阅 / API key / 云）变了要重测，别把它外推成"Codex 普遍更便宜"。中途终止的处置见 `background-agent-monitoring.md`「中途终止」——那是 wrapper 的契约，不适用于 in-process Agent。

**为省额度而调整 transport 之前，先数清额度实际花在哪。** 直觉指向"我起了多少个 subagent"，而大头常是**会再派生会话的编排**——一个校准 / 评测批次里每一跑又各自 fan-out 一层，一批就吃掉几十个 context，且这类批次往往要重跑多轮。这两个数可以差一个数量级，按错的那个优化等于没优化。要数的是**派生出去的 context 总数**，不是自己直接起的那一层。

**换 harness 跑验证会收窄结论的证明范围，这一点必须随结论写明。** 在 Codex 上校准一条 Claude Code slash command，通过只说明**判据能被正确施加、推理链落在判据档上**——该性质不依赖 harness。它**不**证明该 artifact 在原 harness 里的调用、参数解析与自动路由时机正确。两类失效形状不同：判据错让结论错，集成错让它根本不触发或丢参数；后者只有在原 harness 里真跑一次才暴露。省下的额度是真的，覆盖面的收窄也是真的，别让前者把后者盖住。

### Reviewer isolation

reviewer 要"改不了自己正在评审的文件"，三档保证强度不同，别把强档的安到弱档头上：

- `general-purpose`——没有可读 agent 定义，隔离强度只能以派发时的实际 catalog 判定；未核实前不得声称它移除了写工具。
- `general-purpose-readonly`——`tools:` 已核实移除 Edit/Write，但 Bash 仍在，所以仍靠行为契约。
- Codex sandbox——唯一的物理边界，适用条件见上面第 2 步。

Codex caller 走原生 collaboration 时 `CODEX_SANDBOX` 不生效，那条路的隔离来源本文件未核实过，别默认它等价于物理只读。

### Named delegation

Claude Code transport 有一条硬约束：`Agent` 工具传 `name` 会把子代理 spawn 成 in-process teammate，其最终报告**不作为工具结果回流**，且事后经 mailbox 索取两个方向都不可靠：

- **teammate → caller**：实测收件人写 `"main"` 与写正确的 `"team-lead"` 都不投递——teammate 收件箱被清空证明它读到了消息，caller 收件箱仍恒为 0。
- **caller → teammate**：`SendMessage` 返回的 `success` 只表示**入队**、不表示送达。实测同一轮发出的 2 条里，1 条 5 分 18 秒后才落入收件人 transcript、1 条从未到达。

判"无果"以**收件人 transcript** 为准（收件箱恒为 0 是上一条的观测面，不能拿来判这一条），且观察窗口不短于分钟量级。

具名委派的记录也换位置：不落主 transcript 的 sidechain，也不落 `subagents/`，而是另存为同 project 目录下的独立 session 文件（仍带 caller 关联键，可事后打捞；配对键与实测边界见 `~/.claude/commands/custom/review-agent-harness.md` 「编排流」第 2 步里以「**委派证据不在这份文件里，且分两处存**」开头的那段）。不要因为 `subagents/` 里没有就判定无痕。

判据是**caller 是否依赖这次委派的任何返回内容**——依赖就不传 `name`，与它要跑几轮无关。上面「Return contract」要求每个子代理都返回结构化摘要，所以默认答案是"依赖"；多轮 reviewer / implementer 同样要 caller 消费其 findings，"需要多轮"不构成传 `name` 的理由。`name` 只留给 caller **不消费其产出**、纯粹要可寻址长驻的实例。已经传了才发现要不到报告时：催一次无果即按「绕过即回收」回收；**重派前先按上段的关联键从它的独立 session 文件里捞回已完成的产出**——它多半已经把活干完了，只是报告没回流，直接重派等于整份工作重做。捞不回再去掉 `name` 重派，不反复催。

### Codex transport

Codex transport（`codeagent-wrapper --backend codex`、Codex 原生 collaboration 委派等——凡命令最终由 codex 二进制执行的通道）另有一条执行层约束：其内置 exec policy 会拒绝执行 `rm` 的 **force 形态**（`rm -f` / `rm -rf`）。已实测确认的边界，只到这几条为止：

| 实测命令 | 结果 |
|---|---|
| `rm -f a.txt` | 拒绝 |
| `rm b.txt`（裸 `rm`，无任何 flag） | 退出 0，**不拦** |
| 含 `rm -rf -- "$SCRATCH"` 的复合命令（自带路径前缀白名单校验） | 整条拒绝，白名单不解除拦截 |

全表的实验条件：三次观察**都发生在 `--dangerously-bypass-approvals-and-sandbox` 区间内**——即该 policy 不随沙箱档位放松，换审批模式重发无效。

超出这几行的推断都还没有证据：**别把它读成"Codex 不能删文件"**（那会让委派方无谓地绕开正常清理），也别据此断言拦截的具体匹配粒度或触发机制——白名单那一行只说明白名单不解除拦截，不足以支撑"任何含 `rm` 的复合命令一律整体拒绝"这类普遍规则。另外注意上表只测了两端：裸 `rm` 与 `-f` / `-rf`。带其它 flag 的形态（`rm -r`、`rm -i` 等）**一次都没测过，别往任何一端归类**——它们既没有被观察为放行，也没有被观察为拒绝。因此：

- **委派 prompt 里须写明该限制并禁用 force 形态**；能用 `unlink` 或裸 `rm` 表达的就这么写，其余临时产物留系统临时目录自然回收。这条约束的是 prompt 内容，不是写在本文件里就算数——本文件不会被自动继承（被委派方**能**读，见「Nested delegation」那条更正），所以要么在 prompt 里写明，要么指明本节路径要它去读；两者都不做，它只会在执行中现场撞、现场归因、现场改写。
- **被 policy 拒绝时改写成等价形态，不原样重试**——这一条随 prompt 下达给被委派方。**委派方（caller）自己另有一条：不得换审批模式重发**——按上表实验条件，换档位不解除该拦截；而且只有 caller 握着重新派发的 flag，被委派方根本没有这个杠杆，所以这条 duty 只能落在 caller 身上。
- 该限制有官方豁免机制、不是硬编码（实测确认），所以撞上它不等于死路；但豁免会削弱共享宿主 / 并发 session 的 blast-radius 保护，本文件不给配方、也不视其为常规出路。**确需放行时先向用户说明这层代价并取得授权，由用户决定开不开、何时撤回；agent 不自行开启。**

Codex transport 也是「Eligibility」中工具层故障场景的委派目标：hook 强制层只在 Claude Code 侧生效（见 user-scope `Harness 适配` 表），故本侧 hook 拦死 Read/Edit 时 Codex 的文件工具链仍完好；底层文件系统本身故障则不在此列。

#### prompt 传入形态

**用 wrapper 自带的 `-`（从 stdin 读任务）配 quoted heredoc，不要把 prompt 写成命令行参数。** `--help` 自述 `codeagent-wrapper - [workdir]` 与 `codeagent-wrapper resume <session_id> - [workdir]`，本仓既有调用（`execute-plan` / `test-ux` / `execute-ux-contract` / `multi-backend`）全是这个形态：

```sh
CODEX_SANDBOX=read-only codeagent-wrapper --backend codex - <workdir> <<'EOF'
<prompt>
EOF
```

走 `-` 时 prompt 根本不经 argv，下面两类失败都不存在；也不需要 `</dev/null`（stdin 已经是 prompt，读完即 EOF）。**prompt-as-arg 只在确有理由时用**，那时才按 `background-agent-monitoring.md`「派发前自限（每次后台 codex/agent 派发都套）」补 `</dev/null`。

写成命令行参数时会踩的两件事（实测于 zsh，两者独立；下表的 `f` 是一个打印 `$#` 与各参数的一行函数，照跑即可复现）：

| 现象 | 实测 | 后果 |
|---|---|---|
| prompt 里的反引号 / `$()` | 在**调用方 shell** 里被**执行**——权限是调用方的，与下面给被委派方选的沙箱档位完全无关 | prompt 内容被求值结果替换；命令真的在本机跑了。双引号内的替换结果**不再分词**（`f "a \`echo A B C\` d" /w` → `argc=2`），所以它污染内容但不移动参数 |
| prompt 里的字面 `"` | 提前闭合引号（`f "read the "big file" now" /w` → `argc=3`） | 后续位置参数整体错位；实测一次 workdir 因此变成 `-C 0`，wrapper 照常启动 codex，最终报一个与"目录真的不存在"不可区分的错误 |

评审 prompt 里这两种字符都是常态（代码 span 用反引号、引用原文用双引号），所以"这份 prompt 没有反引号所以安全"是错的判断——真正移动参数的是双引号。

**别把 prompt 存进 shell 变量再传**（`P=$(cat <<'EOF' … EOF)` 然后 `"$P"`）：本 harness 的 shell 状态**不跨工具调用**，而复核轮与首轮之间必然隔了若干轮，`$P` 到那时是空串——空串仍占一个位置参数，于是 workdir 解析正常、wrapper 照常启动、codex 收到一个空任务并"没发现新问题"，与"复核通过"逐字同形。

本节是这条契约的单一 owner，各 skill 的调用示例照此写；与 `--help` 不一致时以 `--help` 为准并回来修本节。

#### 沙箱档位

`CODEX_SANDBOX` 有三个取值（`read-only` / `workspace-write` / 不设），但结果有四种——"不设"那一档还要看 `CODEX_REQUIRE_APPROVAL`。选错档的失败形态各不相同，且都不像"档位选错了"：

| 档位 | 本机文件写 | 网络 / ssh | 适用 |
|---|---|---|---|
| `read-only` | 拒 | 拒 | reviewer 及其它只读委派 |
| `workspace-write` | 限 workspace 内 | 通 | 需要联网的委派，典型是远端诊断 |
| 未设 + `CODEX_REQUIRE_APPROVAL` 为假（默认） | 全盘 | 通 | artifact 传 `--dangerously-bypass-approvals-and-sandbox` |
| 未设 + `CODEX_REQUIRE_APPROVAL=true` | 看 config | 看 config | artifact **一个 sandbox flag 都不传**，回落到 codex 自己的 `config.toml`——所以这一格没有固定答案，取决于那台机器怎么配 |

flag 语义的单一来源是 `codeagent-wrapper --help`（artifact 自述），本节只承载**选哪一档、为什么**与实测边界；两者不一致时以 `--help` 为准并回来修本节。

实测边界（2026-08-08，同 prompt 同 workdir 只变档位，写入面逐目标探测并用独立 `ls` 核实文件是否真落地）：

- **`read-only` 也禁网**，且拒绝落在 `connect()`、在认证之前：ssh 报 `Operation not permitted` 而不是任何认证形状的错误。照错误文本去查 key / 网络会全程走错方向——远端工作选错这一档就是这个症状。
- **`workspace-write` 默认远比"workspace 内"宽**，wrapper 把收口条件全部钉成 flag（不读 config，好让该档在每台机器上含义相同）：`/tmp` 与 `$TMPDIR` **默认就是可写根**、无需任何配置；宿主已有的 `writable_roots` 不会被只覆盖 `network_access` 的 `-c` 清掉（实测某机器上它是 `["/tmp","/var/log","~/.codex"]`，全程有效）；`allow` 规则能让匹配的命令**整个跑到沙箱外**，故一并 `--ignore-rules`——注意它关掉的是**整份 user/project `.rules`**（优先级 forbidden > prompt > allow），保护性的 `forbidden` 也一起没了。这个取舍的依据是两种损害的有界性不同：`allow` 逃逸无界（命令整个离开沙箱，该档形同虚设），而 `forbidden` 失效后命令仍被关在 workspace 里。**别指望宿主写的 forbidden 在这一档兜底**；但作用域也只到这里——admin / managed requirements 由别处强制，仍然生效。
- **别把 `CODEX_HOME` 可写读成隐式豁免**。`~/.codex` 常是指向某个仓的 symlink（本机指向 `ai-agent-config/codex`）；当 workdir 恰好是那个仓时它本来就在 workspace 内，写入成功证明不了任何额外的根。判定这类"某目录为什么可写"之前，先看它 realpath 之后落在哪、与本次 workdir 什么关系——只测"写成功了"在两种成因下输出相同。
- **`workspace-write` 档内起不了嵌套 `codeagent-wrapper`**：artifact 在解析任务前就用 `os.TempDir()` 建日志，而两个临时目录排除项正好拒掉它，于是启动期即 `operation not permitted`。这是已知取舍不是缺陷——远端诊断委派按叶子节点用；失败是响的、发生在启动期，不会静默跑成半截。需要嵌套就别用这一档。
- **`workspace-write` 限的是写、不是读**：`~/.ssh/config` 在该档下可读。它压的是本机改动面，不是读取面，更不是外泄面。`read-only` 更是连写带网一起拒，读同样放开。
- **上表任何一行都不约束 ssh 过去的主机**。`read-only` 是本机连接就建不起来，谈不上远端。`workspace-write` 与"未设 + 默认"这两行连得上，远端一侧不受任何本机档位约束。"未设 + `CODEX_REQUIRE_APPROVAL=true`"那一行连不连得上要看 config，但两种结果都不改变本条：连不上就没有远端，连得上就同样没有 enforcement。OS 沙箱不跟随 ssh 连接；openai/codex#32919 独立报告了同一个不可组合性（"本地拒绝不该显得权威，如果相邻的一次调用能在别处照做同类操作"）。远端的 blast radius 只能靠该 ssh 账号自身权限与 prompt 里的只读纪律收口——**这条得随 prompt 下达**：本文件不会被自动继承（它**能**读，见「Nested delegation」那条更正），所以要么在 prompt 里写明，要么指明本节路径要它去读；两者都不做就等于没下达。
- **档位只对 `--backend codex` 生效**，其余 backend 根本不读它；shim 现在会直接拒绝这种组合，因为"跑完了、但要的沙箱从未施加"在调用点上完全看不出来。同理，shim 在用该档前会问 artifact `--help` 确认它认识这个档位——旧 artifact 遇到不认识的值会 fail-open 成完全 bypass，而版本号不变、装机器无从发现。

**注意这里的默认方向是反的**：不设 `CODEX_SANDBOX`、且 `CODEX_REQUIRE_APPROVAL` 保持默认，就落到无沙箱——最宽的那一档**由两个变量同时保持默认选中、不需要任何人授权**；而本文件另一处远比它窄的放松（force-`rm` 豁免）却要求先向用户说明代价并取得授权。收紧档位不需要授权、放开也不需要，这个不对称是现状而非设计——委派方自己判，别把"没设"读成"已经想过了"。

绕过 wrapper 直接调 `codex exec` 去拿某个档位是有代价的：wrapper 负责发射 `SESSION_ID`，绕过它意味着中途被打死时没有 resume handle，只能去 `~/.codex/sessions/**/rollout-*.jsonl` 里按内容 grep 捞回。而中途被传输层打死正是长诊断会话的常见结局。

### Nested delegation

一级子代理指主线程直接委派出的那层，二级子代理指一级自己再 spawn 出的那层；对二级而言，一级就是本文件其余各处所说的 caller。实测于 2026-08-07、Claude Code 内置 `Agent` 工具：

| 观察 | 后果 |
|---|---|
| 二级的 tool catalog 不含任何 `mcp__*` 工具（实测只有 Read / Bash / WebFetch / SendMessage），而主线程与一级都能正常调用 | 它无法遵守"用 free-search / exa 检索"这类指令，会自行改用 WebFetch 等替代路径，而这个降级一级看不见 |
| 二级不知道一级的可寻址名，只能猜 agent type 名（如 `general-purpose`）；已观察到的形态里回传一律失败 | 其最终报告落到主线程的任务通知，而非落到一级 |

由此产生两条 prompt 要求，各自落在不同的一跳：

- **写给二级的 prompt**：指定了特定 MCP 工具时，附一句"该工具不在你的 catalog 里就停下并说明，不要自行换等价物"。补救动作不能让它自己去问用户——上表第一行说明它没有 `AskUserQuestion`（Codex 侧该工具本身即 MCP）。留痕方式随它的写盘能力分两种：**有写盘能力**的二级写进约定的产出文件（无 `Write` 类工具但有 `Bash` 时用 heredoc）；**只读类型**的二级只在返回摘要里说明，不得绕道 `Bash` 写盘——那是它的类型契约明令禁止的，落盘义务按「Return contract」归 caller。禁的是静默降级而非降级本身：换不换等价物由人裁决，二级只负责停下留痕，逐级上报。
- **写给一级的 prompt**：一级若可能自己再 spawn，须在其 prompt 里指明本节路径要求它读取（它有 `Read`，"读不到本文件"指的是不自动继承、不是无法读），并把落盘路径与「Return contract」的捞回义务一并向下透传，让二级产出落在主线程已知的路径上、且一级知道要去取。这条与「Codex transport」共用同一层机制：约束落在写 prompt 的那一跳，不因写在本文件里就自动生效——但补救级别按被委派方能否读到源文件分别取舍，不是一律内联。

**未测边界，别外推**：

- **上表第一行的归因未做对照**：观察到的"无 `mcp__*` 工具"同样可能由 **agent type** 而非嵌套层级决定。反证已出现——一个一级的 `general-purpose-readonly` 代理其 catalog 同样只有 Read / Bash / WebFetch / SendMessage；而一级的 `general-purpose` 代理能正常调用 `free-search` / `exa`。两个变量（type、层级）在已有观察里没有分开，**在做过同 type 跨层级的对照之前，不要把它当成嵌套的属性**。下面那条 prompt 要求不受影响：它只需要"工具可能缺席"为真，不依赖缺席的原因。
- catalog 缺失是设计如此还是缺陷，未查。
- "一级在 prompt 里主动告知自身可寻址名后二级能否回传"这一形态未测，故上表第二行只陈述已观察到的形态、不写成必然——若名字已知仍失败，机制就不是"不知道名字"而是「Named delegation」记的 mailbox 投递不可靠，归因搞错会误导后续诊断。
- 三级及更深、以及 Codex transport 下的嵌套，一次都没测过。

顺带一条同期实测：MCP server 的生效集合由多来源合并（user 的 `~/.claude.json` + 各插件的 `.mcp.json` + project 级 `.mcp.json`），任何单一文件都不权威。具体的绊脚石是 `~/.claude/mcp-configs/mcp-servers.json`——它是插件带的模板清单、**不生效**，却含 26 个与生效集合同名近名的条目和占位符凭据。只查它会得出两种错误结论："某 server 未配置"（实际配在别处），以及"凭据是占位符所以这条路径坏了"（实际生效的那份可能走远程 URL、根本不需要本地凭据）。
