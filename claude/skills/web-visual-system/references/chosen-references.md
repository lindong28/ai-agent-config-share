# Chosen references

References the user has already picked for real products, keyed by audience and scenario. Consulted by SKILL.md's "When no qualifying reference is in hand", and grown by that step's write-back.

**Every entry records a pick the user actually made.** Nothing here is a recommendation written ahead of one: a pre-filled table would encode the author's taste instead of the user's, and would bias future sessions toward exploiting rows no one validated.

## Qualification is **per layer**

A page can be worth copying at one layer and not at another. This is not a refinement — it is the fix for a recorded failure.

`news.aiplanet.live` was probed with the L2 validator, scored **0.417**, and was written into this file as *"no system — not a reference to pick again."* The user then went on naming it as a reference he wanted matched, and he was right: what he was pointing at was its **composition and its restraint** (1.3 screens, 4 saturated colors, 1 badge, 12 bordered boxes), not its spacing ladder. A single verdict per reference cannot express "L0/L1 worth copying, L2 not", and issuing one throws away the layers the user was actually pointing at.

So each entry carries **three verdicts**, each with the readings that produced it:

- **L0 form factor** — workbench / document / feed / dashboard, and whether the shell is self-consistent
- **L1 spend** — `visual-budget` readings
- **L2 parameters** — `validate-visual-system.js` pass rate over evaluated checks

A layer never examined is recorded as **never examined** — not as absent, and not as passing. Two different things leave a verdict empty and they are not interchangeable: the layer was never looked at, or it was looked at and the readings were not kept. Say which.

Two fields travel to anyone running this harness: the **public reference** and the **readings**. **Decision** carries the provenance. **Local embodiment** is provenance only — private deployments other users cannot reach, never to be treated as the reference itself.

## Entries

### Repository / item browsing for developers (list → detail, scan-heavy)

- **Public reference**: GitHub-family sites (code-hosting list/detail patterns)
- **L0**: *(never examined)*
- **L1**: *(never examined)*
- **L2**: *(never examined — the decision below records a choice, not a measurement)*
- **Decision**: 2026-08-08 — Claude Code surveyed comparable sites; the user picked this family. Applied to tt-web in commit `a457d2f` of `research/ai-agent-config`. Request that started it: session `9ef01181`, 2026-08-07.
- **Local embodiment (non-portable)**: tt-web, http://127.0.0.1:39001/

### Experiment and artifact browsing for ML engineers (browse → compare → drill down)

- **Public reference**: Weights & Biases
- **L0 — qualified (workbench)**: full-bleed shell, persistent left nav claiming its own column (196px at 1920), fluid main region with `max-width: none` filling to the right edge (gap 0), data on the first screen.
- **L1 — qualified**: probed 2026-08-20 at 1920×1080 via the deployed embodiment — 3 repeated badge elements, 5 saturated colors / 2 hue buckets, 6 border styles, 1 screen tall, data-region coverage 0.975. **One reading runs counter to intuition and is kept because of that**: its border density is **21.8 per 100 visible elements**, essentially the same as the 25.6 of a page the same user judged cluttered. Border density does not separate them; do not use it as a criterion.
- **L2 — qualified**: 11/12 = 0.917 (2026-08-20, 1600×1000, unfocused). Its instance is additionally documented as a published design system in `~/private-project-b/web/DESIGN-TOKENS.md` + `web/src/styles/tokens.css` / `global.css`: 4px base with a closed 10-step ladder (2/4/6/8/12/16/20/24/32/48, 2 and 6 declared half-steps); density 28px control / 32px row / 36px tab / 40px topbar; an 8-role type ramp each carrying its own integer line-height (10/14, 11/16, 12/16, 13/18, 14/20, 17/24, 24/30) on IBM Plex Sans + Mono, weights 400/500/600 only; radii 2/4/6/pill with the nesting rule `inner = max(2px, outer − padding)`; four elevation levels, level 0 `none` and levels 1–3 all multi-layer; motion 90/120/160ms on `cubic-bezier(.4,0,.2,1)` plus a reduced-motion branch; light workbench palette on a tinted `#f5f7f9` canvas with a dark `#20242a` topbar and accent `#007c9f`. That file states its own evidence boundary: public W&B screenshots prove direction, not exact CSS values.
- **Decision**: 2026-08 (before the 19th) — the user directed a rewrite of the artifacts site to follow W&B's product UI (session `abe898ce`, gpu-box). Re-picked 2026-08-20 as the light-side source for `video-eval-arena`'s shared layer, and again as the reference for the `/dataset` rewrite.
- **Local embodiment (non-portable)**: https://artifacts.philoai.xyz/

