# Reading instance — long-form technical document

One fully-specified visual system for documents that are **read start to finish**: delivery reports, design docs, postmortems, runbooks, internal explainers. Same structure as [`reference-instance.md`](reference-instance.md), different values — that file targets dashboards and consoles at 11–13px, which is punishing over a page of prose.

Intent: one reader, one column, several minutes of continuous reading, with tables and code interleaved. Separation still comes from **line and tint**, not shadow. Density is loose enough that a paragraph does not feel like a log line.

Not suitable for: dashboards and admin surfaces (use `reference-instance.md`), marketing pages, or anything where the reader scans rather than reads.

**Substituting downward is safe; substituting upward forces recomputation of everything below.** Only the values that differ from `reference-instance.md` are restated here; §9 records a disposition for each parameter that sits below the substituted ramp, and colour roles are **not** among the pass-throughs — §8 replaces them.

## 1. Base unit and spacing ramp

Base unit **4px**, same closed ladder as the reference instance. What changes is which step each role draws from — a document breathes at one or two steps looser than a console.

The ladder itself is `reference-instance.md` §1 unchanged — all nine steps, same values. Only the role→token mapping differs, so only that is restated:

| Token | Use in a document |
|---|---|
| `--sp-2` | Label-to-value inside a tile |
| `--sp-3` | List-item separation |
| `--sp-5` | Table cell padding |
| `--sp-6` | Paragraph bottom margin, callout padding |
| `--sp-7` | Card padding, within-section rhythm |
| `--sp-8` | Page shell top |
| `--sp-9` | **Between sections** |

Tokens not listed (`--sp-1`, `--sp-4`) still exist; they simply carry no document-specific role.

## 2. Density

| Token | Value | Applies to |
|---|---|---|
| `--pad-cell` | `12px` | Table cells and headers — a document's tables are read, not scanned |
| `--pad-card` | `24px` | Cards, callouts, summary panels |
| `--pad-page` | `0 24px` | Page shell |

`--h-control` and `--h-row` are **not** inherited from the console instance. That file says a control's height follows from its line-height plus its vertical padding, and the type ramp changed here: `--t-table` at 22px plus `--pad-cell` at 12px already puts a row at 46px, so its `--h-row: 32px` cannot hold. Recompute both from this instance's ramp rather than copying them.

## 3. Type ramp

Each step carries its own line-height, weight and letter-spacing. **Body line-height is the single biggest difference from the console instance**: 26px on 16px text, versus 18px on 13px.

Weights: **400** body · **500** UI label · **600** heading.

| Token | Size / line-height | Weight | Letter-spacing | Use |
|---|---|---|---|---|
| `--t-eyebrow` | 12px / 16px | 600 | `+0.08em`, uppercase | Section kickers, nav title |
| `--t-micro` | 13px / 20px | 400 | normal | Metadata line, footnotes |
| `--t-small` | 13px / 19px | 400 | normal | Table sub-labels, hints |
| `--t-table` | 14px / 22px | 400 | normal | Table cells |
| `--t-body` | **16px / 26px** | 400 | normal | Default text |
| `--t-label` | 14px / 22px | 500 | normal | Nav links, buttons |
| `--t-h3` | 16px / 24px | 600 | normal | Sub-headings |
| `--t-h2` | 20px / 28px | 600 | `-0.01em` | Section headings |
| `--t-h1` | 28px / 36px | 600 | `-0.01em` | Page title |
| `--t-display` | 24px / 32px | 600 | `-0.015em` | KPI values |

**Measure**: prose and lists cap at **74ch**. Tables, cards and code blocks take the full column — the cap governs *text line length*, not container width. Getting this backwards produces a 1100px page with empty gutters on a wide screen.

**Faces**: a text face with tabular figures, plus a companion mono for identifiers and code. When the document must be a single offline file, a webfont cannot be embedded cheaply — use a curated system stack rather than a bare `sans-serif`, and include CJK faces explicitly if the document has CJK text.

## 4. Motion

| Token | Value |
|---|---|
| `--dur` | **140ms** — slightly slower than a console's 120ms; a document's interactions are deliberate, not rapid-fire |

`--ease`, `--t-state`, the transitionable-property whitelist and the `prefers-reduced-motion` branch are `reference-instance.md` §6 unchanged.

## 5. Layout

Unique to this instance; the console instance has no equivalent because a dashboard fills its viewport by definition.

| Parameter | Value | Why |
|---|---|---|
| Container | `max-width: 1560px` | A ~1100px centred container leaves a wide empty band on each side of a 1600px screen |
| Side nav | `190px` fixed | Anchor navigation for a document with sections |
| Gap | `--sp-8` (32px) | |
| **Body share** | **≥70% of the viewport** on wide screens | The measurable form of "the content gets the width". Verify it; do not eyeball it |
| Collapse breakpoint | 860px | Below it the nav becomes a card above the content |

Two failure modes worth stating because both are silent:

- A `1fr` grid column takes its **auto minimum from the content's min-content**, so one unshrinkable child pushes the whole column past the viewport. Use `minmax(0, 1fr)`.
- A mobile override placed **before** the rule it overrides loses on source order at equal specificity. Media-query blocks belong after the rules they modify.

## 6. Document affordances

A console has none of these; a read-through document needs all of them.

