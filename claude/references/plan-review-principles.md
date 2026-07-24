# Plan Review Principles

Behavioral guidelines for reviewing implementation plans — plan files written before code is touched, covering what to build, how, and how to verify. Catches problems while they cost one edit to fix, not one refactor.

**Tradeoff:** These guidelines bias toward tight-scope plans over comprehensive blueprints. For trivial tasks (one-file typo fix), skip the plan entirely.

**These guidelines are working if:** plans describe the minimum work that achieves the goal; verification steps run as written; nothing the user needs (docs, root README updates) gets discovered post-ship.

**Final gate:** check every applicable principle before declaring the plan clean. Re-review routing and termination are owned by `review-plan`; this file owns the review criteria.

---

## Priority and conflict resolution

Principles are listed in **tiebreaker priority order** — when two give conflicting guidance, the lower-numbered principle wins. Principles 4, 13, 14, 15, 16, and 17 are conditional (apply only when their scope is matched); when they apply, their position in the order stands.

**Escape valve**: when applying this order would contradict your judgment of what serves the plan's goal, ask the user before applying.

---

## 1. Understand the Goal

**The plan tells a complete story: what's broken now, what changes, how you'll know it worked.**

The plan must answer three questions concretely:
- **Before**: the current state, as an observable fact — "daemon is foreground, dies on logout", not "daemon management is bad".
- **Change**: which artifacts will exist that don't today, which existing files change.
- **Verify**: the steps a reader can execute to confirm success, with the observable evidence each should produce.

**Verify is from the consumer's perspective.** "Consumer" = whoever uses the deliverable: end user, downstream code, evaluator, deployment env. Internal correctness (types, lint, unit tests) is necessary but not sufficient — a plan that passes its own tests but doesn't satisfy the consumer is not done.

An executable verify fixes the **verification interface** — inputs and prerequisites, invocation or responsible actor, observable evidence, and the pass/fail boundary — not non-load-bearing checker internals. An internal detail is load-bearing only when leaving it open could change an externally relevant outcome, such as observable acceptance, cross-implementation compatibility, or reliable and safe verification / delivery.

When reviewing, flag:
- "Before" stated as a quality ("unmaintainable", "hard to use") rather than a concrete state.
- Verify steps a reader can't execute — missing prerequisites (parent dir creation, tool availability probes), unresolved inputs (which hostname, which filename), ambiguous targets ("tweak a setting").
- Success criteria that stop at "the file exists" and never reach "the feature works end to end".
- **Consumer acceptance boundary not surfaced as first-class** — use-path (what the consumer does with the artifact next), success criteria (what counts as done by what bar), or acceptance threshold all belong on the surface, not buried in scope/description. Same physical artifact form supports wildly different acceptance depths depending on use-path (e.g., a "compare two AIGC systems" report used to *pick one* needs only blackbox scores; used to *cherry-pick algorithms for a new system* must decompose to module/algorithm level). When the plan states only the artifact form and not the acceptance boundary, design depth is ungrounded and reviewers can't validate.

Ask yourself: "Could I execute every verify step from the plan alone, and tell whether each passed — and would passing satisfy the deliverable's consumer for the use-path the plan claims?" If no, flag.

---

## 2. Deliverable Surface Semantics

**Every user-readable point on the deliverable must admit one interpretation.**

The deliverable presents user-readable points the consumer reads to make sense of the artifact — numbers, labels, fields, list items, chart elements. Each must be uniquely interpretable from the plan's deliverable description; otherwise the same artifact form admits multiple valid readings and the implementer silently picks one. The consumer sees the value render correctly and still cannot tell what it represents.

For each user-readable point, the plan must pin the interpretive dimensions the consumer needs to read it — e.g., **attribution** (whose data), **coverage** (which events / records are in scope), **timeliness** (as-of-when), **unit / baseline** (vs what). The relevant dimensions vary by deliverable; this list is not exhaustive.

