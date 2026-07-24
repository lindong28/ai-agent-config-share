---
name: anatomize-llm-workflow
description: 用户要把一个 LLM 调用型系统的 workflow（LLM call 图 / prompt / 生成-审核角色 / 数据依赖）提取成质量诊断地图、逐节点审查 prompt、或生成质量（文本/图片/视频审美、稳定性）只看实际产出定位不了根因时使用。只想给单个判定 prompt 建回归 eval → 用 create-eval-harness。
argument-hint: "<目标系统路径> [要追的质量问题]"
disable-model-invocation: true
origin: 2026-07-10
---

# anatomize-llm-workflow

入口 command：对一个已有的 LLM 调用型系统做设计面提取，产出质量诊断地图——让人与第三方审核 agent 能在设计面（而非只在实际产出上）定位生成质量问题的可审阅产物。

## 工作流总览

Framing（§1，贯穿全程）→ 对齐（§2）→ Extract：codex 提取（§3）→【对账 gate】→ Compose（§4）：【落盘前置 gate】→ MD 真源 + HTML 派生 → Findings（§5）→【Verify gate】→ Handoff（§6）

---

## 1. Framing：产物定性与 consumer 意识

**产物定性**：质量诊断地图，不是架构文档。选材判据只有一条：这条信息能否帮 consumer 解释用户在追的质量问题。能 → 收（prompt 全文、审核节点的判据、边上传递 / 丢失的信息、模型与采样参数、循环退出条件、观测指针——即运行时输入 / 输出的落点）；不能 → 降级或不收（部署方式、重试策略、通用工程细节）。用户选「无特定问题——全面体检」时，按通用生成质量面收材。按"完整描述系统"收材是本 command 的头号跑偏方向。

**Consumer 意识**——三类 consumer，各决定一块产物约束：

| Consumer | 用产物做什么 | 产物必须满足 |
|---|---|---|
| 人（系统 owner） | 看清结构、逐节点审 prompt、对照实际产出 | HTML 派生（交互图，点节点见 prompt 全文）；需当场给人看时起本地 server 给 http 链接（是否当场起归 §2 产物消费方式） |
| 第三方审核 agent | 在设计面上审 prompt / 结构 | MD 结构化：节点 ID、prompt 带 file:line 锚点、边标数据形状 |
| 下游修复 agent | 直接吃 findings 去改代码 | 每条 finding 带锚（节点 ID 或结构级锚）+ file:line 锚点 |

**风格与品味归属**：遵循 `~/.claude/references/deep-discuss-style.md`。品味判断（findings 的质量 lens、何为"好"）归主 session 与用户对齐，不 offload。

---

## 2. 对齐 facet（不限于此）

通用 lens："为了让 findings 聚焦用户真正在追的质量问题、产物形态匹配真实 consumer，我缺哪些只有用户能答的信息？"

| facet | 要对齐什么 | 缺失时行为 |
|---|---|---|
| 目标系统与范围 | 入口在哪？全部 LLM 路径还是某条出问题的路径？ | default 全部；§3 的 spawn 前独立 grep 发现多条独立 LLM 路径时，先问范围再 spawn |
| 追什么质量问题 | 用户当前在追的质量问题（审美不稳定 / 某类产出差 / 审核节点误判…）——materially shapes 选材与 findings 聚焦 | 无默认可 silent 填：参数与上下文均未给出时 spawn 前 AskUserQuestion（选项须含合法值「无特定问题——全面体检」）；参数已给则不重复问 |
| 产物消费方式 | 要不要当场起 server 给人看 HTML、哪个 agent 吃 MD（影响锚点粒度）；MD + HTML 双产物恒产出（§4） | default server 当场起 |

---

## 3. Extract（offload 给 codex）

编排机制照 `~/.claude/commands/custom/execute-plan.md` 的「启动 Codex implementer（harness-aware transport）」、「等待、轮询与周期汇报」（transport-aware wait）、「判定 Codex 输出并裁决」（continuation handle 与异常处置）三节——借其法，读该文件自取，不在此复述；完成判据以本节的对账 invariant 为准，该文件裁决节里基于 plan verify 证据的完成判据不适用。与 codex English、与用户中文。

