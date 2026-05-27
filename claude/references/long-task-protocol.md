# Long-Task Protocol

执行长 plan（多步、多模块、估计跨多次 session 或会触发多次 context compaction）时使用的状态外部化协议。**Trust-the-LLM 优先**：本文档给的是 WHY + WHAT + 触发例，不是 step-by-step 模板。读完应该能在新场景里推断该怎么做。

---

## 1. 何时启用 / 何时不启用

启用条件：plan.md 顶部有 `Long-task mode` banner（见 §8）。banner 的存在本身就是激活信号，不需要其他判断。

不要在以下情况启用：
- 单文件 / 单步骤的任务
- 估计 1 个 session 内能跑完且不会触发 compaction 的任务
- 探索性会话（边讨论边定方向，没有承诺执行的 plan）

启用后，本协议覆盖整个长任务的实施过程，直到任务声明完成或被显式归档。

---

## 2. 核心机制：两个状态文件 + 一条交付前规则

| 文件 | 性质 | 装什么 | 何时读 | 何时写 |
|---|---|---|---|---|
| `state.md` | 可变 snapshot | 有 lifecycle 的事项（任务、开放问题）| 取下一动作前 / compact 后 / 声称完成前 | 状态变化时（任务推进、新子任务产生、问题打开/关闭）|
| `journal.md` | append-only 时间线 | 无 lifecycle 的认知（决策、习得事实、教训）| 决定一件事感觉似曾相识时 / compact 后接手时 | 触发例见 §4 |

第三条规则**不是文件，是一条 hard rule**：声称任务完成前必须执行 plan 中的 verify 步骤并贴出可观察证据。详见 §5。

### 为什么 mutable vs append-only 拆两个文件

mutable 文件适合答"现在到哪了 / 还有什么没做"——你只需要看最新 snapshot。append-only 文件适合答"为什么这么决定的 / 我之前学到了什么"——历史本身就是信息。如果把两类信息混在一个文件里，agent 改 mutable 部分时容易误改 append-only 部分；分开则各自的写入模式干净。

### lifecycle 是分类轴

判断一条新发现该写到哪个文件，问自己一个问题：**"这件事有没有 pending → done 的 lifecycle？"**

- 有 → state.md（例：发现 plan 没规定的子任务、发现一个需要回头处理的问题）
- 没有 → journal.md（例：习得一个事实、做了一个一次性决策、踩了一个坑）

经常一个发现会同时产生两条记录。例：
> 执行第 4 步时发现 OpenAI 接口对 emoji base64 长度有 8KB 限制——目前用 chunked 上传绕过。

拆为：
- state.md：新增 task "全仓 audit 上传链路是否都加了 chunk"（pending）
- journal.md：append "OpenAI emoji base64 上限 8KB，需要 chunked"

---

## 3. state.md 写什么

格式：

```markdown
# State — <task title>

> Mutable snapshot. Update on status change. See `~/.claude/references/long-task-protocol.md`.

## Tasks

- [done] TASK-001 <title>
  - Goal: <要做什么；为什么>
  - Verify: <如何确认完成>
  - Notes (optional): <约束、关键决策、依赖>

- [in_progress] TASK-002 <title>
  - Goal: ...
  - Verify: ...

- [cancelled] TASK-003 <title>
  - Goal: ...
  - Notes: <为什么不做了 — cancelled 必须写>

- [pending] TASK-004 <title>
  - Goal: ...
  - Verify: ...

## Open Issues

- [open] ISSUE-001 <title>
  - Type: bug | improvement | feature
  - Discovered: <when/where>
  - Description: <what needs to be done>
  - Priority: critical | high | medium | low

- [resolved] ISSUE-002 <title>
  - Type: ...
  - Discovered: ...
  - Resolution: <how/where it was resolved>
```

**字段使用 lens**：让另一个 agent 在 compact 后只看这条 task 也能接手执行。缺哪个字段就补哪个；上面字段不够用时自由追加，不要把信息塞进不合适的字段。

**Task status**：`pending` / `in_progress` / `done` / `cancelled`。cancelled 必须有 Notes 说明原因。

