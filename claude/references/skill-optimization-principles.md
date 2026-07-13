# Skill Optimization Principles

Behavioral guidelines for trimming an already-functioning skill so its body stays small, the orchestrating agent burns fewer tokens per invocation, and surprising re-derivation is eliminated. Complementary to `skill-review-principles.md`, which audits violations on a finished skill; this file audits the wrapper-vs-program boundary and pushes deterministic work down into the wrapped code.

**Tradeoff:** These guidelines bias toward moving work out of skill prose into the wrapped program, even when the prose currently works. For pure prompt skills with no wrapped program, principles 2–3 mostly do not apply; principle 1 still does.

**These guidelines are working if:** SKILL.md shrinks rather than grows over time, the orchestrating agent's per-invocation token cost trends down, and "two agents got different results from the same skill" stops happening because every decision either has a documented default or is handed to deterministic code.

**Loop:** For each skill (or each step in its procedure), check principles in order 1 → 3 → 2 → 4. Apply principle 3 before 2 — first verify the program doesn't already output the value before adding new internalization logic.

---

## 1. Eliminate Invocation Variance

**Every flag, parameter, branch, or procedural step the skill mentions must have a documented default and a documented "when to deviate" rule. Silence on these is a tax on every invocation.**

When a default isn't written down, each invocation re-decides — sometimes by asking the user (interrupting flow), sometimes by guessing (inconsistent across runs), sometimes by overriding when no override was needed. The skill author paid the cost of figuring out the right default once; not writing it down forces every invocation to repay that cost in tokens and inconsistency.

When reviewing:
- Flag every flag/parameter mentioned in SKILL.md without a documented default value.
- Flag asking-the-user as the implicit default — calling AskUserQuestion where a documented sane default would do is interruption tax, not collaboration.

Ask yourself: "If I run this skill twice in fresh sessions on the same user prompt, will both runs pass identical flags and use identical paths/names?" If not, undocumented defaults are leaking into invocation variance.

---

## 2. Internalize Deterministic Work Into the Program

**Anything the program could compute without LLM judgment — schema validation, dedup, path derivation, decision rules over structured output, concurrency management — belongs in the program. The skill should orchestrate, not derive.**

The agent's context window is the most expensive resource per invocation. Every file the skill tells the agent to read, every JSON it tells the agent to parse, every rule it tells the agent to apply consumes tokens that compound across invocations. Deterministic logic duplicated in skill prose also drifts from what the wrapped program actually does, because the prose has no test guarding it. Move it into code, write a test, and let the agent read one field.

When reviewing:
- Flag steps that ask the agent to apply a decision tree over structured output (`if recommendation == X and Y then save`) when the program could output the decision directly.
- Flag AskUserQuestion in the skill body where the underlying decision has a deterministic policy AND low reversal cost — encode the policy in the program, don't surface it as a user choice. The reversal-cost test in `skill-review-principles.md` §8 sets the bar: ask only when getting it wrong forces meaningful downstream rework. Common patterns: reuse-existing-vs-add-new (e.g., looking up a tag in a controlled vocabulary), dedup-vs-create, retry-vs-skip on transient errors. Also flag asks that bundle multiple failure modes into one user choice — split by reversal cost and internalize the cheap ones.
- Flag "spawn subagent for parallel work" where the wrapped program already manages concurrency — extra subagents bloat context for no benefit.
- Estimate per-invocation token cost of each step. High-cost steps are primary internalization candidates; small steps may not justify the code change.

Ask yourself: "For each step in this skill, could the program do it more efficiently and reliably? If yes, what evidence forces the agent to do it instead?" Absence of evidence = internalization opportunity.

---

## 3. Trust Program Output, Don't Re-derive Or Fabricate

**If the program already outputs a value — a computed field, a canonical path, a status flag — the skill must instruct the agent to read it. Never re-derive a rule that's in code; never fabricate a path the program already knows.**

Two failure modes share one root cause (the skill doesn't trust the program's output):

- **Re-derivation drift**: skill says "agent applies rules X/Y/Z" while the program already computes that decision. The doc decays as code evolves and the agent burns tokens repeating work.
- **Path/value fabrication**: skill tells the agent to report a path/value without saying where to read it. The agent wings it from README memory or stale conventions and reports something wrong.

When reviewing:
- Flag SKILL.md sentences like "apply these rules" / "compute X based on Y" — grep the wrapped program for the field name. If the program already outputs it, the skill should say "read the field" not "apply rules".
- Flag SKILL.md sentences that tell the agent to report a path/value where the program output JSON does not surface that exact value — either add it to the program output, or have the skill instruct the agent to read the canonical on-disk location.
- Flag the agent constructing values from the user-visible filesystem layout (e.g., assembling `data/<user>/article_summaries/<slug>_output.md`) — these are program-internal conventions the program should output, not the agent should encode.

Ask yourself: "If I deleted this rule/path/value from SKILL.md and the agent had to find it, would it find the answer in program output (good) or have to grep source / guess from README (bad)?" Bad answers point to fabrication risk; fix by adding to program output and instructing the skill to read it.

---

## 4. Verify Against Real Output, Not Fixtures

**After any internalization, validate using real wrapped-program output before declaring done. Synthetic fixtures pass strict validation that real program/LLM output drifts past.**

Fixtures encode the schema you expected; real output reveals what the program actually emits. After moving logic from skill prose into the program, run the wrapped program end-to-end and confirm the agent's downstream steps still parse correctly. Stop at fixture-level validation and you ship a skill that works in tests but breaks on first real invocation.

When reviewing:
- Flag skills whose CI / smoke check exercises mocked output but never the actual wrapped program.

Ask yourself: "Has the wrapped program actually run end-to-end since this change, and does the agent's downstream behavior survive the real output?" If not, validation is incomplete.
