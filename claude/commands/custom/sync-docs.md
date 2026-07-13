---
argument-hint: [<改了什么> | 空=审查全部文档] [max-principle-per-subagent=5]
description: 项目文档维护的单入口——说明改了什么就补该改动的文档，不说明就审查并修全部现有文档；docs/ 未初始化时先建结构。覆盖 docs/ + 根 README/CHANGELOG，与代码和质量标尺对齐。
disable-model-invocation: true
---

# sync-docs

单入口维护项目文档，遵循 `~/.claude/references/docs-organization-protocol.md`。审查范围 = `docs/` 下文档 + 根 `README.md` / `CHANGELOG.md`。两种情形汇入同一条审查循环（§2）收敛：

```
入参有「改了什么」? ──是──▶ §1 seed（对齐取舍 → 起草初稿）──────────┐
                    └─否──▶（docs/ 未初始化则先 §1 建构）──────────▶ ├─▶ §2 审查循环
                                                                      │    审查 → 决策 → 落地
                                                                      │      ├ 有编辑 ─▶ 回 §2.1 重跑
                                                                      │      └ 无编辑 ─▶ 收敛
```

| 情形 | 入参 | 路径 |
|---|---|---|
| 补某次改动的文档 | 给了「改了什么」 | §1 seed（对齐 → 起草）→ §2 审查循环 |
| 审查全部文档 | 无 | 直接进 §2 审查循环（docs/ 未初始化则先 §1 建构） |

**不变量**：seed 初稿不是终点——两种情形落地前都必须过 §2 审查循环。缺陷（"文档没回答用户关心的问题"、audience 错放）在 §2 被 catch，seed 阶段不负责质量。

## 参数

| 参数 | 必需 | 默认 | 说明 |
|---|---|---|---|
| 改了什么 | ✗ | 空 | 自然语言描述本次代码/功能改动。给出→§1 seed；空→跳过 §1（docs/ 未初始化则先 §1 建构）|
| max-principle-per-subagent | ✗ | 5 | 每个 review subagent 至多分到的原则数；越小每条原则获得越多注意力 |

展示与提问风格全程遵循 `~/.claude/references/deep-discuss-style.md`——review subagent 的报告与主 session 的提问都适用。

---

## 1. Seed（「补某次改动」情形，及 docs/ 未初始化时的建构；其余情形跳过本节）

先对齐、后起草：只能用户回答的取舍在起草前解决——带着未对齐的取舍强行起草，初稿可能违背用户偏好，导致无意义的返工。

docs/ 未初始化的 bootstrap（含无「改了什么」时）：以 repo 现状为 context 走本节建立结构（协议 §6「初始化与更新 docs/」），对齐步照常。

1. **侦察**：从「改了什么」+ docs/ 现状确定受影响的文档类型；对每个类型按 `doc-updater` agent 定义中的对齐 lens 表识别取舍点。
2. **对齐**：存在只能用户回答的取舍（组织方式、粒度、叙事角度等）时，用 `AskUserQuestion` 问用户；剩余决策都能被合理 default 时即对齐充分，无取舍则直接起草。
3. **起草**：为每个受影响的文档类型并行 spawn `doc-updater`（输入契约见其 agent 定义），每实例传入：
   - `type` = 该实例负责的文档类型——并行分工无法从 repo 反推；
   - `context` = 「改了什么」描述 + 对齐结论——caller 独有上下文，不在 repo 里、doc-updater 无从自读；
   - `interactive` = `false`——取舍已前置对齐，起草不现场发问；起草中遇未预见的新取舍，写入返回报告、由 §2.2 统一呈现。

   repo 状态由 doc-updater 自读，主 session 不 restate。

按文档类型起草的特例：

| 文档类型 | seed 处理 | 条件 / 备注 |
|---|---|---|
| 各文档类型 | 按协议 §4「各文档的读写规则」建议格式起草 | — |
| contracts/ | 只初始化目录结构 | 内容由协议 §4.6「contracts/」的执行路径建立（plan 工作流主路径 / 专用 command fallback），seed 不起草 |
| data/ | 按项目需要可选 | 协议 §4.13「data/」 |
| README + operations | 服务有增删改 / 部署方式变化时联动更新 | 按 `~/.claude/references/service-operations-protocol.md` 检查生命周期脚本齐备；缺失则提示补脚本，不自动写 |

起草完进入 §2——初稿要过审查循环才算数。

---

## 2. 审查循环（两种情形共用：审查 → 决策 → 落地，产生编辑则回 §2.1 重跑，某轮无新编辑则收敛）

