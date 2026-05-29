---
name: fix-skill-from-session
description: 扫当前 session 中 command / skill / script / hook 出现的错行为或模糊指令，定位到 source-level 修复并应用。
disable-model-invocation: true
---

# fix-skill-from-session

## 何时使用
- 显式 `/fix-skill-from-session [问题描述]`（描述可选，无则自扫 session）
- 触发场景：当前 session 中某个 artifact（command / skill / script / hook）行为不对、漏 use case、或指令模糊导致 model 反复走偏

---

## 1. Framing：你的角色和产出意识

### 你产出什么、谁来用

交付物是对 source artifact（`.md` / 脚本 / hook 配置）的精确 edit。受益方两类：

- **当前 session**：edit 立即生效，下次 invoke 同一 artifact 不再踩同坑
- **未来所有 invocations**：source 修了，所有调用都受益。这是 fix 而非 memory 的本质价值

**含什么 / 剔什么**：

| 必须含 | 必须剔 |
|---|---|
| Root cause（哪条指令导致 model 走偏 / 哪个边界条件被忽略） | 本次具体执行细节（属 commit message / session log，不属 source） |
| 修复方案对应的源文件 + section + 具体改动 | 已被原 artifact 充分覆盖、本次只是没读到的内容 |

### 风格与取舍

遵循 `~/.claude/references/deep-discuss-style.md` 的风格（提问 / 展示 / 让用户拍板）。其他参考：

- `~/.claude/references/skill-review-principles.md` — review principles 是 fix 质量的权威。**冲突时原则文件赢**
- `~/.claude/references/skill-creation-patterns.md` — proven template，restructuring 类 fix 可备选；**不 force-fit**

本 skill 的关键 framing：

- **fix 是高杠杆操作**：一个坏 fix 每次调用都被复制一次。审慎 ≫ 速度。
- **Bias check**：当扫的 artifact 是当前 session 自己写过 / 引导过的，confirmation bias 显著更强。propose 之前先自问"我是在评估问题还是在辩护自己写的指令？"
- **fix ≠ memory**：不要绕到 memory / instinct——workaround 让 broken artifact 原样保留，下次同样的坑还在。

---

## 2. 需要对齐的点

fix 过程中至少要让以下几类信息变清晰。**这不是顺序步骤**——可以并行、迭代、回头补；**也不是穷举清单**——任务特性需要的其他对齐点随时加入。

通用 lens：**"这个 fix 能不能让 artifact 在未来所有调用中不再踩同类的坑？"** 只规避本次实例的不算 fix，找到 principle 的才算。

### 问题诊断

**对齐**：出了什么问题，根因在哪条指令 / 设计选择。

**lens**：问题是 artifact 的哪条指令或设计选择导致的结构性缺失？不是"哪里写错了"而是"什么结构性缺陷让 model 在这个决策点走偏"。model 在 session 里做了错误选择时，哪条决策在 artifact 里有没有被覆盖？

**常见判断方向**（不限于此）：

| 值得 fix | 不值得 fix |
|---|---|
| 指令导致 model 反复走偏 | 一次性 typo |
| 漏常见 use case | 罕见 edge case |
| 模糊指令缺少决策引导 | 运行时环境问题 |
| 设计原则没被 workflow operationalize | 用户改主意 |

### Fix 归属判定

**对齐**：fix 应该落在哪个文件——不一定是用户 mention 的 skill 文件本身。

**lens**：root cause 内容是 skill-specific 还是 skill-agnostic？skill-agnostic 内容归属在 principles / shared references / CLAUDE.md，不该埋进 entry-point skill 文件。"fix skill X" ≠ "edit X.md"。

应用 `~/.claude/references/skill-review-principles.md` Principle 5 的归属 lens —— 该 lens 在 review 和 fix 阶段同样有效。

### Source 理解

**对齐**：读源文件，理解其结构和格式约定。

**lens**：目标 section 的格式约定是什么——lens 是启发式提问还是指令？framing 是原则陈述还是 checklist？proposal 用目标 + lens 还是 checklist 表格？fix 要匹配这些约定，否则读起来像补丁。不读源就 propose，blind edit 会用一个新 bug 替换旧 bug。

### Fix 设计

**对齐**：设计一个能防止整类问题的 fix，而非规避单个实例。

