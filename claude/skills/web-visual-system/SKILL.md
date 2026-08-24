---
name: web-visual-system
description: "Decide how a web interface looks — its form factor (workbench / document / feed / dashboard), how much of each visual device it spends, and its parameters (type ramp with paired line-heights, spacing ladder, color roles, elevation, radius family, motion, numerals, interaction states). Use when styling a new interface, restyling an existing one, matching a reference product, or when a page is judged generic, cluttered, cheap, 'obviously AI-generated', or wasteful of space despite working correctly. Also use for small restyles and additions to an existing page — whether it already has a system is what this skill measures, not something to assume. Not for repairing one element's own layout or rendering bug — even when the fix is a small restyle."
user-invocable: true
---

Supply what a web interface needs in order to look designed rather than assembled. This is the generation side; `design-critique` is the judgment side.

**Three layers, decided in this order.** Later layers are meaningless without earlier ones — and the failure this skill was rebuilt to fix lived entirely above the layer it used to cover.

| Layer | Decides | Instrument |
|---|---|---|
| **L0 form factor** | What kind of surface this is: workbench / document / feed / dashboard | Judgment, or copied wholesale from a reference |
| **L1 spend** | How much of each visual device the page uses — how many badges, how many hues, how much of the width, how long the page is | `~/.claude/bin/visual-budget` — **readings, plus one outlier gate built from three uncalibrated constants** |
| **L2 parameters** | Token values: spacing ladder, type ramp, radius family, elevation, motion, state matrix, color roles | `scripts/validate-visual-system.js` |

## Why the layers, and why L1 has almost no judgments

*(This section is the calibration record. Read it before you are tempted to add a threshold.)*

A page went out with L2 done **correctly** — closed spacing ladder, radius family with a nesting rule, per-step line-heights chosen for CJK, a deliberate `--measure` — scored **10/12 "system present"** on the L2 validator, and was judged by its owner as cluttered, ugly, and wasteful of space. Same run, same viewport, the reference he was happy with scored 11/12. A second page he was **also** happy with scored **0.417 and was recorded as "no system, not a reference to pick again"**.

The L2 validator's reading was **anti-correlated with satisfaction on that sample**, and on the checks it does run, the disliked page won (motion coverage 100% vs 79%; tabular numerals 65/65 vs 2/2). It was not silent; it pointed the wrong way. Everything the owner objected to lived above L2: composition, spend, form factor.

So L1 was built. Then it was calibrated against 9 widely-respected pages, and **the calibration killed almost all of it**:

| Candidate criterion | Verdict | Counter-example |
|---|---|---|
| Few hue buckets = good | **disproved** | IBM Carbon 8, AWS Cloudscape 9 — both above the page judged bad (6) |
| Few saturated colors = good | **disproved** | Cloudscape 100 |
| Few border styles = good | **disproved** | Plotly 15 = the bad page's 15 |
| Low border density = good | **disproved** | The owner's favourite reference sits at 21.8; the bad page at 25.6 |
| Region fill ratio | **disproved** | Its 54% came from a *correct* `--measure`; the fault was container width, not measure |
| Width claim | **three operationalisations all failed** | `<main>` box → 5/5 degenerate at 1.000; page-wide ink union → bad page reads 0.975 (a full-bleed banner fills it); scanline through the data region → bad page 0.703 sits *between* two liked pages at 0.677 and 0.762 |
| Repeated-badge count | **survives only as "extreme outlier"** | good pages 0–48, bad page 1767. **Nothing sampled between 48 and 1767**, so no boundary exists |

**One caveat on that last row, and it is the kind that quietly invalidates a calibration**: those corpus numbers were taken with an earlier counting rule that required the badge to be a childless leaf. An external review showed that rule was DOM-structure dependent — wrapping `<span class=badge>OK</span>` in another span changed the count from 1 to 0 without changing a pixel — so the rule was replaced with paint-and-geometry detection plus nesting de-duplication. The two anchor points were re-measured under the new rule and both verdicts hold (bad page 1754 vs 14 = 125×, fires; fixed page 3 vs 14, does not). **The other nine pages were not re-measured**, so treat the 0–48 range as indicative of the old rule, not as a calibrated band for the current one.

