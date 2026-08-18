---
argument-hint: [project-root=cwd] [定位提示]
description: 审查一个项目的服务故障告警是否符合告警设计原则（值不值得 page、多严重、说什么、要不要合并）并修复。用于你为某服务建了或改了告警、想在依赖它值守前审核其质量时。投递/去重契约（im-notify、dedup-key）归 service-operations-protocol §6，不是本命令主职。
---

# review-alerting

输入 (`$ARGUMENTS`)：项目根（默认当前工作目录），可附加定位提示（如"告警在 admin/alerts.py"）。

审核对照 `~/.claude/references/alerting-review-principles.md`。该档与 `service-operations-protocol.md` §6 的边界见其开头——本命令聚焦**设计质量**（§6 管投递与去重）。

## 工作流

前置**定位**，之后循环 3 阶段：**审查 → 决策 → 落地**。任一阶段产生改动后回到审查重跑，直到无新发现。展示与提问风格遵循 `~/.claude/references/deep-discuss-style.md`。

### 0. 定位告警面

grep 出该项目**决定 fire、格式化消息、配置阈值、文档化告警**的全部位置：发告警的代码（fire 判定 + 消息模板，通常经 `im-notify --alert`）、阈值/规则配置、监控 runbook（如 `operations/*.md`）。把它们作为审查目标清单。项目若不发任何告警 → 报告并结束。

### 0.5 真实数据接地（前提基线核查）

告警 fire 逻辑正确、却因部署里拿不到足够/新鲜的输入而**永远不上膛**，与写错同样有害——是静默失效，比误报更难发现。审查前先把它接地到真实生产数据，别只对着合成或臆想的输入推理：

- **回放真实生产样本/信号看实际 fire**：取该告警实际消费的近期真实生产输入（样本 / 信号 / 指标 / 状态文件），喂进 fire 判定，观察**实际会不会 fire、fire 什么**——而非只从代码推断。
- **依赖基线的 gate/降级/rollup/确认窗**（如"N 条样本才评估""对照基线降级""窗口内达到 X"）：核查**该基线在目标部署是否真被产出**，且**量 + 新鲜度**足以在该告警自身声称的时效内让它上膛。基线**本应产出却被饥饿**（产不出、太慢、太旧、被上游占用挤走）即是 **finding，与逻辑错误同级**——这正是"idle 样本被 pipeline 挤到攒不够、告警永不 fire"这类静默失效；但基线在该部署**本就合法缺席**（可选集成被关、该 vantage 未启用）则该告警**本就不该 arm**、不是 finding（详见 alerting-review-principles P9 的"被饥饿 vs 本就不该有"）。
- **真实输入不可取得时**：同 execute-plan §3「真实数据接地」的 **DEFER 不 CLOSE**——记为部署后必须补的 live 核查义务，未过前该告警不算可信值守、不算审查通过。

### 1. 审查（per-principle 并行 subagent）

`alerting-review-principles.md` 的**每条原则各 spawn 一个 reviewer 并行**审查整个告警面，确保每条原则获得充分注意力。通道按 `~/.claude/references/delegation-policy.md` §Transport selection 判；走 in-process 时用 `general-purpose` 且**不传 `name`**。

每个 subagent 的输入：
- `~/.claude/references/alerting-review-principles.md`（完整——相邻原则提供边界；明确告知只应用指定那一条）
- `~/.claude/references/human-facing-message-principles.md`——**审 P3 / P4 的 subagent 必给**：这两条的通用判据住在该档，只给 alerting 档它们会拿到空壳
- `~/.claude/references/service-operations-protocol.md` 的 §6（边界上下文，避免把投递层问题误报为设计问题）
- `~/.claude/references/deep-discuss-style.md`
- 第 0 步的告警面文件清单 + 第 0.5 步的真实生产输入与前提基线核查结论（让 subagent 对真实数据判定，而非合成推理）

每个 subagent 只输出其负责原则维度下的违反/borderline 发现（定位到具体规则/消息/行），不修改文件、不发 AskUserQuestion。

所有 subagent 完成后，主 session 汇总：去重、标注每条发现来自哪条原则、按优先级排序（P1>…>P9，编号小者胜）。

### 2. 决策

整理为 `AskUserQuestion` 让用户决策。注意 bias：对 subagent 发现做反驳前先自检"我在反驳还是在辩护"。一个发现要否决另一个时，先核实它依赖的事实主张（"某条件/字段存在"）再裁决——subagent 会臆造存在性事实。不预设修复让用户照单全收。

### 3. 落地

按用户选择 Edit 代码/消息模板/阈值配置/runbook。若有改动，回到审查——按第 1 步完整流程重跑；无改动则循环终止。

若审查发现现有原则未覆盖某类告警问题，用 AskUserQuestion 把「是否改进 `~/.claude/references/alerting-review-principles.md`」作为一项决策交用户拍板——原则缺口是高杠杆发现，附带提及会被略过、同类坑复发。改完后执行 `/custom:review-skill ~/.claude/references/alerting-review-principles.md` 循环审查改动。

---

## 反模式

- **合并 subagent**：不要因告警面小而把多条原则塞进同一 subagent——独立性保证跨原则交叉发现不被单 subagent 上下文污染。
- **跳过重跑**：不要因改动小或"显然安全"而跳过 Phase 3 重跑——编辑者对自己改动有 confirmation bias。
- **重跑 prompt 不中立**：重跑给 subagent 的 prompt 必须中立重审，禁止把「上一轮 fix 想达成什么 / 去确认它生效」当成功判据喂给它。
- **越界审投递层**：手搓 webhook、缺 dedup-key、要不要告警属 service-ops §6，不是本命令主职；顺带发现可指出，但别喧宾夺主。
