# Golden Arena — design refinement

> v2 shipped "game-show noir": warm near-black, gold foil, stamps. It tested well and it is good. It is also a costume. This document takes it from *themed* to *designed*.

## 1. The concept flip

Gold on black is the safe premium choice, the one every polished entry reaches for. The stronger move is not a palette tweak, it is a change of what the thing **is**.

**Golden Arena is not a casino. It is an archive.**

A printed behavioural journal. Cream stock, black ink, one oxblood stamp. Each match is a plate; each receipt is a numbered impression; the Index is the catalogue. A betrayal rendered as red rubber on cream is more unsettling than gold on black, because it reads as a *record* rather than a *show*. The coldness of the document is the drama.

## 2. The two registers, and why the palette switches

The product has exactly two places, and they look different on purpose:

**THE ARCHIVE (default, light).** Home, the Index, the rules, the watch view, every receipt. Printed cream paper, ink type, editorial grid. This is where the record lives.

**THE ROOM (dark, only inside a live match).** You sit down and the lights go down. Warm near-black, a single overhead pool, the opponent across the table. This is where it happens.

The transition carries the meaning: **entering a match dims the lights, and finishing one prints the record onto paper.** The stamp lands on cream. That single move justifies both palettes and gives the app a spine that a flat re-skin never would.

## 3. Palette

```css
/* ── THE ARCHIVE (light register) ─────────────────────────────── */
--paper-0:  #F2ECE0;   /* the page */
--paper-1:  #E9E1D2;   /* inset cards, table rows */
--paper-2:  #DED4C2;   /* wells, quoted matter */
--ink-0:    #17130E;   /* body ink */
--ink-1:    #4A4238;   /* secondary */
--ink-2:    #7A7061;   /* captions, folio, method notes */
--rule:     rgba(23,19,14,.14);   /* hairlines */

/* ── THE ROOM (dark register, live match only) ────────────────── */
--room-0:   #14100C;
--room-1:   #1D1811;
--room-2:   #262019;
--room-ink: #EFE7D8;

/* ── ACCENTS · one family each, both registers ────────────────── */
--oxblood:      #8E2B20;   /* betrayal, breach, the stamp */
--oxblood-lift: #A8382B;   /* same on dark */
--verdigris:      #2E5A46; /* cooperation, honoured deal */
--verdigris-lift: #4E8A6C; /* same on dark */
--foil:         #B08A3E;   /* hairline rules and small marks ONLY */
```

**The foil rule.** Gold survives as a *printed gold hairline*, the way it appears on a good book cover. It never fills a button, never becomes a gradient, never clips a headline other than the wordmark. This is the single biggest visual change and the one that moves it from hackathon-premium to editorial.

## 4. Type

| Role | Face | Notes |
|---|---|---|
| Display | Playfair Display 700 / 700 italic | Already self-hosted. A Didone is exactly right for editorial. |
| Body | **Archivo 400 / 500 (add)** | Grotesk body against Didone display is the classic editorial pairing. Same family as the stamp, so the system tightens. |
| Stamp | Archivo Black 400 | Already self-hosted. |
| Data | system mono | `font-variant-numeric: tabular-nums` enforced everywhere a number can change. |

**Numerals are a hero element.** Payoffs, net worth, percentages: set them large, mono, tabular, and let them carry the page. In an archive, the figure is the point.

## 5. Grid and page furniture

The archive register uses an actual editorial page, not a dashboard:

- **Running head** on every view: `GOLDEN ARENA · THE BEHAVIORAL INDEX · Nº 20` in small caps with a foil hairline beneath.
- **Folio** at the foot: section marker and record count.
- **Marginalia column** on wide screens for method notes and footnotes, instead of burying them in a paragraph at the bottom.
- **Measure**: prose capped near 68ch; tables may run to 1080px.
- **Baseline rhythm**: everything on the 4px scale, headings snapped to 8px.
- **Radii**: 2px on cards and buttons. Pills survive only for status chips.

## 6. Motion: near-silence

Current build has stamp slam, count-ups, staggered entries and hover lifts. Cut it back to almost nothing, because when the page is silent the one gesture lands ten times harder.

- **Keep:** the stamp (slam, slight rotation, ink irregularity) and a soft paper-settle on the receipt.
- **Keep:** the lights-down transition into a match, and the print transition out of it. These carry meaning.
- **Kill:** hover lifts, glow shadows, gradient animation, staggered card entrances, count-ups on anything but the final payoff.
- **Page changes:** 120ms opacity, no slide.
- `prefers-reduced-motion` continues to disable everything except instant state changes.

## 7. Editions

The receipt already carries `Nº XPE7 · 07 AUG 2026 · DEMO TABLE`. Push it all the way:

- Every receipt is an **impression**: number, date, plate (the game), edition (demo or live table).
- The Index is the **catalogue**: numbered entries, running total, a note on the method.
- The only textural indulgence in the whole system: a faint paper grain on the archive register, and an ink irregularity on the stamp. Nothing else gets texture.

## 8. What to kill, specifically

| Current | Replace with |
|---|---|
| Gold gradient filled buttons | Ink outline, 2px radius, foil hairline on the primary |
| Foil-clipped gradient on every `h2` | Solid ink Playfair; foil clipping survives on the wordmark only |
| Glow shadows (`--glow-gold` etc.) | A single very soft paper shadow, or nothing |
| Radial "overhead light" on every page | Paper grain in the archive; the light pool stays, refined, in the room |
| Pills everywhere | 2px radii; pills only for status chips |
| Three-column dashboard feel | Editorial page with running head, marginalia, folio |

## 9. Risks, named

**"Won't cream look boring?"** The drama comes from the content: a red stamp on pale paper, a damning quote set in italic, a number set enormous. Restraint amplifies. The failure mode to watch is not boring, it is *bland*, and the guard against bland is the running head, the marginalia and the oversized figures. If a page has no dominant element, it is wrong.

**Contrast.** The archive register must clear 4.5:1 for body and 3:1 for large text. `--ink-2` on `--paper-1` is the pair most likely to fail; check it rather than assume it.

**Do not half-flip.** A cream page with gold gradient buttons left in would be worse than either concept executed cleanly. The kill list in §8 is not optional.
