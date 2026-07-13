---
argument-hint: <skill-or-command-or-reference-path> [optimize] [principle-prune-mode=disable/moderate/aggressive] [max-principle-per-subagent=3]
description: 审查单个 SKILL.md / command / reference 文件，逐条对照 skill 写作原则评审并修复；可选 optimize 模式追加 wrapper-vs-program 边界优化。用于你写好或改过一个 skill / 斜杠命令 / 供其阅读的 reference 文件、想审核其触发描述、结构与指令质量时。
---

# review-skill

输入 (`$ARGUMENTS`)：待审 SKILL.md / command / reference 文件路径。optimize 模式是否叠加见「模式」判定；可附加 `principle-prune-mode`、`max-principle-per-subagent=N` 覆盖默认值。

## 参数

| 参数 | 必需 | 类型 | 默认 | 说明 |
|---|---|---|---|---|
| skill-path | ✓ | 字符串 | — | 待审 SKILL.md / command / reference 文件路径 |
| optimize | ✗ | boolean | false | 显式强制叠加 optimize 审查（默认判定见「模式」） |
| principle-prune-mode | ✗ | 字符串 | moderate | 按审查目标裁剪原则集的强度：`disable`（不裁剪，全量应用）｜`moderate`（默认，安全裁剪）｜`aggressive`（激进，自担 silent-miss 风险）；三档判据见工作流 §1「裁剪原则集」 |
| max-principle-per-subagent | ✗ | 整数 | 3 | 每个 subagent 至多分配的 principle 数量；值越小，每条原则获得越多注意力 |

## 模式

- **review-only**（默认）：仅应用 `~/.claude/references/skill-review-principles.md`，找违反/borderline。
- **review + optimize**：额外应用 `~/.claude/references/skill-optimization-principles.md`，审 wrapper-vs-program 边界、把确定性工作下沉到外部 program。

optimize 适用判定：optimize 的增量价值主要来自 wrapper-vs-program 边界——目标本身驱动一个执行 agent 的外部 program、存在"逻辑放 command 还是放外部 program、二者如何分工"的问题时才成立。适用与否是从目标文件读得出的结构事实；是否在本次叠加这趟 optimize 审查，是用户的成本权衡。`$ARGUMENTS` 显式传 `optimize` 时直接强制叠加、跳过判定；否则读目标文件、判定它是否包裹这样的外部 program：

- 否（纯 prompt 类，绝大多数）→ review-only，不询问。
- 是 → 用 AskUserQuestion 让用户拍板本次是否叠加 optimize。

## 工作流

循环 3 阶段：**审查 → 决策 → 落地**。任一阶段产生改动后回到第 1 阶段重跑，直到无新发现。展示与提问风格遵循 `~/.claude/references/deep-discuss-style.md`——subagent 输出报告与主 session 提问都适用。

### 1. 审查（裁剪 → 分组 → 并行 subagent）

先按 `principle-prune-mode` 定本次要应用的原则集，再按原则簇就近分组 spawn。

**裁剪原则集**（`disable` 跳过，全量原则都上）：逐条评估每条原则的适用前提是否被审查目标（diff 范围或全文）结构性满足——它考察的对象在目标里根本不存在时，subagent 至多只能返回"不适用"，spawn 它是纯浪费（如目标不含 cross-file reference → §16；body 无 subagent 指令 → §11）。`moderate`（默认）只裁掉可证明被结构性排除的、拿不准则保留；`aggressive` 额外裁掉与审查目标主观判断不相关的。裁剪后产出一份拟裁清单：逐条列出被裁原则、裁剪理由、及该裁剪的置信度/风险。`moderate` 下作信息性报告、不阻断；`aggressive` 下 spawn 前把清单作 `AskUserQuestion` gate 由用户确认——裁掉的覆盖面不能静默消失，主观相关性裁剪须经用户过目。

**分组 spawn**：将选中的原则按 `~/.claude/references/skill-review-principles.md` 的 `Principle clusters` 表就近分组（同簇尽量进同一 subagent，每组 ≤ `max-principle-per-subagent`），每组 spawn 一个 general-purpose subagent **并行**审查，确保每条原则获得充分注意力，不因原则数量增长而稀释。

每个 subagent 的输入：
- `~/.claude/references/skill-review-principles.md`（传完整文件而非截取单条——相邻原则提供边界上下文，帮助 subagent 避免报告属于其他组的发现；但明确告知只应用分配给该 subagent 的那几条 principle。conditional 原则仅在适用范围内生效）
- `~/.claude/references/deep-discuss-style.md`
- 目标文件
- 本次审查范围（审全文 or 聚焦某段 diff 改动）——聚焦 diff 时须把改动本身（hunks / base ref）一并入 prompt，subagent 无法从全文识别哪些是改动；范围须与主 session 裁剪所依据的一致

每个 subagent 只输出其负责的 principle 维度下的违反/borderline 发现。subagent 不修改文件、不发 AskUserQuestion。

