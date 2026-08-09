/*
 * probe-visual-system.js — extract a visual system's parameters from a rendered page.
 *
 * Reports what the page actually computes, not what its stylesheet claims. Use it on a
 * reference product to obtain an instance to target, and on your own page to obtain the
 * one you currently have. Probing both in the same run under the same viewport, zoom,
 * theme and interaction state is what makes the two comparable.
 *
 * Run:  agent-browser eval "$(cat probe-visual-system.js)"
 * Or paste into any DevTools console.
 */
(() => {
  const vis = Array.from(document.querySelectorAll('body *')).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  });

  const bump = (map, key) => { if (key) map.set(key, (map.get(key) || 0) + 1); };
  const ranked = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([value, count]) => ({ value, count }));
  const px = (v) => parseFloat(v) || 0;

  // --- Type ramp: one entry per (size, weight, line-height, tracking) combination in use.
  const typeSteps = new Map();
  for (const el of vis) {
    const hasOwnText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!hasOwnText) continue;
    const s = getComputedStyle(el);
    const size = px(s.fontSize);
    const lh = s.lineHeight === 'normal' ? 'normal' : px(s.lineHeight);
    const track = s.letterSpacing === 'normal' ? 0 : px(s.letterSpacing);
    bump(typeSteps, JSON.stringify({
      size,
      weight: Number(s.fontWeight),
      lineHeight: lh,
      ratio: typeof lh === 'number' && size ? Number((lh / size).toFixed(3)) : null,
      trackingEm: size ? Number((track / size).toFixed(4)) : 0,
      fractionalLineHeight: typeof lh === 'number' && Math.abs(lh - Math.round(lh)) > 0.01,
    }));
  }

  // --- Spacing: every non-zero padding/margin/gap value in use.
  // All four margins, not just the block axis: inline margins set the same rhythm, and a
  // ramp transcribed without them understates what the reference actually uses.
  const spacing = new Map();
  const SPACE_PROPS = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'rowGap', 'columnGap'];
  for (const el of vis) {
    const s = getComputedStyle(el);
    for (const p of SPACE_PROPS) {
      const v = s[p];
      if (!v || v === 'normal' || v === 'auto' || v === '0px') continue;
      if (!/^-?[\d.]+px$/.test(v)) continue;
      const n = px(v);
      if (n !== 0) bump(spacing, n);
    }
  }

  // --- Elevation: distinct shadow stacks, with layer count per stack.
  const shadows = new Map();
  for (const el of vis) {
    const v = getComputedStyle(el).boxShadow;
    if (!v || v === 'none') continue;
    if (/^(rgba\(0, 0, 0, 0\) 0px 0px 0px 0px(, )?)+$/.test(v)) continue; // Tailwind's empty stack
    bump(shadows, v);
  }
  const elevation = ranked(shadows, 10).map((s) => ({
    ...s,
    layers: s.value.split(/,(?![^(]*\))/).filter((l) => !/rgba\(0, 0, 0, 0\) 0px 0px 0px 0px/.test(l)).length,
  }));

  // --- Motion: only transitions with a real duration count.
  const motion = new Map();
  let animatesLayout = 0;
  let transitionAll = 0;
  for (const el of vis) {
    const s = getComputedStyle(el);
    const durs = s.transitionDuration.split(',').map((d) => parseFloat(d) || 0);
    if (!durs.some((d) => d > 0)) continue;
    const props = s.transitionProperty;
    if (/\ball\b/.test(props)) transitionAll += 1;
    if (/\b(width|height|padding|margin|top|left|right|bottom)\b/.test(props)) animatesLayout += 1;
    bump(motion, `${props} | ${s.transitionDuration} | ${s.transitionTimingFunction}`);
  }

  // --- Numerals: cells whose text is numeric, split by whether they are tabular.
  const numericCells = vis.filter((el) => {
    if (!/^(TD|TH)$/.test(el.tagName)) return false;
    return /^[\s$€¥£+\-]*[\d,.]+\s*[%kKmMbB]?\s*$/.test(el.textContent.trim());
  });
  const tabularCells = numericCells.filter((el) => /tabular/.test(getComputedStyle(el).fontVariantNumeric));

  const roundedTally = new Map();
  const familyTally = new Map();
  const lineTally = new Map();
  const fillTally = new Map();
  for (const el of vis) {
    const s = getComputedStyle(el);
    bump(familyTally, s.fontFamily);
    if (s.borderRadius && s.borderRadius !== '0px') bump(roundedTally, s.borderRadius);
    if (s.borderTopWidth !== '0px') bump(lineTally, s.borderTopColor);
    if (s.backgroundColor !== 'rgba(0, 0, 0, 0)') bump(fillTally, s.backgroundColor);
  }

  // A declared family is echoed by getComputedStyle whether or not the file arrived, so a
  // reference read while its webfont 404s would be transcribed as using a face it never
  // rendered. Resolve availability separately.
  const declared = [...new Set([...familyTally.keys()]
    .map((f) => (f.split(',')[0] || '').trim().replace(/^["']|["']$/g, ''))
    .filter((f) => f && !/^(ui-|system-ui|-apple-system|sans-serif|serif|monospace|cursive|fantasy)/.test(f)))];
  const fontsResolved = document.fonts && document.fonts.check
    ? declared.map((f) => ({ family: f, available: document.fonts.check(`12px "${f}"`) }))
    : 'no font-loading API in this browser';

  return JSON.stringify({
    url: location.href,
    viewport: `${innerWidth}x${innerHeight} @${devicePixelRatio}x`,
    visibleElements: vis.length,
    fontFamilies: ranked(familyTally, 4),
    fontsResolved,
    typeRamp: ranked(typeSteps, 16).map((r) => ({ ...JSON.parse(r.value), count: r.count })),
    weightsInUse: [...new Set([...typeSteps.keys()].map((k) => JSON.parse(k).weight))].sort((a, b) => a - b),
    spacingRamp: [...spacing.entries()].sort((a, b) => a[0] - b[0]).map(([value, count]) => ({ value, count })),
    radii: ranked(roundedTally, 8),
    elevation,
    motion: { distinct: ranked(motion, 6), elementsWithTransition: [...motion.values()].reduce((a, b) => a + b, 0), transitionAll, animatesLayout },
    numerals: { numericCells: numericCells.length, tabular: tabularCells.length },
    lineColors: ranked(lineTally, 6),
    fillColors: ranked(fillTally, 8),
  }, null, 1);
})()
