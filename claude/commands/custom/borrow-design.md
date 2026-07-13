---
name: borrow-design
description: 把"X 比 Y 强在哪些点能借鉴"、"对比 A 和 B 找出 A 该借鉴的点"、"what should we migrate from Y to X" 类需求结构化为 consumer-aware、ROI 排序的 borrow checklist。Inputs 是两份 anatomy / design 文档加可选的优化目标。
disable-model-invocation: true
origin: 2026-05-01
---

# borrow-design

入口 command：对比 target 与 reference 系统，产出**可被 maintainer / 团队直接用来决策迁移**的 borrow checklist——consumer-aware、按 ROI 排序、surface 拒绝项理由。

## 何时使用
- 用户说"X 比 Y 强在哪些点能借鉴"、"对比 A 和 B 找出 A 该借鉴的点"、"what should we migrate from Y to X"
- target 和 reference 都已有 anatomy / design 文档，需要结构化对比

## Inputs

- `target` (positional, required)：target's anatomy / design doc 路径
- `reference` (positional, required)：reference's anatomy / design doc 路径
- `goals` (optional)：用户的优化维度，自由文本。如未传，§ 2 "优化目标" facet 会问
- `output` (optional)：输出路径，默认 `docs/<target-stem>-borrow-from-<reference-stem>.md`（如 `docs/agent_mem-borrow-from-claude-mem.md`）。已存在则 `AskUserQuestion` 是否覆盖

---

## 1. Framing：你的角色和产出意识

### 你产出什么、谁来用

交付物是一个 borrow checklist markdown 文件。读它的是 **target 系统的 maintainer / 团队**——他们要根据这个 checklist 决定哪些设计真的值得迁移过来。

**必须含**：

- 用户拍板的 **philosophical boundary**（target 的 identity 边界——超出此边界的 reference 特性即便诱人也是 reject 候选）
- 用户拍板的 **consumer identity**（target 真正服务的下游受益者，常和触发 command 的 maintainer 不同）
- 用户拍板的 **优化目标 + 排序**（"首先 X、其次 Y" 的权重不能 flatten）
- 每个 borrow item 的 ROI 推理 + 受益的具体 consumer / goal
- 每个 reject item 的简短理由（防止未来读者 re-evaluate 已 reject 的项）

判据：reader 能从 anatomy 自行推出来的 → **剔**；非显然 / 用户特定决策 / 跨文档对比的判断 → **含**。

### 风格与取舍

遵循 `~/.claude/references/deep-discuss-style.md` 的风格。本 command 的关键 framing：

- **borrow checklist 是高杠杆 artifact**：错的 borrow 决策会在 target 里被 implement 一次，撤销代价高。**审慎 ≫ 速度**。
- **anatomy / design 文档是 hypothesis 而非 gospel**——为可读性而压缩，常 overstate 或 invert 看起来 incidental 的细节。当 borrow 推荐的 "how to migrate" 依赖某个具体算法 / 数据结构，必须打开源码确认（spot-check，不必 re-read）。
- **没有绝对对错的点必须让用户拍**——boundary / consumer / goals 三个核心 framing 由用户决策，不是 command 自己揣测。

---

## 2. 需要对齐的点（不限于此）

产出 borrow checklist 前至少要让以下几类信息变清晰。**这不是顺序步骤**——可以并行、迭代、回头补；**也不是穷举清单**——任务特性需要的其他对齐点（合规 / backward-compat / 团队偏好 等）随时加入。

通用 lens：**"为了产出对的 borrow checklist，我现在缺哪些只能用户拍板的信息？"** 下面 3 个核心 facet 不能跳过——跳了 checklist 就失去 boundary / consumer / 排序 锚点，输出走偏。

研究 / 探索 / verify 是对齐的有机组成——读 target 和 reference 的 anatomy、必要时打开两边源码 spot-check 关键算法 / 数据结构、跑 grep 看实际使用——能让 checklist 更准确的动作都该做，不要因为没明确写出就跳过。

对齐过程中，每识别一个"考虑过但准备自己 default 的 borderline 决策"（如某个 feature 在 boundary 边缘是否算 violation），立刻显式列给 user 审。**每条都要写出具体形式**："决策 X / 我的 default 是 Y / 理由 Z / 你确认还是推翻？"

### 任务边界（philosophical boundary）

**对齐**：哪些设计选择若被改变会 invalidate target 的 identity——reject 候选的判据来源。

**lens**：target 的核心 identity 是什么？哪些约束是设计前提（如 "Markdown is source of truth"、"no external services"、"single-binary distribution"）？reference 中违反这些边界的特性，无论看起来多诱人，都是 reject 候选。

**常见询问方向**（不限于此）：