**Issue status**：`open` / `resolved` / `wontfix`。wontfix 必须有说明原因。

### 何时写

**Lens**：当你这次执行让 "下一个动作该做什么" 的答案变了时——任何会改变接手 agent 决策的状态变化，都要落进文件。

触发例（不限于此）：

- plan 里某个步骤的状态变了（pending → in_progress → done / cancelled）
- 执行中发现一个 plan 没规定但必要的子任务 → 新增 Tasks 条目
- 执行中发现一个待解决的问题 → 新增 Open Issues 条目
- Open Issue 被解决 → 状态改 resolved 并简述结果

### 何时读

**Lens**：当你不确定当前进度是什么、是否已经覆盖了所有 plan 步骤、或是否有未解决的 open issue 时——读 state.md 比凭记忆推断便宜。

触发例（不限于此）：

- **取下一动作前**：决定"接下来做什么"时先扫一眼 Tasks 和 Open Issues
- **compact 后第一件事**：在恢复执行前必须重读，重建对当前进度的认知
- **声称完成前**：核对所有 Tasks 都 done、所有 Open Issues 都 resolved

### 为什么不要靠记忆

context compaction 会保留"最近做了什么"，但容易丢失"什么开了还没关"。state.md 的存在就是为了让"开放但未解决的事"不依赖 agent 的短期记忆。

---

## 4. journal.md 写什么

格式自由，建议每条带 timestamp + type + content：

```markdown
# Journal — <task title>

> Append-only timeline of decisions, learned facts, lessons.
> Format: `## <YYYY-MM-DD HH:MM> [decision|fact|lesson|decision-revision]\n<content>`
> See `~/.claude/references/long-task-protocol.md`.

## 2026-05-03 14:32 [decision]
选择 chunked upload 而非降低 emoji 分辨率，因为分辨率压缩会失去角色识别度。
取舍：chunk 协议略复杂（+30 行），但避免了 review 失败。

## 2026-05-03 15:08 [fact]
OpenAI emoji base64 上限是 8KB（实测在 8.2KB 触发 413）。
所有上传链路需要 chunk fallback。