When reviewing, flag:
- A user-readable point whose interpretive dimensions are implicit when the consumer's interpretation depends on them — e.g., a "5h quota" KPI on a multi-system dashboard with no indication of whose quota.
- Plan specifies the artifact form (KPI card / chart / list / report field) but not what the value carried by that form represents in consumer-readable terms.

Ask yourself: "For every user-readable point on the deliverable, could the consumer determine what it represents without inventing a definition or asking the implementer?" If no, flag.

---

## 3. Verify Layering

**Verify must be specified in two layers — what the deliverable's user accepts, and what implementation-side checks back it up. Both are required. The user-facing layer must be expressible without reference to internal design.**

The deliverable's verify serves two distinct purposes:
- **User-facing verify** — what the deliverable's actual user (end user, downstream code, evaluator, deployment env) accepts as "delivered". Expressible without reference to internal structures, state machines, or design choices, so it can be defined *before* implementation is settled (TDD-style: define what success looks like, then design toward it).
- **Internal verify** — implementation-side self-checks that protect against low-level errors during construction (types / lint / unit tests / contract tests / invariant assertions). Each non-trivial design decision should have a paired internal check.

A plan with only internal verify ships code that compiles but doesn't satisfy the user. A plan with only user-facing verify pushes every implementation error to the user-acceptance gate, blowing iteration cost up.

When reviewing, flag:
- Verify list with no separation of user-facing from internal — implementer can't tell which check is the actual deliverable gate vs which is just an internal safety net.
- User-facing verify written in terms of internal data shapes / state machines / private APIs — that's internal verify mislabeled; the actual user acceptance is undefined.
- User-facing verify modality mismatched with the consumer's acceptance modality — e.g., "command + stdout" check when the consumer accepts visual / qualitative / human-judgment evidence. The check passes mechanically yet leaves the consumer's acceptance ungated.
- Internal verify reduced to "build green" / "lint passes" only — non-trivial design decisions have no per-decision implementation-time safety net.
- User-facing verify deferred to "after implementation" / "we'll see when it's done" — the deliverable's shape and use haven't collapsed enough for the plan to be ready; user-facing verify must be definable from the deliverable description alone.
- Internal verify present without any user-facing verify — plan describes how to build but not what the user accepts.

Ask yourself: "Could the implementer execute the user-facing verify without knowing how the implementation works internally? And does each non-trivial design decision have a paired internal check that catches its own failures before the user-facing gate?" If no on either count, flag.

---

## 4. Spec Verify Coverage (conditional)

**Applies only when the plan references an upstream `spec.md` as user-facing contract. Skip otherwise.**