追加维度（按情况额外 spawn）：
- 启用 optimize 模式时：额外 spawn 1 个 subagent 应用 `~/.claude/references/skill-optimization-principles.md` 全部原则
- 若本会话包含目标的创建过程：额外 spawn 1 个 subagent 应用 `~/.claude/references/skill-creation-principles.md`
- 若 diff 看起来是 session-level upgrade fix：额外 spawn 1 个 subagent 应用 `~/.claude/commands/custom/fix-skill-from-session.md` §2 Fix 设计 作为 diff-aware fix-review lens

所有 subagent 完成后，主 session 汇总全部报告：去重、标注每条发现来自哪个 principle、解决跨 principle 冲突。

### 2. 决策

基于 subagent 报告 + 主 session 判断，整理为 `AskUserQuestion` 让用户决策。遵循 `~/.claude/references/deep-discuss-style.md` §Principles #3：

呈现 finding 时附主 session 的判断（同意 / 保留 / 反驳 + 理由），不只是 relay subagent 原文——用户需要看到这层加工才能 trust 决策依据。

**判断反模式**（论证依赖以下任一即不算合规证据）：

| 反模式 | 为什么不要 |
|---|---|
| 路径依赖（previously-was-worse）：用"前任版本更糟" / "上一轮 review 留下的 fix" 当作当前合规的证据 | 前任更糟与当前合规是两件事；fix 自身也要过原则审视 |
| 未核实事实主张：让一个 subagent 的发现/反驳否决另一个，却没核实它依赖的"某条目存在/缺失""同类条目都如此"等主张 | subagent 会臆造存在性事实，未核实的错误前提会击败正确发现 |
| 自由价值压原则发现：反驳/保留一条原则发现时，理由是原则不衡量的价值（"更醒目"/"更全"/"读着重要"），没把该原则自带的判定测试套到自己的反方上 | 发现立在原则自带的判定测试上（trust-the-model / substitution-path / narrowest-scenario 等）；要否决得让自己的反方过**同一测试**，否则是用直觉压原则——有效发现被 recommendation 埋掉，只能靠用户事后独立重提原则才捞回 |
| 状态维持/成本压发现（status-quo/cost）：因"可容忍/改动太大"把已发现的问题扣回、不 flag | 设计优劣（是否存在 materially-better 的组织/写法）是你的判断，改动时机/成本是用户的判断——用后者否决前者既越权、又把有效发现埋掉；判据立在原则自带的判定测试上，不是"改起来太麻烦"。最易发生在你/本 session 刚写的结构上 |

The test：对每条你选择不 flag 的发现回读理由——若它立在该原则自带的判定测试之外的替代依据（而非该原则自身判其为真实缺陷），你用错了 bar。

### 3. 落地

按用户选择 Edit。若有改动，回到第 1 阶段重跑——范围按改动触及的原则锚定，不靠直觉挑哪条（直觉会裁到自己盲点）；拿不准则全量。**重跑审的是本 review 自己的 fix 编辑：除分组 subagent 外，额外 spawn 1 个 subagent 应用 `~/.claude/commands/custom/fix-skill-from-session.md` §2「验证」lens（跨段矛盾 / 删除内容是否被依赖 / 折叠是否丢了 guarantee）——这类编辑引入的 regression，分组 subagent 只审「留存文本是否良构」时看不见。** 无改动则循环终止。

若审查发现现有原则未覆盖某类问题，用 AskUserQuestion 把「是否改进对应 principles 文件」作为一项决策交用户拍板——principles 缺口是高杠杆发现，只在 prose 里附带提及会被略过、用户遗忘后同类坑复发。改完后执行 `/custom:review-principles <principles-file>` 循环审查改动——principles 文件本身也要过 meta-原则。

---

## 反模式

- **塞爆 subagent**（≠ 裁剪原则集）：省成本走 `principle-prune-mode` 裁掉整条不适用原则，不是把保留的原则挤进更少 subagent。不要因 diff 小或原则相关而超出 `max-principle-per-subagent` 分组上限把多条塞进同一 subagent——分组越大，跨原则交叉发现越易被单 subagent 的上下文污染。
- **过度裁剪原则**：除非显式走 `aggressive`（经 spawn 前 gate 确认），别把"看着跟审查目标不相关"当裁掉理由——一段纯 prose 改动照样能引入 MUST-无-why（§3）或新同义词（§9）；主观"不相关"裁剪正是这套框架要防的 cost-driven quality compromise。
- **跳过重跑**：不要因改动小或"显然安全"而跳过第 3 阶段的重跑循环——编辑者对自己改动有 confirmation bias，重跑的价值恰恰在于独立于编辑者的判断。
- **重跑 prompt 不中立**：重跑时给 subagent 的 prompt 必须是中立重审，禁止把「上一轮 fix 想达成什么 / 去确认它生效」当成功判据喂给 subagent。确认式框架（"verify 这个 fix 解决了 X" / "确认没 reintroduce Y"）把 subagent 推向印证编辑者的修复而非独立挖洞，让编辑者自伤引入的 over-correction 撑过多轮。
