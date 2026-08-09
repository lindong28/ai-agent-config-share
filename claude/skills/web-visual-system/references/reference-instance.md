# Reference instance — data-dense technical interface

One fully-specified visual system. It is the default instance the method consumes, not the only possible one. **To target a different look, keep this file's structure and substitute values.** The sections below are ordered by the derivation order in `SKILL.md`; substituting downward is safe, substituting upward forces recomputation of everything below.

Intent: dashboards, consoles, admin surfaces, anything where the reader is comparing numbers. Separation comes from **lines and tint, not from shadow** — shadow is reserved for things that genuinely float. Density is tight enough that a full table fits a screen without feeling cramped.

Not suitable for: marketing pages, editorial long-form, consumer apps whose job is to feel warm. Those want a different instance, not a tweak of this one.

## 1. Base unit and spacing ramp

Base unit **4px**. Every spacing value is drawn from this closed ladder — nothing between the steps.

| Token | Value | Use |
|---|---|---|
| `--sp-1` | 2px | Icon-to-label, hairline nudges |
| `--sp-2` | 4px | Label-to-value inside a tile |
| `--sp-3` | 6px | Chip padding, tight inline gaps |
| `--sp-4` | 8px | Default gap between siblings |
| `--sp-5` | 12px | Cell padding, control padding |
| `--sp-6` | 16px | Card padding, grid gutter |
| `--sp-7` | 24px | Between sections |
| `--sp-8` | 32px | Page top/bottom margin |
| `--sp-9` | 48px | Major page divisions |

## 2. Density

| Token | Value | Applies to |
|---|---|---|
| `--h-control` | 28px | Buttons, selects, inputs |
| `--h-row` | 32px | Table body rows |
| `--pad-cell` | `6px 12px` | Table cells and headers |
| `--pad-card` | `12px 16px` | Card and panel interiors |
| `--pad-page` | `16px 24px` | Page shell |

The paddings above are drawn from the ladder in §1; a padding token off the ladder defeats the ladder, being an ad-hoc value with a name. The two heights are not ladder values and are not meant to be: a control's height follows from its line-height plus its vertical padding, so pinning it to a gap size would fight the type ramp.

## 3. Type ramp

Each step carries **its own** line-height, weight and letter-spacing. There is no global multiplier — a global `line-height: 1.45` is what produces 17.4px and 21.75px, and it means no step was ever decided.

Weights used: **400** body · **500** UI label · **600** heading. Nothing heavier; 700/800 in a dense UI reads as shouting.

| Token | Size / line-height | Weight | Letter-spacing | Use |
|---|---|---|---|---|
| `--t-eyebrow` | 11px / 16px | 600 | `+0.04em`, uppercase | Column headers, group labels |
| `--t-micro` | 11px / 16px | 400 | normal | Timestamps, footnotes |
| `--t-small` | 12px / 16px | 400 | normal | Table cells, secondary meta |
| `--t-body` | 13px / 18px | 400 | normal | Default text |
| `--t-label` | 13px / 18px | 500 | normal | Form labels, nav, buttons |
| `--t-title` | 14px / 20px | 600 | `-0.005em` | Panel titles |
| `--t-section` | 16px / 22px | 600 | `-0.01em` | Page section headings |
| `--t-display` | 26px / 32px | 600 | `-0.015em` | KPI values |

Letter-spacing tightens as size grows and loosens as size shrinks — the two directions are one rule, not two exceptions.

**Faces.** Text: a technical sans with true small sizes and tabular figures — numbers are set in it too (see §7). A companion mono is carried for identifiers, paths and code, not for numerals. Validated default: **IBM Plex Sans** + **IBM Plex Mono** — designed as a pair for this kind of interface, open-licensed, self-hostable. Avoid Inter, Roboto, Open Sans and bare system stacks; they are the default-font look.

## 4. Radius family

| Token | Value | Use |
|---|---|---|
| `--r-sm` | 3px | Bars, swatches, inner chips |
| `--r-md` | 5px | Buttons, inputs, chips |
| `--r-lg` | 6px | Cards, panels, tables |
| `--r-pill` | 999px | Status pills, counts |

