# Evangelism Review Principles

Behavioral guidelines for reviewing evangelism docs — internal write-ups whose primary job is to spread an idea, tool, or methodology and shift readers toward adoption. Distinct from READMEs (which walk a committed user through a task) and runbooks (which are referenced under pressure).

**Tradeoff:** Precision over recall — include only what the in-scope reader will find genuinely useful; borderline content is cut, not kept for coverage. Dense, scannable formats (tables, diagrams, callouts, bold/highlighted key terms) over comprehensive prose.

**Stakes:** Evangelism docs compete for attention in a queue. Readers scan title, header, and visuals first, then decide whether to invest more — most never get past this gate. A reader who drops off at the scan stage is a permanent loss. The doc must succeed at the scan stage to succeed at all.

**Success metric:** Readers can extract the doc's core value (claim, benefit, action to take) with minimal time investment. Scanning the first viewport yields the takeaway; deeper reading yields proportional new signal.

**These guidelines are working if:** the first viewport answers "why should I care" and "what's the takeaway"; core content and detail are visibly separated; readers can state the doc's claim after a one-glance scan; nothing repeats when one statement upstream would do; the structure between parallel items conveys their relationship, not just their existence.

**Loop:** For each section of the doc, check 1–5 in order. Loop until no principle is violated. When two principles conflict on the same content, lower-numbered principles take precedence — they represent higher-priority structural decisions.

---

## 1. Takeaway Before Deep-Dive

**Design the first viewport to communicate the doc's core claim, reader benefit, and credibility signal at first glance — evangelism docs are scanned, not read top-down. Readers who can't locate the value proposition immediately drop off permanently.**

When reviewing:
- Flag docs whose top-of-doc doesn't communicate the takeaway in one glance — TL;DR / hook owns the first viewport.
- Flag missing reader benefit ("what do I gain") or credibility signal ("why trust this") in the first viewport.

The test: from a first-viewport scroll, the reader can state the doc's claim in one sentence, name the benefit, and know whether to deep-dive.

---

## 2. Main Flow Carries Only Core Content

**Core information lives in the main document flow. Non-core information — reference material, detailed how-to, full code blocks, exhaustive configuration — goes in appendices, linked documents, or collapsible sections. Precision over recall: when in doubt, move it out.**

When reviewing:
- Flag content in the main flow that supports the claim but isn't required to understand it — move to appendix or linked doc.
- Flag full code blocks, file listings, or configuration dumps in the main flow when a summary or link would convey the same point to most readers.

The test: for each paragraph in the main flow, ask "if this section were absent, would the reader fail to understand the claim?" If they'd still get the claim, relocate it.

---

## 3. Why Before How

**Lead with why (problem, tradeoff, rationale) before how (commands, file lists, syntax). Inverted order reads like documentation, not insight, and trains readers to copy mechanically.**

When reviewing:
- Flag docs that open with usage examples, file lists, or commands before establishing why the artifact exists.
- Flag missing tradeoff statements — non-obvious choices owe the reader a "what we gave up to get this".
- Flag rationale diluted by interleaved procedural detail.

The test: if the reader stops after the why section, can they decide whether to adopt and how to adapt?

---

## 4. Maximize Information Density

**Every paragraph competes for attention. Maximize signal density two ways: format (image / annotated screenshot / table / bullet list / diagram beats prose for parallel or comparative content) and explanation (trust the in-scope reader to follow links, infer from examples, fill gaps).**

When reviewing:
- Flag parallel or comparative content rendered as prose — that's a table, bullet list, or diagram.
- Flag prose that could be made scannable with a denser format (callouts, bold key terms, diagrams) — evangelism docs are scanned, not read linearly.
- Flag content within the in-scope reader's prior — trust them to fill from context.
- Flag pre-emptive disambiguation and edge-case enumeration — that's recall-optimizing in a precision-first medium.

Ask yourself: "given this content stays, can the same point land in a denser format — table, diagram, shorter sentence — that the in-scope reader still follows?" If yes, compress.

---

## 5. Structure Must Carry Information

**The doc's structure must carry information, not just organize content. When N items share the same framing, write it once at parent level. When parallel concepts have a relationship, depict it visually — sequence, loop, hierarchy.**

Two structural failures waste reader attention. *Predictable boilerplate*: each parallel section repeats the same setup, teaching readers to skim everything — including the parts that carry unique signal. *Flat enumeration*: N items depicted as equally weighted and independent when they're not, outsourcing the synthesis the doc owes the reader.

When reviewing:
- Flag parallel sections where each repeats the same setup, definition, or framing — hoist to parent level.
- Flag table columns whose values are identical or trivially predictable across rows — that column belongs in caption or above.
- Flag parallel concepts depicted as flat lists or tables when they have a relationship (sequence, loop, hierarchy) that should be visually carried.
- Flag visual treatments that don't encode meaning stably — decorative, collapsing distinct concepts into the same style, or shifting the same style's meaning across the doc.

The test: across parallel items, count what's unique vs. what repeats — if repeated > unique, hoist it. Across parallel items, does the visible structure show how they combine, or only that they exist?