**Region fill ratio is worse than useless as a regression check — it moves against you on a good change.** Measured: a delivery report whose oversized summary block was fixed read `data_region_coverage` **0.672 → 0.37**, *at the same `scan_y`* (1078). Re-derive with `visual-budget <url> --ready 'section>=5' --data-region main --json | jq '.page.scan_y, .page.data_region_coverage'` against `video-eval-arena` `arena/static/rt-delivery-report.html` before and after commit `889c870` — the reading is a property of that page pair, not of this file, so it is reproducible rather than asserted. Nothing got narrower; the block above got shorter, so the one scanline stopped landing inside a card with a painted background and landed on prose at its correct 74ch measure instead. Two failure modes here, and the second is the dangerous one: the metric is a **single line** at the region's centre, so it reports whatever happens to be at one y; and because "painted" includes container backgrounds, **a page reads denser the more card chrome it has**. Do not diff it before/after — if you do, it will tell you the improvement was a regression.

**The lesson is the section, not the table**: cross-page thresholds for visual spend did not survive contact with a diverse corpus. Two orders of magnitude is visible; a factor of two is not a defect. If you find yourself about to write "≤ N is good", you are repeating the mistake this file was rewritten to record.

## The same pixels read as restraint or as waste — and which one is measurable

The complaint that starts most of these jobs is *"it doesn't use the space, the sides are just empty"*. That complaint is sometimes the real defect and sometimes a correct `--measure` doing its job, **and a screenshot cannot tell you which** — the two look identical. Measured here: a report page was read off a screenshot as "prose left-aligned in a 1520px container leaving a ragged void", and the fix was about to be a full-bleed conversion. The actual readings: prose median **710px = 74.0 ch**, container **1560px**, tables **1254–1288px** — i.e. the page was already implementing the document tier exactly as `reading-instance.md` specifies. There was nothing to fix. (Source page: `video-eval-arena` `/report`, i.e. `arena/pages/report.html`, at 1920×1080. Re-derive by taking the median `getBoundingClientRect().width` of its `p` elements and dividing by the width of one `0` in their computed font — the numbers are a property of that page, not a claim this file can settle.)

**Before treating "wasted space" as a defect, take one reading: is the text at the measure its own tier declares?**

| Reading | Verdict |
|---|---|
| Text runs at the declared measure (~65–75ch), and non-text — tables, cards, code — takes the full column | Not a defect. The whitespace is the design. Say so and stop. |
| Text runs at the declared measure but **everything else is capped with it**, so tables and cards sit in the same narrow ribbon | The cap is on the wrong element — it belongs on text, not on the container |
| Text runs well **under** its declared measure | Something upstream is eating the measure — find it before widening anything |
| No measure is declared, and this tier **has** one (document, feed, and the prose regions of a workbench) | That tier's parameters were never applied. Go get them before judging the whitespace |
| No measure is declared, and this tier **has none** — a full-bleed workbench, dashboard or canvas that is all controls and data | Not a finding at all. Judge it on its own tier's axes; a missing measure says nothing about whether L0 was decided |

**The last two rows exist because collapsing them was a real error in this file** (caught by external review): "no measure declared" was written as "L0 was never decided", which sends an agent back to redo the form factor on a page whose form factor is settled and simply has no prose in it. Ask which tier it is *first*; the measure question only has an answer inside a tier that defines one.

The reason this is worth a rule: the first and fourth rows produce the **same** visual impression and the **opposite** correct action. Widening row one is damage, and it is damage that will be praised, because "now it uses the whole screen" is exactly what the complaint asked for.

