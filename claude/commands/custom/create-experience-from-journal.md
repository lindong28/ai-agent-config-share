---
description: 把 journal 文件中的内容提炼为本项目内可复用的经验，写入项目目录下 ./docs/experiences/ 合适位置。触发：用户显式调用 /custom:create-experience-from-journal <journal-path> [<more>...]。
disable-model-invocation: true
---

# create-experience-from-journal

入口 command：从一份或多份 journal 出发，提炼**未来 LLM 类似任务时不需要重读 journal 就能复现质量**的经验，写入项目目录下 `./docs/experiences/`。

## 何时使用

- 用户显式 `/custom:create-experience-from-journal <journal-path> [<more-paths>...]`
- 任何"刚跑完一个 plan / 长任务，从 journal 提炼本项目可复用经验"的场景

不是用来：归档项目状态、写 changelog、单次 bug 复盘。后两类应放进项目 memory 或 commit message。

---

## 1. Framing

### 产出物 + 谁来用

交付物是项目目录下 `./docs/experiences/<topic>.md`（新建，或 edit/append 已有）。读它（实际是被未来 session 加载或主动检索）的是**未来某次在本项目工作的 LLM session**——它没有源 journal、没有这次提炼对话，但**有**当前项目的代码与上下文。

### 核心目标（用户原话 ranking，不可 flatten）

1. **提升未来类似任务的成功率**：agent 能以更少人类时间成本自主跑通
2. **提升质量**：含"用户体验好"这类模糊目标也尽量贴近
3. **跳过 efficiency**：agent 自己探索能完成、只是慢一点的事不值得记
4. **泛化性硬约束**：经验必须能复用到本项目其他类似任务，不能只对该 journal 描述的单次任务有用

### 关键 framing

- **去重 = 第一性步骤**：提炼前必须扫 `~/.claude/references/` 和本项目 `./docs/experiences/` 已有内容。已被既有 SOT 覆盖的 → cut，避免冗余/漂移。
- **格式跟随但不被绑死**：append 进既有 file 时跟随其结构，避免无意义风格漂移；但**不允许因为现有格式硬塞不合适的内容**——结构不匹配是新建文件信号，不是改既有结构信号。新建 / 新格式如何走见 §2 落点决策。

---

## 2. 需要对齐的点（不限于此）

通用 lens：**"future LLM 没有 journal、没有这次对话、没有该项目上下文，缺什么会让经验不可复现 / 误用？"**

挖掘必做：读完 journal 后，**至少**扫一遍 `~/.claude/references/` 和本项目 `./docs/experiences/`，看候选条目是否已被覆盖。跳过这步会导致重复记录或与 SOT 矛盾。

### 候选筛选

**对齐**：从 journal 抽出的候选条目，哪些值得记 / 哪些剔。

**lens**：候选必须同时满足 user ranking（成功率/质量、跳过 efficiency、在本项目内可泛化）且不被既有 `~/.claude/references/` / `./docs/experiences/` 覆盖。**把候选用 1-2 句 WHAT-framing 给 SOTA 模型，会自动产出对的东西吗？会 → 模型已知 → cut。**

候选分类 anchors（不限于此）：设计反模式 / security_note / 工具 gotcha。

### 落点决策

**对齐**：每条留下来的候选去哪个文件，append 还是新建。

**lens**：

- **优先 append/edit 已有 file**：相同 topic 的经验合并能让未来 session 一次拉到全集
- **格式跟随**：append 时结构跟随现有 file
- **新建场景**：候选 topic 没合适的既有 file；或既有 file 格式承载不了新内容（强塞会损害两边可读性）

**新建文件 / 选用新格式**：必须按 `~/.claude/references/deep-discuss-style.md` 给用户至少 2 个选项 + 推荐 + 取舍，让用户决策。不允许直接默认。

### 呈现给用户的候选清单

**对齐**：写入前必须给用户审，含 keep + drop 两侧。

**lens**：用户审的是"取舍合理性"不是"内容正确性"——keep 与 drop 都必须呈现，每条配能让用户反对的最少信息。新建文件 / 选用新格式的决策单独按 deep-discuss-style 列，不混进 keep/drop 表。

### 写入后处理

**默认行为**：写完只**告知 wiring 状态**——`./docs/experiences/` 下文件默认不被加载，需要项目 `CLAUDE.md` / `.claude/` 配置 / skill / hook 引用才会进入未来 session 上下文。说明所需 step，**不主动**改加载入口。这类改动影响所有未来在本项目工作的 session，留给用户单独决策。

例外：用户在调用时显式说"顺手 wire 上"再做。

---

## 3. 输出

### 落点

`./docs/experiences/<topic>.md`（新建或 edit，路径相对项目根目录；目录不存在时先 `mkdir -p`）

`<topic>` 命名：复用既有文件名（append 场景），或根据候选主题 kebab-case 新起（如 `execution-anti-patterns`、`prompt-engineering-traps`）。新建时主题名应与 deep-discuss 中用户拍板的一致。

### 必须满足

| Future LLM 必须能从结果答出 | 不合格示例 |
|---|---|
| 这条经验适用什么场景 / 不适用什么 | "处理 X 时" 太泛 |
| 怎么识别症状 + 怎么处置 | 只有"应该 X" 没说怎么判 / 怎么做 |
| 与既有 references / experiences 的分工 | 与 plan-execution-principles 重叠又不说明 |
| 每条都过 trust-the-model test | 大段 SOTA 常识 |

### Handoff

写完后打印：

```
experience written: /abs/path/to/<file>
mode: <new | append-to-existing>
wiring: <已 wired via X / 未 wired，生效需 Y>
```

---

## 反模式

- **跳过既有 references / experiences 扫描**：直接从 journal 提炼 → 重复或与 SOT 矛盾
- **强行 append 进格式不适配的既有 file**：保留风格 ≠ 强塞内容，结构不合就该新建
- **drop 表省略**：只给 keep 不给 drop → 用户没法反对取舍
- **顺手改 CLAUDE.md 等加载入口**：默认只告知 wiring 状态；用户没要求别擅自 wire
- **违反 §1 ranking 约束**：保留 efficiency-only 候选 / flatten ranking 序号
