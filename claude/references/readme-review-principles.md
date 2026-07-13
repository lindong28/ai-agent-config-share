# README Review Principles

Behavioral guidelines for reviewing user-facing documentation — READMEs, install guides, usage docs, any doc a user reads to accomplish a task. Not for design docs, internal runbooks, or agent/system instructions.

**Tradeoff:** These guidelines bias toward shorter, task-focused docs over comprehensive ones. For pure reference material (API specs, exhaustive CLI listings), use judgment.

**These guidelines are working if:** users accomplish the stated task from the doc alone; scope stays tight to the reader's job.

**Loop:** For each section of the doc, check 1–7. Loop until no principle is violated.

---

## Priority and conflict resolution

Principle 1 is a **prerequisite** for principles 2–7 — without a defined reader and task, 2–7 cannot be evaluated.

Principle 2 is a **routing gate** — content that fails it belongs in another doc (typically CLAUDE.md), not improved in place.

Principles 3–6 are listed in **tiebreaker priority order** — when two give conflicting guidance, the lower-numbered principle wins.

Principle 7 is **conditional** — it fires only for entry docs, a thing's first-contact surface; when it fires, the orientation content it requires prevails over 3–6 (§7).

**Escape valve**: when applying this order would contradict your judgment of what serves the reader's task, ask the user before applying.

---

## 1. Understand Before Reviewing

**Understand the doc's intended reader and task before reviewing anything else. Don't assume — ask.**

A user-facing doc can only be reviewed against a goal. Before anything else, the reviewer must be able to name:
- **Reader**: who is this doc for? (first-time installer, existing operator, occasional upgrader…)
- **Task**: what should they be able to accomplish after reading?

Before reviewing:
- Read the doc as the reader, not the author — what confuses them, what they'd skip past.
- Restate reader / task in one sentence each. If you can't for either, ask.
- If reader or task is ambiguous, stop — every subsequent principle depends on this. Ask via AskUserQuestion.

The test: you can state reader / task in one sentence each, without opening any linked file.

---

## 2. Audience: feature users and operators, not change-makers

**README serves people who deploy, verify, and operate this project. Content valuable only to people modifying the project's code belongs in CLAUDE.md.**

README mixed with change-maker content forces users to skip past sections that don't apply, or worse, follow instructions not meant for them. Pulling change-maker content into CLAUDE.md sharpens the user's reading path and gives change-maker content a coherent home.

When reviewing:
- Flag write-safety constraints, decision rules for adding new code, or scope traps for authoring — these serve change-makers, not users.
- Flag commands that only serve the code-modification workflow (e.g., lint hooks, pre-commit checks) — not deployment-verification commands the user is expected to run (e.g., post-install test suites), which serve the user's "verify" task.

Ask yourself: "Would someone deploying, verifying, or operating this project need to read this, or only someone modifying its code?" If only modifying, it belongs in CLAUDE.md.

---

## 3. Content Serves Scope

**The reader and their task define the scope. Include only content that serves that scope; everything else lives in another file, cross-linked.**

When reviewing:
- Flag content written for maintainers or future authors.
- Flag implementation internals the user doesn't act on. Brief internals are OK only when they motivate a user action.
- Flag content that belongs to a neighboring section or sibling file.
- Flag content whose removal wouldn't affect the user's ability to finish the stated task.

Ask yourself: "If I delete this sentence, can the reader still accomplish the stated task?" If yes, it's out of scope.

---

## 4. Observability

**The user can see whether actions succeeded and where to look when they didn't.**

Using a product requires seeing what it's doing — observable success confirms the happy path; observable failure lets the user diagnose when something went wrong.

When reviewing:
- Flag instructions that end without an observable signal.
- Flag vague verification phrases like "check that it works".
- Flag docs that describe success but not how to see common failures.
- Flag verification steps buried inside prose.

Ask yourself: "Can the user tell whether this step worked, and if not, where to look?" If no, flag missing observability.

---

## 5. Simplicity First

**Minimum content that lets the user complete the task. Nothing speculative.**

- Flag commands split into steps that add no reader benefit (`git fetch` + `git checkout` + `git merge --ff-only` instead of `git pull --ff-only`).
- Flag pre-enumerated edge cases or hypothetical branches — cover what users will actually hit, not everything they might.
- Flag prose that adds no information beyond the heading, command, or structure it surrounds.
- If the section is 50 lines and could be 15, push back.

Ask yourself: "Would a senior engineer say this doc is overwritten?" If yes, cut.

---

## 6. Defer, Don't Duplicate

**If another doc is the authoritative source for a fact, link to it — don't mirror its content.**

Upstream CHANGELOGs, parent READMEs, and vendor docs own their content — the local copy is always the one that goes stale.

When reviewing:
- Flag tables or sections that re-state what an upstream CHANGELOG, release notes, or vendor doc already covers.
- Flag parallel structures that track an upstream format — they invite mechanical drift as the upstream evolves.
- Flag content that duplicates a sibling doc in the same repo — pick one home, link from the other.
- Flag cross-references placed away from the step where the reader needs them — links far from the decision point go unfollowed.
- Flag "we'll keep this updated when X changes" comments — they announce upcoming drift.

Ask yourself: "Is this information authoritative here, or is it a copy?" If a copy, replace with a link.

---

## 7. Orientation (conditional — 仅入口文档)

**入口文档必须先让读者判断「这是什么 / 何时用它 / 与同类怎么选」，再讲 how-to——入口文档的读者群几乎永远包含尚未决定采用的新用户，缺了这层，这些读者无法判断该不该用它，或在多个相似选项间选错。**

**触发条件**：只对**入口文档**——一个东西的第一接触面（典型：顶层 README、landing 文档）——触发。判定看文档在 doc-set 中的角色而非 genre：一份"安装指南"若是第一接触面，它就是入口文档。纯任务文档（升级步骤、单个功能的使用页）不触发——orientation 的家在入口文档，不必逐页复制。是否入口无法判定时，按 P1 的 ambiguous 路径处理。

When reviewing:
- Flag 入口文档只讲了 how-to（怎么装 / 怎么跑）却没讲 what-it's-for / when-to-reach-for-it —— 这样的文档只对"已经决定用它"的读者有用。
- Flag 一个工具的入口文档没有把它与仓库内 / 生态内的同类工具区分（读者不知道何时用这个 vs 那个）。
- Flag 把"是什么 / 为什么用 / 何时用 / 与同类怎么选"这类定位内容当 speculative 砍掉，或只塞进用户不会翻的开发者文档。

定位内容可由决策点处指向权威来源的 link 承载——不必为满足本原则而内联复制 sibling / 上游已有的比较或定位内容。

Ask yourself: "一个**还没决定用不用**这个东西的读者，在读到 how-to 之前能不能判断出'这适不适合我的场景、该不该用它、和相邻选项比强在哪'？" 判断不出 → flag 缺 orientation。
