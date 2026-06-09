---
name: deep-discuss
description: >-
  Think a tradeoff-heavy task through together before acting, without producing
  a plan.md. Use when the user brings a task that turns on real tradeoffs or
  competing approaches they want to think through before committing (讨论一下 /
  帮我想想这个怎么弄 / 有几个方案拿不定 / weigh the options / think through the
  tradeoffs), but it's too light to warrant a plan.md. Skip when the user wants
  an implementation plan to hand off (use create-plan) or just a quick one-shot
  answer.
---

# deep-discuss

轻量入口：对一个取决于真实取舍 / 需要想清楚、但不值得开 plan 的任务，进入 deep-discuss 模式陪用户把取舍想透——对齐在前、动手在后，**不产出 plan.md**。

## 何时使用 / 何时不用

| | |
|---|---|
| **用** | 任务取决于真实取舍 / 多个合理方案并存，用户想一起想清楚再动手；用户说"讨论一下 / 帮我想想 / 有几个方案拿不定 / weigh the options"。显式 `/deep-discuss <task>` 也走这里；裸调用不带 task 则先问要讨论什么。 |
| **不用** | 用户要的是能交给另一个 session 落地的 plan.md → `/create-plan`；任务是单步 / 事实性 / 没有取舍的快问快答 → 直接答，别强行拉进讨论。 |

精度优先于召回——deep-discuss 是会拖慢节奏的模式，borderline 时**不触发**。

## 怎么做

全程遵循 `~/.claude/references/deep-discuss-style.md`——这就是你要复用的讨论纪律，直接读它、照它做。

区别于 create-plan 的两条边界：

- **不落文件**：不写 plan.md、不 bootstrap state.md / journal.md。
- **聊重了就升级**：讨论中若暴露任务其实够重（多步骤、跨 session、需交给独立 implementer 落地）→ 建议转 `/create-plan`，别在 deep-discuss 里硬塞一个 plan。

## 产物

无文件产物。产物是会话内对齐过的决策（按 deep-discuss-style 呈现给用户），以及（如有）随后的直接行动。