## 2026-05-03 16:42 [lesson]
试了三种 retry 策略才发现 image API 对 5xx 不能盲 retry——状态码 503 实际表示 quota 软限制，retry 会被永久 ban 掉。
现在的方案：5xx 立即停，等用户介入。
```

### 何时写

**Lens**：当这次会话产生了 compact 后丢失会让你或下一个 agent 重复踩坑、重复决策、或前后不一致的认知时——记下来。

触发例（不限于此）：

- 你做了一个 plan 没指定、且未来重复决策可能影响一致性的取舍
- 你需要查文档 / 试错 / 阅读源码才搞清楚一个事实
- 一次失败让你换了方案
- 你识破了一个 plan 中隐含的错误假设
- 你在自然语言交互中给用户解释了一个非显而易见的判断

### 何时读

**Lens**：当你正要做的决策让你有 "之前是不是处理过类似的" 的感觉时——读 journal 比重新推理便宜，且能避免前后不一致。

触发例（不限于此）：

- **接手 / compact 后**：读 journal 让你"想起"之前的决策路径，避免推翻已经选过的方案
- **遇到似曾相识的决策点**：先 grep journal 看以前怎么处理的，避免前后矛盾

### 为什么 append-only

决策可以被 supersede 但不能被改写：你可以追加"DECISION-007 supersedes DECISION-003，因为现在情况变了"，但不能直接删除或编辑 003。删除会让"为什么这次和上次不一样"这个信息永久丢失，再次遇到同类问题时 agent 又会重新踩坑。

如果一个决策被推翻，新增一条 [decision-revision] 类型的条目说明：
- 之前的决策 ID
- 推翻的原因
- 新的选择

---

## 5. 交付前必须验证

**Rule**：在你说"任务完成"之前，必须执行 plan.md 中规定的 verify 步骤，并把可观察证据贴在响应里。

**Why**：任务完成是高反转成本判断——一旦你说完成、用户接受、session 结束，后面发现没真的完成代价极大。"我觉得应该能跑"和"我执行了，证据是这样"是两种东西。这一条没有 trust-LLM 余地。

### user-facing verify 是交付 gate，不是 internal verify

plan 里的 verify 通常按 `/create-plan` 三层 framing 分两类（细节见 plan-review-principles.md Principle 2）：

- **User-facing verify**（plan Layer 2）：使用者眼里『算交付完成』的可观测证据。**这是交付 gate**——只有 user-facing verify 通过 + 贴出证据，才能声称"任务完成"。
- **Internal verify**（plan Layer 3）：实现侧的过程兜底（types / lint / unit test / contract test / 不变式断言）。**这是过程检查，不是交付证据**——internal verify 全绿但 user-facing verify 没跑或没通过 = 任务未完成。

执行中两个都要做，但只有 user-facing 的可观察证据能贴进交付响应。"build green / 测试都过了 / 类型对了" 不能替代 user-facing verify。

### verify 步骤的形态由 plan 决定，不限于命令

常见形态：

| 形态 | 可观察证据 |
|---|---|
| shell 命令 | stdout / stderr 完整输出 |
| UI 改动 | 截图，或交互后的页面可观察状态描述 |
| 报告类产出（含 eval 报告） | 报告文件路径 + 关键结论摘录 |
| LLM 自评 / 阅读判断 | 评估输出 + 你**不仅凭主观感觉**的依据（具体引用、对照标准） |
| 人工确认 | 先按 `plan-execution-principles.md` 拆分并完成 executor 可验证子项；只对剩余的真实人工 gap 等待用户回执，不要替用户拍 |

**什么不算可观察证据**：

- ❌ "我审视了代码，看起来正确" — 这不算
- ❌ "类型检查应该通过" — 这不算
- ❌ "之前跑过测试，现在改动小应该还好" — 这不算
- ❌ "我感觉评估结果是 A 比 B 好" — 没有具体引用 = 不算

**如果 verify 步骤失败**：不要试图遮掩或绕过——把失败贴出来，转入修复流程。failure 也是合法的中间状态。

**如果 plan 里 verify 步骤本身有问题**（命令过期、依赖缺失、判据模糊、措辞含糊）：说出来，更新 plan 的 verify 段，再执行。绕过验证不是选项。

---

## 6. 处理 plan 偏离

执行长 plan 时经常发现 plan 没考虑到的信息——可能小到一句补充，也可能大到原目标不再合理。

日常 plan 内补丁（plan 没规定但必要的子任务、临时 issue）参见 §3 何时写——本节只覆盖**路径或目标层面的偏离**，需要判断要不要打断用户。

按偏离严重度分两级：

| 级别 | 含义 | 处理 |
|---|---|---|
| **方案调整** | plan 的目标不变，但实现路径需要换：原方案被新发现否决、找到更优路径、某个步骤的接口契约和原假设不符 | 见下方 lens 决定问不问 |
| **目标质变** | 原目标本身需要重新定义或承诺已不再成立 | **必须** AskUserQuestion，可能触发 re-plan（重跑 `/create-plan`） |

### 方案调整的 lens

> "如果我推下去，发现用户事后不接受这个方案，补救成本会多大？"

- **高反转成本**（已经写出去的代码 / 数据迁移 / 不可逆 API 调用 / 用户已对齐过的具体方案被推翻）→ AskUserQuestion，提供"原方案 / 新方案 / 我的判断和理由"让用户拍
- **低反转成本**（局部代码改动、容易回滚、不影响用户已对齐的决策）→ 不打断用户，但在 journal.md 写 `[decision-revision]` 条目说明：原方案 / 新发现 / 新选择 / 为什么没问用户。让用户事后能审。

**实际反转成本经常被低估**——遇到模棱两可时，倾向 AskUserQuestion。

### 目标质变的 lens 与 trigger

**Lens**：**原 plan 的某项承诺已不再成立**——goal、关键假设、对 consumer 的价值预期、用户已拍过的决策——任何一项失效，原 plan 就不能算"按规执行"了。这种偏离不允许静默继续，必须停下来 AskUserQuestion。

常见 trigger（不限于此）：

- 某个 task 的 Goal 字段发现写得不对
- 一个 Open Issue 的 root cause 让原 plan 的某个核心假设不成立
- 完成原 plan 后，预期产物对 consumer 不再有价值（按 plan-review #1 的 consumer perspective 判断）
- plan 阶段对齐过的取舍偏好被实施现场推翻——例如用户当时选了"傻瓜式一键"，实际场景发现使用者全是要细调的高级用户，原 verify 维度阈值全部对错对象（按 plan-review #3 Tradeoff Surfacing 的横切影响判断）。这种偏离会让 L1 产物形态、L2 verify 维度、L3 实现取舍同时失准，必须重新 align 而不是局部修补。

**另一类独立 trigger：成本严重超预期**——估算的工作量翻倍以上。即使承诺仍然成立，让用户重新评估投入产出比也是合理的。

AskUserQuestion 时附带：

- 偏离描述（具体新发现 / 是什么承诺失效）
- 影响评估（plan 的哪几条要改 / 用户已对齐的哪个决策要重审）
- 候选选项（继续原 plan 接受代价 / 调整 plan / 重跑 `/create-plan` / 中止任务）

---

## 7. 硬 blocker

外部依赖不可用、权限缺失、环境损坏等不在 LLM 能修复范围内的阻塞——按全局 preference "Resolve Blockers, Don't Bypass" 处理：找用户修根因，不要静默 fallback 到次优路径。同时把 blocker 加到 state.md 的 Open Issues。

---

## 8. plan.md banner

激活长任务模式时，plan.md 顶部应有形如下面的 banner（由 `/create-plan --long-task` 自动插入）：

```markdown
> ⚠️ **Long-task mode** — 本 plan 处于长任务模式
> - 进度状态：`./state.md`
> - 决策日志：`./journal.md`
> - 协议详情：`~/.claude/references/long-task-protocol.md`
>
> 实施时（含 compact 之后）必须先读 state.md 和 journal.md 再决定下一步动作。
> 声称任务完成前必须实际跑本 plan 的 verify 步骤并贴出输出。
```

Agent 读 plan.md 时看到这段就进入长任务模式。compact 之后重读 plan 的第一段也能恢复模式认知。

---

## 9. 反模式

| 反模式 | 为什么不要 |
|---|---|
| compact 后凭记忆继续，不重读 state/journal | 这是协议存在的核心动机；省这步 = 退化为没协议 |
| 把待办事项写进 journal | journal 是 append-only，事项 done 后没法直接标记，下次扫不到状态 |
| 把决策追溯写进 state.md | state 是 snapshot，会被覆盖，决策历史丢失 |
| 跳过 verify 因为"改动很小" | 高反转成本判断没有"很小"档；不验证就别说完成 |
| 只跑 internal verify（types/lint/unit test 全绿）就声称完成 | internal 是过程兜底不是交付证据；user-facing verify（Layer 2）才是交付 gate，必须实跑 + 贴可观察证据 |
| 以为 banner 不在 plan 顶部就是没启用 | 如果 plans/<slug>/state.md 已经存在，且 plan.md 是同目录里的，那就是启用了——补 banner 而不是绕过协议 |
| 静默 re-scope 让 plan 看起来还在轨道上 | 目标质变必须 AskUserQuestion；"我先做完再报告" 是这条协议针对的核心反模式 |
| 实施中发现取舍偏好失效但当作"局部偏差"处理 | 取舍偏好横切 L1/L2/L3，失效会让多层同时失准；按 §6 目标质变处理，不是 §3 状态变化 |

---

## 10. 何时归档 / 退出长任务模式

任务真正完成后（所有 Tasks done、所有 Open Issues resolved、verify 全部通过），处理方式：

- 默认：保留 state.md 和 journal.md 在原目录，作为该任务的执行记录归档
- 不主动删除——journal 里的认知未来同类任务还能复用

如果 plan 被取消或废弃：在 plan.md banner 下加一行 `> Status: ABANDONED <date> — <reason>`，state/journal 保留但不再更新。
