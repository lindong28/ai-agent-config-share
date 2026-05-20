---
description: 把当前 session 的关键上下文外部化为一份 markdown handoff，交给新 coding agent session 接力。用户在 context 接近用满或要切到新 session 前手动触发。
argument-hint: [可选：补充 scope/重点/语言/排除项]
disable-model-invocation: true
---

# handoff

把当前 session 的关键上下文落到一份 markdown 文件，让一个**没有本会话上下文**的新 coding agent 能接着干。

---

## Consumer 与产物意识

读这份 handoff 的是另一个 LLM session，**它没有本会话的对话记录**。它能看到的只有这份 markdown + 你引用的一手材料路径。reader 也可能在另一个 harness（Codex / Claude Code / 其他）里跑——所以不要假设它能继承本会话的工具状态或 MCP 配置。

衡量 handoff 是否合格的唯一标准：**那个新 session 读完后，能不能不重读源对话就独立推进？** 推不动 = 信息缺；推错方向 = 边界没划清。

**自包含要求**：handoff 中的所有内容都必须在没有当前 session 上下文的情况下读懂。不要写只有本 session 才知道的简称、代词、裸版本名或结论跳跃；提到 baseline / latest / 某个实验 / 某个反馈时，要在本文件内给出必要定义、日期、版本/commit、用户原话或一手材料路径。不能靠“前面聊过”“刚才验证过”“见对话”来补语义。

**对照命名要全套定义**：自包含失败的最常见盲点是对比组只定义一端——定义了 baseline，没把 target / latest / 实验版本一并定义，reader 看到 "target 已接近 baseline" 这种 quote 时无法解码 target 指哪个版本。

**用户 quote 必须带 anchor**：用户原话单独列出来时，每条必须附最小语境（看哪个 artifact / 回应哪条信息 / 在哪一步说的），否则 reader 看到 "我看了，觉得明显 baseline 更好" 这种孤立 quote 无法判断"看了"什么。

**handoff 的内容边界（核心原则）**：handoff 只承载**客观 context**——用户原话 / 已生成产物 / 已推翻方案 / 文件路径 / 执行轨迹。它**不**承载 handoff 写作者的推理产出——推荐执行顺序 / 验证假设 / 主观建议 / 待测 case / "你应该自己再验证 X" 类的指导都不行。决策与新调研都是下一 agent 的工作；handoff 写作者的角色是**客观信息的搬运工**，不是 pre-think 替代下一 agent。

**判断越界靠功能测试，不靠 phrase matching**：换标签（"改进思路 / 初步观察 / 记录的方向"）不改变功能本质。判断 lens：这段内容 reader 能否从 git log / 一手材料 / 用户原话独立得到？只能从你的会话思考得到 = 越界。跨样本归纳的规律（"action prompt 比 appearance prompt 更适合 GIF"）即使加"未量化验证"前缀也仍是推理而非客观。

---

## 标准动作

### 1. 自己挖 scope，不要让用户重复

用户敲 `/custom:create-handoff` 时**不要先问"你想交接什么"**。先扫本会话最近的执行轨迹（用户最后几个 prompt、刚跑完的工具调用、生成 / 修改的文件、未完成的待办），自己推断 scope。

如果上下文确实推不出"下一 agent 要做什么"（刚做完探索、还没明确下一步），才在第 2 步的 AskUserQuestion 里直接问。

`$ARGUMENTS` 如果存在，把它当作对推断的额外约束（重点提示 / 排除 / 语言 / 命名 / 其他形态要求），不要当作完整 scope。

### 2. 立刻对齐 handoff 层级的信息缺口

scope 和其他关键 context（reader 限定 / 负向边界 / 语言 / 命名 / 是否纳入某个话题 / 是否记录敏感标识 / 目标读者需要知道但当前 session 没法客观推出的信息等）由你负责推断。

如果你认为存在 **handoff 层级**的信息缺口或关键决策，且这个缺口可以由用户当场澄清，就必须在写文件前立刻对齐：优先用 `AskUserQuestion` 工具；如果当前 harness 没有该工具，就直接问用户一个简短问题。不要把这种缺口写成 `待确认`、`可能`、`应该是`、`下一 session 再问` 留在 handoff 里。用户拍板后再 Write 文件。

只有在缺口不是 handoff 层级事实（例如属于下一 session 自己要调研或设计的实现决策），或当前无法通过用户澄清得到客观答案时，才可以记录为“当前会话未提供/未验证”的客观事实。记录时要说明它为什么是上下文缺口，而不是把它伪装成结论。

**信息缺口的识别 lens**：用户的语义 ≠ 你能从源资料（代码 / 一手材料 / 对话明文）锁定的对象 = ambiguity，不是矛盾。例：用户说"每天 10 词"但代码按任务次数计数——必须用 AskUserQuestion 问清"用户原意是现有口径还是新口径"，不能把一句"实际不是按词数扣减"当作放过 ambiguity 的客观事实。

只有当 X 属于下一 session 自己 plan/调研期的决策（例：新功能要覆盖哪些 openid / 目标上限具体数值），才可以记录为"用户本轮未提供 X"作为客观事实，并显式说明这是 implementation-time gap 而非 handoff-time gap。

### 3. 写文件

落点：`handoffs/<topic>-handoff-YYYYMMDD.md`

- `<topic>`：从下一 agent 任务里抽 3-6 个英文单词（kebab-case），例：`summarizer-prompt-parity`、`wechat-emoji-3-baseline`
- `YYYYMMDD`：今天日期，无分隔
- 默认中文写作；除非 `$ARGUMENTS` 或上下文明确要求英文
- Write 前确认目标路径不存在；若同日已有同 slug 文件，让用户选覆盖、改 slug、或加 `-v2` 后缀

写完后简短回执：文件路径 + 一句话说"下一 session 用 `理解并执行 handoffs/<file>` 即可接力"。

---

## 产物 spec：reader 必须能答出的问题

不强制 section 名，但下面这些问题，新 session 读完 handoff **必须能直接回答**。如果某条没法答，你写漏了：

| 问题 | 必含内容 |
|---|---|
| 我（新 session）要做什么？ | 任务一句话（用户给的目标）+ 上下文动机（为什么做，从对话里摘） |
| 我**不**该做什么？ | 显式负向边界——只摘录用户原话给出的"不要 X"、"且仅 Y"、"只记录 Z" |
| 之前已经做了什么？ | 关键执行轨迹 / 已生成的产物 / 已被推翻的方案及原因——全是客观事实 |
| 我去哪里找一手材料？ | 关键文件 / 命令 / URL 速查，用代码块列出绝对路径 |
| 有哪些信息缺口？ | 只允许记录无法在写 handoff 时向用户澄清、或不属于 handoff 层级的客观缺口；凡是写 handoff 时就该问清的内容，不得留到文件里 |

**用户在历史样本里反复表达过的硬约束**（写 handoff 时遵守）：

- 不替下一 agent 做 planning——不写完整 plan / 1-2-3 步骤 / 成功标准 / 代码片段；下一 session 自己 plan，reader 删除这段还能独立推进 → 就是越界
- 优先 quote 用户原话，少用自己的概括——记录用户已决策 / 硬约束 / 澄清时把原话作为 anchor；概括会丢失原话的限定条件与语义层级
- 当用户说"且仅 X"或"只记录 Y"时严格执行负向边界，不要扩散到相邻话题
