# AI-Slop Anti-Patterns

The fingerprints of generic AI-generated interfaces (2024–2025). These are the tells that make a design instantly recognizable as machine-made rather than intentionally designed.

**The test**: Show the interface to someone and say "AI made this." Would they believe you immediately? If yes, that's the problem. A distinctive interface makes people ask *"how was this made?"* — not *"which AI made this?"*

Scan the design for each tell below. Every match is evidence of AI slop; report the specific elements that match.

## Color & Theme

| Tell | Why it reads as AI |
|------|--------------------|
| The "AI palette": cyan-on-dark, purple→blue gradients, neon accents on dark | The single most common AI signature |
| Default dark mode with glowing accents | Dark + glow is the lazy AI default, rarely a deliberate choice |
| Gradient text for "impact" | Decorative, not meaningful — pure ornament |
| Pure black (#000) or pure white (#fff) | Untinted extremes; real palettes tint neutrals toward a brand hue |
| Gray text on colored backgrounds | Should be a shade of the background color instead |

## Layout & Composition

| Tell | Why it reads as AI |
|------|--------------------|
| Everything wrapped in cards | Not everything needs a container |
| Cards nested inside cards | Un-flattened hierarchy |
| Identical card grids — same-size cards, each icon + heading + text, repeated endlessly | The canonical AI landing-page layout |
| Hero metric layout — giant number tiles dominating the top | Dashboard cliché applied indiscriminately |
| Everything centered | Left-aligned text with asymmetric layout feels more designed |
| Uniform spacing everywhere | No rhythm → monotonous, machine-spaced |

## Typography

| Tell | Why it reads as AI |
|------|--------------------|
| Overused fonts: Inter, Roboto, Arial, Open Sans, system defaults | The default-font look; no distinctive display face |
| Monospace as shorthand for "technical/developer" | Lazy vibe signaling |
| Large rounded-corner icons above every heading | Rarely add value; a repeated AI decoration |

## Visual Details

| Tell | Why it reads as AI |
|------|--------------------|
| Glassmorphism everywhere — blur used decoratively, not purposefully | Trend-following, not intentional |
| Rounded rectangles with generic drop shadows | Safe, forgettable, default |
| Rounded elements with a thick colored border on one side | A lazy accent |
| Sparklines / tiny charts used as decoration | Convey nothing meaningful |
| Modals for things that don't need them | Default interruption pattern |

## Motion & Interaction

| Tell | Why it reads as AI |
|------|--------------------|
| Bounce / elastic easing | Dated and tacky |
| Animating layout properties (width, height, padding, margin) | Janky; real motion uses transform + opacity |
| Every button styled as primary | No hierarchy — AI can't decide what matters |
| Redundant headers / intros restating the heading | Repeats info the user can already see |
| Critical functionality hidden on mobile | Amputated instead of adapted |
