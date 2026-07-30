---
name: create-aigc-design
description: 为任何合成/编辑/后处理/多来源接合/多步生成、失败模式为视觉工程痕迹（断层/鬼影/孔洞/残渣/重复/漂移/涂抹）的效果或机制，在实现前写 L1/L2/L3 设计文档（深度随复杂度伸缩），聚焦算法-视觉-效果层。触发看改动性质、不看大小/时机——单个效果、实现或调试中途新增、看似"小 tweak"的照样先设计再实现；单步纯生成（文生图等无接合）不在此列，除非明确有漂移/重复风险。软件架构/API 设计不用（用 create-plan）。
argument-hint: <生成流水线任务描述>
origin: 2026-07-23
---

# create-aigc-design

为 AIGC 流水线产出**实现前**的设计文档，让 `review-aigc-design` 能在设计层拦下问题——避免跑几小时+用户反馈后才发现设计缺陷。

先完整读 `~/.claude/references/aigc-design-review.md`（核心视角、五条硬纪律、三层设计模板、接合类型学、7 维评审 rubric、评审平面边界）——它是本命令的产出规格。**当设计目标含对照 exemplar 的风格保真时**，L2/L3 须含独立 style-judge gate（与算法层 gate 分工，见 reference 评审平面边界）；无 exemplar 要匹配的场景不适用。

## 产出

一份设计文档（落 `<流水线所在处>/designs/<name>-design.md`），**内容按底座三层设计模板（L1/L2/L3）**。create 侧要落实的两点（底座已含，此处强调为撰写动作）：

- L1 的**必避问题**从**本项目真实历史**（读该项目 knowledge / 踩坑记录）取，不是泛泛清单。
- L1 把**可实测真实素材/地标集的路径**列为显式输入——否则底座硬纪律"能实测优先实测"在评审时无物可跑。

## 交接（BINDING）

**写完即评审、评审前不实现**：交 `review-aigc-design <设计文档路径>`，未过其 blocker gate 不进入实现。撰写中的真取舍用 AskUserQuestion 让用户拍。
