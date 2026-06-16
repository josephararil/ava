# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Omnius Technology Exhibition** — an HTML slide deck presenting the Omnius multi-asset trading platform to potential clients at Ava Trade.

No build step, no dependencies, no package manager. Four files:

| File | Contents | Size |
|------|----------|------|
| `index.html` | `<head>` + all slide markup (`<main>`) | ~28 KB |
| `styles.css` | Full design system — CSS custom properties, layout, animations | ~18 KB |
| `app.js` | Slide navigation engine (keyboard, click, dots, progress) | ~1.5 KB |
| `arch.png` | Architecture diagram (was a base64 inline image) | ~283 KB |

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

Four-file project:

- **`index.html`** — `<head>` + 23 `<section data-i="N">` slides (0–22) inside `<main>`
- **`styles.css`** — full design system via CSS custom properties, slide layout, animations
- **`app.js`** — slide navigation engine (keyboard ←/→, Space, Home/End; click; progress bar; dot indicators)
- **`arch.png`** — architecture diagram used in slide 6

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

- **Slide text** → edit `index.html` (the `<main>` block). Each slide is `<section data-i="N" class="slide ...">`.
- **Styling** → edit `styles.css`.
- **Navigation logic** → edit `app.js`.
- **Architecture diagram** → replace `arch.png`.
- To add a slide: add a new `<section>` with the next sequential `data-i`. The JS uses `slides.length` dynamically — no hardcoded count to update.
- Animations use the `.rise` class with staggered CSS `animation-delay` via `style` attributes — follow existing patterns.