## L0 — form factor, before any token

Name the surface before styling it. Everything downstream inherits from this, and it is the only layer where copying a reference wholesale is both cheap and correct.

| Form factor | The reader is here to… | Shell |
|---|---|---|
| **workbench** | operate on many records, comparing and drilling | Full-bleed shell, persistent nav claiming its own column, fluid main region, data on the first screen |
| **document** | read start to finish | Single measured column, generous margins, anchor nav; see [`references/reading-instance.md`](references/reading-instance.md) |
| **feed** | scan for something worth opening | Repeating cards, one column of interest, cheap scanning |
| **dashboard** | watch state at a glance | Fixed tiling, no scroll for the primary answer |

**The four above are not a closed set** — editor / canvas, chat, wizard / form and landing pages do not honestly fit any of them. When none fits, name the surface in your own words and say so; forcing it into one of these four is worse than admitting the table does not cover it.

**Only `workbench` and `document` have measured before/after evidence here** (one page, one conversion). `feed` has a single lateral sample; `dashboard` has none. For those two, produce readings and say the form factor is unvalidated — do not derive judgments from them.

**The tell that L0 was never decided**: the page has been patched repeatedly for symptoms of being the wrong shape. Comments like *"this used to be 1.06 screens below the entry"*, *"a 33000px page had no navigation at all"*, *"this block was open and took 42% of the distance to the first video"* are each locally correct fixes that could never question the shape, because nothing put the shape on the table.

## L1 — spend, measured against a reference

```bash
~/.claude/bin/visual-budget <url> --reference <ref-url> \
  --ready '<selector>>=N' --reference-ready '<selector>>=N' \
  [--data-region <selector>] [--reference-data-region <selector>] [--viewport 1920x1080]
```

`--ready` is **required** and per-page: it names an anchor that can only exist once the real content
arrived, and the probe counts only its **visible** matches. Without it a page whose request failed but
which still rendered a nav, an empty state and an error card sails straight into normal readings —
and those readings look like an exquisitely restrained design. Skipping it takes an explicit
`--no-ready-gate`, which prints in the output and marks that run as not verified.

`--ready` and `--data-region` are **caller-supplied semantic premises, not something the probe calibrated**:
you are deciding which region does this page's job and which anchor means "content arrived". The probe
prints both back on every run precisely so a later reader can audit whose judgment the numbers rest on.

It emits, for your page and the reference side by side: repeated-element counts (badges/pills/chips), distinct saturated colors and hue buckets, distinct border styles, border density, radius family size, page length in screens, and content coverage on a scanline through the data region.

Exactly **one** of those is a gate — but it is built out of **three uncalibrated constants, and they are named here because "no thresholds" was not true**:

- **Extreme outlier**: a repeated visual element at **≥10× the reference's count of the same thing, AND ≥50 in absolute terms**. It asserts only *"this is extreme relative to that reference"* — never *"this page fails"*.
  - The multiplier comes from one negative example; the floor from the top of the observed positive range (48).
  - Their combination has **known discontinuities**, and pretending otherwise is how a threshold gets trusted: reference 0–4 with 49 on your page does not fire (floor); reference 5 with 50 does fire (two more than the highest good page seen); reference 20 with 199 does not fire.
- **A difference threshold of 25%** decides which readings demand an answer. `120 vs 100` is silently not a difference. This one is easy to miss because it does not print as a gate.

All three are overridable (`--outlier-multiple` / `--outlier-floor` / `--diff-threshold`) and all three are printed on every run, next to the caller-supplied selectors. **Print them in your report too** — a reading whose thresholds are invisible cannot be audited.

Everything else is a **reading plus an obligation**: for each metric where you differ from the reference, write one sentence saying why. The probe exits **incomplete** — not "pass" — until every difference has an answer. The program guarantees the question gets asked; it cannot and does not judge the answer.

