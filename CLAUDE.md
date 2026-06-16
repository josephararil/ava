# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Omnius Technology Exhibition** — an HTML slide deck presenting the Omnius multi-asset trading platform to potential clients at Ava Trade.

No build step, no package manager. Five files plus two CDN libraries:

| File | Contents | Size |
|------|----------|------|
| `index.html` | `<head>` + all slide markup (`<main>`) | ~28 KB |
| `styles.css` | Full design system — CSS custom properties, layout, animations | ~18 KB |
| `app.js` | Slide navigation engine (keyboard, click, dots, progress) | ~1.5 KB |
| `anim.js` | GSAP entrance choreography + Three.js WebGL effects | ~775 lines |
| `arch.png` | Architecture diagram (was a base64 inline image) | ~283 KB |

**CDN libraries loaded in `<head>` (deferred, in execution order):**
- **GSAP 3.12.5** — entrance choreography, timeline sequencing, scroll/trigger animations
- **Three.js r128** — WebGL 3D field effects used on divider slides and the cover hero

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

Five-file project:

- **`index.html`** — `<head>` + 22 `<section data-i="N">` slides (0–21) inside `<main>`
- **`styles.css`** — full design system via CSS custom properties, slide layout, animations
- **`app.js`** — slide navigation engine (keyboard ←/→, Space, Home/End; click; progress bar; dot indicators)
- **`anim.js`** — GSAP entrance choreography + Three.js WebGL effects; runs after `app.js`
- **`arch.png`** — architecture diagram used in slide 6

### Slide Structure

| Range | Section |
|-------|---------|
| 0 | Cover |
| 1 | The Opportunity — CEO-level "why own Omnius at all" pitch (animated leapfrog hero) |
| 2 | What Omnius Means for Ava |
| 3 | Divider A |
| 4 | What Is Omnius (6 capability cards) |
| 5 | What The Platform Does (functional scope + 3-layer arch) |
| 6 | Core Components Diagram |
| 7–14 | Technical Deep Dive (models, liquidity, institutional, SoR, TV, bespoke, perf, foundation) |
| 15 | Divider B |
| 16–18 | Why We Built It & How (AI team, AI proof, cost comparison) |
| 19 | Divider C (live demo) |
| 20–21 | Closing |

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
- **Animations & 3D effects** → edit `anim.js`.
- **Architecture diagram** → replace `arch.png`.
- To add a slide: add a new `<section>` with the next sequential `data-i`. The JS uses `slides.length` dynamically — no hardcoded count to update.
- CSS `[data-r]` staggered rise-in is the **fallback** for when `anim.js` hasn't loaded. When `anim.js` is live, it adds `body.js-anim` and GSAP takes over entrance choreography entirely.

## Animation System

Two layers work together:

**CSS fallback (`styles.css`)** — `[data-r="1..6"]` attributes on slide children trigger a simple `rise` keyframe (fade + translateY) with staggered delays. Always works, even without JS.

**GSAP + Three.js (`anim.js`)** — loaded after `app.js`. When active, sets `body.js-anim` which disables the CSS rise animations. Use this layer for anything beyond simple fade-ins:
- **GSAP timelines** — per-slide entrance sequences, staggered reveals, counter animations, morphing
- **Three.js WebGL** — particle fields / 3D ambient effects on divider slides (A, B, C) and the cover hero; injected as fixed `.fx-webgl` / `.fx-cover` canvases behind slide content
- **SVG connectors** — `anim.js` can inject `.fx-svg` overlays inside slides for animated paths/flows

**When adding animations, prefer `anim.js` + GSAP** over new CSS keyframes — it gives timeline control, easing presets, and plays well with the existing entrance system. Pure CSS animations (like the `sor-*` SVG flows on slide 10) are fine for self-contained, always-on effects that don't need to be sequenced with slide transitions.

**Reduced-motion:** `anim.js` checks `prefers-reduced-motion` and sets `body.reduce-motion` — reveal elements instantly, skip WebGL. Always respect this in any new animation code.