When a `spec.md` defines user-facing verify dimensions (the conditions the artifact's actual user accepts as "delivered"), the plan + state.md (long-task mode) must contain implementer-executable verify steps that **cover every dimension**. Spec is the contract; plan/state is the implementer-side deliverable. The implementer is responsible for executing every verify step in plan/state — so plan/state must collectively cover spec's full user-facing verify surface.

The translation is necessary because the two layers serve different readers:

- **Spec's user-facing verify** is written for the user to audit the contract. Form: natural-language acceptance ("使用者跑评测看分数 ≥ 0.7 算 work", "5 个真实场景跑一遍 OK").
- **Plan/state's verify** is written for the implementer to execute. Form: command + expected output, subagent simulating user flow, screenshot-compare script, evaluator score check, structured rubric — anything the implementer can run directly.

Letting the implementer translate spec's natural-language verify ad-hoc at execution time causes drift (different implementers translate differently), missed dimensions (selective translation), and late realization (verify shape only becomes clear when implementer hits the verify step).

When reviewing, flag:
- Spec defines a user-facing verify dimension (specific success / error / quality dimension) that has no corresponding implementer-executable verify step in plan or state.
- Plan verify entries are written in spec's user-audit form ("使用者满意" / "user accepts") instead of implementer-executable form (command / subagent / script) — implementer can't directly execute, has to re-translate at runtime.
- Plan claims to translate spec verify but reduces multi-dimension acceptance to a single binary check — coverage degraded silently.
- State.md task `Verify` slots exist but don't trace to any spec dimension — verify items exist but cover nothing the user contracted.
- Spec lists multiple dimensions (latency, quality, error path, ...) but plan/state only covers some — ungrounded partial coverage.

Ask yourself: "For each user-facing verify dimension named in spec, can I point to a specific plan or state.md verify step that the implementer can execute and that produces evidence of that dimension being satisfied?" If any spec dimension has no such mapping, flag.

---

## 5. User-Facing Surface Verify Coverage

**Every factual sub-promise on the plan's user-facing surface must map to an implementer-executable verify assertion. The user reads the user-facing surface to confirm intent; the implementer reads and runs verify steps. Review-plan ensures the mapping so neither party silently drops a promise.**

The user-facing surface — sections the user reviews and signs off on — has two core sources:

- **Locked user decisions** — items the user and planner have explicitly aligned on. Different plans express these under different names (AskUserQuestion outcomes, "已确认决策", "user-approved choices", etc.); recognize the role, not the literal label.
- **User-perspective verify / acceptance criteria** — verify entries written for the user to audit (distinct from internal verify written for the implementer, per P3).

The implementer-facing surface — implementation steps + per-step internal verify — the user does not exhaustively audit; the implementer runs every verify step and ships only when all pass.

The handshake: user signs off on the user-facing surface; reviewer ensures every factual sub-promise on the user-facing surface maps to an implementer-executable verify assertion; implementer executes all verify steps. If a sub-promise has no corresponding assertion, neither party catches deviation — the implementer can ship something that contradicts what the user signed off on, and verify still passes.

Sub-promise = any factual / quantitative / scope claim on the user-facing surface — including **preservation** claims ("don't touch X", "保留 X 不动") and **error / edge / failure path** claims (timeout handling, missing input, permission denied, etc.), not just success-path mutation claims. **Granularity**: take the smallest semantic unit the user recognized when aligning with the planner; a "clear tables X/Y/Z, preserve table W" locked decision contains four sub-promises (three mutations + one preservation), not one. Examples:

Coverage mapping may be many-to-one when one shared assertion fails on any mapped violation. Evidence granularity follows the consumer acceptance boundary and the cost of acting on a failure; many-to-one does not require a bespoke mechanism per sub-promise.

- User-perspective verify says "search button absent on all 4 tabs" → verify asserts DOM contains no `button#refresh` on each tab.

When reviewing, flag:

- A factual sub-promise on the user-facing surface (mutation / preservation / scope / threshold) has no implementer-executable verify assertion that would fail if the sub-promise were violated.
- **Preservation** sub-promise ("don't touch X", "保留 X") with no assertion that X is unchanged — silent over-mutation cannot be detected.
- Verify only asserts the downstream observable (e.g., content quality after a rerun) without asserting the mechanism named in the sub-promise (which tables cleared, which range covered, which version used) — a passing observable check can mask wrong-table / wrong-range / wrong-version execution.

Ask yourself: "Walking each factual claim on the user-facing surface (locked user decisions + user-perspective verify), can I point to an implementer-executable verify step that would fail if that exact claim were violated — including preservation and error-path claims, not just success-path mutation claims?" If any claim has no such mapping, flag.

---

## 6. User Decision Handoffs

**When the plan requires a user decision mid-plan, the plan must minimize the user's path from "stop" to "confident choice".**

A user-gated phase boundary is a deliverable, not a pause marker. If the implementer must stop for the user to choose among alternatives, approve quality, or make a subjective judgment, the plan must specify a decision packet the implementer can hand over directly:
- **Decision objective**: what the choice controls downstream, and what happens after each option.
- **Options**: the exact choices available, with the tradeoff each choice changes.
- **Evidence format**: the artifacts the user should inspect, in the modality that matches the decision (e.g., screenshots for visual choices, sample matrix for style/quality comparisons). The packet must be **complete enough to reach the decision in one pass**.
- **Shortest access path**: exact URL, file path, command, screenshot bundle, or other artifact path the user can open without researching where to look.
- **User action**: the precise reply or action needed to unblock the next phase.
- **Preflight verify**: agent-autonomous checks proving the packet is viewable and the links/artifacts work before the user is asked to inspect it.

When reviewing, flag:
- A visual / audio / quality decision supported only by text when the user needs direct sensory evidence.
- Handoff makes the user research, navigate, or set up what the implementer could have prepared first — exact URLs / files / page states / sample bundles must be ready before the gate, not discovered by the user during it.
- Manual decision gates whose verify proves only artifact existence, not that the user-facing decision packet is accessible and sufficient to choose from.
- Subjective / perceptual judgment offered without an explicit per-sample rubric (dimensions to score, annotation slots, structured ballot) — freeform comparison is unstable across re-reads and across users.
- Stochastic / runtime-config-dependent output offered as evidence without per-sample activation proof — user can't distinguish "fix not applied" from "fix insufficient" (e.g., which model / branch / config the run actually used).
- Plan documents fallback branches downstream of this gate, but evidence packet lacks the diagnostic data needed to choose those branches — user must come back asking for more.

Ask yourself: "Can the user receive the handoff, inspect the necessary evidence in one pass, and reply with a valid option without asking what to open, what to compare, what the choice affects, or what data they'd need for the next branch?" If no, flag.

---

## 7. Surface Implicit Tradeoff Preferences

**Tradeoff preferences (the user's relative priority among competing dimensions) shape product form, verify-dimension priority, and implementation choices — and the user's initial task description usually does NOT include them. The plan must surface them explicitly.**

A tradeoff preference is the user's choice on multi-option decisions where no answer is universally right — e.g., "one-click idiot-proof generation vs. high-end tunable interface", "minimum-viable launch vs. all-in-one comprehensive coverage", "fastest-path delivery vs. long-term maintainability". The same tradeoff cuts across the plan, simultaneously shaping —

- **Product form** — "idiot-proof vs. tunable" literally changes which artifact gets shipped.
- **Verify-dimension priority and thresholds** — same artifact under "minimum steps + within-time-budget" vs. "maximum effect quality" gets verified by completely different metrics, with completely different pass bars.
- **Implementation tradeoffs** — "code complexity vs. evolvability", "performance vs. stability".

Because tradeoffs cut across the plan rather than living in one section, missing them is uniquely expensive — every downstream decision the implementer makes is partly random, and the consumer-acceptance gate becomes ambiguous (which dimension's threshold matters more?). This is most acute in AIGC / UX-heavy / product-strategy work; least relevant in binary feature work (it exists or doesn't) or pure technical chores (rename, dead-code removal).

When reviewing, flag:
- Plan touches user-experience / output-quality / product-strategy dimensions but contains no surfaced tradeoff — likely because the user's initial description didn't include the tradeoff and the planner accepted it implicitly. Tradeoffs the user **didn't initially express** are exactly the ones the plan must surface.
- User-facing verify lists multiple dimensions (e.g., latency, accuracy, output quality, ease-of-use) without any priority order — implementer cannot tell which to optimize when they conflict at runtime.
- Verify thresholds (numbers, "good enough" bars) appear without grounding in any tradeoff statement — the bar is arbitrary, will be argued post-hoc.
- Tradeoff stated as a planner default ("I assumed X over Y") without `AskUserQuestion` confirmation, on a high-reversal-cost surface (changes the deliverable that ships).
- Plan declares "we'll figure out the tradeoff later / based on results" on dimensions that are central to the deliverable — defers the most important decision to the most expensive moment.
- **Defaulted decision with reversal-cost ≥ medium has no trigger response (observable signal + concrete pivot)** — the plan ships the default with no runtime safety net for the most expensive class of decision.

**When the principle does NOT apply**: plan deliverable is binary (feature exists / doesn't), or all relevant dimensions are stated explicitly in the user's initial description. In those cases, document explicitly that no surfaced tradeoff is needed; don't fabricate one.

Ask yourself: "If the implementer hits a runtime conflict between two dimensions the plan claims to optimize, does the plan tell them which wins — and would the user agree with that ranking?" If no, flag.

---

## 8. Docs in Scope

**User-facing and root-level docs are plan deliverables, not discoveries during cleanup.**

When reviewing, flag:
- New features without a plan entry updating the place a user first looks — root README's Layout/Services tables, top-level how-to-add-a-thing walkthroughs.
- Sub-READMEs planned but never linked from upstream docs.
- Docs limited to "explain the code" when the reader needs "how to add / check / remove".
- Plan lists scripts to create but not the existing docs those scripts are mentioned in (first-install walkthrough, ops runbook, troubleshooting guide).

Ask yourself: "After this ships, what does a collaborator look at first — and will they find the feature there?" If no, flag the missing doc touch.

---

## 9. Simplicity First

**Minimum artifacts and minimum work that achieves the goal. Nothing speculative.**

Judge verification machinery by the combined plan footprint serving one shared invariant. Include a mechanism only when leaving it open could make conforming implementations differ in externally relevant behavior or evidence; express repeated symptom-specific mechanisms as the shared invariant / interface instead. Calibrate safety and evidence machinery to actual consequences, reversibility, downstream use, and agreed assurance requirements — not deployment status alone (see `references/rigor-tiers.md` 的 proportionality invariant).

This calibration is **bidirectional**: machinery below what the stakes warrant under-protects, machinery above it is over-rigor — both are P9 violations. It binds the reviewer's own demands too — demanding evidence heavier than the stakes warrant is itself over-rigor to flag, not a stronger review. Where a plan declares a rigor tier `(A,V)`, use it as the anchor **only after confirming the declared tier matches the actual stakes** — a mis- or under-declared tier is itself the defect, and must not be allowed to ratify under-protection or re-label a warranted demand as excess; where no tier is declared, calibrate to the real consequences and reversibility above. This ceiling governs only the **weight / intensity** of verification and authorization machinery; it does not speak to whether a coverage-existence or shortfall-discrimination assertion must exist — that floor is owned by P3–P5 and P14 — as is the existence of P17's operating contract where P17 applies — and P9 does not license striking it as over-rigor; P9 governs only the contract's granularity.

When reviewing, flag:
- Features, fields, or error-handling for scenarios the stated goal doesn't require.
- Abstractions (helpers, templates, dispatch layers) introduced for single-use code.
- Two or more artifacts where one works (example file + real file, template + generated output, config + flag-that-does-the-same-thing).
- Divergence from a nearby peer's proven pattern without a reason in the requirements.
- Transient verification harnesses whose own testing and review burden is disproportionate to the risk they cover.
- Verification / authority machinery — planned **or demanded by the review itself** — whose weight exceeds what the stakes (or a confirmed declared `(A,V)`) warrant.

Ask yourself: "Given what is actually at risk if execution or verification is wrong, would a senior engineer say every planned artifact and gate is proportionate and necessary?" If no, push back.

---

## 10. Surgical Scope

**Every file and edit in the plan traces to the stated goal. Don't widen.**

When reviewing, flag:
- New files whose purpose isn't traceable to the Before/Change/Verify narrative.
- Config fields, env vars, or keys copied verbatim from a reference without checking this plan actually needs them.
- Refactors or renames of adjacent code the goal doesn't require.
- "While we're at it" improvements to unrelated systems.

The test: every proposed file, section, and edit traces to one sentence in the goal.

---

## 11. Risk Surfacing and Response

**New coupling, external dependencies, and unverified assumptions are part of the plan — not things to discover during implementation.**

Don't use this principle to justify scope expansion — Simplicity and Surgical Scope still win in tiebreaker; use it to surface risks the leaner plan must consciously accept.

**Each surfaced risk carries two slots:** *acceptance* (why it isn't mitigated — probability / impact / cost) and *trigger response* (what runs when it fires). Trigger response is one of:
- **No-impact alternative** — preserves the deliverable's user experience. Planner writes it; implementer runs it autonomously.
- **User-impact alternative** — changes or degrades the deliverable. Planner pre-surfaces options + tradeoffs via `AskUserQuestion` *during planning* and records the user's chosen ordering (1–2 fallbacks); implementer follows that order without re-asking. See Principle 6 for the decision packet shape.
- **Stop-and-ask** — only when all pre-listed fallbacks fail and the implementer cannot locate a fresh no-impact alternative.

A trigger response fixes the next safe action and its observable result. It need not define recovery-coordinator internals unless leaving them open could change that action, correctness, or the observable result; strict sequencing is one example.

When reviewing, flag:
- New components depending on a single instance / endpoint / process whose unavailability collapses the plan.
- Tight coupling introduced to nearby modules that aren't part of the stated goal.
- Assumptions hidden inside "Before" that haven't actually been verified — version, availability, permission, performance — yet the plan rests on them.
- Required tools / environment / permissions the plan never checks for existence.
- **External-system facts (DB engine, config field, API shape, schema column, version) named from memory, not traced to a grep / read / docs lookup performed before the claim is written.**
- Risk entries that conflate two distinct response paths: **objectively verifiable assumptions** (env / version / input shape / path existence / performance baseline) belong in planner-side probes resolved *before* the plan is finalized; **subjective or irreversible decisions** (cross-system side-effects, irreversible operations, SLO trade-offs, compliance) belong in `AskUserQuestion` handoffs *during* planning. Mixing them defers both to implementation, where they're most expensive.
- Risk entries with acceptance only and no trigger response — implementer is left with no pre-set move when the risk fires.
- User-impact fallbacks left to be discovered at trigger time instead of pre-ranked by the user during planning.

Ask yourself: "If this plan ran on staging tomorrow, where would it crack first — and for that crack, does the plan name an acceptance reason plus either an autonomous no-impact alternative or a user-pre-ranked set of user-impact fallbacks?" If no, flag.

---

## 12. Iteration Cost-Aware Verify

**Verify steps that need human action cost orders of magnitude more iteration time than agent-autonomous ones. Plan verify so the slow path is sparse and pre-covered.**

A failed agent-autonomous check loops in seconds; a failed human-gated check spends the user's wall-clock attention each retry. The plan must structure verify with two constraints in mind:
- Each verify step's class is identifiable — implementer can run alone, or user action / external device / subjective judgment is required.
- Before any human-required step, agent-autonomous checks have already excluded the failure modes that the human gate could surface — so the human iteration runs against pre-screened state, not raw risk.

When reviewing, flag:
- Verify steps that don't distinguish "agent can run alone" from "needs the user / external manual judgment" — implementer can't tell where to expect to be blocked.
- Human-required steps with no upstream agent-autonomous coverage of the failure modes the gate could surface (UI logic only checked on real device when API / browser-automation could have exercised the same paths first).
- Verify written as "manual test" when an API / CLI / browser-automation / DB query / mock-driven check could exercise the same path without the user.
- A verify that backs a **costly or irreversible gate** with only a **fidelity-limited stand-in** for the real target (e.g. mock, dry-run, simulator, sampled data) — the branches that execute only against the real target (e.g. output parsing, readback, state compare) are never exercised before the gate, so defects surface serially across expensive live attempts. Common shape: an external-interface driver (CLI / API / SDK) validated per-touchpoint against mocks. Demand a real-target sweep (zero-write / dry-run harness exercising the whole path) before the gated action (see `references/rigor-tiers.md`「外部接口 driver 的 V2 落地」).

Ask yourself: "If every human-gated verify failed once, how much of that failure could have been caught by a cheap autonomous check first?" If most, the plan is misallocating iteration cost.

---

## 13. LLM Output Reproducibility (conditional)

**Applies only when the artifact's behavior depends on LLM output (generated content, decisions, classification). Skip for pure deterministic code.**

LLM-dependent artifacts differ from deterministic code in two ways evaluation cares about: outputs vary across runs / models / sampling, and the call site (prompt construction, model choice, post-processing) is itself a tunable surface. A plan that treats the LLM call as an opaque function leaves evaluators reverse-engineering the implementation to design even a single eval case.

When reviewing, flag:
- No reproducible **input → output call path**: where does the prompt come from, how is the LLM invoked, where does the output land? An evaluator should be able to run "same input → same path → observe output" without reading the implementation.
- Output **landing point and format** unspecified: file path / DB column / return shape — what does the evaluator inspect?
- No **typical test inputs** named: "what would you feed this to see it working?" If the plan can't name 2–3 representative inputs, eval design has no anchor.
- **Determinism not addressed**: deterministic outputs need the contract stated; non-deterministic outputs need the sampling strategy / seed / temperature / retry policy stated. "It depends on the model" is not an answer.

Ask yourself: "Could a downstream evaluator design eval cases from the plan alone, without re-reading the implementation to figure out where to hook in?" If no, flag.

---

## 14. Existence Is Not Completeness

**An existence check (≥1 hit / file exists / output produced) is built to fail only on total absence, never on a shortfall. When the success definition involves completeness, coverage, or count-consistency, the verify assertion must be strong enough to fail on a shortfall — an expected-vs-actual comparison, not an existence hit.**

The same passing check masks the missing data: "search the source name returns ≥1 article" passes even when the source has 10 articles and only 1 comes back. The shortfall can live *upstream* of the edited layer (ingestion / pipeline coverage a component check like "is the column indexed?" can't see) or inside the edited layer itself (a dedup dropping 9 of 10 records) — both pass the existence check identically.

**The numeric baseline need not be fixed at plan time** — the implementer derives it dynamically from real data; what the plan fixes is the comparison *action* (expected from the real input, checked against actual), where an unexplained or hand-waved gap is a defect, not a pass. A plan line like "search-by-source-name return count ≈ the source's own published total" suffices.

Applies when the change affects "how much data the user can see / get" — connect a source → searching it surfaces its (full / expected) content; process N inputs → produce the corresponding count; migrate X rows → target holds X. Pure binary features (exists / doesn't) or changes not touching data volume need not apply — say so explicitly rather than fabricate a coverage check.

When reviewing, flag:
- A verify criterion that stops at existence (≥1 hit / exists / has output) while the success definition involves completeness / coverage / count-consistency.
- A verify that checks only the layer the change touched — a component check (column indexed, function called) or one stage of a data flow — instead of the end-to-end count the user actually gets, so a shortfall anywhere (upstream, or in the edited layer itself) escapes.
- Verify that asks for expected-vs-actual but hard-codes the count at plan time when the real baseline is only knowable at implementation — should require the implementer to derive expected dynamically and compare.

Ask yourself: "If the success definition involves how completely the user should see, can this verify's assertion fail on a shortfall — or only on total absence?" If only on total absence, flag.

---

## 15. UX Contract Sync Coverage (conditional)

**Applies only when the plan changes user-facing product behavior AND the product has `docs/contracts/ux-contract.md`. Skip for pure-internal / refactor plans, and for products with no ux-contract.**

`ux-contract.md` is the whole-product user-acceptance spec. When a plan changes user-facing behavior, the user-facing slice of its L1/L2 must be projected onto the affected contract section. Example: a plan adds an export-CSV button and records its new L2 verify, but records no delta to the contract's toolbar section → the next UX test still accepts the old toolbar, and the contract no longer describes the product.

When reviewing, flag:
- The plan's record doesn't let a reviewer confirm `ux-contract.md` still describes the shipped product — behavior the contract **already describes** changed but has **no section delta** (or a delta that **mis-locates / under-describes** it), or a **net-new user-facing surface** got **no new section** added. (A change **below contract granularity**, or explicitly **outside the contract's declared scope**, legitimately needs no contract change — passes when the plan records that consciously and the reason actually holds.)
- The plan records a contract delta but its L2 verify is point-functional only, **missing the contract's acceptance lens** — the question `create-ux-contract` §1 governs: *what about this delta can only the user accept, beyond "the function works"?* (recurring instances: 验收侧重 / pass-threshold / coverage tradeoff / domain-specific acceptance for product types listed in `~/.claude/references/domain-registry.md` — not an exhaustive set.)
- The plan changes user-facing behavior but skips this principle **without the reviewer being able to confirm the skip is both intentional and that its stated reason actually holds** — e.g., the "无契约文件 → skip" note is missing, or it's present but a `ux-contract.md` actually exists / the change is in fact contract-covered.

Ask yourself: "If this plan's user-facing change shipped, would `ux-contract.md` still describe the product accurately — e.g., is the affected section's change captured correctly, and is it L2-verified with the contract's acceptance lens, not just point-functional?"

---

## 16. Batch Execution Model (conditional)

**Applies only when the plan's work includes a program iterating over independent, I/O-bound work items (e.g., eval runs against an LLM API, batch data processing, bulk API calls) at a scale where execution model materially affects wall-clock. Skip otherwise — including CPU-bound or shared-state loops, where concurrency is a different decision.**

For I/O-bound batch workloads, the execution model (serial vs bounded-concurrent, concurrency cap, rate limits) dominates wall-clock cost, and the constraints that bound it — e.g., API rate limits, quota, cost tolerance — are user knowledge the implementer cannot derive. A plan silent on execution model leaves the implementer to default to serial (hours of avoidable wall-clock) or to guess a concurrency level that may burn quota. Bounded concurrency for independent I/O-bound items is part of meeting the requirement, not speculative complexity — wall-clock is a deliverable property.

When reviewing, flag:
- Plan contains a batch-processing / eval step over independent I/O-bound items but states no execution model — serial-by-omission.
- Plan specifies concurrency against a rate-limited or metered external service (LLM APIs, paid endpoints) without stating the rate / quota / cost constraint it must respect — that constraint is user knowledge; if the plan doesn't carry it, it was defaulted, not aligned.
- Serial execution chosen for independent I/O-bound items with no stated reason (e.g., ordering dependency, debuggability — a rate limit usually argues for a lower concurrency cap, not serial).

Ask yourself: "If the implementer builds exactly what's written, will the batch step's wall-clock and quota behavior match what the user expects — and can I tell from the plan alone?" If no, flag.

---

## 17. Verification Machinery Operating Contract (conditional)

**Applies only when the plan introduces verification / authorization machinery — verifiers, evidence ledgers, canonical gates, receipt or approval systems — that enters the iteration loop and whose cost against each legitimately recurring event is not already bounded by an existing mechanism. Skip otherwise.**

Such machinery becomes part of every later fix's path to green, and itself becomes a review target. A plan that specifies what the machinery must reject, but not what each legitimate recurring event costs against it (e.g., a fix re-verifying, a human approving, a review round concluding, a configuration evolving — examples, not the set), converges on machinery that is provably strict and practically unaffordable. (Motivating case: a monitoring-delivery plan whose verification chain, approval receipts, and internal-tool reviews each charged unbounded cost to exactly these events.) The required contract's granularity scales with the stakes the plan's rigor is calibrated to — for lightweight machinery, "full re-run is cheap" is itself a valid bound.

When reviewing, flag:
- **No incremental re-verification semantics**: changes the plan classifies as carrying no verification authority (often tests, fixtures, docs — unless they define what green means) invalidate the same green lights as authority-bearing ones, and the plan does not bound what a legitimate fix costs to re-verify.
- **Approval/receipt validity windows mismatched to the responder**: a human-approval step whose receipt expires on a machine timescale guarantees at least one expire-and-reprepare round per approval.
- **Machinery review depth unbounded by the declared threat model**: the plan locks a trust boundary (e.g., same-UID attacker out of scope) but sets no rule for findings premised on excluded capabilities — so each review round can escalate out-of-scope attacks into blocking findings against internal tooling. (The boundary itself remains challengeable as a finding against the declaration; what's excluded is accepting the declaration while still blocking on capabilities it rules out.)
- **Identity/anchor coupling without an evolution contract**: records or approvals bound to a hash of mutable configuration (task manifest, config file) with no stated rule for how the chain continues after that configuration legitimately evolves — first evolution deadlocks or orphans history.

Ask yourself: "For any event the iteration loop legitimately repeats, does the plan bound what the machinery charges it?" If any is unbounded, flag.