**spawn 前独立 grep**：supervisor 先自行 grep 枚举 LLM-call 签名（SDK import / HTTP LLM endpoint / 本地推理调用）——无论范围是否已对齐都做。该签名清单是 §2 判定多路径的依据，也是下方对账 invariant 的独立锚，**不得放进 spawn prompt**：对账的独立性依赖两侧不同源。

spawn-prompt 的内容契约分两层：

**给 codex 的输入**（codex 隔离上下文，prompt 是唯一信息通道）：目标系统路径 + §2 对齐出的范围与质量问题 + role framing——为质量诊断地图做设计面提取，只做静态提取 + 观测指针，不实际抓取运行时输入 / 输出内容；产出是交回 supervisor 的结构化中间清单（载体格式由 spawn prompt 当场指定，codex 严格遵循），不写 `docs/llm-workflow.md`、不落任何终稿（落盘与合成归 §4 主 session）。输出规格不逐句转写——prompt 给出本文件路径与「codex 的输出规格」节名，令 codex 自读并严格遵循（只读该节，文件其余为 supervisor 侧编排、勿消费；对话保持 English，与文件为中文不冲突）；spawn 后令 codex 先回显五项字段标签作送达校验，回显缺失 / 错位即视为规格未读入，就地 inline 补发规格全文再开工。

**codex 的输出规格**：按本规格列出的字段名作为稳定标签、输出结构化清单（supervisor 对账要机器 parse 这份产出；字段标签原样进入 §4 的 MD 真源，供 HTML 派生 parse），call site 清单与节点须可交叉引用，全部带 file:line：

1. **Call site 清单**：机械枚举所有 LLM call site（SDK 调用 / HTTP LLM API / 本地推理），作为对账的 ground truth
2. **节点**：每个 call site 一个节点——节点 ID（由 call site 的稳定身份确定性派生，如 file path + 函数/符号名，跨重生成保持可对应——findings 与增量更新以它为锚）、角色（生成 / 审核 / 路由 / 抽取…，用系统自己的命名）、模型 + 采样参数（运行时决定的标「运行时决定」+ 决定点 file:line）、prompt 来源（静态模板给全文；运行时拼接给模板 + 变量来源；模板存于代码外——DB / registry / 配置——则给来源定位器 + 拼接站 file:line，全文标「不可静态取」）、观测指针（日志 / 中间文件 / DB；没有观测指针本身记为 finding 候选）
3. **边**：数据依赖——传什么形状的数据、上游产出中哪些信息被传递 / 被丢弃（无边则为空）
4. **控制流**：循环（+ 退出条件）、分叉、合并（无则为空）
5. **对账报告**：call site 清单 ↔ 节点双向对账的结果——每个 call site 都在图里、每个节点都指回 call site，不匹配项逐条列出

清单之外可追加自由观察（可疑 call site / 异常模式）——不参与对账，供 §5 参考。

**对账 invariant（产物可信底线）**：codex 按输出规格第 5 项执行双向对账并报告；漏节点的图会让 consumer 对着残缺的图下结论。但两侧都出自 codex 同一次提取、会同源漏检——supervisor 须另用 spawn 前独立 grep 的签名清单与 codex 的 call site 清单反向对账（代码 → 清单方向），并抽查 ≥1 个节点从锚点跳回代码验证。签名清单为空或显著少于 codex 清单（动态分发 / 框架内部调用 / 配置声明式调用）时，反向对账不计为独立佐证——此时 AskUserQuestion：①接受降级、加大抽查并在产物中注明（默认）②用户提供替代独立锚（运行时 trace / 已知调用点清单）重建反向对账 ③缩小范围到签名可枚举的路径再对账。对账不过 → resume codex 补漏后重对账（resume-prompt 须带对账缺口：缺失签名 / 失败抽查项 + 证据，可按需补充情境线索，不重复已传内容，输出规格仍令其自读原节（若初次已 inline 补发则无需再令自读）），不进 §4；codex 对某签名给出排除理由（死代码 / 测试 fixture / 非 LLM 调用）且 supervisor 沿锚点核实后，从对账基数剔除；同一缺口 resume ≥2 轮未收敛（无论分歧还是补漏不齐）→ 升级 AskUserQuestion，不无限 resume。

---

## 4. Compose：MD 真源 + HTML 派生

