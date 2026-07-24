# CLAUDE.md / AGENTS.md Review Principles

Behavioral guidelines for reviewing project-level or user-level instruction files (`CLAUDE.md` / `AGENTS.md`) that shape every turn of a session. Catches failure modes that turn the loaded instruction file into noise rather than signal.

**Tradeoff:** These guidelines bias toward routing over inline coverage. When an inline safety invariant would otherwise be removed as generic advice, retain only the minimum invariant if routing it would remove a load-bearing guarantee whose miss could cause significant hard-to-recover harm; otherwise remove it. Ask when the boundary is uncertain.

**Stakes:** The active instruction file is loaded into context every turn — every line costs attention budget across the project's entire history. Pruning has correspondingly high leverage. Quality beats speed here: when uncertain whether a violation applies, ask.

**These guidelines are working if:** the instruction file routes to detail rather than holds it; inline content is scope-specific, current, and usable by a fresh session; safety-critical rules remain visible without forcing the file to encyclopedia size.

**Loop:** For each section of the file, check 1–5. Loop until no violation remains.

---

## 1. Audience Matches Loading Scope

**Keep only content needed by the agents and people in the file's loading scope. Project instruction files serve project change-makers rather than feature users; user-level files may also carry cross-project harness operation rules.**

The instruction file is loaded into context every turn. Product-facing content costs attention without guiding work and usually duplicates product documentation; user-level content that only one project needs similarly pollutes every other project.

When reviewing:
- In project files, flag product framing, installation, usage, or observability content that serves feature users rather than change-makers; route it to project documentation.
- In user-level files, retain harness operation rules needed across projects; flag project-specific or product-user content whose audience is narrower than the loading scope.

Ask yourself: "Is this instruction for consumers in this loading scope whenever it applies?" If no, route it to the narrower owning surface.

---

## 2. Routing Directory, Not Encyclopedia

**The instruction file routes each consumer to reachable detail rather than holding that detail itself. Agent rules, checklists, and procedures belong in references or skills that every applicable consumer can resolve; otherwise split the owning surfaces or retain the minimum shared invariant.**

The instruction file is loaded every turn; every inline line dilutes attention on the routing signals next to it. Detailed content that only matters for a subset of tasks should live in an on-demand doc that loads only when relevant.

When reviewing:
- Flag missing inline safety nets — a few highest-risk rules (destructive actions, concurrent-edit safety) stay inline as insurance against routing miss.

Ask yourself: "Does this line help the model find what it needs, or substitute for what it would find?" If substitute, route instead.

---

## 3. Scope-Specific Knowledge, Not Generic Advice

**Document non-obvious knowledge at the narrowest instruction scope shared by all of its consumers. Advice a capable model would follow without losing an explicit user policy or intentional default override belongs in the model's training rather than the instruction file.**

The instruction file is loaded every turn; generic advice already lives in the model — repeating it here just costs attention without adding lift. Project files hold project-specific gotchas and conventions; user-level files hold cross-project behavior that should govern every project. Putting narrower knowledge higher pollutes unrelated sessions, while putting shared behavior lower duplicates it across projects.

When reviewing:
- Flag content whose consumer scope is narrower than the file's loading scope, or shared behavior duplicated into several narrower files instead of its common scope.
- Flag content that names or source code already convey without non-obvious constraints.

Ask yourself: "When it applies, is this instruction or routing cue relevant to consumers in the loading scope, and is this the narrowest shared scope that can own it?" If no, move it down, lift it up, or remove it.

---

## 4. Currency

**Every command, path, and architecture description must reflect the current code. Stale info actively misleads — worse than absence.**

Instruction files drift as code changes: commands stop working, paths get renamed, architecture evolves. A stale instruction file is a lie the model trusts on every turn.

When reviewing:
- Treat content that has gone unverified through many relevant changes as requiring verification, not as proof of drift.

Ask yourself: "Does this still match the code?" Verify unverified claims; fix or remove confirmed drift; leave unverifiable claims unresolved rather than guessing.

---

## 5. Fresh-Reader Verification

**An instruction file is verified by what a fresh session can do with it, not by what the author thinks it says.**

The author has context the doc doesn't capture: prior conversations, mental models, and local conventions. A fresh session sees only the words.

When reviewing:
- Flag shorthand or entity references a fresh reader cannot resolve without an explicit definition or pointer.

Ask yourself: "Could a fresh agent session, with only this doc, act on this without confusion?" If no, expand or remove.
