---
name: design-critique
description: "Holistic UI/UX design critique — evaluates visual hierarchy, information architecture, cognitive load, emotional resonance, and AI-slop tells, then delivers prioritized, actionable fixes. Use when the user asks to review, critique, evaluate, or give feedback on a UI design, screen, or component."
argument-hint: "[area (feature, page, component...)]"
user-invocable: true
---

Conduct a holistic design critique — evaluate whether the interface actually works, not just technically but as a designed experience. Think like a design director giving feedback.

Flow: Preparation → ① Critique → ② Present Findings → ③ Ask the User (skip if findings are straightforward) → ④ Prioritized Action Plan.

## Preparation

Before critiquing, know what you're judging against: who uses this (target audience), what they're trying to do (use cases), how it should feel (brand tone), and what the interface is trying to accomplish. Pull this from project docs or a design brief; if it isn't available there, ask the user via AskUserQuestion before starting Phase 1 — don't assume. Without it, feedback is generic — a clinical tone is a flaw for a consumer app but correct for a medical device.

Read `~/.claude/references/web-ui-observation.md` before judging layout, alignment, or how far the reader has to travel to reach anything — it defines the relation layer that per-element value checks are blind to, and how to measure it.

When a reference product is in play — the user says "make it look like X" or "X is better than ours" — that file additionally governs the pairwise same-condition measurement and the reference→ours completeness direction: judging our UI against a transcribed value list can pass while the two still look different.

This skill judges; it does not supply parameters. When a finding's root cause is that visual system parameters were never decided or are inconsistent — arbitrary type sizes, spacing off any ladder, one flat shadow everywhere, no transitions — the `web-visual-system` skill owns the replacements; name the parameters at fault in Phase 4 rather than restating the symptom. Findings with other root causes (information architecture, composition, microcopy, emotional tone, discoverability) are this skill's own to direct, and a parameter set will not fix them.

## Phase 1: Critique

Evaluate the interface across these dimensions.

For each one, name the reading that would settle it before you judge it, and where a reading exists but you did not take it, report the dimension as unmeasured rather than as a verdict. Only dimensions 4 and 10 have no reading — emotion and voice have no number, and inventing one is worse than judging.

### 1. AI Slop Detection (CRITICAL — start here)

**The most important check.** Does this look like every other AI-generated interface? Scan against every tell in [ai-slop-antipatterns](reference/ai-slop-antipatterns.md) — AI palette, gradient text, glowing dark mode, glassmorphism, hero-metric layouts, identical card grids, generic fonts, and the rest.

**The test**: If you said "AI made this," would they believe you immediately? If yes, that's the problem.

### 2. Visual Hierarchy
- Does the eye flow to the most important element first? Can you spot the primary action in 2 seconds?
- Do size, color, and position communicate importance correctly?
- Is there visual competition between elements that should have different weights?
- **Distance to the answer**: name what the reader came for — often a row inside a component, not the component — and measure it per `web-ui-observation.md`「测量技术」. Below the first screen is a defect unless the product documents that placement as deliberate; your own reading that the page "goes top to bottom" is not that. Vary the data volume as well: one screen deep on demo data can be five in production.

### 3. Information Architecture & Cognitive Load
> *Consult [cognitive-load](reference/cognitive-load.md) for the working-memory rule and 8-item checklist.*
- Is the structure intuitive? Is related content grouped logically? Is navigation clear and predictable?
- Count visible options at each decision point — if >4, flag it.
- **Progressive disclosure**: Is complexity revealed only when needed, or dumped upfront?
- Run the 8-item cognitive-load checklist and report the failure-count band (defined in the reference).

### 4. Emotional Journey
- What emotion does the interface evoke? Is that intentional and on-brand? Would the target user feel "this is for me"?
- **Peak-end rule**: Is the most intense moment positive? Does the experience end well (confirmation, celebration, clear next step)?
- **Emotional valleys**: Check onboarding frustration, error cliffs, discovery gaps, anxiety spikes at high-stakes moments (payment, delete, commit) — and whether design intervenes there (progress, reassurance, undo).

### 5. Discoverability & Affordance
- Are interactive elements obviously interactive? Would a user know what to do without instructions?
- Do hover/focus states give useful feedback? Are there hidden features that should be more visible?

