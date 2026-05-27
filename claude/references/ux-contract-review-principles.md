# UX Contract Review Principles

Behavioral guidelines for reviewing **ux-contract.md** — the user-facing verification specification for an existing product. Contract captures L1 (product overview + usage) + L2 (user-facing verify) + cross-cutting 验收侧重; it does **not** include L3 (agent-level verification methods, interaction tool choice, internal implementation).

**Tradeoff:** These guidelines bias toward contract accuracy and executability over document aesthetics.

**These guidelines are working if:** verify conditions are executable against the deployed product without ambiguity; contract claims match the deployed product; high-priority dimensions get proportionally deeper verification.

**Loop:** For each principle, check 1–4. Loop until no principle is violated.

---

## Priority and conflict resolution

Principles are listed in **tiebreaker priority order** — when two give conflicting guidance, the lower-numbered principle wins.

**Escape valve**: when applying this order would contradict your judgment of what serves the contract's purpose, surface the conflict instead of applying blindly.

---

## 1. Contract-Expectation Alignment

**Contract comprehensively covers the product's features and describes their intended behavior. Missing features create verification blind spots; inaccurate claims produce false pass/fail signals.**

The contract is a verification **specification** (what should be true), not a status **description** (what is currently true). Product bugs don't invalidate the contract — bugs are not accepted behavior in the contract. When a mismatch is ambiguous — behavior inconsistent with documentation or common sense but not clearly a bug — surface it to the user for judgment rather than deciding silently.

When reviewing, flag:
- L1 feature set that doesn't cover all user-reachable features, entry points, or interaction modes discoverable in the live product. **Verify against the actual deployment**, not just the document text.
- Contract-reality mismatch where the **contract** is wrong — features described that don't exist in the product, or intended behavior described that is unreasonable given the product's design. (If the product behavior appears to be a bug contradicting the contract's description of intended behavior, that's a product issue, not a contract error.)

Ask yourself: "Does the contract cover every feature I find in the product? And for each feature, does the contract describe reasonable intended behavior?" If no, flag.

---

## 2. Verify Executability

**L2 verify conditions must be unambiguous: pass/fail determinable from user-level product interaction alone. Every feature and usage pattern described in L1 should have corresponding L2 verification covering user-relevant acceptance dimensions.**

When reviewing, flag:
- Verify conditions stated as subjective qualities ("works well", "looks good", "responds quickly") without an observable pass/fail criterion. Each condition needs a determinable method — visual comparison, content match, timing threshold, or explicit "human judgment required" marker.
- Verify covering only happy paths when the product has boundary conditions (empty states, error states, extreme inputs) that matter given stated 验收侧重.
- Verify assuming context not available in the contract or user-facing project documentation — e.g., "user has configured X" but neither the contract nor project docs (README, deployment guide etc.) explain how to reach that state.

Ask yourself: "For each L2 condition, can pass/fail be determined by using the product as a user — without information beyond what the contract and user-facing project documentation provide?" If no, flag.

---

## 3. Feature Verification Coverage

**High-priority dimensions (per stated 验收侧重) must not be under-covered in L2. Under-coverage of declared priorities is the failure; thorough coverage of lower-priority dimensions is not a problem.**

When reviewing, flag:
- High-priority dimensions with insufficient L2 coverage — L2 should cover the features relevant to those dimensions, with verify conditions addressing user-relevant acceptance dimensions for each feature.

**Uniform priority is valid**: when the contract states all dimensions are equally prioritized, P4 checks that no dimension is notably under-covered — since all are equally high priority.

Ask yourself: "Are the dimensions declared as high-priority in 验收侧重 covered in L2 — with verify conditions spanning relevant features and their user-relevant acceptance dimensions?" If no, flag.

---

## 4. User-Observable Boundary

**Contract describes the product purely from the user's perspective. Internal implementation and agent-level verification methods belong to L3, not the contract.**

When reviewing, flag:
- L2 verify in implementation terms — internal APIs, database states, backend response codes, state machine transitions, log entries. Rewrite as user-observable conditions.
- L1 descriptions referencing architecture ("uses microservices", "Redis-backed") instead of user-visible behavior.
- Agent-level verification methods in contract ("check logs for X", "inspect network request to Y") — those are L3, not contract content.

Ask yourself: "Could a non-technical user understand every claim in this contract without knowing how the product is built?" If no, flag.