**审查范围**：「补某次改动」情形聚焦改动波及的文档 + 其索引 / cross-ref；「审查全部」情形覆盖全部 `docs/` 文档 + 根 README.md / CHANGELOG.md。

### 2.1 审查（分组并行 review subagent）

两组 review subagent 并行跑独立审查；每组内将原则按 `max-principle-per-subagent` 均匀分组，每组 spawn 一个。

**Docs 结构审查**组——`docs-review-principles.md`：
- 读的引用文件：
  - `~/.claude/references/docs-review-principles.md`（传完整文件——相邻原则提供边界上下文；明确告知只应用分到该 subagent 的那几条）
  - `~/.claude/references/docs-organization-protocol.md` + `~/.claude/references/deep-discuss-style.md`
  - `~/.claude/references/service-operations-protocol.md`——只发给分到 P5（服务运维）的那个 subagent，它是 P5 的 authority；其余 subagent 不需要
- 审查对象：审查范围内的 docs/ 文档 + 根 README.md / CHANGELOG.md。README.md 在本组只做 cross-ref / audience 边界 + Content Currency（P3）检查，写作质量由 README 内容审查组覆盖；Content Currency（P3）对全部审查对象生效——含 README 与 CHANGELOG，不止分到 P3 的 subagent 的审查对象。

**README 内容审查**组——`readme-review-principles.md`（仅当审查范围内存在 README 或其他 user-facing 使用文档时 spawn）：
- 读的引用文件：`~/.claude/references/readme-review-principles.md`（同上，传完整文件但只应用分到的那几条）+ `~/.claude/references/deep-discuss-style.md`
- 审查对象：根 README.md 及审查范围内其他 user-facing 使用文档

所有 review subagent 不修改文件、不发 AskUserQuestion。每条发现按固定 schema 输出，供 §2.2 去重/排序/核实：`所属原则(§N) | 定位(文件+段/行) | 一句缺陷 | 它依赖的存在性主张(若有，供核实)`。

**ask-gate 桥接**：review subagent 不能自己 AskUserQuestion，但原则会要它 ask（如 `readme-review-principles` P1 reader/task 歧义须停下问、原则文件的 escape-valve）。触发这类情形时，review subagent 把它当一条发现上交 §2.2（那里才有提问权）并标注「需问用户、非可径改的缺陷」，不得静默跳过。

所有 review subagent 完成后，主 session 汇总两组报告：去重、标注每条发现的原则来源（及所属组）、按优先级排序（编号小者胜）。

### 2.2 决策

基于汇总报告 + 主 session 判断，整理为 `AskUserQuestion` 让用户决策；§1 起草上交的取舍与 ask-gate 项一并呈现。三条卫语：

- **bias check**：主 session 可能看过自己产出的内容（§1 seed 初稿、或上一轮落地的编辑）——反驳一条发现前先自省"我是在评估问题还是辩护自己写的"。
- **先核实再裁决**：一条发现或反驳要否决另一条时，先核实它依赖的存在性主张（"某条目存在/缺失""同类条目都如此"）——review subagent 会臆造存在性主张，未核实的错误前提会击败正确发现。
- **不预设修复**：呈现为可选项让用户决策，不让用户照单全收。

### 2.3 落地与重跑

按用户决策应用编辑。有新编辑则回 §2.1 按完整流程重跑；无新编辑则收敛。

**重跑须中立**：给 review subagent 的重跑 prompt 必须是中立重审，禁止把「上一轮编辑想达成什么 / 去确认它生效」当成功判据喂进去——确认式框架（"verify 这个 fix 解决了 X"）把 subagent 推向印证编辑而非独立挖洞，让编辑者自伤的 over-correction 撑过多轮。

若审查暴露 `docs-review-principles.md` 或 `readme-review-principles.md` 未覆盖的一类问题，用 `AskUserQuestion` 把「是否改进对应原则文件」作为一项决策交用户——原则缺口是高杠杆发现，只在 prose 附带提及会被略过、同类坑复发。改完后执行 `/custom:review-principles <原则文件>` 让它循环收敛：原则文件本身也要过 meta-原则。此支路作用于原则文件、是 §2 环外的条件侧支——其编辑不计入本命令 §2.1 收敛环的「有新编辑则重跑」。

---

## 反模式

- **减少 review subagent 数量**：不要因改动小而超出 `max-principle-per-subagent` 分组上限，工作量看似少也不放宽。
- **跳过重跑**：不要因编辑小或"显然安全"而跳过 §2.3 的重跑。