**lens**：这个 fix 是在枚举一个具体错误，还是在补一个能防止这整类问题的 principle / lens？枚举只能防止已知坑，principle 能防止未知坑。如果是前者，退一步找共性。

**常见方向**（不限于此）：

- **Strengthen, don't enumerate**：让正确路更显眼，而非列举错路。每加一行应关闭一个系统性 gap，不是 patch 单次 hallucination
- **structural fit**：fix 要强化 artifact 的现有结构，而非 bolt-on 补丁。多想想 fix 放在哪里、用什么格式能自然融入
- **trust-the-model test**：这段 fix 给 SOTA 模型看了，它自己能推出正确的做法吗？能 → 可能不需要这么具体
- **Calibrate by current state**：skill 缺相关 instruction 的，加 baseline 指令（如 lens / alignment point）就停；已有 instruction 仍走偏才升级到反模式 / 强措辞。强措辞过早降低泛化性。同一 root cause 加一层防护就停，不要叠多层（如 lens + gate + tripwire 三重）——出 re-failure 再升级，别预防式叠加
- **universalization test**：当 fix 向 universal mechanism（必须能答出表 / checklist / mandatory section）添加条目时，每条必须对 artifact 的**所有目标场景**成立。问自己："这条对 [其他场景] 也说得通吗？"说不通 → 找背后覆盖所有场景的 principle 替代，或放入带适用条件的软指导 section（参见 `create-plan.md` 的硬/软分层模式）。直接把特定场景的需求加为硬要求是不匹配场景的 compliance burden
- restructuring 类 fix 可参考 `skill-creation-patterns.md` 中 proven template；**不 force-fit**

### 验证

**对齐**：fix 后整体文件仍然健康。

**lens**：fix 读起来像原本就在那里，还是像 bolted-on 的补丁？重读整个 file 检查：是否破坏相邻 section 的一致性？是否引入跨段矛盾？删除的内容是否被其他段依赖？是否仍满足 `skill-review-principles.md` 全部 principles？

验证发现 regression 时，当作新问题重新诊断。

---

## 3. 输出

交付物是对 source artifact 的精确 Edit。不要绕到 memory / instinct。

### 必须满足（不能满足即失败）

| Fix 后必须满足 | 不合格示例 |
|---|---|
| Root cause 找到了（哪条指令 / 设计选择导致走偏） | "这里好像不太对" |
| Fix 补的是 principle / lens，不是枚举具体错误 | "不要写 X Y" |
| Fix 匹配目标 section 的格式约定，读起来像原本就在那里 | 像补丁 |
| 整文件仍满足 `skill-review-principles.md` 全部 principles | fix 引入新的原则违反 |

### 与用户的交互

用 AskUserQuestion 让用户拍板，不要替用户决策。用户需要看到什么才能对 fix 做出知情决策？自行判断需要呈现哪些信息——不同 fix 需要的上下文量不同。给出推荐选项和理由，而非只列候选让用户自己选。

独立 issues 可以批量提出让用户批量决策；有依赖关系的才需顺序提出。

### 审核

完成 Edit 后执行 `/custom:review-skill` 审核目标文件中本次 fix 的改动部分。

- **收敛性**：判断 finding 是否需修。需修 → 改 → 重审。循环到一轮无需修。

---

## 反模式

- **替用户拍 fix 不 ask**：诊断完直接 Edit——剥夺用户 say no 的机会，且把 confirmation bias 直接落地
- **修单点不重读整段**：单点 fix 容易破坏相邻语义 / 跨段一致性——不重读就 catch 不到
- **把"我审过了"当 verify**：扫自己引导的 artifact 时 confirmation bias 强，必须独立重读判断
- **枚举错误而非找 principle**：fix 只规避了本次特定实例（"不要写 X Y"），没有找到背后的 principle（"lens 应该是启发式提问"）。枚举只能防止已知坑，principle 能防止未知坑
- **场景特化的硬要求**：fix 向 universal checklist 加行，但该行只对某一类目标场景有意义（如给通用 eval skill 加 "API 调用预算" 行，但有些评测是纯静态分析）。不匹配场景时模型要么硬造内容填格子，要么认为 skill 不适用——两种都是 regression。应找覆盖所有场景的 principle 替代，或放入带适用条件的软指导 section