- 数据 / 持久化形态约束（local-only / file-based / cloud-backed / 等）
- 部署形态约束（single binary / multi-service / browser-based / 等）
- 架构哲学约束（unix-style / monolith / agent-native / 等）

surface 识别出的 boundary 让 user 确认或修正——boundary 误读会让所有下游 reject 判断失效。

### 受益者（consumer）

**对齐**：target 真正服务的下游受益者，及其关心的维度。

**lens**：target 的 output 最终给谁？通常和触发 command 的 maintainer 不同——例如 memory plugin 的 consumer 是读 memory 的 LLM agent，不是维护 plugin 的开发者。consumer 不显然时必须问，不要默认 maintainer = consumer。

**常见询问方向**（不限于此）：

- consumer 类型（human / LLM agent / downstream service / end user）
- consumer 关心的 quality 维度（precision / recall / latency / cost / DX 等）
- 改善 maintainer 体验但不到达 consumer 的 borrow 应降权

### 优化目标（goals + ranking）

**对齐**：用户的优化维度及其排序。

**lens**：用户在 target 上想优化什么？维度间有排序吗？"首先 X、其次 Y" 的权重信号不能 flatten——flat goals 会破坏 ROI 排序的根基。

**常见询问方向**（不限于此）：

- standard system-quality 轴（precision / recall / latency / reliability / cost / DX）
- domain-specific 轴（如 memory system 的 "recall over time"），从 target anatomy 实际强调的维度抽
- 如果 `goals` 入参已传入，用它；否则 `AskUserQuestion` 提 4-6 个候选维度（从两份 anatomy 抽取，**不要 invent disconnected dimensions**），让用户挑 / 删 / 加 / 改

**关键**：用户的 goal 措辞会成为 output 的 section header **原文保留**，包含中英文 / 用户特定说法。不 paraphrase。

---

## 3. 输出：borrow checklist

### 落点

默认 `docs/<target-stem>-borrow-from-<reference-stem>.md`，已存在则 `AskUserQuestion` 是否覆盖。

文件名编码方向（`<target>-borrow-from-<reference>`）让未来 grep 能找到 "target 借鉴了哪些"。

### 必须做到（不能做到即失败）

| Reader 必须能从 checklist 答出 / 看到 | 不合格示例 |
|---|---|
| 哪些设计值得 borrow，按 ROI 排序，weighted by goal hierarchy | flat list "everything is high priority" → 失去 actionability |
| 每个 borrow item 受益于哪个 goal、reach 到哪个 consumer | 只说 "improves system"，没说对哪个 consumer 哪个维度 |
| 哪些 reference 特性被 reject，每条一行简短理由 | 没 reject section → 未来读者 re-evaluate 已驳回项 |
| 用户的 goal 措辞作为 section header 原文保留 | paraphrase / 翻译 → 丢失用户语境 |
| 优先级表 ≤ 10 项；多余的降级为 inline mention | 30 项全 high priority → 等于无优先级 |
| 哪些决策是访谈中没问、command 自己 default 的（"我默认 X，因为 Y"） | 没列 → reviewer 无从审 |

### 写完后自检

逐行对照上方"必须做到"表：每一行都能从 checklist 里找到具体证据吗？答不上的行就是漏了——回去补，不要进入 handoff。

### Handoff

写完后打印：

```
borrow checklist written: /abs/path/to/<target>-borrow-from-<reference>.md

下一步：
- 和 maintainer / 团队 review，决定真正 implement 哪些 item
- 高优先级 item 可继续 /create-plan 进入实施规划
```

---

## 反模式

- **flatten ranking**：用户说 "首先 X、其次 Y" → 输出 flat 优先级 → 失去权重，ROI 排序失效
- **漏 consumer 视角**：默认 maintainer = consumer → 改善 maintainer 但不到达 consumer 的 borrow 被推到高优先级
- **没 surface rejections**：reject 项没写 / 没理由 → 未来读者 re-evaluate 已驳回项，重复浪费时间
- **borrow 违 boundary 项 high-rank**：reference 中诱人但违反 target identity 的特性，分析阶段没识别就推荐 → user 阅读时困惑
- **anatomy doc 当 gospel**：直接基于 anatomy 描述推荐 borrow，不打开源码 spot-check 关键算法 → 推荐基于 hypothesis 而非现实
- **goal 措辞 paraphrase**：用户原话 "首先优化 recall over time" → 输出 "improve memory accuracy" → 丢失用户语境，对齐 break
- **超过 10 item 强排序**：30 项都进表 → 失去 actionability；多余的应降级为 inline mention
- **invent disconnected dimensions**：提候选 goal 维度时 invent target anatomy 没强调的维度 → 用户被诱导选错方向