**落盘前置 gate**：目标系统所在项目的 `docs/llm-workflow.md` 已存在（此前 anatomize 过）时，先 AskUserQuestion——整份重生成覆盖 / 保留人工标注做增量更新 / 另落新路径。活文档上的人工标注是高反转成本资产，不静默覆盖；增量更新中 fresh 提取与已有人工标注冲突或使其孤立时，同样 AskUserQuestion 让用户裁定保留 / 迁移 / 丢弃，不静默解析。

**MD 真源**：落目标系统所在项目的 `docs/llm-workflow.md`（随系统演化的活文档，进项目 docs 体系）。ASCII 总览图 + 节点分节 + 边表；节点字段标签保持一致（HTML 派生要 parse）；人工标注写入每节点固定的「标注」子字段（生成时不产出该字段）——增量更新据此识别哪些内容归人。禁 Mermaid（vim / diff 不可读）。

consumer（第三方审核 agent）必须能从 MD 答出（不能答即失败）：

| 必答 | 不合格示例 |
|---|---|
| 系统有几个 call site，各自什么角色 | 只有散文描述、无节点清单 |
| 任一节点的 prompt 全文 / 拼接逻辑在哪（file:line）、用什么模型 + 采样参数（模板存于代码外则给来源定位器 + 拼接站 file:line、标「不可静态取」即为答出；模型 / 采样参数运行时决定的标「运行时决定」+ 决定点 file:line 即为答出） | "prompt 在 utils 里" |
| 任一边传什么数据、上游产出中丢了什么（无边的系统显式标「无边」即为答出） | 只画箭头不标内容 |
| 循环在哪、退出条件是什么（无循环则显式标「无循环」即为答出） | 系统有循环但图上无标注 |
| 任一节点的运行时输出去哪看（无观测指针则显式标「不可观测」即为答出） | 既无观测指针也无「不可观测」标注 |

**HTML 派生**：从 MD 生成自包含单文件（inline JS/CSS）`docs/llm-workflow.html`——交互图、点节点展开 prompt 全文与字段。给人看时起本地 server（按全局约定绑 0.0.0.0）给 http 链接。

**单真源纪律**：内容变更只改 MD、重新派生 HTML；两份各改是漂移事故。

---

## 5. Findings（同文档末节，与事实分节隔离）

事实描述（§4 主体）与判断（本节）物理分节——第三方审核 agent 应能只信前者、独立复核后者。

- **prompt 审**：逐节点按 `~/.claude/references/prompt-writing-guidelines.md`（权威）审；「不可静态取」节点先经来源定位器尝试取全文，取不到则在 findings 显式记「该节点 prompt 未审（不可静态取）」，不静默跳过
- **结构审**：以 §1 选材判据为 lens，从图、边、控制流里找能解释用户在追的质量问题的设计缺陷（e.g. 审核节点缺位的生成直出；审核节点拿生成所用的同一描述当批改答案的循环论证），并参酌 §3 的自由观察项
- 每条 finding：锚（节点 ID，或结构级锚——相关节点 ID 集合 / 边——加最近可定位的 file:line）+ 问题 + 建议方向 + severity（High / Medium / Low，按对该质量问题——全面体检时按通用生成质量面——的解释力与影响面定）——下游修复 agent 能直接吃
- 「追什么质量问题」此时应已在 §2 对齐（spawn 前已问或随参数给出）；「无特定问题——全面体检」时按通用生成质量面审、findings 按影响面排序，其余按 severity 排序聚焦

---

## 6. Verify + Handoff

- 对账 invariant 通过（§3）
- §4 必答项表自检通过
- HTML 在浏览器实际渲染过（不是只生成了文件）——HTML 恒随 handoff 交付，故必验
- 有人看 HTML 时（§2 产物消费方式）：给出 1-2 个代表性节点让用户点开看 prompt、确认锚点可跳回代码

handoff 打印：

```
质量诊断地图 (MD 真源): /abs/path/docs/llm-workflow.md
html: /abs/path/docs/llm-workflow.html （起了 server 时附 server: http://<host>:<port>）
findings: N 条（High X / Medium Y / Low Z）
```

指向审核节点的 High / Medium finding，建议下一步用 `/custom:create-eval-harness` 给该节点建回归 eval。
