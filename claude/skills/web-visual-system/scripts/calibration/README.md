# Calibration pages

Three pages built to have a coherent visual system, used to establish what
`validate-visual-system.js` reports on a page that *was* designed. Without them the
pass-rate thresholds in `SKILL.md` are unfalsifiable numbers.

| Page | System it implements | Reading (`PASS / (PASS+FAIL)`) |
|---|---|---|
| `coherent.html` | Data-dense console, Carbon-like foundations | 8 PASS / 4 FAIL → **8/12** |
| `reading.html` | Long-form document, separation by line and tint, no shadow, nothing focusable | 5 / 1 → **5/6** |
| `ratio.html` | Type ramp on per-role line-height ratios (1.6 body, 1.3 heading) | 5 / 1 → **5/6** |
| `thin.html` | **Negative control** — no system at all, UA reset plus one block of prose | 3 / 2 → **3/5** |

The fourth reading cited in `SKILL.md` — a real undesigned page at 2/7 — has no fixture
here. It was measured once on a live page and cannot be re-run from this directory.

## Reproducing

The documented way, against any of these files served or opened in a browser:

```bash
agent-browser eval "$(cat ../validate-visual-system.js)"
```

`run.js` / `run_focus.js` drive a headless Chromium over CDP instead, which is what produced
the readings above. They hardcode a version-pinned Playwright path
(`~/Library/Caches/ms-playwright/chromium_headless_shell-1217/…`) and port 9333 — expect to
update the path. `run_focus.js` focuses `.ring` before measuring; that is the only way to
reach the `shadows are multi-layer` failure that a focus ring produces, since the plain run
measures the unfocused state.

## What `thin.html` establishes

It is the reason `SKILL.md` requires a denominator of at least 6. An undesigned page scores
**0.60** here — inside the "system is present" band — not because anything was decided but
because only five checks found anything to evaluate. The pass rate measures decidedness and
page richness at the same time, and below a short denominator the second one dominates.

## What these still do not cover

The `≲ 0.35` band rests on a single live-page observation with no fixture. A *rich* undesigned
page — many components, many interactive elements, still no decided parameters — is the
fixture that would put a reproducible point under it. `thin.html` is thin by construction and
cannot serve that role.
