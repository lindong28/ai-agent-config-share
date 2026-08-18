---
name: web-visual-system
description: "Decide a web UI's visual system parameters — type ramp with paired line-heights, spacing ladder, color roles, elevation levels, radius family, motion, numerals, interaction states. Use when a page has no visual system or an inconsistent one: styling a new interface, restyling an existing one, matching a reference product, or when a page is judged generic, unpolished, cheap or 'obviously AI-generated' despite working correctly. Also use for small restyles and additions to an existing page — whether it already has a system is what this skill measures, not something to assume. Not for repairing one element's own layout or rendering bug — even when the fix is a small restyle."
user-invocable: true
---

Supply the parameters a web interface needs in order to look designed rather than assembled. This is the generation side; `design-critique` is the judgment side. A page can pass every functional test, satisfy every heuristic rubric, and still read as vibe-coded — because *nothing ever decided its parameters*. That decision is what this skill makes.

## Does this page already have a system?

"I am working inside an established system" is what most callers assume and few have measured. An existing page reads as established simply because it exists, and on a page that never had a system, "follow the system already in place" means the browser's UA defaults keep deciding. Add a `<ul>`, write no CSS, and the UA's own padding and margin land on the page as real spacing values — 28 of them in one measured case. Every such addition is small and locally correct; none is ever large enough to read as "restyling an interface".

Measure instead of assuming. Same validator as the one under **Verify**, run before the work:

```bash
agent-browser eval "$(cat ~/.claude/skills/web-visual-system/scripts/validate-visual-system.js)"
```

It only runs inside a rendered page — it reads `document` and `getComputedStyle`, so `node validate-visual-system.js` fails with `ReferenceError: document is not defined`.

**Most `FAIL`s do not answer the question.** Ten of the validator's fourteen checks can fail on a page whose system was genuinely designed — six because the check is narrower or stricter than the parameter it stands for, four because they compare the page against `EXPECTED`:

| Check | Fails on a designed system when |
|---|---|
| `neutrals tinted` | The instance chose untinted foundations — IBM Carbon's `#ffffff` / `#161616` fails it |
| `shadows are multi-layer` | A focus ring is `box-shadow: 0 0 0 3px` **and the run happens with that control focused** — the plain `eval` above measures the unfocused state and passes. The same validator's `focus-visible` check accepts that very shadow as a valid cue |
| `tabular numerals` | Prose contains a bare number. The parameter this skill defines is about numbers **in a column** |
| `no layout-property transitions` | An accordion animates `height` on purpose |
| `line-heights are integers` | The ramp uses per-role ratios (1.6 body, 1.3 heading). The source says so itself: computed values carry no provenance, so it cannot tell a per-step choice from one global multiplier |
| `focus-visible defined` | The stylesheets declare no `:focus-visible` rule — including a document with nothing focusable. The check looks for the rule, never for controls |
| spacing ladder, type-step count, weight tiers, motion coverage | The page's own ladder differs from `EXPECTED` at the top of the validator. Substitute the page's values and re-read; if no self-consistent ladder can be reconstructed, that failure to reconstruct is itself the answer |

Because any single `FAIL` is that weak, read the **pass rate over the checks that were evaluated** — `PASS / (PASS + FAIL)`. `UNCHECKED` gets no vote: its count tracks what the page happens to contain, not whether anything was decided.

**The denominator has to be at least 6.** Below that the rate stops measuring the page and starts measuring how much of it there was to look at: a thin page that never had a system scores 3/5 = 0.60, close to the top band, purely because only five checks found anything to evaluate. A short denominator means no verdict — go read the failures individually.

| Pass rate | Reading |
|---|---|
| ≳ 0.65 | A system is present. Measured unfocused, default viewport: a coherent console page 8/12, a long-form document 5/6, a page on a ratio-based ramp 5/6 |
| ≲ 0.35 | **No system.** Measured once, not reproducible here: a real page at 2/7, failing on the things nothing ever chooses — zero transitions across 442 interactive elements, declared typefaces not resolving |
| In between | Not answered. Check each `FAIL` against the table above; what survives after the known false positives are removed is the reading |

Run conditions move these. The coherent page sits only just above its band — measure it again with a control focused and it reads 8/13 = 0.615, because focus brings the `shadows are multi-layer` false positive into play. Treat the bands as two clusters with a wide gap between them, not as a calibrated scale.

[`scripts/calibration/`](scripts/calibration/) holds the pages behind every reading above except the 2/7, which was a one-off observation on a live page.

`UNCHECKED` is not evidence of absence either. Several are structural: a system separating by line and tint alone leaves `shadows are multi-layer` and `elevation ladder coverage` nothing to look at, and `focus-visible` / `reduced-motion` both abstain whenever any stylesheet is cross-origin. Read each one's stated reason before counting it.

## What "looks cheap" actually is

It is rarely the palette. It is a set of parameters that were never set, each of which is measurable:

