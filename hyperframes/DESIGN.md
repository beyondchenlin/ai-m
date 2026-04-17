# AI Comic Builder — Promo Video Design

## Style Prompt

Warm technical noir. A cinematic promo that feels like peeking at an animation studio's control room — deep charcoal canvas, a single warm orange-red signal color from the brand, cream text. Motion is confident and bladed: fast entrances with expo/power eases, never bouncy. One hero color does all the heavy lifting; the rest is restraint.

## Colors

- `#0B0807` — deep canvas (background)
- `#14100D` — panel / card fill (warm dark)
- `#E8553A` — primary brand accent (from logo)
- `#FF7A5C` — lighter accent for highlights and glows
- `#F5EBE0` — primary text (cream, never pure white)
- `#9A8F85` — secondary text (warm muted gray)
- `#2A1E18` — hairline borders / dividers

## Typography

- Display/Headline: `"Inter"`, weight 900, tracking -0.03em (English)
- Chinese: `"Noto Sans SC"`, weight 700-900
- Body: `"Inter"`, weight 400-500
- Mono / code: `"JetBrains Mono"`, weight 500

## Motion Signature

- Entrances: `power3.out` (0.6-0.8s) for mass, `expo.out` (0.5s) for punch
- No exit tweens except final scene — scene transitions handle exits
- Ambient: slow radial glow breath behind logo / hero elements

## What NOT to Do

- No blue accents — stay in the warm orange family
- No pure white (#FFFFFF) — cream text only
- No bouncy eases (back.out, elastic) — this is confident, not playful
- No full-screen linear gradients on dark (H.264 banding) — use radial or localized
- No generic stock shapes (blue circles, teal squares) — every element earns its place
