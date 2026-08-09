# Delegation Policy

委派用于隔离高噪声、可独立、批量型工作，让主线程保留需求、决策与最终验收的语义连续性。

## Eligibility

- 只有任务边界明确、无需共享写入且可以独立验证时才委派。
- 短任务、单次查询、强耦合修改或需要完整语义连续性的工作不委派。
- 独立性或写入边界在执行中失效时，立即停止该子任务并交回主线程。
- 主 harness 自身工具层故障（如 hook 拦死 Read/Edit）使文件工具链退化、且本 session 内不可修复时，规格明确的批量编辑单元转为优先委派对象，而不是降级为 shell 层 patch 脚本硬扛；transport 选择见「Harness transport」。

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

有一类委派**刻意**用只读 agent type——reviewer 就是（`general-purpose-readonly` 移除写工具，是为了让它改不了自己正在评审的文件，多个 review command 明文要求用它）。这类委派不要为了落盘去换 agent type：它的返回文本就是交付物，落盘义务转由 caller 在收到报告后履行。

**报告缺失时先去捞，再决定重派**：这是上一条在 caller 侧的另一半——报告未到或不完整时，先读 prompt 里约定的那个路径把产出取回。少了这一步，产物写在磁盘上也没人去拿，caller 的默认动作仍是重派或判失败，落盘等于白做。

理由不限于某一条通道坏掉：返回文本只在一次工具结果里存在，**任何一种中断都会把它一起带走**——回传通道失败（已实测两类：具名委派见「Named delegation」，嵌套委派见「Nested delegation」）、子代理被 API 错误中途终止、caller 自己 context 压缩。文件不随这些消失。实测发生过两次：一个二级子代理完成整份调研、未写任何文件、回传失败，内容仅因偶然落到主线程的任务通知里才没蒸发；另一个后台 agent 被连接错误终止，事后核查现场才发现它已完成的工作远多于它最后一句自述。

## Harness transport

按 user-scope `Harness 适配` 表的 `子代理委派` mapping 选择 context boundary。

| Target context | Prompt requirements |
|---|---|
| 不继承 user/project rules | 传入完成任务所需的规则子集，并补充 role、task scope、输入快照、返回契约等必要上下文 |
| 已继承 user/project rules | 不重复整段规则；至少补充 task-specific role、scope、输入快照与返回契约，并按任务补充其他必要上下文 |

### Named delegation

Claude Code transport 有一条硬约束：`Agent` 工具传 `name` 会把子代理 spawn 成 in-process teammate，其最终报告**不作为工具结果回流**，且事后经 mailbox 索取两个方向都不可靠：

- **teammate → caller**：实测收件人写 `"main"` 与写正确的 `"team-lead"` 都不投递——teammate 收件箱被清空证明它读到了消息，caller 收件箱仍恒为 0。
- **caller → teammate**：`SendMessage` 返回的 `success` 只表示**入队**、不表示送达。实测同一轮发出的 2 条里，1 条 5 分 18 秒后才落入收件人 transcript、1 条从未到达。

判"无果"以**收件人 transcript** 为准（收件箱恒为 0 是上一条的观测面，不能拿来判这一条），且观察窗口不短于分钟量级。

具名委派的记录也换位置：不落主 transcript 的 sidechain，也不落 `subagents/`，而是另存为同 project 目录下的独立 session 文件（仍带 caller 关联键，可事后打捞——关联键是行内的 `agentName` 与 `teamName`，后者实测形如 `session-<caller session id 前 8 位>`）。不要因为 `subagents/` 里没有就判定无痕。

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