| Parameter | What must be decided | Tell when it was never decided |
|---|---|---|
| **Type ramp** | Each step's size **paired with its own** line-height, weight role, and letter-spacing | One global `line-height` multiplier producing fractional computed values (17.4px, 21.75px); weights jumping 400→700 with no mid-tier |
| **Spacing ramp** | One base unit and a closed ladder; every spacing value on it | Values off the ladder (7, 10, 14, 18, 22px alongside 4, 8, 12, 16) |
| **Density** | Control height, table row height, section rhythm — derived from the ramp | Padding chosen per component, so no two components share a rhythm |
| **Surface & line** | Which single mechanism separates a surface from its background: border, shadow, or tint | All three applied weakly at once, or one flat shadow used everywhere |
| **Elevation ladder** | Which levels exist and what sits at each. A system may separate by line and tint alone and carry no shadow; if it does use shadow, each level is a **multi-layer** stack | One single-layer shadow token on every raised thing — nothing is higher than anything else |
| **Radius family** | Outer radius, the nesting rule for inner radii, and the pill case | One radius, or several unrelated ones; inner corners not narrower than outer |
| **Motion** | One duration + one easing for state change, the property list it applies to, and the reduced-motion branch | Zero transitions — state changes snap. The single largest contributor to "cheap" that no screenshot reveals |
| **Numerals** | Where numbers align in a column, and whether the face is proportional or tabular | Proportional numerals in a data table — digits shift horizontally as values change |
| **State matrix** | Every state an interactive class can actually reach — at minimum default, hover, focus-visible; plus active, disabled and selected where the class has them (a link has no disabled state) | Hover styled, focus left to the UA ring, disabled indistinguishable from enabled |
| **Color roles** | Semantic roles mapped to values, with the foundations — page background and body text — tinted toward the brand hue | A flat list of hexes with no role; untinted foundations (a `#fff` page on `#000` text). A white surface on a tinted canvas is a normal choice, not this tell |

## Derivation order

Later parameters depend on earlier ones; deciding out of order forces rework.

```
base unit → spacing ramp → density → type ramp → radius family → elevation ladder → motion → state matrix
                                          ↑
                                   color roles (independent; decide any time)
```

## What the method fixes, and what an instance chooses

The table above is the list of decisions to make; the values are an instance's to choose. [`references/reference-instance.md`](references/reference-instance.md) is one fully specified instance — a data-dense technical interface — and its own values encode that intent: tight density, separation by line rather than shadow, a 120ms transition. A calmer or harder-edged system answers the same list differently.

[`references/reading-instance.md`](references/reading-instance.md) is the second instance, for long-form documents — it is what substituting values while keeping the structure actually looks like, and it adds the axes a console never needs (measure, body share, anchor nav, progressive disclosure, offline-file constraints).

**To target a different look, keep that file's structure and substitute its values.** Two things do not travel with the values: the `EXPECTED` block at the top of the validator, which restates the ladder and the allowed weights, and any instance-specific advice in the prose around a table. Change those with the values.

## Getting an instance

| Situation | Do this |
|---|---|
| A real product is the reference ("make it look like X") | `scripts/probe-visual-system.js` against the live site |
| A published design system is the reference | Take its documented token values directly; probe its docs site to fill gaps it does not publish |
| The surface is a **document meant to be read start to finish** (report, design doc, postmortem, runbook) | [`references/reading-instance.md`](references/reading-instance.md) — same structure at a reading tier, plus the parameters a console has no equivalent for: measure, body-share, anchor nav, progressive disclosure |
| No reference | Start from `references/reference-instance.md` and substitute the color roles and faces to fit the product's intent |

The probe returns an inventory of what a page computes — its type steps, spacing values, radii, shadow stacks, transitions and resolved faces, each with a usage count. It does **not** return a finished instance: role names, component mappings, the radius nesting rule, the state matrix and density are decisions to be read off that inventory, not fields in it. Treat its output as the evidence, and write the instance yourself.

Probing a reference and probing your own page in the **same run and same conditions** is what makes the two comparable — a described reference is a lossy projection of the running one. The probe runs against one document at a time and does not pair them; running it twice under the same viewport, zoom, theme and interaction state is what the comparison requires. When a reference is in play, `~/.claude/references/web-ui-observation.md` governs it.

## Verify before claiming it is fixed

`scripts/validate-visual-system.js` reports **PASS / FAIL / UNCHECKED** per check — UNCHECKED meaning the page gave it nothing to evaluate, which is not a pass. Run it against the page, not against the stylesheet: computed values are what the reader sees, and CSS source does not reveal what cascaded.

It covers the parameters that are decidable from a rendered page: the spacing ladder, line-height integrality, ramp size count, weight set, shadow layering, motion coverage and property choice, tabular numerals, typeface availability, focus-visible, the reduced-motion branch, and untinted foundations. It does not check exact type values, letter-spacing, easing curves, color-role assignment, density, or the radius nesting rule — those need reading the stylesheet against the instance.

And no check tells you whether the result looks right. Run it, then look at the page.