| Affordance | Requirement |
|---|---|
| Anchor navigation | Sticky side nav (or sticky top on narrow), with the current section marked. Highlight from a line at ~25% of viewport height, not the top edge, or a long section loses its highlight before it scrolls away |
| Progressive disclosure | `<details>` for depth. Default collapsed, and **the summary line must be readable on its own** — the reader should know what is inside without opening it |
| Code blocks | Copyable as a block. `navigator.clipboard` is unavailable outside a secure context, and `file://` is not one — so a document meant to be opened as a file needs a fallback that selects the text and says so. Without it the button silently does nothing |
| Wide tables | Wrap in an `overflow-x: auto` region that is **keyboard focusable** (`tabindex="0"`, `role="region"`, an `aria-label`), and announce the scroll only when the region actually overflows |
| Status | Badges with a text label, never colour alone |

## 7. Accessibility floor

Verify by measuring computed colours, not by intent.

| Check | Floor |
|---|---|
| Body and secondary text on their own background | 4.5:1 |
| **In both light and dark schemes** | Same floor. The muted/subtle role is the one that fails, and it usually fails in only one of the two |
| `lang` on the root element | Set it. Without it a screen reader may read CJK with an English voice |
| `focus-visible` | Never removed, never replaced by a shadow alone |

## 8. Colour roles

A console runs in whatever theme its host app sets. A document gets opened in a browser by whoever was sent the link, so `prefers-color-scheme: dark` is a normal condition, not an edge case — and §7's floor is unverifiable without values for it. `reference-instance.md` §9 is light-only, so colour roles do **not** pass through here.

**Light**: that file's §9 table, with one override. Its `--ink-subtle` `#7d8894` measures **3.21:1** on `--surface-sunken` — under §7's floor, and this instance puts that role on table headers and metadata where a console used it only for non-essential text. Use **`#5f6a76`** (4.90:1). Everything else in §9 clears the floor as written.

**Dark**: the base has no dark values at all, so the whole table is stated here. Roles are the same list; neutrals stay tinted toward the accent hue.

| Token | Dark value |
|---|---|
| `--canvas` | `#12161b` |
| `--surface` | `#181d24` |
| `--surface-sunken` | `#1e242c` |
| `--ink` | `#e6ebf0` |
| `--ink-muted` | `#a3aeba` |
| `--ink-subtle` | `#96a2ae` |
| `--line` / `--line-soft` / `--line-strong` | `#2c343d` / `#232a32` / `#3d4650` |
| `--bg-hover` / `--bg-active` | `#1e242c` / `#242c35` |
| `--accent` / `--accent-ink` / `--accent-bg` | `#61a8f0` / `#8cc3f7` / `#16283c` |
| `--ok` / `--warn` / `--danger` | `#5cc48a` / `#d3a63c` / `#e88a82` |

Shadows need their own dark values too — the light stack is tuned against a white surface and vanishes on a dark one. Raise the alpha and drop the spread.

**`--ink-subtle` is the value that gets set by feel and then fails, in both schemes.** The base's `#7d8894` measures 3.21:1 on light; an unadjusted dark port of it measures 4.33:1 — both under the floor, both looking perfectly readable to the author. The overrides above measure 4.90 light and 6.01 dark on table headers. Measure yours rather than porting these: the floor is a property of your surface colours, not of these hexes.

## 9. Everything else

Radius family, elevation ladder, state matrix and numerals: `reference-instance.md` unchanged. Tinted neutrals and separation-by-line apply here for the same reasons.

**Dispositions for what sits below the ramp.** The skill's derivation diagram puts radius, elevation, motion and state matrix below the type ramp, and the ramp changed here, so each owes an answer rather than a pass-through:

| Below the ramp | Disposition |
|---|---|
| Radius | **Changed by judgement, not derived.** `--r-lg` 6px → 8px. No rule in the base fixes radius to the ramp, so there is nothing to recompute; the reason is that this instance's outermost surfaces (page cards, full-width tables) are larger than a console's. Recorded as a judgement so a later reader knows there is no derivation behind it. The nesting rule itself is untouched: `outer − padding` floored at `--r-sm` — with `--pad-card` 24px, an 8px card holds children at the 3px floor. |
| Elevation | **Carried over, one level added.** Levels 0–3 of `reference-instance.md` §5 are unchanged — they key off surface and line, not off type size. Added between 1 and 2: a sticky-nav level, because a nav that text scrolls under needs more separation than a card (level 1) and less than a popover (level 2). Multi-layer like the others: `0 0 0 1px rgba(28,33,40,.06), 0 1px 3px rgba(28,33,40,.07), 0 8px 24px -12px rgba(28,33,40,.14)`. |
| Motion | **Changed** — 140ms rather than 120ms, per §4. |
| State matrix | **Checked, unchanged.** The six states are defined by treatment (border, fill, outline), not by size, so a larger ramp moves none of them. The one size-coupled clause — selected may raise weight one step but not size — still holds, since this ramp's weights are the same 400/500/600. |

Numerals passes through: it fixes digit width and alignment, which the ramp's sizes do not enter. **Colour roles do not pass through** — §8 replaces them for the dark scheme, and that is a substitution of its own, not an inheritance. The diagram calls colour roles independent, but that is the base's claim; the reason recorded here is the one checked against this instance.