### 6. Composition & Balance
- Does the layout feel balanced or uncomfortably weighted? Is there visual rhythm in spacing and repetition? Does asymmetry feel designed or accidental?
- **Whitespace, measured**: for each top-level region with its own heading or border, plus one representative repeated item, take how much of it carries content per `web-ui-observation.md`「测量技术」表「一个区域里有多少在承载内容」一行 — whitespace is its complement, and that file says which width to take it at. Leftover whitespace is a defect unless the design documents it as deliberate; a generous margin and a region the grid had nothing to fill look the same by eye. With no DOM to measure, report this dimension as unmeasured.

### 7. Typography as Communication
- Does the type hierarchy signal what to read first, second, third? Is there enough contrast between heading levels?
- Is body text comfortable (line length, spacing, size)? Do font choices reinforce the brand/tone?

### 8. Color with Purpose
- Is color used to communicate, not just decorate? Does the palette feel cohesive?
- Are accent colors drawing attention to the right things? Does meaning survive for colorblind users?

### 9. States & Edge Cases
- **Empty**: guides toward action, or just "nothing here"?
- **Loading**: reduces perceived wait?
- **Error**: helpful and non-blaming?
- **Success**: confirms and guides next steps?

### 10. Microcopy & Voice
- Is the writing clear, concise, and human (the right human for this brand)?
- Are labels and buttons unambiguous? Does error copy help users fix the problem?

## Phase 2: Present Findings

Structure feedback as a design director would.

### AI Slop Verdict
Start here — pass/fail: does this look AI-generated? List specific tells matched from [ai-slop-antipatterns](reference/ai-slop-antipatterns.md). Be brutally honest.

### Design Health Score
> *Consult [heuristics-scoring](reference/heuristics-scoring.md).*

Score each of Nielsen's 10 heuristics 0–4 in a table (heuristic | score | key issue), with a total `/40` and rating band. Be honest — a 4 means genuinely excellent. Most real interfaces score 20–32.

### Overall Impression
A brief gut reaction — what works, what doesn't, the single biggest opportunity.

### What's Working
2–3 things done well. Be specific about *why* they work.

### Priority Issues
The 3–5 most impactful problems, ordered by importance. Tag each with P0–P3 severity (definitions in [heuristics-scoring](reference/heuristics-scoring.md)):
- **[P?] What**: name the problem clearly
- **Why it matters**: how it hurts users or undermines goals
- **Fix**: concrete direction

A finding that carries a reading does not fall out of this section quietly. Score it on both axes in [heuristics-scoring](reference/heuristics-scoring.md): P0 and P1 belong here, P2 and P3 go to Minor Observations carrying their reading with them. If the P0/P1 set runs past the 3–5 above, keep it ordered and let it run long rather than dropping one.

### Persona Red Flags
> *Consult [personas](reference/personas.md).*

Auto-select 2–3 personas most relevant to this interface (use the selection table). If project design context (audience/brand) is available, also generate 1–2 project-specific personas. For each, walk through the primary user action and list specific red flags — name the exact elements and interactions that fail them, not generic descriptions.

### Minor Observations
Quick notes on smaller issues worth addressing.

**Remember**: Be direct and specific ("the submit button", not "some elements"). Say what's wrong *and* why it matters. Give concrete directions, not "consider exploring...". Prioritize ruthlessly — if everything is important, nothing is. Don't soften criticism.

## Phase 3: Ask the User

After presenting findings, ask targeted questions (via AskUserQuestion) grounded in **what was actually found** — never generic "who is your audience?" prompts. Keep to 2–4 questions with concrete options. If findings are straightforward (1–2 clear issues), skip and go straight to Phase 4.

- **Priority direction**: which of the found issue categories matters most right now? (offer the top 2–3 categories)
- **Design intent**: if a tonal mismatch was found, was it intentional — or should it feel warmer/bolder/more playful? (offer directions that would fix it)
- **Scope**: address everything, top 3, or critical only?
- **Constraints** (only if relevant): anything off-limits that should stay as-is?

## Phase 4: Prioritized Action Plan

Present a prioritized plan. For each item: the fix direction (what to change and why), mapped to the Priority Issues it resolves. Order by the user's stated priorities first, then impact — if Phase 3 was skipped, order by impact alone. Respect any chosen scope and off-limits areas. Do not point to external commands; describe the work directly so any downstream session or agent can act on it.

Close by inviting the user to re-run the critique after fixes to see the score improve.
