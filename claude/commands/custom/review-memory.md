---
name: review-memory
description: 审查当前项目相关的跨 session memory，识别应保留、更新、毕业到 git-tracked 权威载体或删除的内容，并应用用户批准的调整。用于清理过时/重复记忆和 memory 毕业；默认不审全部 user memory。
argument-hint: "[project-or-scope | 空=当前项目]"
disable-model-invocation: true
---

# review-memory

## 输入与输出契约

| 项目 | 契约 |
|---|---|
| 默认输入 | 当前项目标识，以及当前 harness 为该项目提供的 memory 索引、条目与可用的引用/召回证据 |
| 可选输入 | 用户指定的项目、时间段、topic 或“全部 user memory”范围 |
| 输出 | 覆盖说明 + `keep / update / graduate / delete` 决策及应用结果；每项含来源、证据、目标/影响、推荐、target / memory status 与验证证据，无法完成的状态明确标为 blocked / pending / failed |
| Consumer | 未来检索 memory 的 agent，以及读取毕业后权威载体的人或 agent |

## 审查骨架

### 1. 发现当前 harness 的 memory contract

先确定当前 harness 实际使用的 memory 读写 surface、项目标识与生成/手写边界，并通过该 harness 规定的正式读取 surface 取证。生成型索引、摘要、rollout 或数据库不是编辑面，除非 harness 明确提供对应 mutation API。

**作用域限于当前 harness**：本 command 只审当前 harness 为本项目提供的 memory；另一 harness（Claude Code 与 Codex 互为对方）的 memory 是独立的，不在本次作用域，相关经验需在该 harness 的原生机制下单独审。据此 delete / graduate 的清理只作用于当前 harness 的副本，判「重复 / 已存在」也只在当前 harness 可见范围内可靠——跨 harness 的等价副本无法从此处验证，不得静默当已去重或已一并清理。

正式读取 surface 不存在、鉴权失败或查询失败时停止审计，保留错误与缺失契约证据并输出 `blocked audit`；不得产出候选或 clean，也不得绕到底层生成文件取证。

若无直接 mutation surface，仍完成审查与决策，并继续不依赖 memory mutation 的毕业目标工作：存在正式 request surface 时，获批项目进入异步请求路径；mutation 与 request surface 都不存在时，需修改 memory 的项目才记为 `blocked proposal`。明确指出缺失的正式 surface，不直接改底层存储绕过它。

### 2. 逐项判断

| 判定 | Lens | 处置 |
|---|---|---|
| `keep` | 内容仍正确、独有、放在 memory 合适，未来检索能改变决策或避免非平凡返工 | 保留 |
| `update` | 核心价值仍在，但事实已过时、范围不准或与权威来源冲突 | 用当前可验证事实替换；保留 provenance |
| `graduate` | 内容已成为稳定规则、系统当前态或可复用知识，且其他项目/人类或不依赖 memory 的 agent 也需要 | 写入正确的 git-tracked 权威载体；memory 删除或缩为指针 |
| `delete` | 内容错误、重复、被更权威内容完整取代，或只是可从 git/session history 恢复的过程事件与已完成临时状态 | 删除 |

“很久没被引用”只能作为辅助信号，不能单独支持删除。只有 memory 系统能提供与具体条目可靠关联的召回/引用证据时才报告最后使用时间；不要为了维护指标而给每条 memory 人工刷新日期。

### 3. 毕业落点

毕业落点按 `~/.claude/CLAUDE.md`「长期解决方案载体」逐项判定。目标是项目 docs 时依序：

1. 读取 `~/.claude/commands/custom/sync-docs.md`「被 supervisor 编排复用」契约；
2. 传入毕业语境与源证据，执行完整 Seed + 审查循环；
3. 由本 command 接回其输出与目标 repo commit ownership。

不要把一次性事实升级成 skill，也不要让 memory 成为 git-tracked 权威载体的副本。若目标已存在同等或更优内容，直接判 `delete` 或保留指针，不重复写入。

### 4. 集中决策与应用

遵循 `~/.claude/references/deep-discuss-style.md`。按 `候选 | 当前问题 | 证据 | 推荐动作 | 目标/影响` 集中呈现；`keep` 只报告，会改变状态的候选及确需用户裁决的争议项才通过 `AskUserQuestion` 请求批准。

`graduate` 严格按顺序执行：写入目标权威载体 → 执行目标自己的 review/验证 → 按 `create-commit` 逻辑只提交本次毕业 diff → 再删除或缩短原 memory。禁止 push；目标 commit 未完成时保留原 memory。

分别记录毕业目标与 memory 清理状态；非 `graduate` 项的 target status 为 `not applicable`。

| 目标条件 | Target status |
|---|---|
| `graduate` 未获用户批准 | `not approved / not started`；不写入目标，不修改原 memory |
| 权威载体已 review、验证并本地提交 | `committed` |
| 未发生失败，但目标尚未完成本地 commit | `pending graduation`；保留原 memory |
| 目标写入、review、验证或 commit 失败 | `failed`；保留原 memory |

Memory status 按当前 surface 的真实语义分流：

未获批准的 `update / graduate / delete` 不执行，memory status = `unchanged`；其中 `graduate` 使用上表的 `not approved / not started`，非 `graduate` 的 target status 仍为 `not applicable`。

`graduate` 且 target status 不是 `committed` 时，memory status = `unchanged`，停止清理；只有 target status = `committed` 的 `graduate` 项，以及获批的 `update / delete` 项进入下表。`keep` 的 memory status = `unchanged`，不进入应用分流。

| Surface / 条件 | 动作与验证 | Memory status |
|---|---|---|
| 直接 mutation 成功且重新读取确认 | 接受目标状态 | `applied` |
| mutation 或异步 request 的调用 / 验证失败 | 停止后续依赖动作，保留错误证据 | `failed` |
| 异步 update request / note 已创建 | 只验证请求载体，不宣称 memory 已变更 | `submitted / pending consolidation` |
| 无正式 mutation 或 request surface | 不修改底层存储 | `blocked proposal` |

## 输出

`blocked audit` 只报告尝试范围、错误与缺失的正式 contract 证据。完成审计时，最终报告列出审查覆盖、四类决策、实际应用结果、毕业目标与验证证据；`graduate` 同时报告 target status 与 memory status，不得让任一状态遮蔽另一半结果，也不得把请求提交、pending 或 proposal 误报成已修改。凡 delete / graduate / 去重判断依赖了当前 harness 不可见的跨 harness 副本存在性，报告须显式标注「另一 harness 未核、可能残留副本」。
