---
name: update-docs
description: 更新项目文档（docs/ + 根目录 README/CHANGELOG）。显式 `/custom:update-docs [type...]`。
disable-model-invocation: true
argument-hint: "[readme|architecture|adr|experiences|issues|contracts|changelog|plans|claude-md]"
origin: 2026-05-21
---

# update-docs

更新项目文档，遵循 `~/.claude/references/docs-organization-protocol.md`。覆盖 docs/ 下的文档和根目录的 README.md / CHANGELOG.md。不指定类型则更新所有类型。文档不存在则创建，已存在则增量更新。

## 执行

为每个文档类型并行 spawn `doc-updater` subagent：

```
spawn doc-updater:
  type = <doc-type>
  context = <用户输入>
  interactive = true
```

Subagent 自行读取 repo 状态，不需要主 agent 传递。

**对齐原则**：在写文档过程中遇到**取舍不确定**（某内容要不要写、写到什么粒度、、在哪里创建文件、两种组织方式选哪种）时，通过 AskUserQuestion 上升到用户。

## 约束

- 遵循协议 §4 中各文档类型的建议格式
- contracts/ 初始化时只创建目录结构——内容由专用 command 建立（见协议 §4.6）
