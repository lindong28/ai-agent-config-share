# prose-choice-gate prompt eval

给 `../../prose-choice-gate.js` 的 LLM 判官 prompt 做回归 / 迭代 eval。每次怀疑它误判（**误报**正常收尾 / **漏报**真把选项写成 prose）时复用这套，并把新发现的 case 加成场景持续扩展。

## 跑

```bash
ZHIPU_API_KEY=<key> node run.mjs
# 或把 key 放 ~/.claude/.glm-judge-key
# EVAL_N=5 每场景采样次数；EVAL_THRESHOLD=0.8 通过率阈值
```

## 它做什么

把 `scenarios/` 下每条带标签的 agent 收尾消息喂给【真实】`prose-choice-gate.js`（stdin 按 Stop hook 协议 `{"last_assistant_message": "..."}`），读 exit code（`0`=ok/放行，`2`=flag/block），与期望比，每场景跑 `N` 次出**通过率**。

> **喂入路径就是生产主路径**：hook 优先读 payload 内联的 `last_assistant_message`，转录扫描只是回落（见 `../../lib/transcript.js` 的 no-freshness-contract 说明）。所以场景文件是一段**纯消息文本**，不必像 stop-gate 那套合成 JSONL。

- **打真实 artifact，不另抄 prompt**——避免「offline prompt 与部署漂移 → 漏报」。
- 判官是 GLM，以 **temperature=0** 调用，近确定性。通过率保留为残余非确定性的安全余量。
- **需 GLM key**：rubric 按 GLM-4.6 标定，runner 缺 key 直接报错退出——无 key 时 hook fail-open（恒放行），eval 会假性全绿。

## 加场景

丢一个 `scenarios/<name>.txt`：

```
# expect: ok | flag
# note: 一句话说明这条守的是什么
<agent 那条收尾消息的原文，可多行>
```

**必须两个方向都有**：误报守卫（正常收尾该 `ok`）+ 漏报守卫（真用 prose 抛选项该 `flag`）。只测一边会让你优化掉误报、却放过漏报。

## 判据权威源

= CLAUDE.md「Surface Choices (Real Ones), Recommend One」(BINDING) + `~/.claude/references/surface-choices-rubric.md`。本 gate 只管该规则的**载体**那一半（选项经不经 `AskUserQuestion` 抛出）；**推荐标注与理由**那一半归 `ask-recommend-gate`，两者串成流水线。judge rubric 是上述两份为小模型压缩的派生 smell-test，规则实质变更时同步瞄一眼 `../../prose-choice-gate.js` 的 judge prompt。

## 与 stop-gate 的边界（改场景前先读）

两道闸同挂 `Stop`、同读最后一条消息，但判的不是一件事：stop-gate 判**该不该停**（Plan Execution §0，甩活给用户 → flag），本 gate 判**选项以什么形态给出**。

跨闸一致性是硬约束：stop-gate 的 rubric 明写「请用户做决定 / 给授权 / 做主观取舍 → 判 ok」，而它的 `commit-question` 场景把 prose 的「要我提交吗？」标定为 ok。所以本 gate 的 `binary-auth` 场景**必须**保持 ok——判据定在「有没有摆出 ≥2 个并列备选」，不在「用户要不要表态」。改动任一侧的这条判据时，两套 eval 一起跑。

## 当前场景

| 场景 | 期望 | 守的是 |
|---|---|---|
| `ground-truth` | flag | 用户 2026-08-07 实拍的那条：三个并列处置写成正文列表（主漏报守卫 / 本 gate 存在的理由） |
| `inline-choice` | flag | 并列备选写在散文里、无任何列表标记——守"判据是有没有备选"而非"有没有 bullet" |
| `next-steps-menu` | flag | 收尾的「接下来可以 1/2/3，你想先做哪个」——最易被当成善意建议放过的形态 |
| `did-list` | ok | 已完成改动的清单：有列表但不是选择题（主误报守卫，最常见的收尾形态） |
| `binary-auth` | ok | 裸二元授权「要我提交吗」——跨闸一致性，见上节 |
| `quoted-options` | ok | 选项清单是 agent 正在编辑的**文档内容**，不是此刻要用户挑的（content-vs-action；本仓最大的误报面） |
| `will-ask-via-tool` | ok | agent 声明将用 AskUserQuestion 问，正文未把选项摆成待打字回答的清单 |
| `findings` | ok | review 报出的并列发现，明说由 agent 自己接着修 |

## 方法

这套「带标签 eval + 通过率 + 打真实 artifact + 双向守卫」的方法适用于任何 **prompt 驱动的语义判断组件**。方法本身见 `/custom:create-eval-harness`。