### News aggregation and feed reading for general readers (scan → open item)

- **Public reference**: AI Radar (`https://news.aiplanet.live/`, code at `~/research/ai-radar`)
- **L0 — qualified (feed)**: self-consistent feed shell; 1.3 screens tall at 1600×1000.
  **Two different axes live near this field and must not be read as one.** This verdict says *this page is
  worth copying at L0*. It says nothing about whether the `feed` form factor's own rules are calibrated —
  they are not: `feed` has exactly this one lateral sample in the corpus, and SKILL.md records it as
  unvalidated. A reference can be perfectly good to copy from while the category it belongs to has no
  measured rules at all.
- **L1 — qualified**: probed 2026-08-20 (1600×1000) — 1 repeated badge element, 4 saturated colors / 3 hue buckets, 5 border styles, 5.8 borders per 100 elements. This is the restraint the user was pointing at.
- **L2 — DISQUALIFIED**: probed 2026-08-20 (1280×577, unfocused, default theme) — 5 pass / 7 fail = **0.417**, and substituting its own values does not resolve it: 15 distinct off-ladder spacing values (3px×324, 10px×161, 7px×86, 18px×81, 14px×43, 15px×40, +9 more) reconstruct no self-consistent ladder, which per SKILL.md is itself the answer. Alongside: 12 type sizes including half-pixel steps (10.5/11.5/12.5/13.5/15.5px — the signature of em compounding), 15 of 22 steps on a fractional line-height, five weight tiers (400–800), 4 of 4 shadows single-layer, 8 of 169 interactive elements transitioning (5%), and a `prefers-reduced-motion` branch that caps no duration. It does pass elevation-ladder coverage, focus-visible, tinted neutrals, and both transition-property checks.
- **Decision**: 2026-08-20 — the user proposed it as a visual reference for `video-eval-arena`. **The first qualification run disqualified the whole page and that verdict was wrong**: it was an L2 reading applied as a verdict on the reference as a whole, while the user was pointing at L0/L1. Re-recorded per layer the same day. Its *theme-toggle interaction pattern* was adopted separately: a three-position segmented control (dark / follow-system / light) with a sliding thumb, `data-theme` + `data-theme-mode` on `<html>`, a `localStorage` key, and a blocking inline `<head>` script that resolves the theme before first paint.
- **Local embodiment (non-portable)**: https://news.aiplanet.live/

## Calibration corpus (not references — negative controls)

Measured 2026-08-20 to calibrate `visual-budget`'s criteria. **They are not picks and carry no endorsement**; they are here because they are what disproved six of seven candidate criteria, and re-deriving that costs a session.

| Page | saturated colors | hue buckets | border styles | borders/100 | badges |
|---|---|---|---|---|---|
| IBM Carbon (data-vis palettes) | 48 | 8 | 4 | 0.9 | 0 |
| AWS Cloudscape (data-vis colors) | 100 | 9 | 10 | 10.3 | 0 |
| Stripe | 24 | 5 | 13 | 2.3 | 1 |
| Plotly | 8 | 7 | 15 | 7.4 | 48 |
| Observable | 19 | 5 | 8 | 2.2 | 0 |
| Grafana Play | 5 | 3 | 10 | 4.6 | 1 |
| Apache ECharts examples | 5 | 3 | 3 | 0.2 | 1 |

**The `badges` column was measured with a superseded counting rule** (childless-leaf detection), which an
external review showed to be DOM-structure dependent. The probe now detects by paint + geometry with nesting
de-duplication. Only the two anchor points were re-measured under the new rule — both verdicts held
(bad page 1754 vs 14 = 125×, fires; fixed page 3 vs 14, does not). **These seven rows were not re-measured.**

**The corpus did not converge**: candidate search ran three rounds on three axes and each surfaced a new sub-family; the pre-registered `X` (`Vega-Lite`) never appeared. Treat these as counter-examples that disprove thresholds, **not** as a distribution to derive ranges from.