**Nesting rule**: an inner radius is `outer − padding`, floored at `--r-sm`. A 6px panel with 12px padding holds children at 3px, not at 6px — matching radii make the inner element look pasted on.

## 5. Elevation ladder

Separation is carried by **line and tint**. Shadow is used only where something genuinely sits above the page, and every level is a **multi-layer** stack — a single-layer shadow is the flat-card look.

| Level | Token | Value | Applies to |
|---|---|---|---|
| 0 | `--e-flat` | `none` + `1px solid var(--line)` | Tables, inline panels, the default |
| 1 | `--e-raised` | `0 0 0 1px rgba(28,33,40,.05), 0 1px 2px rgba(28,33,40,.06)` | Cards, sticky table headers |
| 2 | `--e-overlay` | `0 0 0 1px rgba(28,33,40,.08), 0 2px 4px rgba(28,33,40,.08), 0 8px 24px -8px rgba(28,33,40,.16)` | Popovers, dropdowns, tooltips |
| 3 | `--e-modal` | `0 0 0 1px rgba(28,33,40,.10), 0 8px 16px rgba(28,33,40,.10), 0 24px 48px -12px rgba(28,33,40,.24)` | Dialogs, command palette |

Nothing at level 0 may carry a shadow, and nothing above level 0 may appear more than once per stacking context without a reason.

## 6. Motion

| Token | Value |
|---|---|
| `--dur` | 120ms |
| `--ease` | `cubic-bezier(.4, 0, .2, 1)` |
| `--t-state` | `color var(--dur) var(--ease), background-color var(--dur) var(--ease), border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease), opacity var(--dur) var(--ease)` |

Transition **only** color, background-color, border-color, box-shadow, opacity, and `transform`. Never width, height, padding or margin — animating layout properties is janky and reads as amateur. `transition: all` is not acceptable: it silently animates layout properties the moment one changes.

Reduced motion is not optional:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: .01ms !important; animation-duration: .01ms !important; }
}
```

## 7. Numerals

| Rule | Why |
|---|---|
| `font-variant-numeric: tabular-nums` on every number that shares a column with another number | Proportional digits change width with value, so a column visibly jitters between renders |
| Numeric columns right-aligned; units and labels stay left | Aligned decimal position is what makes magnitudes comparable at a glance |
| Numbers set in the **text face**, using its tabular figures — not in the mono face | Tabular figures already equalise digit width, which is the whole requirement. A mono face additionally gives the period and comma a full cell each, so `$1020.79` renders as `$1020 . 79`; the artifact is mild at 12px and disfiguring at display sizes |
| Mono reserved for identifiers, paths, hashes and code | There the alignment that matters is character-level, and full-width punctuation is correct rather than a defect |

This applies to KPI values, table cells, legends and axis ticks — anywhere a reader compares two numbers.

## 8. State matrix

Every interactive class defines all six. A missing `focus-visible` is a keyboard user having no idea where they are.

| State | Treatment |
|---|---|
| default | Surface + `--line` border |
| hover | Background to `--bg-hover`, border to `--line-strong` |
| focus-visible | `outline: 2px solid var(--accent); outline-offset: 1px` — never removed, never replaced by a shadow alone |
| active | Background to `--bg-active`, no transform bounce |
| disabled | `opacity: .55`, `cursor: not-allowed`, no hover response |
| selected | `--accent-bg` fill + `--accent-ink` text; weight may rise one step, size may not |

## 9. Color roles

Roles first, values second. Neutrals are **tinted** toward the accent hue — untinted grey plus pure `#fff`/`#000` is the machine-made default.

| Token | Value | Role |
|---|---|---|
| `--canvas` | `#f4f7f9` | Page background |
| `--surface` | `#ffffff` | Raised content |
| `--surface-sunken` | `#eef2f6` | Table headers, inset wells |
| `--ink` | `#1c2128` | Primary text |
| `--ink-muted` | `#57616c` | Secondary text, labels |
| `--ink-subtle` | `#7d8894` | Timestamps, disabled text |
| `--line` | `#d3dae1` | Default border |
| `--line-soft` | `#e6ebf0` | Row separators |
| `--line-strong` | `#b4bec8` | Hover border, emphasis |
| `--bg-hover` | `#f0f4f8` | Hover fill |
| `--bg-active` | `#e5ecf3` | Pressed fill |
| `--accent` | `#0b66c3` | Primary action, focus ring |
| `--accent-ink` | `#0a559f` | Accent text on light |
| `--accent-bg` | `#dcecfb` | Selected fill |
| `--ok` | `#1a7f4b` | Success |
| `--warn` | `#8a6300` | Warning |
| `--danger` | `#c33` | Error, destructive |

