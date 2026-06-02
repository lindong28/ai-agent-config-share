# UX-Contract Domain Registry

`create-ux-contract` / `review-ux-contract` / `execute-ux-contract` 共用的路由表：按 ux-contract 在 **L1 声明的产品类型**，决定各阶段额外加载哪些 domain 文件、针对契约的哪一段。**加类型只改这张表一处，三命令不动。**

顶层 `ux-contract-review-principles.md` 对每个 contract 都加载（基线）；本表列的是按产品类型**额外**加载的 domain 文件。create 与 review 共用同一份原则文件（各阶段用法见该文件「何时加载」段）；execute 另用一份测试模式文件。

## 路由表

| L1 产品类型 | 定义（如何判定） | create 写 / review 审（原则文件） | execute 跑（测试模式文件） | 对应契约段 |
|---|---|---|---|---|
| 功能型 | 价值来自"功能正确"（默认） | 无额外（走顶层基线） | 无额外（通用 execute 流程） | L2 verify |
| 游戏 | 价值来自"玩的过程"本身（vs 功能正确） | `~/.claude/references/game/ux-contract-review-principles.md` | `~/.claude/references/game/ux-test-patterns.md` | 「游戏体验验收」段 |

## 扩展

- **新增产品类型**：加一行——`产品类型 + 定义 → 原则文件 → 测试模式文件 → 对应契约段`（某阶段无专属文件就标"无额外"）。
- 本表只路由 + 给判定定义，**不枚举**文件内部的原则条目（G1/G2、GP1-3 等归各文件自己列）——避免文件改原则时这里 desync。
