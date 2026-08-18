# ADR 索引

本仓自身组件的架构决策记录（协议 §4.4）。**append-only 的承诺是「采纳时原文始终可追溯」，不是「文件字节不变」**：决策不删、编号不复用，正文可能被后续修订改写，改写前的原文由修订记录 verbatim 保存。唯一实例 ADR-004 决策 9 实测就是整行替换（见其 A-2 第 1 条）——这里按事实描述，不按理想描述。

两种变更形态，别混用：

| 形态 | 何时用 | 怎么写 |
|---|---|---|
| **Supersession** | 推翻一条已采纳决策 | 开新 ADR，标注 supersedes 哪一条并说明为什么这次不一样；被推翻的文件保持原样，只在自身状态行标注被谁 supersede |
| **修订记录（Amendment）** | 已采纳决策**内部**的补充或更正——实施期发现内部张力、原前提被证伪但结论仍成立、或原陈述与实现不符 | 在该 ADR 末尾追加 `## 修订记录` 条目，必含项**按变更类型分档**（见下）；正文对应位置加一句指向该条目的行内提示 |

必含项分档——两档都要写清授权与 gate 状态，区别在前半截：

| 变更类型 | 必含 |
|---|---|
| **决策级修订**（改变了决策内容） | 采纳时原文 verbatim + 改了什么 + 触发 + 被否备选 + 授权与评审状态 |
| **纯事实更正**（决策不变，只是原陈述与事实不符） | 改了什么 + 为何原述不成立（附可复核的证据） + 授权与评审状态。无 verbatim、无被否备选不构成条目不合格——没有决策被改，也就没有备选可否 |

第三种关系不算变更：新 ADR **refines** 旧 ADR 的某条决策——旧决策仍成立，新 ADR 只补它字面未定的语义。在新 ADR 头部写明 refines 哪一条即可，旧文件不动。

**起草期更正**：ADR 首次进入 git 之前的修改不走上述任何形态，直接改。无已采纳版本可追溯，修订记录无对象可保存；若更正面较大，可在头部留一行说明改过哪些，供同批 reviewer 对齐。

**未过 `decision-review` gate 的一律显式声明**，新 ADR 与修订记录条目同此，并在下表状态列一并标出——ADR 头部的评审放行只覆盖 gate 当时审过的文本，据 ADR 判 drift 的下游要能区分这两部分。

**给数就说清口径**：同一份 ADR 里「触碰几处 / 退役几处」很容易出现几个不同的数，且**数字相同而集合不同**（交叉核对会假性对上，比数字不同更难发现）。写清单优于写数；非给数不可时，写明这个数算的是什么、含不含零 diff 的消费者与 command 文件本身。

## 列表

> 本仓（ai-agent-config-share）是上游完整个人配置仓的精选子集，只收录**组件在本仓实际存在**的那几条 ADR（见 [scope-policy.md](../scope-policy.md)）。即便如此，条目正文仍可能指向上游独有之物——被 supersede / refine 的兄弟 ADR、上游 issue 账本的 HARNESS-\d+ 编号、或某个未收录的配套组件。决策记录保留原文不改写；按引用寻文件撞空时先按此理解。

| # | 标题 | 状态 | 组件 |
|---|---|---|---|
| [002](./002-tt-web-open-requests-fresh-generation.md) | `tt-web open` 请求新 generation，不绕过准入层读取本机额度 | accepted（2026-08-09） | `tt-web` |
| [003](./003-continuation-gate-session-tree-root.md) | continuation-claim-gate 的进程子树起点改为上溯到 claude 祖先 | 已采纳（2026-08-09） | `claude/hooks/continuation-claim-gate.js` |
| [005-judge-log](./005-judge-log-judged-text-fingerprint.md) | judge-gate 日志记录被判文本的 SHA-256 指纹（仍不记原文） | 已采纳（2026-08-10），**尚未实施**；与 005-marker 撞号，双 005 并存 | `claude/hooks/lib/judge-log.js` 与写 `judge-gate.jsonl` 的 6 道判官闸 |
| [006](./006-concurrent-egress-risk-probes.md) | 并发执行出口信誉查询，30 秒页面上限内放宽 StopForumSpam 读取预算 | accepted（2026-08-11） | `tt-web /network`、`ip-check` |
| [010](./010-web-delivery-receipt.md) | 网页交付改用「送达回执」——不再推断用户拓扑，只读本次的正面证据 | **accepted**（2026-08-12）；3 轮完整 gate + 3 轮复核；连同此前 4 轮共 7 轮，前 6 轮全否，共同结构是「用 agent 侧代理量推断用户侧可达性」 | `claude/references/remote-web-delivery.md`、`claude/CLAUDE.md` §「本地 Web Server」 |
| [011](./011-cross-harness-command-parity.md) | Claude commands 与 Codex wrapper、compaction 连续性的完整能力对齐 | accepted（2026-08-12）；supersedes ADR-004 决策 9 的 Claude-only/no-wrapper 与四键日志边界 | command wrapper farm、Codex hooks、active-plan、run-program；双侧退役 orchestrate |
| [013](./013-codex-hook-behavior-parity.md) | Codex hook 对齐采用逐 handler 的证据状态机 | accepted（2026-08-12）；refines ADR-011 决策 6 | Claude active hook inventory、Codex hooks、兼容与验证层 |
| [016](./016-page-acceptance-probe.md) | 交付页面前的声明锚定验收探针（`--expect` 报"经祖先裁剪后是否进入过视口"）+ 两处可见性/取证判据修正 | accepted（2026-08-16）；decision-review 三轮（换方案后重走完整 gate），用户 waive「无机械约束保证被调用」一项 | `claude/bin/page-acceptance`、`evidence-sufficiency.md`、`web-ui-observation.md` |
| [018](./018-reclaim-log-observed-transcript-root.md) | teammate-reclaim 日志改记「观察到的 transcript 位置」（`transcript_under_projects`）而非推断出的来源 | accepted（2026-08-16）；decision-review **四轮**——前三轮未放行（布尔 origin → 三值 origin；blocker 为「持续替未来记录断言来源」与「无机制发现语义误分类」），第四轮改为观察事实型后 7/7 成立放行 | `claude/hooks/teammate-reclaim-check.js` 日志写入端 |
| [019](./019-judge-route-per-call-carry.md) | 判官路由由调用方逐调用显式携带，模块级「最近一次」状态退役 | accepted（2026-08-17）；**refines ADR-005**（第 5 参改元数据袋，不抢它给 `judged_text_sha256` 的位置）；decision-review **三轮完整全审 + 六轮窄复核**，判据 7（错误多久发现、回退成本）**由用户显式 waive**——缺口与理由见该文件「被 waive 的不成立项」 | `claude/hooks/lib/{llm-judge,judge-log}.js`、六道写日志的判官闸、`claude/bin/gate-stats`、`claude/references/judge-gate-authoring.md`；`permission-gate` 刻意不动 |

> 2026-08-11 补：008 / 009 已补入上表（本 session 新增，故归自己的责任范围）。
>
> 2026-08-18 补（share 侧）：本仓按 [scope-policy.md](../scope-policy.md) 只保留组件在本仓存在的 10 条；上游另有 13 条（autopilot / permission-gate / run-program / wexin 等专有物的决策）不收录，其编号因此在本表中缺席。
