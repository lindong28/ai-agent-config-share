# Skill Review Principles

Behavioral guidelines for reviewing skills — covering triggering, structure, instruction style, and scope. Applies equally to new skills pre-merge and existing skills under periodic audit.

**Tradeoff:** These guidelines bias toward skills with sharper triggers, leaner bodies, and narrower scope. For trivial wrappers or shims over a single command, use judgment.

**These guidelines are working if:** skills trigger when they should and stay silent when they shouldn't; SKILL.md bodies stay readable; authors explain why, not just how; scope matches the stated purpose without accumulated cruft; every section is actionable by the actor chain.

**Loop:** For each skill (or each section, for large skills), check 1–7 in order. Loop until no principle is violated.

---

## 1. Description = Trigger

**The description is the only skill text always in context. Judge it as a trigger, not a summary: it must state WHAT the skill does AND WHEN to invoke it, both concretely.**

Claude decides whether to consult a skill from its description alone — nothing else loads until the skill triggers. A description that reads like a clean summary but lacks concrete trigger cues is broken, even if everything it says is true.

When reviewing:
- Restate the description as "this triggers when…". If you can't finish that sentence concretely, the WHEN is missing.
- Imagine near-miss queries (shared keywords, different intent). Flag if the description would over-trigger on them.
- Imagine realistic user phrasings that should trigger. Flag if the description would miss them.
- Flag descriptions that only restate the name or re-assert genericity ("Skill for X. Use when X comes up").
- Flag description content that doesn't help decide whether to trigger — tool choices ("use AskUserQuestion"), style references ("per deep-discuss-style.md"), workflow steps. Behavioral instructions belong in body. Description = trigger only.

The test: you can write a one-sentence "triggers when the user [concrete context] and does [concrete thing]" without opening the body.

---

## 2. Demand Interface Contract for Wrapped Programs

**When a skill drives a wrapped program and acts on its output, the skill ↔ program boundary is an interface; judging the skill's behavior across it requires reading the contract, not just SKILL.md prose. Reviewers MUST locate the contract before entering principles 3–7; if it is missing — or enumerates fields without explaining what each field means and how the program intends consumers to act on it — flag and require补充 before continuing the audit.**

