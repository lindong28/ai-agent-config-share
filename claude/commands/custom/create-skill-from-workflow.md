---
name: create-skill-from-workflow
description: 把刚执行的工作流提取为可复用的 skill / slash command。触发：用户说"提取这个工作流"、"做成 skill"、"存成命令"、"turn this into a skill"、"extract this workflow"、"save this as a command"、"make this reusable"、"把这个变成 skill" 等。
disable-model-invocation: true
origin: 2026-05-01
---

# create-skill-from-workflow

入口 command：从刚执行的工作流出发，提取并写出**未来 LLM 不需要重读源对话就能复现质量**的 skill / command 文件。

## 何时使用
- 用户显式说"提取这个工作流"、"做成 skill"、"save this as a command" 等
- 任何"多轮对话产出 → 固化为单次可调用 skill"的入口

---

## 1. Framing：你的角色和产出意识

### 你产出什么、谁来用

交付物是一个 skill.md / command.md 文件（Markdown + frontmatter）。读它（实际是触发并执行它）的是**未来某次 LLM session**——它没有这次产生 skill 的源对话上下文。

**必须含**：

- 让 future LLM 不重读源对话就能复现质量的非显然信息（用户取舍 / corrections / consumer 的真实身份 / domain-specific 措辞）
- 用户在源对话中明确表达过的目标（含 ranking 信号）、约束、触发条件

判据：能从 SOTA 模型常识推出的 → **剔**；非显然 / 用户特定 / 源对话独有的 → **含**。

### 风格与取舍

严格遵循 `~/.claude/references/deep-discuss-style.md` 的风格（提问 / 展示 / 让用户拍板）,`AskUserQuestion` 走多轮逐步推进。其他参考：

- `~/.claude/references/skill-review-principles.md` — 6 条原则是 skill 质量的权威；本 command 只是"应用流程"。**冲突时原则文件赢**

本 skill 的关键 framing：

- **skill 是高杠杆 artifact**：错误设计每次调用都被复制一次。审慎 ≫ 速度。
- **trust-the-model test 必须严守**（Principle 2）：每段内容把 WHAT-framing 1-2 句给 SOTA 模型，会自动产出对的东西吗？会 → 那段是教模型已知的 → cut。
- **用户拍板的取舍 / corrections 必须 inline**——这些是非显然信息，剔了 skill 复现不出。

---

## 2. 需要对齐的点（不限于此）

提取过程中至少要让以下几类信息变清晰。**这不是顺序步骤**——可以并行、迭代、回头补；信息既来自源对话挖掘也来自和用户的当场对齐。**也不是穷举清单**——任务特性需要的其他对齐点（compliance / 隐私 / 跨 session 状态 等）随时加入。

通用 lens：**"future LLM 没有源对话上下文，缺哪些信息会让产出不可复现？"** 缺的就要 inline 进 skill；source conversation 已显式且模型不会自动 default 的也要 inline。

挖掘 / 研究 / verify 是对齐的有机组成——读源对话 transcript、跑 `git diff` 看实际改动、查最近 file 历史、读已被引用的 reference 文件——能让 skill 更可复现的动作都该做，不要因为没明确写出就跳过。源对话被 compacted 时尤其依赖这些补充信息。

源对话信息密度通常较高（用户已经多轮表达过偏好），**节奏可紧凑**——但下面 4 类对齐点不能跳过，跳了 future LLM 行为发散。

对齐过程中，每识别一个"考虑过但准备自己 default 的 borderline 决策"（如 form factor / 默认 input behavior），立刻显式列给 user 审。**每条都要写出具体形式**："决策 X / 我的 default 是 Y / 理由 Z / 你确认还是推翻？"

### 任务范围与触发

**对齐**：这个 skill 涵盖什么任务、不涵盖什么、什么情况下被触发。

