# continuation-claim-gate prompt eval

给 `../../continuation-claim-gate.js` 的 LLM 判官 prompt 做回归 / 迭代 eval。怀疑它误判（**误报**正常收尾 / **漏报**真正的前向承诺）时复用这套，并把新发现的 case 加成场景持续扩展。

## 跑

```bash
ZHIPU_API_KEY=<key> node run.mjs
# 或把 key 放 ~/.claude/.glm-judge-key
# EVAL_N=5 每场景采样次数；EVAL_THRESHOLD=0.8 通过率阈值
```

## 它测的是判官，不是控制流

场景文件是一段**纯消息文本**，经 stdin 按 Stop hook 协议喂给真实 hook，判分读的是 hook 自己落的 `verdict`（经 `CLAUDE_JUDGE_LOG_PATH` 隔离到临时文件），不看退出码——理由见 `run.mjs` 头部。

本闸有三条**判官根本不会跑**的放行路径，runner 把它们全记为 `no-verdict` 而不是 `ok`：

| verdict | 含义 | 为什么不能算 ok |
|---|---|---|
| `ok_live_task` | 探测到有活任务，前向叙述本来就成立 | 判官没跑，这一分不属于 prompt |
| `ok_override` | 走了逃生口（口令 + HANDOFF 声明） | 同上 |
| `detect_unavailable` | `ps`/`lsof` 不可用，运行态判不了 | 同上——漏了它，探测故障的样本会冒充判官 ok |
| `skipped` / `judge_unavailable` | 早退或判官不可用 | 同上 |

还有一类**退出码是 2、但判官同样没跑**的：逃生口的意图检查（缺声明 / 声明自相矛盾 / 同行两个标记）。它与判官的 flag 在 `verdict` 上完全同形，runner 靠 **`backend` 字段是否存在**判断判官到底跑没跑（judge-log 的契约是「本进程调用过 `callJudge` 才写它」），缺席即记为 `no-verdict(judge-not-invoked)`——否则场景里一旦含口令就会假绿。**别改回匹配 `reason` 的自然语言短语**：判官自己的理由完全可能含「自相矛盾」这类词，那会把真判定误记成 no-verdict。

两个后果，写场景前先知道：

- **场景里不要放逃生口口令**。带 `CONTINUATION-OK` 的消息会短路到逃生口，判官一个字都看不到。口令与意图声明（`INTENT-HANDOFF` / `INTENT-CONTINUE`）的行为属**控制流**，由 `../../continuation-claim-gate.control-flow.test.js` 的确定性 test 覆盖，不在本 eval 的射程内。
- **跑 eval 时本进程树里不能有活任务**。有的话每个场景都会命中 `ok_live_task`，整片变成 no-verdict——那不是通过，是没测到。看到大面积 no-verdict 先查这个，别去改 prompt。

## 场景从哪来

`forward-plan-tail.txt` 是 2026-08-08 的**真实误例**：一大批已完成工作 + 收尾一句把剩余工作写成"接着做"的计划。当时 agent 附了 `CONTINUATION-OK` 口令，逃生口短路、判官从未对它表态，用户手动发现后才暴露。该场景去掉口令，专问一件事：**判官本来抓不抓得住它**。`promise-buried-in-report.txt` 是它的同族变体（承诺埋在更长的汇报末尾）。

其余场景对齐 `../../continuation-claim-gate.test.js` 里那 9 条判官用例的语义边界：过去时汇报、明确标注未开始、征询、条件式未来、说明用户该做什么一律 ok；对自己的前向承诺、以及"声称有东西在跑"这类事实错误一律 flag。