**Take the readings in the region that does this page's job, at the width its readers use.** A whole-page or first-screen aggregate averages the problem away: on the page that started this, the first-screen numbers were *better than* both liked references (0.975 width, 4 colors, 11 bordered boxes) while the metric tables four screens down carried 1721 badges and 1979 borders.

**Every page-scale aggregate needs a render-readiness gate.** An unrendered page reads as an exquisitely restrained one — measured: the same census reported "2 saturated colors, 14 bordered boxes, 5 border styles" on a page whose data had not arrived, and "4 colors, 209 boxes" once it had. `page-repetition` hit the same trap in the same session, counting 465 of a page's 72,885 characters and reporting **pass**. Gate on something that can only be true after the content exists, and report `unresolved` rather than a number.

## L1b — three readings that need no calibration at all

Everything above is empirical: "how many colors is too many" needed a corpus, and the corpus mostly said *no*. **These three are different in kind.** They are true by construction, so they need no reference, no corpus and no threshold — and conflating them with the empirical ones is how a weak claim borrows a strong one's credibility. `visual-budget` reports them separately and exits `6`, not `1`.

### 1. A repeated structure must repeat *identically*

When the same block appears many times down a page, the same column must land at the **same x** in every instance. A reader who scrolls through 90 tables should never have to re-find where a column is.

Measured as: distinct x positions of the same header label, grouped by *(label, column count, container class)*. **`> 1` is a defect, always.** Grouping matters — grouping by label text alone conflates two families of table that legitimately start at different x, which is a false positive this probe shipped once and had to fix.

The usual cause is `table-layout: auto`: each table sizes its first column to its own longest content, and every value column downstream inherits the wobble. Measured on a real page: the same header at **8 distinct x, spanning 542px**.

### 2. Anything that expands must show that it expands, and its current state

Measured as: a `<details>` whose `<summary>` **renders identically open and closed** — the probe toggles `open`, diffs a signature of the summary's pseudo-elements, transforms, background images and icon children, and restores the previous state. **`> 0` is a defect.** The usual cause is invisible: setting `display: flex` or `grid` on a `<summary>` silently removes the browser's default triangle, because that triangle depends on `display: list-item`. Nothing errors; the affordance just stops existing. Measured on a real page: **92 of 128** disclosures with no marker at all.

**The criterion is "does anything change with state", not "is there an icon"** — two earlier versions of this check tested for a marker's *presence* and were wrong in both directions, each caught by external review with a concrete case:

| Written as | False positive | False negative |
|---|---|---|
| only `::before` has content | `::after` chevrons, `<svg class=chevron>`, background-image markers | — |
| any of those graphics is present | `summary::after{content:"";border-right;border-bottom}` — a chevron drawn from *borders* on an **empty** pseudo-element, the most common way to write one | an avatar `<svg>` unrelated to expansion makes a page with **no** affordance pass |

Presence is not the property the reader uses. What they use is that it *moved*.

### 3. Repeated text is not noise — it is a layering decision that was never made

Measured as: the highest count of one identical string among leaf elements. There is **no threshold** here and there should not be one; the number is a prompt, not a verdict. Measured on a real page: one 12-character gloss printed **465 times**.

Ask of each repetition: **which layer does this sentence actually belong to?** Four answers cover almost everything:

| The repeated thing is… | Its real layer | What that looks like |
|---|---|---|
| a property of the **column** | the header | state it once in `<th>`, drop it from the cells |
| the **gloss of a state** | a legend | cell keeps a compact token (`N/A`, `未记录`); the sentence goes to one legend plus each cell's `title` |
| a property of the **row's object** | that row, on demand | an `ⓘ` disclosure — reachable in one click, absent from the default surface |
| a marker for something **the value already says** | nowhere | delete it. A cell containing a number does not also need a badge saying it produced a number |