**lens**：源对话执行的是哪一类工作流？domain-bound 还是 cross-domain？future caller 调用时希望 LLM 自动识别触发，还是用户显式调用？trigger keywords 用源对话里用户的原话还是抽象化？

**常见询问方向**（不限于此）：

- **形态**：auto-invocable skill（misfire 成本低 + 需要发现性）vs slash command（misfire 成本高 / 低频调用）。参 Principle 5——别 default "skill"，要主动选
- **scope**：domain-bound（专门领域，prompt 含 domain 术语）vs cross-domain（通用框架，system-agnostic 措辞）
- **trigger 措辞**：trigger keywords 通常应保留**用户在源对话里的原话**（涵盖中文 / 英文 / 用户特定说法），不要 paraphrase

### 来自源对话的非显然内容

**对齐**：source conversation 中用户实际表达过、SOTA 模型不会自动 default 的内容。

**lens**：哪些是用户在多轮对话中调整 / 纠正 / 显式拍板过？这些是 skill 必须 inline 的非显然信息——不 inline 则 future LLM 不知道，复现不出。Default-mode 阅读对话只看"任务做了什么"会漏掉这些 framing 维度，要专门读。

**常见询问方向**（不限于此）：

- **Goals**：用户用自己的话说的目标。**注意 ranking**——"首先 / 其次" 是不能 flatten 的权重信号
- **Consumer**：产物的真正受益者，常和触发 user 不同（memory plugin 的 consumer 是读 memory 的 LLM，不是维护 plugin 的开发者）
- **Audience preferences**：consumer 关心的 quality / cost / speed / reliability 取舍
- **Caller role**：用户的角色 / 知识水平（maintainer vs newcomer）——决定 skill 该多 prescriptive
- **Corrections**：每次用户在源对话中 push back / 改方向的内容（非显然 move 的最强信号）
- **`AskUserQuestion` 中 user 的回复**：user 在选项中的选择 / 拒绝 / 自由文本注释是结构化决策点的拍板痕迹

### 输入 / 输出契约

**对齐**：skill 调用时收什么 input、产出什么 output、落点在哪。

**lens**：什么 input 是必需的？optional input 缺失时该 mid-flow `AskUserQuestion` 还是 silent default？output 落点 / 命名要不要编码方向 / 关系信息让 future grep 能找到？

**常见询问方向**（不限于此）：

- **input 必需 vs 可选**；可选缺失时的行为——materially shape output 的 input（如 goals）缺失时通常该 mid-flow 问，silent default 会导致和用户期待错位
- **output 落点**：路径模板 / 命名规则；entity 间有方向 / 关系时编码进文件名（如 `<target>-borrow-from-<reference>.md` 而不是 `borrow-from-<reference>.md`），未来 grep 能找到
- **output 结构约束**：spec **内容**（reader 必须答的问题）默认优先；除非下游 parser 需要，不要硬性规定 section 名

### 写法决策

**对齐**：skill body 实际写什么、cut 什么、怎么组织。

**lens**：每段内容跑 trust-the-model test。哪些是 source conversation 独有、必须保留原话的（goal headers / trigger keywords / 例子值）？哪些是 procedural step list 可以收敛为单条 principle 的？哪些是 speculative HOW（"failure modes" / 边界 case 枚举）可以 cut 让模型自己处理？

**常见询问方向**（不限于此）：

- **措辞保真度**：每处用户原话——哪些字面措辞承载非显然信号（domain 术语 / ranking 词 / trigger keywords / consumer 特定说法）值得保留，让 future LLM 复现 user voice；哪些只是 incidental wording 可抽象？判据：移除或改写后 future LLM 会失去什么具体信号？
- **值的 binding 角色**：源对话里的具体值（路径 / 代号 / 特定 section 名 / 具体 keywords / 输出落点）在 skill 里是**固化为默认**、**提为参数**、还是**仅作例子**？
- **principle vs step list**：异质 step 通常合并为单条 principle；同质 procedural 才作为步骤
- **是否引用 `~/.claude/references/skill-creation-patterns.md`** 中的 proven template（alignment facet shape / lens-vs-procedure default 等）——case-by-case，**不 force-fit**

