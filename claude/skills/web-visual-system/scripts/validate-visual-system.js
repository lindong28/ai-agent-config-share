/*
 * validate-visual-system.js — check a rendered page against the visual system parameters.
 *
 * Run against the page, not the stylesheet: computed values are what the reader sees, and
 * CSS source does not reveal what cascaded. Returns a text report.
 *
 * Every check reports one of three states, and they are never conflated:
 *   PASS      — checked against real samples, satisfied
 *   FAIL      — checked, violated (offending values listed)
 *   UNCHECKED — no sample to evaluate, or the evidence is not fully visible here. Not a pass.
 *
 * The UNCHECKED state carries the weight of this tool. A check with nothing to look at
 * produces the same clean output as a check that looked and found nothing wrong, so any
 * check that cannot tell those apart must say so rather than report the page clean.
 *
 * Run:  agent-browser eval "$(cat validate-visual-system.js)"
 *
 * Substitute EXPECTED below when targeting an instance other than references/reference-instance.md.
 */
(async () => {
  // Settle probe, before anything else. `document.readyState` is about document load and
  // goes 'complete' long before an app that fetches-then-renders has content — measured on
  // one such page: 51 visible elements at readyState 'complete', 1082 once settled, and the
  // verdicts differ. Two samples apart in time is the reading that actually discriminates.
  const countVisible = () => Array.from(document.querySelectorAll('body *'))
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length;
  const before = countVisible();
  await new Promise((r) => setTimeout(r, 600));
  const after = countVisible();
  const settleNote = before === after
    ? `page settled (${after} visible elements, unchanged over 600ms)`
    : `PAGE STILL RENDERING (${before} → ${after} visible elements over 600ms) — every count and verdict below is provisional; re-run once it stops changing`;

  const EXPECTED = {
    spacingLadder: [2, 4, 6, 8, 12, 16, 24, 32, 48],
    maxTypeSteps: 8,
    weights: [400, 500, 600],
    minMotionCoverage: 0.6, // share of interactive elements that must transition
  };

  const out = [];
  const add = (state, name, detail) => out.push({ state, name, detail });
  const px = (v) => parseFloat(v) || 0;
  const trunc = (arr, n = 6) => arr.slice(0, n).join(', ') + (arr.length > n ? `, +${arr.length - n} more` : '');
  const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

  const vis = Array.from(document.querySelectorAll('body *')).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  });

  // ---------- 1. Spacing on the ladder ----------
  // Margins count: they set the same rhythm padding does, and excluding them lets a page
  // off the ladder everywhere its gaps happen to be margins.
  const SPACE_PROPS = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'rowGap', 'columnGap'];
  const offLadder = new Map();
  let spacingSamples = 0;
  for (const el of vis) {
    const s = getComputedStyle(el);
    for (const p of SPACE_PROPS) {
      const v = s[p];
      if (!/^-?[\d.]+px$/.test(v)) continue;
      const n = px(v);
      if (n === 0) continue;
      spacingSamples += 1;
      // Negative and oversized values are reported rather than dropped: silently
      // ignoring them is how a page off the ladder still reads as on it.
      if (!EXPECTED.spacingLadder.includes(n)) offLadder.set(n, (offLadder.get(n) || 0) + 1);
    }
  }
  const offList = [...offLadder.entries()].sort((a, b) => b[1] - a[1]);
  if (!spacingSamples) {
    add('UNCHECKED', 'spacing on ladder', 'no non-zero spacing found — nothing to evaluate');
  } else {
    add(offList.length ? 'FAIL' : 'PASS', 'spacing on ladder',
      offList.length
        ? `${offList.length} off-ladder value(s) across ${spacingSamples} samples: ${trunc(offList.map(([v, c]) => `${v}px×${c}`))}`
        : `all ${spacingSamples} spacing values on the declared ladder`);
  }

  // ---------- 2. Type steps ----------
  const steps = new Map();
  for (const el of vis) {
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1)) continue;
    const s = getComputedStyle(el);
    steps.set(`${px(s.fontSize)}|${s.fontWeight}|${s.lineHeight}`, true);
  }
  const stepKeys = [...steps.keys()];

  if (!stepKeys.length) {
    const why = 'no element carries its own text on this page — no type step to evaluate';
    add('UNCHECKED', 'line-heights are integers', why);
    add('UNCHECKED', 'type ramp size count', why);
    add('UNCHECKED', 'weight tiers', why);
  } else {
    // `normal` is the giveaway that no line-height was chosen at all, so it counts as
    // unpaired rather than being skipped for lacking a px value.
    const unpaired = stepKeys.filter((k) => {
      const raw = k.split('|')[2];
      if (raw === 'normal') return true;
      const lh = px(raw);
      return lh > 0 && Math.abs(lh - Math.round(lh)) > 0.01;
    });
    // Named for what is actually measured. Computed values carry no provenance, so a
    // global multiplier that happens to land on integers is indistinguishable from a
    // per-step choice; claiming "paired per step" would assert more than the evidence.
    add(unpaired.length ? 'FAIL' : 'PASS', 'line-heights are integers',
      unpaired.length
        ? `${unpaired.length} of ${stepKeys.length} step(s) have a fractional or unset line-height — the signature of one global multiplier: ${trunc(unpaired, 4)}`
        : `all ${stepKeys.length} type steps compute to an integer line-height — whether each was chosen per step is not observable here; confirm against the stylesheet`);

    const sizes = [...new Set(stepKeys.map((k) => px(k.split('|')[0])))].sort((a, b) => a - b);
    add(sizes.length > EXPECTED.maxTypeSteps ? 'FAIL' : 'PASS', 'type ramp size count',
      `${sizes.length} distinct sizes (max ${EXPECTED.maxTypeSteps}): ${sizes.join(', ')}px`);

    const weights = [...new Set(stepKeys.map((k) => Number(k.split('|')[1])))].sort((a, b) => a - b);
    const stray = weights.filter((w) => !EXPECTED.weights.includes(w));
    add(stray.length ? 'FAIL' : 'PASS', 'weight tiers',
      `weights in use: ${weights.join(', ')}` +
      (stray.length ? ` — ${stray.join(', ')} outside the declared set (${EXPECTED.weights.join(', ')})` : ''));
  }

  // ---------- 3. Elevation ladder ----------
  const stacks = new Map();
  for (const el of vis) {
    const v = getComputedStyle(el).boxShadow;
    if (!v || v === 'none') continue;
    if (/^(rgba\(0, 0, 0, 0\) 0px 0px 0px 0px(, )?)+$/.test(v)) continue;
    stacks.set(v, (stacks.get(v) || 0) + 1);
  }
  const levels = [...stacks.keys()];
  const multiLayer = levels
    .map((v) => v.split(/,(?![^(]*\))/).filter((l) => !/rgba\(0, 0, 0, 0\) 0px 0px/.test(l)).length)
    .filter((n) => n > 1).length;
  // Two questions, deliberately separate: whether the shadows in use are built like real
  // levels, and whether this page shows enough of the ladder to say the ladder exists.
  // One multi-layer level answers the first and cannot answer the second.
  if (!levels.length) {
    add('UNCHECKED', 'shadows are multi-layer', 'no shadows on this page — nothing to evaluate');
    add('UNCHECKED', 'elevation ladder coverage', 'no shadows on this page — the ladder is not exercised here');
  } else {
    // Every distinct shadow must stack, not just one of them: a page carrying one proper
    // level plus a flat blur elsewhere still has the flat blur.
    add(multiLayer === levels.length ? 'PASS' : 'FAIL', 'shadows are multi-layer',
      multiLayer === levels.length
        ? `all ${levels.length} distinct shadow(s) stack more than one layer`
        : `${levels.length - multiLayer} of ${levels.length} distinct shadow(s) are single-layer — one flat blur on a raised thing is the default-card look; real levels stack a contact shadow with a diffuse one`);
    add(levels.length >= 2 ? 'PASS' : 'UNCHECKED', 'elevation ladder coverage',
      levels.length >= 2
        ? `${levels.length} distinct levels appear here`
        : 'only one level appears on this page — a page with an overlay is needed to exercise the rest');
  }

  // ---------- 4. Motion ----------
  // Resolve each property to its own duration: CSS cycles the shorter list, so a page can
  // carry a long duration on a property that is not actually animated, and vice versa.
  const movingProps = (s) => {
    const props = list(s.transitionProperty);
    const durs = list(s.transitionDuration).map(parseFloat);
    if (!props.length || !durs.length) return [];
    return props.filter((p, i) => p !== 'none' && (durs[i % durs.length] || 0) > 0);
  };

  const INTERACTIVE = 'a[href], button, input, select, textarea, summary, [role="button"], [tabindex]:not([tabindex="-1"]), tbody tr';
  const interactive = Array.from(document.querySelectorAll(INTERACTIVE)).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  if (!interactive.length) {
    add('UNCHECKED', 'motion coverage', 'no visible interactive elements on this page — nothing to evaluate');
  } else {
    const moving = interactive.filter((el) => movingProps(getComputedStyle(el)).length);
    const coverage = moving.length / interactive.length;
    add(coverage >= EXPECTED.minMotionCoverage ? 'PASS' : 'FAIL', 'motion coverage',
      `${moving.length}/${interactive.length} interactive elements transition (${Math.round(coverage * 100)}%, floor ${EXPECTED.minMotionCoverage * 100}%)` +
      (coverage < EXPECTED.minMotionCoverage ? ' — state changes snap; no screenshot reveals this' : ''));
  }

  const LAYOUT_PROPS = /^(width|height|padding|margin|top|left|right|bottom|inset|flex-basis)/;
  let usesAll = 0; let usesLayout = 0; let transitioning = 0;
  for (const el of vis) {
    const props = movingProps(getComputedStyle(el));
    if (!props.length) continue;
    transitioning += 1;
    if (props.includes('all')) usesAll += 1;
    if (props.some((p) => LAYOUT_PROPS.test(p))) usesLayout += 1;
  }
  if (!transitioning) {
    add('UNCHECKED', 'no `transition: all`', 'nothing on the page transitions — vacuous here, recheck once motion exists');
    add('UNCHECKED', 'no layout-property transitions', 'nothing on the page transitions — vacuous here, recheck once motion exists');
  } else {
    add(usesAll ? 'FAIL' : 'PASS', 'no `transition: all`',
      usesAll ? `${usesAll} of ${transitioning} transitioning element(s) — silently animates layout properties as soon as one changes`
        : `${transitioning} transitioning element(s), all naming their properties`);
    add(usesLayout ? 'FAIL' : 'PASS', 'no layout-property transitions',
      usesLayout ? `${usesLayout} element(s) animate a layout property with a real duration` : 'no layout properties animated');
  }

  // ---------- 5. Numerals ----------
  // Any leaf whose own text is a number counts, not just table cells: KPI tiles and legend
  // values are exactly where proportional digits are most visible, and they are not cells.
  const NUMERIC = /^[\s$€¥£+\-(]*[\d][\d,.\s]*\)?\s*[%‰kKmMbB]?\s*$/;
  // Two or more dots means a dotted identifier — an IP, a version, a build number.
  // Those are not magnitudes anyone compares by eye, and the rule is about magnitudes.
  const DOTTED_ID = /\d+\.\d+\.\d+/;
  const numeric = vis.filter((el) => {
    if (el.children.length) return false;
    const t = el.textContent.trim();
    return t.length > 0 && /\d/.test(t) && NUMERIC.test(t) && !DOTTED_ID.test(t);
  });
  if (!numeric.length) {
    const excluded = vis.filter((el) => {
      if (el.children.length) return false;
      const t = el.textContent.trim();
      return NUMERIC.test(t) && DOTTED_ID.test(t);
    }).length;
    add('UNCHECKED', 'tabular numerals',
      'no comparable numeric text found on this page — check a page that has some' +
      (excluded ? `; ${excluded} dot-grouped value(s) were excluded as identifiers (IPs, versions, and any dot-grouped thousands such as 1.234.567)` : ''));
  } else {
    const tabular = numeric.filter((el) => /tabular/.test(getComputedStyle(el).fontVariantNumeric));
    const bad = numeric.filter((el) => !/tabular/.test(getComputedStyle(el).fontVariantNumeric));
    add(bad.length ? 'FAIL' : 'PASS', 'tabular numerals',
      `${tabular.length}/${numeric.length} numeric elements are tabular` +
      (bad.length ? ` — e.g. ${trunc(bad.slice(0, 3).map((e) => `<${e.tagName.toLowerCase()}${e.className ? '.' + String(e.className).split(' ')[0] : ''}>"${e.textContent.trim().slice(0, 12)}"`), 3)}` : '') +
      ' (not covered: numbers drawn into a canvas, and dot-grouped thousands such as 1.234.567, which are excluded with IPs and version strings)');
  }

  // ---------- 6. Declared typefaces actually loaded ----------
  // getComputedStyle echoes the declared family list whether or not the file arrived, so a
  // fully fallen-back page and a correctly loaded one read identically without this.
  // Sample text is collected per family from the elements that actually declare it: one
  // truncated slice of the whole page can miss the characters a given face is responsible
  // for, and a unicode-range that excludes them would then report available.
  // Keyed by family *and* weight and style, not family alone: with 400 loaded and 600
  // missing, a family-level check answers for the file that arrived and stays silent
  // about the one that did not — which is the case this check exists to catch.
  const families = new Map();
  for (const el of vis) {
    const s = getComputedStyle(el);
    const first = list(s.fontFamily)[0];
    if (!first || /^(ui-|system-ui|-apple-system|sans-serif|serif|monospace|cursive|fantasy)/.test(first)) continue;
    const family = first.replace(/^["']|["']$/g, '');
    const key = `${s.fontStyle} ${s.fontWeight} "${family}"`;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
    const prev = families.get(key) || { family, style: s.fontStyle, weight: s.fontWeight, sample: '' };
    if (prev.sample.length < 300) prev.sample = (prev.sample + own).slice(0, 300);
    families.set(key, prev);
  }
  if (!document.fonts || !document.fonts.check) {
    add('UNCHECKED', 'declared typefaces available', 'this browser exposes no font-loading API');
  } else if (!families.size) {
    add('UNCHECKED', 'declared typefaces available', 'no non-generic family declared — nothing to confirm');
  } else {
    // check() alone does not discriminate: with no FontFace registered for a family there
    // is nothing pending, so it answers true for a family the page never had. Split the
    // three cases instead of collapsing them into one verdict.
    // Descriptors are compared, not just family names: with only upright files vendored,
    // an italic request is satisfied by a synthesised oblique and check() answers true.
    // That is not the declared face having arrived, so it cannot be reported as one.
    const faces = [];
    document.fonts.forEach((f) => faces.push(f));
    const weightRange = (w) => {
      const s = String(w).trim();
      if (s === 'normal') return [400, 400];
      if (s === 'bold') return [700, 700];
      const nums = s.split(/\s+/).map(Number).filter((n) => !Number.isNaN(n));
      return nums.length ? [nums[0], nums[nums.length - 1]] : null;
    };
    const descriptorFor = (family, style, weight) => faces.find((f) => {
      if (String(f.family).replace(/^["']|["']$/g, '') !== family) return false;
      if (String(f.style).trim() !== style) return false;
      const range = weightRange(f.weight);
      return range && Number(weight) >= range[0] && Number(weight) <= range[1];
    });
    const anyFamily = (family) => faces.some((f) => String(f.family).replace(/^["']|["']$/g, '') === family);

    const failed = []; const unknown = []; const synthesised = []; const ok = [];
    for (const [key, { family, style, weight, sample }] of families) {
      const probe = sample || '0123456789';
      if (!anyFamily(family)) unknown.push(key);
      else if (!descriptorFor(family, style, weight)) synthesised.push(key);
      else if (document.fonts.check(`${style} ${weight} 12px "${family}"`, probe)) ok.push(key);
      else failed.push(key);
    }
    const note = " (sample text per face capped at 300 chars)";
    if (failed.length) {
      add('FAIL', 'declared typefaces available',
        `@font-face declared but not loaded for this face's own text: ${trunc(failed, 4)} — rendering in fallback while the stylesheet claims otherwise${note}`);
    } else if (synthesised.length || unknown.length) {
      const parts = [];
      if (synthesised.length) parts.push(`no @font-face matches ${trunc(synthesised, 3)} — the browser is synthesising these from another weight or slant, which is not the declared face arriving`);
      if (unknown.length) parts.push(`no @font-face registered at all for ${trunc(unknown, 3)} — these rely on a local install, which is not confirmable here`);
      if (ok.length) parts.push(`loaded: ${trunc(ok, 3)}`);
      add('UNCHECKED', 'declared typefaces available', parts.join('; ') + note);
    } else {
      add('PASS', 'declared typefaces available', `loaded for each face's own text: ${trunc(ok, 4)}${note}`);
    }
  }

  // ---------- 7. Stylesheet-dependent checks ----------
  // Flattened to individual style rules rather than each top-level rule's cssText: a
  // media rule's text contains all its children, so a box-shadow belonging to a different
  // selector inside the same block would read as the focus rule's own substitute cue.
  let rules = null; let reduceRules = null; let blocked = 0;
  // selectorText is tested before cssRules, not after: browsers supporting CSS nesting
  // give every CSSStyleRule an (empty, but truthy) cssRules list, so branching on that
  // first sends ordinary style rules down the grouping path and collects nothing.
  const walk = (cssRules, inReduce, flat, reduce) => {
    for (const r of cssRules) {
      if (r.selectorText) {
        flat.push(r.cssText);
        if (inReduce) reduce.push(r.cssText);
        if (r.cssRules && r.cssRules.length) walk(r.cssRules, inReduce, flat, reduce);
      } else if (r.cssRules) {
        const cond = String(r.conditionText || r.media || '');
        walk(r.cssRules, inReduce || /prefers-reduced-motion\s*:\s*reduce|prefers-reduced-motion\s*\)/.test(cond), flat, reduce);
      }
    }
  };
  try {
    rules = []; reduceRules = [];
    for (const sheet of document.styleSheets) {
      try { walk(sheet.cssRules, false, rules, reduceRules); }
      catch { blocked += 1; }
    }
  } catch { rules = null; }

  // Even one unreadable sheet can override what the readable ones say — a later
  // `!important` rule is invisible here — so a partial view yields no verdict.
  if (!rules || blocked) {
    const why = !rules
      ? 'stylesheet rules unreadable — inspect the source directly'
      : `${blocked} stylesheet(s) unreadable (cross-origin); a rule there can override what is visible, so no verdict from a partial view`;
    add('UNCHECKED', 'focus-visible defined', why);
    add('UNCHECKED', 'reduced-motion branch caps durations', why);
  } else {
    const all = rules.join('\n');
    const fvRules = rules.filter((r) => /:focus-visible/.test(r));
    // A substitute cue only counts if it paints something: `box-shadow: none`,
    // `border-color: transparent` and `outline-width: 0` are the property name without
    // the indicator. The value is captured and compared after trimming rather than
    // excluded with an inline lookahead — `\s*` before a lookahead backtracks to zero
    // width, so `(?!none)` tested at the space accepts the very value it names.
    const valueOf = (rule, prop) => {
      const m = new RegExp(`(?:^|[;{])\\s*${prop}\\s*:\\s*([^;}]+)`).exec(rule);
      return m ? m[1].replace(/!important\s*$/i, '').trim() : null;
    };
    // A fully transparent colour paints nothing either, so it is treated like `none`.
    const CLEAR = /^(transparent|rgba\([^)]*[,/]\s*0(\.0+)?\s*\)|#[0-9a-f]{3}0|#[0-9a-f]{6}00)$/i;
    const paints = (v, blankPattern) => v !== null && !blankPattern.test(v) && !CLEAR.test(v);
    // A shadow's colour sits inside its geometry, so the whole value never equals a clear
    // colour: `0 0 2px rgba(0,0,0,0)` paints nothing while looking like a cue.
    const shadowPaints = (v) => {
      if (v === null || /^none$/i.test(v)) return false;
      const colours = v.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}\b|\btransparent\b/gi);
      return !colours || colours.some((c) => !CLEAR.test(c));
    };
    const hasSubstituteCue = (r) => shadowPaints(valueOf(r, 'box-shadow'))
      || paints(valueOf(r, 'border-color'), /^transparent$/i)
      || paints(valueOf(r, 'outline-width'), /^0(px)?$/i);
    const fvKilled = fvRules.filter((r) => /outline\s*:\s*(none|0(px)?)\b/.test(r) && !hasSubstituteCue(r));
    if (!fvRules.length) {
      add('FAIL', 'focus-visible defined', 'absent — keyboard users get no location cue beyond the UA default');
    } else if (fvKilled.length) {
      // Whether a later rule restores the indicator is a cascade question, and rule text
      // does not answer it. Reporting FAIL here would be as wrong as reporting PASS.
      add('UNCHECKED', 'focus-visible defined',
        `${fvKilled.length} of ${fvRules.length} :focus-visible rule(s) remove the outline; whether a later rule restores it is not resolvable from rule text — focus a control and look`);
    } else {
      add('PASS', 'focus-visible defined', `${fvRules.length} rule(s), none removing the indicator`);
    }

    // `prefers-reduced-motion: no-preference` is the opposite branch; matching the bare
    // feature name would accept a page that never honours the reduction. And a reduce
    // branch setting 10s satisfies "has a duration" while reducing nothing, so the value
    // has to be read, not merely matched.
    const rmRules = reduceRules;
    // Every duration in the reduce branch has to come down. Accepting the branch because
    // one of its rules is short lets the long ones beside it keep running.
    // A duration declaration is a comma list: reading only its first entry lets
    // `0.01ms, 10s` pass on the strength of the value that was never the problem.
    const entriesIn = (text) => [...text.matchAll(/(?:transition|animation)-duration\s*:\s*([^;}]+)/g)]
      .flatMap(([, value]) => value.split(','))
      .map((piece) => piece.trim().replace(/!important\s*$/i, '').trim());
    const rmEntries = rmRules.flatMap(entriesIn);
    const parsed = rmEntries.map((e) => /^([\d.]+)(m?s)$/.exec(e));
    // An entry that does not parse — `var(--slow)`, a calc() — could be anything. Letting
    // the values that did parse speak for it is how a 10s custom property rides through.
    const opaqueEntries = rmEntries.filter((_, i) => !parsed[i]);
    const rmDurations = parsed.filter(Boolean).map(([, n, unit]) => (unit === 's' ? parseFloat(n) * 1000 : parseFloat(n)));
    const rmShortens = (rmDurations.length > 0 && rmDurations.every((d) => d <= 100))
      || (!rmDurations.length && rmRules.some((r) => /animation\s*:\s*none/.test(r)));
    if (!rmRules.length) {
      add(transitioning ? 'FAIL' : 'UNCHECKED', 'reduced-motion branch caps durations',
        transitioning ? 'absent — required whenever transitions exist' : 'absent, and nothing transitions here — not required on this page');
    } else {
      // Named for what is measured. Whether the branch actually *reduces* would need each
      // element's normal-state duration paired with the rule that overrides it, which rule
      // text does not give; the 100ms cap is a floor low enough that a slower reduce
      // branch cannot pass it.
      const over = rmDurations.filter((d) => d > 100).length;
      // A value already known to break the cap settles it; an unreadable value beside it
      // changes nothing. Only an otherwise-clean branch is left unresolved by one.
      if (over) {
        add('FAIL', 'reduced-motion branch caps durations',
          `${over} duration(s) in the reduce branch exceed 100ms — a reduce branch that leaves a long duration reduces nothing`);
      } else if (opaqueEntries.length) {
        add('UNCHECKED', 'reduced-motion branch caps durations',
          `${opaqueEntries.length} duration value(s) in the reduce branch are not literals (${trunc(opaqueEntries, 3)}) — their length is not readable here`);
      } else {
        add(rmShortens ? 'PASS' : 'FAIL', 'reduced-motion branch caps durations',
          rmShortens ? `${rmRules.length} reduce-branch rule(s); every duration in them is ≤100ms`
            : `${rmRules.length} reduce-branch rule(s), but none caps a duration — no literal duration and no \`animation: none\` found in the branch`);
      }
    }
  }

  // ---------- 8. Untinted foundations ----------
  // The tell is untinted *foundations* — the page's own background and its body text.
  // A pure-white card on a tinted canvas is a deliberate and common choice, so surfaces
  // are excluded; flagging them would reject correct palettes.
  const rgb = (v) => {
    const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)\s*(?:[,/]\s*([\d.%]+))?\s*\)/.exec(v || '');
    if (!m) return null;
    const a = m[4] === undefined ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    return { r: +m[1], g: +m[2], b: +m[3], a };
  };
  const greyLabel = (c) => (c && c.a > 0 && c.r === c.g && c.g === c.b ? `rgb(${c.r},${c.g},${c.b})` : null);
  const bodyStyle = getComputedStyle(document.body);
  const htmlStyle = getComputedStyle(document.documentElement);
  // With both transparent, the reader still sees the browser canvas, which is white.
  const bodyBg = rgb(bodyStyle.backgroundColor);
  const htmlBg = rgb(htmlStyle.backgroundColor);
  const opaque = (c) => c && c.a === 1;
  const translucent = (bodyBg && bodyBg.a > 0 && bodyBg.a < 1) || (htmlBg && htmlBg.a > 0 && htmlBg.a < 1);
  const effectiveBg = opaque(bodyBg) ? bodyBg
    : opaque(htmlBg) ? htmlBg
      : (!bodyBg || bodyBg.a === 0) && (!htmlBg || htmlBg.a === 0) ? { r: 255, g: 255, b: 255, a: 1 }
        : null;
  if (!effectiveBg && translucent) {
    // Compositing a translucent layer over what is behind it is not attempted here, and
    // guessing from the top layer alone gets the answer wrong in both directions.
    add('UNCHECKED', 'neutrals tinted', 'the page background is translucent; its composited colour is not resolved here');
  } else {
    const foundations = [
      ['page background', greyLabel(effectiveBg)],
      ['body text', greyLabel(rgb(bodyStyle.color))],
    ].filter(([, v]) => v);
    add(foundations.length ? 'FAIL' : 'PASS', 'neutrals tinted',
      foundations.length
        ? `${foundations.map(([k, v]) => `${k} is ${v}`).join('; ')} — real palettes tint their foundational neutrals toward the brand hue`
        : 'page background and body text both carry a hue');
  }

  // ---------- Report ----------
  const n = (s) => out.filter((o) => o.state === s).length;
  const width = Math.max(...out.map((o) => o.name.length));
  const body = out.map((o) => `  ${o.state.padEnd(9)} ${o.name.padEnd(width)}  ${o.detail}`).join('\n');
  const verdict = n('FAIL') ? `${n('FAIL')} FAILED` : n('UNCHECKED') ? 'all evaluated checks passed' : 'all checks passed';

  return [
    `visual system — ${location.href}`,
    `viewport ${innerWidth}x${innerHeight} · ${settleNote}`,
    '',
    body,
    '',
    `${verdict}  ·  ${n('PASS')} pass, ${n('FAIL')} fail, ${n('UNCHECKED')} unchecked`,
    n('UNCHECKED') ? 'UNCHECKED is not a pass — those conditions remain unverified on this page.' : '',
    'No check here can tell you whether the result looks right. Run it, then look at the page.',
  ].filter(Boolean).join('\n');
})()