**Not one word has to be deleted for any of these.** That is the point, and it is what separates layering from truncation: the reader who needs the sentence is one hover or one click away, and the reader who does not gets a page they can scan.

**Two traps, both hit in practice:**

- **Shrinking the repetition is not the same as removing it.** Replacing a 12-word gloss with a 6-word label, printed 270 times, is still 270 repetitions. If the answer is "on demand", the affordance should be an icon with a `title` and a screen-reader label — not an icon plus a caption.
- **The layer is chosen by semantics, not by how much ink it saves.** The cheapest layer is often the wrong one. A fact that happens to be constant across this batch is *not* thereby a property of the batch — see the D-026 note in the verify section. Ask "would this jump layers if the data changed?" If yes, that layer is wrong.

**What must not be collapsed**: anything that is a *warning*. Whether a block may be folded away is decided by whether a reader who never opens it can still be misled — not by whether it is text. Two blocks emitting "partially synced" and "measured at unknown time" were folded into a collapsed explainer, and the page went on drawing stale metric numbers with no signal at all.

## L2 — parameters

Unchanged and still required. It was never disproved; it is just not sufficient.

| Parameter | What must be decided | Tell when it was never decided |
|---|---|---|
| **Type ramp** | Each step's size **paired with its own** line-height, weight role, letter-spacing | One global `line-height` multiplier producing fractional computed values (17.4px, 21.75px); weights jumping 400→700 with no mid-tier |
| **Spacing ramp** | One base unit and a closed ladder; every spacing value on it | Values off the ladder (7, 10, 14, 18, 22px alongside 4, 8, 12, 16) |
| **Density** | Control height, row height, section rhythm — derived from the ramp | Padding chosen per component, so no two components share a rhythm |
| **Surface & line** | Which single mechanism separates a surface from its background: border, shadow, or tint | All three applied weakly at once, or one flat shadow used everywhere |
| **Elevation ladder** | Which levels exist and what sits at each. A system may separate by line and tint alone; if it uses shadow, each level is a **multi-layer** stack | One single-layer shadow token on every raised thing |
| **Radius family** | Outer radius, the nesting rule for inner radii, and the pill case | Several unrelated radii; inner corners not narrower than outer |
| **Motion** | One duration + one easing for state change, the property list, the reduced-motion branch | Zero transitions — state changes snap |
| **Numerals** | Where numbers align in a column; proportional or tabular face | Proportional numerals in a data table |
| **State matrix** | Every state an interactive class can reach — at minimum default, hover, focus-visible; plus active, disabled, selected where they exist | Hover styled, focus left to the UA ring |
| **Color roles** | Semantic roles mapped to values, foundations tinted toward the brand hue | A flat list of hexes with no role; untinted foundations |

Derivation order within L2 — deciding out of order forces rework:

```
base unit → spacing ramp → type ramp → density → radius family → elevation ladder → motion → state matrix
                                          ↑
                                   color roles (independent)
```

**`type ramp` precedes `density`, not the other way round.** This file had it reversed until an external review caught it against its own references: `reference-instance.md` states that control height follows from its line-height plus vertical padding, and `reading-instance.md` recomputes row and control heights whenever the type ramp changes. Deciding density first therefore forces exactly the rework this ordering exists to prevent.

[`references/reference-instance.md`](references/reference-instance.md) is one fully specified L2 instance (data-dense technical interface). [`references/reading-instance.md`](references/reading-instance.md) is the reading-tier instance and carries the axes a console never needs. **To target a different look, keep the structure and substitute the values** — and change the `EXPECTED` block at the top of the validator with them, plus any instance-specific prose around a table.

## Does this page already have a system? — ask it per layer

"I am working inside an established system" is what most callers assume and few have measured. On a page that never had one, "follow the system already in place" means the browser's UA defaults keep deciding: add a `<ul>`, write no CSS, and the UA's own padding and margin land as real spacing values.