---

## 3. 输出：skill.md / command.md

### SKILL.md Structure

**Frontmatter (YAML):**
- Two required fields: `name` and `description` (see [agentskills.io/specification](https://agentskills.io/specification) for supported fields)
- Max 1024 characters total
- `name`: Use letters, numbers, and hyphens only (no parentheses, special chars)
- `description`: Third-person, describes ONLY when to use (NOT what it does)
  - Start with "Use when..." to focus on triggering conditions
  - Include specific symptoms, situations, and contexts
  - **NEVER summarize the skill's process or workflow** (see CSO section for why)
  - Keep under 500 characters if possible

### 落点

按 form factor + scope（facet 1 + facet 3 决定）落到对应位置：

| form factor | scope | 路径 |
|---|---|---|
| auto-invocable skill | user | `~/.claude/skills/<name>/SKILL.md` |
| auto-invocable skill | project | `.claude/skills/<name>/SKILL.md` |
| slash command | user | `~/.claude/commands/<namespace>/<name>.md` |
| slash command | project | `.claude/commands/<namespace>/<name>.md` |

### 必须满足（不能满足即失败）

| Future LLM 必须能从 skill 答出 / 决定 | 不合格示例 |
|---|---|
| 何时该被触发 / 不触发（trigger keywords + skip conditions） | "处理 X 时" — 太泛，未来 LLM 无法判断 |
| skill 的核心 WHAT-framing（1-2 句让模型推出 80%+ 行为） | 整段都是 procedural step，没有 lens |
| 哪些非显然信息已 inline（goals + ranking / consumer / corrections / audience） | 全是 SOTA 常识 → 删了等于没写 |
| input 契约 + 缺失时行为 | 没说 input 是什么 / 缺失静默 default |
| output 契约（落点 / 命名 / reader 必须答的问题） | 没说 output 在哪 |
| 每段都过 Principle 2（trust-the-model test） | 大段 procedural HOW 教模型已知 |

### skill 写法常见关注点（不限于此）

下面这些方面通常值得在 skill 里显式照顾，但要不要加由 extractor 根据 source conversation 判断——并非强制：

- **list 标记 exhaustive vs 不限于此**：未标 → reader 当 spec 来扫；明确标 "不限于此" 让模型知道可自行扩展
- **self-check gate**：如果 skill 有"必须答的问题"表，应有 self-check 段引用该表，避免 model 跳过验证
- **决策 trace 闭环**：如果 skill 涉及多个 facet 决策（form / scope / trigger / input / output 等），输出段建议有对照——每条决策在 skill 哪段落实，避免漂移成 dead decision

### 验证

调用 `/custom:review-skill <path>` 完成审查。

- **独立性**：spawn general-purpose subagent 跑（不要 inline 自查替代）。
- **收敛性**：主 session 判断 finding 是否需修。需修 → 改 → 重审。循环到一轮无需修。

### Handoff

reviewer 循环 clean 后打印：

```
skill written: /abs/path/to/<file>
```

---

## 反模式

- **跳过 trust-the-model test**：每段不过 Principle 2 就保留 → procedural 大堆，model 已知的也教
- **flatten 用户 ranking**："首先 / 其次" 权重信号 flat list 化 → 失去优先级
- **silent default 关键 input**：input materially shapes output 时，缺失必须 mid-flow 问，不能静默 default
- **未经 alignment 就 paraphrase 用户原话**：跳过措辞保真度 alignment、静默 paraphrase → 损失非显然信号（决策引导见 §2 写法决策 → 措辞保真度）
- **force-fit `skill-creation-patterns` 模板**：template 是 case-by-case 备选，照搬而不思考是反模式