Contrast floor: `--ink-muted` on `--surface` and on `--canvas` must both clear 4.5:1; `--ink-subtle` is for non-essential text only and must clear 3:1.

**Categorical series** (charts, legends) are a separate concern — the roles above do not supply them. Use the `dataviz` skill's palette, which is validated for categorical distinctness and colorblind safety.

## Copy-paste block

```css
:root {
  --sp-1:2px;  --sp-2:4px;  --sp-3:6px;  --sp-4:8px;  --sp-5:12px;
  --sp-6:16px; --sp-7:24px; --sp-8:32px; --sp-9:48px;

  --h-control:28px; --h-row:32px;
  --pad-cell:6px 12px; --pad-card:12px 16px; --pad-page:16px 24px;

  --font-sans:"IBM Plex Sans",ui-sans-serif,system-ui,sans-serif;
  --font-mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;

  --r-sm:3px; --r-md:5px; --r-lg:6px; --r-pill:999px;

  --e-flat:none;
  --e-raised:0 0 0 1px rgba(28,33,40,.05), 0 1px 2px rgba(28,33,40,.06);
  --e-overlay:0 0 0 1px rgba(28,33,40,.08), 0 2px 4px rgba(28,33,40,.08), 0 8px 24px -8px rgba(28,33,40,.16);
  --e-modal:0 0 0 1px rgba(28,33,40,.10), 0 8px 16px rgba(28,33,40,.10), 0 24px 48px -12px rgba(28,33,40,.24);

  --dur:120ms; --ease:cubic-bezier(.4,0,.2,1);
  --t-state:color var(--dur) var(--ease), background-color var(--dur) var(--ease),
            border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease),
            opacity var(--dur) var(--ease);

  --canvas:#f4f7f9; --surface:#fff; --surface-sunken:#eef2f6;
  --ink:#1c2128; --ink-muted:#57616c; --ink-subtle:#7d8894;
  --line:#d3dae1; --line-soft:#e6ebf0; --line-strong:#b4bec8;
  --bg-hover:#f0f4f8; --bg-active:#e5ecf3;
  --accent:#0b66c3; --accent-ink:#0a559f; --accent-bg:#dcecfb;
  --ok:#1a7f4b; --warn:#8a6300; --danger:#c33;
}
```

Type steps are applied per element rather than as variables, because each step is a group of four properties:

```css
.eyebrow { font:600 11px/16px var(--font-sans); letter-spacing:.04em; text-transform:uppercase; }
.micro   { font:400 11px/16px var(--font-sans); }
.small   { font:400 12px/16px var(--font-sans); }
.body    { font:400 13px/18px var(--font-sans); }
.label   { font:500 13px/18px var(--font-sans); }
.title   { font:600 14px/20px var(--font-sans); letter-spacing:-.005em; }
.section { font:600 16px/22px var(--font-sans); letter-spacing:-.01em; }
.display { font:600 26px/32px var(--font-sans); letter-spacing:-.015em; font-variant-numeric:tabular-nums; }
```

The state matrix from §8, applied once to every interactive class rather than per component:

```css
.control { background:var(--surface); border:1px solid var(--line); transition:var(--t-state); }
.control:hover:not(:disabled)  { background:var(--bg-hover); border-color:var(--line-strong); }
.control:active:not(:disabled) { background:var(--bg-active); }
.control:disabled              { opacity:.55; cursor:not-allowed; }
.control[aria-current],
.control[aria-selected="true"] { background:var(--accent-bg); color:var(--accent-ink); border-color:var(--accent); }
:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration:.01ms !important; animation-duration:.01ms !important; }
}
```
