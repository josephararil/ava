# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Omnius Technology Exhibition** — a single-file HTML slide deck presenting the Omnius multi-asset trading platform to potential clients at Ava Trade.

No build step, no dependencies, no package manager. The entire project is `index.html`.

## Running & Viewing

Open `index.html` directly in a browser, or serve it locally:

```powershell
# Python (simplest)
python -m http.server 8080

# Node (if available)
npx serve .
```

Hard-refresh (`Ctrl+Shift+R`) to bust any cached service worker or asset.

## Architecture

Single HTML file (~430 KB) structured as:

- **`<style>`** — full design system via CSS custom properties, slide layout, animations
- **`<main>`** — 23 `<section data-i="N">` slides (0–22)
- **`<script>`** — slide navigation engine (keyboard ←/→, Space, Home/End; click; progress bar; dot indicators)

### Slide Structure

| Range | Section |
|-------|---------|
| 0 | Cover |
| 1–2 | Intro (Opportunity + What Omnius Means for Ava) |
| 3 | Divider A |
| 4 | What Is Omnius (6 capability cards) |
| 5 | What The Platform Does (functional scope + 3-layer arch) |
| 6 | Core Components Diagram |
| 7–14 | Technical Deep Dive (models, liquidity, institutional, SoR, TV, bespoke, perf, foundation) |
| 15 | Divider B |
| 16–19 | Why We Built It & How (own vs rent, AI team, AI proof, cost comparison) |
| 20 | Divider C (live demo) |
| 21–22 | Closing |

### Design System (CSS Variables)

```
--bg: #08090b          background
--surface: #111316     card/panel surface
--border: #1e2128      borders
--text: #e8eaed        primary text
--muted: #8b9099       secondary text
--accent: #00d4a1      primary accent (green)
--accent2: #00f0b5     secondary accent (lime)
--blue: #2962ff        highlight blue
```

Fonts: Inter (body), Roboto Mono (code/metrics) — loaded from Google Fonts.

## Editing Guidelines

- All changes happen in `index.html` — no separate CSS or JS files.
- Slide content is in the `<main>` block. Each slide is `<section data-i="N" class="slide ...">`.
- To add a slide: add a new `<section>` with the next sequential `data-i`, then update the total count in the JS navigation logic if it uses a hardcoded max.
- The JS navigation tracks current index in a variable and reads `data-i` attributes — check for any hardcoded slide-count references when adding/removing slides.
- Animations use the `.rise` class with staggered CSS `animation-delay` via `style` attributes — follow existing patterns.