**Measure each layer separately. They fail independently, and the whole point of the rebuild is that L2 passing tells you nothing about L0 or L1.**

- **L2**: run the validator. Read the **pass rate over checks that were evaluated** — `PASS / (PASS + FAIL)`; `UNCHECKED` gets no vote. **Denominator must be ≥6**, or there is no verdict. `≳0.65` = a system is present; `≲0.35` = none; in between = not answered, go read the failures against the false-positive table below.
- **L1**: run `visual-budget`. There is no pass rate — read the numbers next to the reference's.
- **L0**: name the form factor. If you cannot, that is the answer.

```bash
agent-browser eval "$(cat ~/.claude/skills/web-visual-system/scripts/validate-visual-system.js)"
```

It only runs inside a rendered page — `node validate-visual-system.js` fails with `ReferenceError: document is not defined`.

**Most L2 `FAIL`s do not answer the question.** Ten of fourteen checks can fail on a genuinely designed system:

| Check | Fails on a designed system when |
|---|---|
| `neutrals tinted` | The instance chose untinted foundations — IBM Carbon's `#ffffff` / `#161616` fails it |
| `shadows are multi-layer` | A focus ring is `box-shadow: 0 0 0 3px` **and the run happens with that control focused** — the plain `eval` above measures the unfocused state |
| `tabular numerals` | Prose contains a bare number. The parameter is about numbers **in a column** |
| `no layout-property transitions` | An accordion animates `height` on purpose |
| `line-heights are integers` | The ramp uses per-role ratios. Computed values carry no provenance |
| `focus-visible defined` | The stylesheets declare no `:focus-visible` rule — including a document with nothing focusable |
| spacing ladder, type-step count, weight tiers, motion coverage | The page's ladder differs from `EXPECTED`. Substitute the page's values and re-read; if no self-consistent ladder can be reconstructed, that failure is itself the answer |

Run conditions move the bands — a coherent page reads 8/12 unfocused and 8/13 with a control focused. Treat them as two clusters with a wide gap, not a calibrated scale. `UNCHECKED` is not evidence of absence: a system separating by line and tint alone gives the shadow checks nothing to look at, and `focus-visible` / `reduced-motion` both abstain whenever any stylesheet is cross-origin.

[`scripts/calibration/`](scripts/calibration/) holds the pages behind those readings.

## Getting a reference — and qualifying it **per layer**

| Situation | Do this |
|---|---|
| A real product is named ("make it look like X") | Qualify it per layer (below), then probe it with `scripts/probe-visual-system.js` and `visual-budget` |
| A published design system is named | Take its documented token values for L2 directly; probe its docs site for L0/L1 |
| The surface is a document meant to be read start to finish | [`references/reading-instance.md`](references/reading-instance.md) |
| No reference in hand | An absent reference is a problem to solve — see below |

**Qualification is per layer, and a reference can qualify for some and not others.** This is not a refinement; it is the fix for a recorded failure. A news site the user had explicitly named as a reference was probed, scored **0.417 on L2, and was written down as "no system, not a reference to pick again"** — while the user went on wanting its composition and its restraint. He was right and the qualification was wrong: the page is **L0/L1 qualified, L2 disqualified**. A single verdict per reference cannot express that, and throwing the whole page away throws away the layers he was actually pointing at.

Record each layer's verdict separately in [`references/chosen-references.md`](references/chosen-references.md), with the readings that produced it. A layer never examined is recorded as never examined — not as absent.

**Probing the reference and your own page in the same run and the same conditions** is what makes them comparable; a described reference is a lossy projection of the running one. When a reference is in play, `~/.claude/references/web-ui-observation.md` governs the comparison.

### When no qualifying reference is in hand

**First, is this surface throwaway** — a debug page, a one-off nobody returns to? Then none of the below: start from `references/reference-instance.md` and substitute color roles and faces. Everything after this is for a page that will be around.