Without documented semantics, the reviewer can audit only surface form (does the skill mention this field?) and not substance (is the skill's interpretation aligned with what the program actually means?). A skill might bundle "重跑 / 手动修复 / 仍然保存" into an ask when validation fails; surface review only sees the bundle. But if the contract distinguishes "informational already-self-fixed" from "actionable needs-human", the misalignment becomes immediately visible. Without the contract, that gap stays invisible to anyone who hasn't grepped the program's source.

A useful contract has two layers: (a) **meaning per field** — not "tag_violations: list" but "tags the program rejected during self-validation; non-empty does not mean the agent must act"; and (b) **intended consumer behavior** — what the program expects the caller to do with each output. "Field exists" alone tells a reviewer nothing about whether the skill's reaction is appropriate.

When reviewing:
- For wrapped-program skills, locate the contract (README section, entry-point docstring, schema spec). If absent, stop the audit — the rest is built on guesses.
- Flag contracts that list fields by name and type without explaining semantic meaning or intended consumer behavior.
- For each program output the SKILL.md consumes, hold contract and SKILL.md side by side: does the skill's interpretation match the contract's stated meaning? Does the skill's response match the contract's stated consumer behavior?
- Flag SKILL.md sections acting on fields whose semantics aren't in the contract — either the contract is incomplete or the skill is fabricating.
- Flag asks where the contract already specifies a deterministic consumer behavior — the skill is asking the user for something the contract has decided.

Ask yourself: "Reading SKILL.md and the contract together, can I tell whether the skill ↔ program interaction is appropriate? If I can only see what the skill does (form) but not whether it's right (substance), the contract is what's missing."

---

## 3. Why Over How

**State the rule. Explain the reasoning. Trust the model to extrapolate. Walls of MUST/NEVER and rigid templates are a yellow flag.**

LLMs with good theory-of-mind extrapolate from principles to novel situations. Procedures and edge-case lists overfit to the scenarios the author imagined, then mislead the model on scenarios the author didn't. HOW-detail is reserved for places the model demonstrably fails at the WHAT level — not added speculatively.

When reviewing:
- Flag stacks of all-caps MUST / NEVER / ALWAYS without the "why" behind them.
- Flag rigid step-by-step templates in sections where judgment is needed — templates strip judgment.
- Flag speculative HOW-scaffolds added "just in case" — edge-case lists, lookup tables. Each item must trace to an observed failure, not to "the model might also need this."
- Flag enumerated trigger / scenario / criterion lists that give concrete bullets but never state the underlying lens (the shared judgment criterion the bullets exemplify). The model can extrapolate to listed cases but not to neighbors. Constructive recommendation: extract the lens, then keep the minimum anchors needed to span the lens's distinct cases.
- Flag procedural detail (exact command, exact file path) where a principle would generalize further.
- Flag NEVER-class absolutism about the skill's own structure or evolution. Skills are artifacts that evolve; those statements freeze unverified assumptions and cannot survive their own first audit.
- Flag cross-references that are provenance — even a non-duplicating pointer (to a downstream gate, consumer, or source) is author-serving if its removal wouldn't change executor behavior; sweep references, not just prose.

Positive form: one sentence stating the rule, one sentence explaining why it matters, then stop. If a rule is inescapably about HOW, lead with the WHY so the model can still extrapolate.

The trust-the-model test (section scope): write any prescriptive section's WHAT-framing in 1–2 sentences. If a SOTA model handed only that framing would produce the right output, the section's body is teaching what the model already knows. Each individual item can pass scrutiny (every rule has a WHY, every example has a purpose) while the section as a whole adds nothing the model wouldn't already do — item-by-item review misses this. Same test catches author-facing content (provenance, repetition reasons, historical context): if removing it doesn't change executor behavior, it's serving the author, not the runtime.

---

## 4. Simplicity First

**Minimum skill that solves the goal. Nothing speculative.**

- Flag features beyond what the skill's stated purpose requires.
- Flag abstractions, configurability, or flexibility that was not asked for.
- Flag skills that bundle multiple unrelated domains — split them, or argue explicitly why they co-habit.
- Flag named phases that don't clearly improve the outcome — skip or inline them.
- If the skill is 500 lines and could be 150, push back.

Ask yourself: "Would a senior engineer say this skill is overcomplicated?" If yes, push back.

---

## 5. Progressive Disclosure

**SKILL.md stays lean. Depth goes into references/ and scripts/, with clear pointers to when they load.**

Three layers load in order: description (always), SKILL.md body (on trigger, ideally <500 lines), bundled files (on demand). Content at the wrong layer either bloats every triggered session or never gets read at all.

When reviewing:
- Flag SKILL.md over 500 lines without hierarchical sections and "go here next" navigation cues.
- Flag content in SKILL.md that only matters for one rare branch — it belongs in references/.
- Flag reference files with no "read this when…" pointer from SKILL.md. Unreferenced files are dead weight.
- Flag duplication — paraphrased summaries, same-constraint repetition across description / overview / tail-end guard sections. Apply the **substitution-path test** before consolidating: piece A is safely consolidatable into piece B only when every (consumer, scenario) of A has a reasonable path to B. Self-question: "Who reads this, in what scenario, and where do they go if it's gone?" Executor-aid cues (param tables, output shape examples in SKILL.md) overlapping an authoritative spec are not duplication if removing them forces an extra hop at execution time. Pick one location of truth only when no (consumer, scenario) breaks.
- Flag mixed-role lists in the body — items playing different functional roles (e.g. references read vs review objects processed) bundled into one bulleted list. Split into role-named sub-sections so the reader doesn't classify each bullet before acting.

The test: from SKILL.md alone, a reader can decide whether they need to open each reference file, without opening it.

---

## 6. Trigger Mode: Auto vs Manual

**Auto-invocable skills need low false-positive cost. Manual skills need to be discoverable without reminders.**

An auto-invocable skill fires whenever Claude judges its description relevant; every triggered session pays its context cost and risks misfire. A manual (slash-command) skill only fires on explicit invocation, so it costs nothing until used — but the user must remember it exists.

When reviewing:
- Flag auto-invocable skills whose misfire is expensive or confusing — ones that would kick off background work, modify files, or derail the conversation if triggered wrongly.
- Flag manual skills whose triggers are cleanly recognizable from context and whose users would benefit from not having to remember a command.
- Flag skills that declare themselves auto-invocable but whose description is too vague to reliably win against adjacent alternatives.
- Flag manual-only skills/commands whose frontmatter lacks `disable-model-invocation: true`.

The test: for auto — "what's the worst thing that happens if this fires unprompted?" For manual — "would a typical user know to invoke this at the right moment?"

---

## 7. Confirm High-Cost Decisions

**For each decision the skill's runtime makes implicitly, ask: "if the model picks wrong, how expensive is the redo?" If high — regenerated artifacts, re-run subprocess, modified files, or significant user re-work — the skill must explicitly instruct the runtime to use `AskUserQuestion` at that point. Trust-the-LLM is no substitute for confirming user intent at high-reversal-cost branches.**

The runtime model has good judgment for low-stakes choices, but some decisions are genuinely under-specified at runtime: ambiguous user inputs with multiple plausible interpretations, branches with diverging downstream consequences, upstream picks that propagate into all later artifacts. Self-deciding at those points produces fast wrong answers; a single AskUserQuestion turn is far cheaper than rework. The inverse failure exists too — skills that ask about decisions the model could trivially make alone interrupt unnecessarily.

When reviewing:
- Walk the skill's runtime path. At each implicit decision (the skill's body lets the model pick one of several options without an explicit ask), classify reversal cost: low (recoverable in seconds, e.g. "regenerate") vs high (forces re-running expensive ops or rewriting outputs).
- Flag high-cost decisions that aren't gated by `AskUserQuestion` in the skill body — especially upstream ambiguities (which input? which interpretation of user request?) that propagate downstream.
- Flag the inverse: skills asking about decisions the model could derive from context alone.

Ask yourself: "What's the worst case if the model picks this without asking — recoverable in one turn, or forces the user to redo significant work?" If the latter, the skill must explicitly require an ask.
