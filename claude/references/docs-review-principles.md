# Docs Review Principles

Behavioral guidelines for reviewing project documentation (docs/ directory) — architecture, ADRs, contracts, experiences, issues, references, docs/CLAUDE.md, and their cross-file consistency with root README.md / CHANGELOG.md. Not for reviewing README content quality (use `readme-review-principles.md` for that).

**Authority**: `docs-organization-protocol.md` defines what each document type is, who consumes it, and when to read/write. These principles detect violations of that protocol — they don't duplicate its definitions. Service-ops checks (P5) additionally derive from `service-operations-protocol.md`.

**Tradeoff**: These guidelines bias toward structural correctness (right content in right place) over content completeness. Content gaps are flagged only when verifiable against the codebase.

**These guidelines are working if**: each document serves its stated consumer without requiring them to look elsewhere for misplaced content; every cross-reference lands the reader on material that says what cites it; content reflects current codebase state; indexes match actual files.

**Loop**: Check all docs/ files + root README.md / CHANGELOG.md against all principles. Loop until no principle is violated.

---

## Priority and conflict resolution

Principle 1 is a **routing gate** — content that fails audience placement belongs in another document, not improved in place.

Principles 2–4 are listed in **tiebreaker priority order** — when two give conflicting guidance, the lower-numbered principle wins.

Principle 5 is **domain-specific** — it fires only when the project runs services; it's outside the 2–4 tiebreaker order.

**Escape valve**: when applying this order would contradict your judgment of what serves the reader, ask the user before applying.

---

## 1. Audience Placement

**Content must be in the document whose consumer level matches its audience. Misplaced content forces readers to skip irrelevant sections or miss content placed elsewhere.**

The protocol (§2) defines three consumer levels:

```
  User       ← 看的最少：产品功能、变更记录、部署配置、使用验证、运维操作
  Developer  ← 中间层：+ 架构、设计决策、行为契约
  Agent      ← 看的最多：+ 经验、issues、测试 pattern
```

Each document type is tagged with its topmost consumer level (§4). Content should match.

When reviewing:
- Flag developer/agent content in User documents (README.md, CHANGELOG.md) — write-safety constraints, decision rules for adding code, internal hooks. A command belongs by who is expected to run it, not by what it touches: a lint hook is developer content, an install-verification suite is User content.
- Flag user content in Agent-only documents (experiences/, issues/) — deployment steps, usage instructions belong in README or references/.

Ask yourself: "Would the stated consumer of this document need to read this content, or only someone at a different level?" If different level, flag as misplaced.

---

## 2. Cross-reference Integrity

**Every cross-reference must put this document's reader in front of material that says what the citing text claims — and where the citation can never be corrected, it must go on doing so after the target moves on. Broken references silently misdirect readers and erode trust in documentation.**

When reviewing:
- Flag any identifier that no longer resolves where the reader stands — a path to a file that was deleted or renamed, a URL that 404s, an anchor whose heading is gone, a symbol or command that no longer exists.
- **When the check you would run gives the same reading whether the reference is right or wrong, it is not a check — read the target's content.** A drifted `file.py:123` still resolves, landing on a syntactically valid but unrelated line; a section whose heading survived a rewrite still resolves, now pointing at different material. Where the target is genuinely out of your reach, say the reference is unverified rather than passing it on an existence check.
- **Where a citation can never be corrected — the text is frozen the moment it lands — the identifier has to hold up on its own.** That is true of ADRs and archived plans, and equally of anything already sent, published, or written into history. Ask what happens to this reference when the target is next edited: if it would keep resolving and quietly point elsewhere, it is worth flagging while it is still accurate, because nobody will be able to fix it afterwards. Such a citation is a snapshot of its writing day, so the gap closes as soon as the reader is told that much and where the material lives now — however that reaches them. What you flag is a drift they would walk into unwarned.
- Ask whether this document's reader can actually reach the target. Gitignored paths, untracked artifacts, user-scope `~/...` paths and out-of-repo symlink targets all pass an existence check on the machine that wrote them, and whether they resolve for anyone else turns on what the document has established its reader already has — a path it declares as a prerequisite is reachable; one that merely looks conventional to its author is not, and a home directory holding files that ship with nothing is the common case of the latter. **Only what the reader must read in order to follow the document counts here** — a config location they will create, a log the tool will write, a path on the machine they are operating are objects of the described work, not references. The escape is reachability, not disclosure: saying "this is on my machine" names the problem without solving it.

Ask yourself, of every reference you let through: "Did I judge it from where the reader stands, with a check that would have read differently had the reference been wrong?" Clearing it on your own machine, with a check that could not have failed, is how misdirection survives review.

---

## 3. Content Currency

**Documentation must reflect the current state of the codebase. Stale content is worse than missing content — it actively misleads.**

**Verification requirement**: never flag on suspicion alone, and gather the evidence at the layer the reader acts on — what they only read is verified by reading the source; what they will run, click, or paste is verified by doing it. A check one layer below their action is a **proxy** (e.g. confirming that the symbols a command references all exist). Where their action can't or shouldn't be reproduced during review, take the closest approximation you can and say how it differs from theirs; where even that is out of reach, report the claim as unverified rather than reporting a proxy as verification.

When reviewing:
- Flag documentation sections that don't cover modules, data flows, or abstractions visible in the current codebase (architecture.md is the most common staleness target).
- Flag examples, commands, or paths in any doc that no longer work.

Ask yourself: "If a new agent reads this document and acts on it, will they get correct, current information?" — and "did my evidence come from the same action they'd take, or from a proxy one layer below it?" If not, flag as stale.

---

## 4. Index Consistency

**Index files must exactly match the actual files on disk. Index drift makes documentation undiscoverable or misleading.**

Where P2 judges the references a document makes, this principle covers **coverage**: every file must appear in its parent index, and every index entry must map to a real file.

Index points defined by the protocol:
- `docs/CLAUDE.md` — master index of all docs/ content
- `docs/adr/README.md` — ADR listing
- `docs/experiences/README.md` — topic file listing
- `docs/issues/README.md` — domain file listing

When reviewing:
- Flag index entries pointing to files that don't exist.
- Flag files in the directory that aren't listed in their parent index.

Ask yourself: "If I compare this index to the actual directory listing, do they match?" If not, flag as inconsistent.

---

## 5. Service Discoverability & Operability

**Every long-running service must be discoverable and operable through `service-operations-protocol.md`: listed in the README service section + operations/services.md, and backed by canonically-named lifecycle scripts — and, where pulled code doesn't take effect on its own, its make-live path (how code changes take effect in the running service) documented as well. A service the user can't find, can't drive with the standard verbs, or can't tell how its code changes take effect, defeats the convention.**

Read source to enumerate actual services — don't infer from docs alone. A service whose lifecycle wiring the repo doesn't own (e.g. a vendored daemon) documents its native interface, not repo scripts (convention §1) — that's correct, not a gap.

When reviewing:
- Flag a running service absent from the README service section or operations/services.md.
- Flag a documented lifecycle operation written as a raw command (`launchctl bootout`, `kill $(cat pid)`) where a canonically-named script (install/uninstall/start/stop/status) should back it.
- Flag a service whose make-live path is undocumented in README/operations, when pulled code doesn't take effect in the running service on its own (service-ops §3.5). Separately, flag undocumented migration of code-external persistent state (DB schema, on-disk config), which code convergence doesn't cover.

Ask yourself: "Could a user find this service, drive it with the standard verbs applicable to its form, and tell how its code changes take effect — all without reading its source?" If not, flag the gap.