1. **Look up [`references/chosen-references.md`](references/chosen-references.md)**, matching on the audience and scenario each entry is headed by. A hit whose decision was made **for this same product** is already a named reference — go back to the table above. Two things cancel that: the user signalling they want off it, and that entry being the one that just failed to qualify.
2. **Search for fresh candidates regardless of a hit** — on a hit, at least one candidate must come from outside the file, or it becomes a ceiling. Candidate discovery is a search with a mandatory procedure: `~/.claude/references/evidence-sufficiency.md`「发现候选的检索」 governs it, category-fixing included. **Expect it not to converge**: three rounds on three axes here each surfaced a new sub-family, and the pre-registered `X` never appeared. Report that rather than claiming a complete list.
3. **Present the candidates with trade-offs, name your recommendation and why, let the user choose** (`AskUserQuestion`, per the user-level Surface Choices rule). A subagent, having no `AskUserQuestion`, hands back the candidates, their trade-offs, its recommendation **and the traits it measured**, names the pick as outstanding, and stops there.
4. **Write the pick into `chosen-references.md`**, per layer, with the measured readings.

Two outcomes end this with no reference: no qualifying candidate, or the user picked none. Both land at `reference-instance.md` with values substituted.

## Verify before claiming it is fixed

Run **all four**, in this order, and report all four. The first one has no instrument, which is exactly why it gets skipped — an agent that runs the two probes and glances at the page can claim all three layers done while never having decided L0 at all.

1. **L0 — restate the form factor and check the shell against it.** In one sentence: what kind of surface is this, does the shell match (nav placement, width behaviour, what is on the first screen), and — if the form factor is one this file records as unvalidated — say so. **No probe covers this.**
2. **L1 — `visual-budget`.** Readings beside the reference. Every difference answered; and note that "answered" is not "justified" — the program only checks the text is non-empty, and someone has to read those answers. **Report the three L1b readings too** — they need no reference, so there is never an excuse for omitting them.
3. **L2 — `validate-visual-system.js`.** PASS / FAIL / UNCHECKED per check, against the rendered page, not the stylesheet.
4. **Look at the page.** No check tells you whether the result looks right, and the probes are blind to entire classes of defect by construction.

Four things the numbers will not tell you, each of which cost a real cycle here:

- **A layer moved to the wrong scope reads clean.** A fact deduplicated from cells up to rows, then up to tables, produced 0 leaks, 0 over-fires and green tests both times — and was wrong both times, because the project's own record put that fact at cell scope. **Semantic layering has no reading; only a contract or a person can judge it.** Ask "would this jump layers if the data changed?" — if yes, the layer is wrong.
- **Collapsing things by density is not free.** Whether a block may be collapsed depends on **whether it is a warning**, not on whether it is text. Two blocks that emitted "partially synced", "missing N", "measured at unknown time", "parse failed" were folded into a collapsed explainer, so the page kept drawing metric numbers while the reader had no signal they were stale.
- **On an evaluation surface, "which controls are visible by default" is part of the viewing condition.** Collapsing the control that decides *which subjects appear on the page* is a change to the experiment, not a density improvement.
- **Persistent navigation must be measured after scrolling.** Readings that only prove a media-query branch fired and nothing overflows do not prove the nav is still reachable; and `inView` does not prove it is unobscured — use a hit test.

Then check contrast on whatever you just made quieter. Demoting a status color from a warn role to a subtle ink took an 11px badge from 9.52:1 to **3.87:1** on its real background — below AA — and no L1 or L2 check looks at contrast.

## Not this skill's job

- Whether the content is any use to the reader → `~/.claude/references/web-ui-observation.md`「交付前的最低证据」 and `~/.claude/bin/page-repetition`.
- Information architecture, cognitive load, emotional register → `design-critique`.
- Whether the primary elements actually rendered → `~/.claude/bin/page-acceptance`.
- Real multi-state usage by a person → `/custom:test-ux`.
