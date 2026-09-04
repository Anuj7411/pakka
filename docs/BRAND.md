# Pakka — visual identity

Specification v1, September 2026. Produced by Claude Design; the source comp is
`Pakka Visual Identity.html`. Full research, sources and dates live in the
accompanying `DESIGN.md` from that session.

This file is the extracted, portable version — attach it to any tool that needs
to work in the brand without shipping an 800KB bundle.

## The idea

Hindi पक्का — confirmed, certain, locked-in. *Paka* is cooked. *Pakka* is
certain. The doubled क्क is the whole word.

The mark is that geminate: **two K's**. Drawn alone, a lowercase-K skeleton is
also the character `<` — and Pakka's decision lattice is written
`allow < escalate < block`. KK to a Hindi speaker, two ordering operators to an
engineer. Both readings are the same fact.

### Two glyphs, one asymmetry

The two glyphs are **not identical, and the asymmetry is the architecture.**

| Glyph | Layer | Rights |
|---|---|---|
| Stem + chevron — a complete K | deterministic | may allow · may escalate · **may block** |
| Chevron, no stem — incomplete | language model | may allow · **may only escalate** |

The complete K has a foundation, so it is allowed to stop a payment: it can
prove quantities, lengths, part numbers, totals, and proof is what earns the
right to stop money. The stemless chevron can point and can order, but has no
ground to stand on. **It is never drawn closed, at any size.**

    verdict = max(deterministic, model)   over   allow < escalate < block

### What the mark deliberately is not

- **No tick.** A tick would be a factual lie — the model layer structurally
  cannot approve anything. A mark that says "approved" misdescribes the system.
- **No shield, padlock, chain-link or lightning bolt.**
- **One chamfer** on an otherwise plain square. It survives 16px where a
  rounded square does not, and a cut corner is what a franked, filed document
  looks like. Pakka signs an Ed25519 certificate into an append-only log — the
  corner is gone and you cannot put it back.

## Geometry

Drawn on a 32u grid (twice the 16px floor) so every terminal lands on a whole
pixel at 16, 32, 64 and 128px. Butt caps, mitre joins, no optical rounding.

    seal      M0 0 H22 L32 10 V32 H0 Z
    chamfer   10u on both axes
    stroke    3u · butt · mitre · miterlimit 1.05
    L stem    x8 · y8 -> 24
    L chev    16,8 -> 8,16 -> 16,24
    R chev    25,8 -> 17,16 -> 25,24
    shift     -0.6x +0.6y (optical)

### Three cuts

Each cut is drawn separately. **None is a scaled copy of another.**

| Cut | Size | Spec |
|---|---|---|
| Large | >= 32px | stroke 3u · chamfer 10u |
| Small-use | 20–31px | stroke 3.5u · chamfer 12u |
| Micro | 16–19px | stroke 4.5u · **model layer dropped** |

At 16px two 2px strokes separated by a sub-pixel gap merge into a smear, so the
model layer is dropped — and the layer that survives is the one that can act.
Below 16px no mark is used: the tab falls back to a solid Haldi chamfered square
with no interior strokes. A silhouette is still Pakka. A smudge is not.

## Two states

The name is a question and an answer, so the mark is too. The asking state is
not a second drawing — it is the seal with its deterministic layer withheld.
No new shape enters the system.

- **`pakka ?` — asking.** Un-struck outline, 1.4u, one stemless chevron. While a
  cart is being checked, only the layer that can raise a hand is drawn: chevron,
  no stem, no field.
- **`pakka .` — signed.** Struck, Haldi field, both layers present, second
  impression in Vermilion at 30%. When the Ed25519 certificate signs, the stem
  lands and the seal is struck.

The state change is the product's actual state change, not an animation added to
a static mark.

**Applied strike** — rotated -2.5°, offset 1.4u, Vermilion at 34%. A hand-struck
impression rather than a placed logo. Licensed for stationery, stickers, merch
and the certificate stamp. **Never the master lockup, never in product UI.**
The second impression drops below 20px.

## Typography

| Role | Face |
|---|---|
| Wordmark | **drawn, not set** — monolinear on a 32u cap |
| UI | **Archivo** |
| Mono / figures | **Martian Mono** |
| Devanagari | **Anek Devanagari** (Ek Type, Mumbai) |

The wordmark is uppercase, against the category's lowercase-geometric default,
which is what makes the geminate visible at a glance. P's bowl, A's apex and
both K's are built from the same three moves: a stem, a 45° diagonal, a flat cut.

- **Large cut**, >= 96px wide — 4.6u stroke.
- **Small-use cut**, < 96px wide — 5.4u stroke, KK gap opened from 1.4u to 4.4u.
  It looks loose at that size. That is correct.

**पक्का is co-primary, not subordinate.** It is set, not drawn — the shirorekha
carries the word and redrawing it badly would cost more than it gains. It sits
under the drawn Latin on a shared hairline at matched cap. क्क is the same
geminate the mark draws, which is why the two carry equal weight without
competing.

## Colour

Four values. Flat. **No tints, no gradients.**

| Token | Hex | oklch | Role |
|---|---|---|---|
| Ink | `#0E100C` | `oklch(.18 .008 130)` | ground · wordmark on light |
| Paper | `#F5F2E9` | `oklch(.957 .014 95)` | light ground · knockout |
| Haldi | `#E8C400` | `oklch(.83 .164 96)` | chevrons · **the escalate state** |
| Vermilion | `#D8341B` | `oklch(.58 .203 33)` | **the block state · product only** |

### The one argument with the category

Category practice reserves the accent for the happy path — Cash App green is
money moved. Pakka's thesis is that the model layer may only raise its hand, so
**the brand colour is the colour of raising a hand.** `allow` renders in plain
ink: silence. `block` renders in Vermilion, which appears nowhere else in the
identity.

The accent is turmeric because every other position in the category is taken —
Wise `#9FE870`, Cash App `#00D533`, Robinhood neon, Monzo Hot Coral, Nubank
roxinho, Klarna pink, Coinbase blue, Razorpay blue, Brex orange — and because
turmeric is a specifically Indian colour of marking something confirmed.

### Contrast

| Pair | Ratio |
|---|---|
| Haldi on Ink | 10.9:1 |
| Ink on Paper | 16.4:1 |
| Ink on Haldi | 9.8:1 |
| Haldi on Paper | **1.5:1 — shape only, never text** |

## Clear space and minimums

`c` = seal width ÷ 3.2, the chamfer unit. Applied on all four sides, measured
from outermost ink. Nothing enters it.

| Asset | Digital | Print |
|---|---|---|
| Seal · micro cut | 16 px | 5 mm |
| Seal · small-use cut | 20 px | 6 mm |
| Seal · large cut | 32 px | 10 mm |
| Wordmark alone | 72 px | 22 mm |
| Horizontal lockup | 104 px | 32 mm |
| Stacked lockup | 64 px | 20 mm |
| Endorsed lockup | 160 px | 48 mm |

## In-product components

The identity emits three things in product: a verdict, a certificate, and a
state of waiting. Each has one component and no more.

**Verdict badges — the lattice, in order.** Uppercase mono, tracked +8%, tabular
figures beside them. The order on screen is always `allow`, `escalate`, `block`
— the lattice order — so the badge set teaches the model that produced it.

| Verdict | Treatment |
|---|---|
| `allow` | silence. no colour is spent on the happy path. |
| `escalate` | Haldi. the brand colour is the raised hand. |
| `block` | Vermilion. never appears in the identity. |

**Waiting indicator — the asking seal.** The only place the asking state appears
at large size. It is a state, not a spinner: it does not rotate, pulse or
shimmer. It holds still until the strike.

**Certificate stamp.** The seal at 40% Ink, over-printed with the certificate's
short hash in mono, tabular figures. That is the entire pattern system, and it
exists because the product actually emits the thing it depicts.

## Asset index

| File | What it is | Licensed at |
|---|---|---|
| `pakka-seal-signed.svg` | primary seal, signed | >= 32px |
| `pakka-seal-signed-struck.svg` | applied strike, off-square | print, merch, cert stamp |
| `pakka-seal-asking.svg` | asking, un-struck outline | in-product |
| `pakka-seal-mono.svg` | single colour, masked knockout | engraving, foil, 1-colour |
| `pakka-seal-small.svg` | small-use cut | 20–31px |
| `pakka-favicon-16.svg` | micro cut, signed | 16–19px |
| `pakka-favicon-16-asking.svg` | micro cut, asking | 16–19px |
| `pakka-appicon.svg` | ink ground, seal inset | app icon |
| `pakka-wordmark.svg` | drawn, 4.6u stroke | >= 96px |
| `pakka-wordmark-small.svg` | small-use, 5.4u stroke | < 96px |
| `pakka-lockup-horizontal.svg` | primary lockup | >= 104px |
| `pakka-lockup-stacked.svg` | narrow space | >= 64px |
| `pakka-lockup-bilingual.svg` | co-primary, live Devanagari | India-facing |

The wordmark and mono seal take `currentColor`, so one file serves both grounds.
Everything is pure geometry with no font dependency — **except the bilingual
lockup, which holds live Anek Devanagari and must be outlined before it leaves
the team.**

## What this identity must never do

01. Sit on a gradient, a photograph, a blur, or a mesh.
02. **Restore the right-hand stem.** The model cannot approve; the mark cannot
    say it does.
03. Use the large cut below 32px, the small-use cut above 31px, or the micro cut
    above 19px.
04. Add a shield, padlock, tick, chain-link or lightning bolt — in the mark or
    beside it.
05. Recolour the chevrons to anything but Haldi, Ink or Paper. Never Vermilion.
    Never two colours across the two glyphs.
06. Set the wordmark in another typeface, or letterspace it wide.
07. Substitute पक्का for PAKKA. It accompanies; it does not replace.
08. Rotate, mirror, skew, outline, emboss or shadow the seal. The chamfer is
    always top-right; a mirrored chamfer is a different mark.
09. Set Haldi as text on Paper. 1.5:1.
10. Use the seal alone as a first-impression identifier. The name is not known
    yet.
11. Animate the mark by drawing the chevrons in sequence — it implies the layers
    vote in order. They do not; the answer is a maximum over a lattice. The
    permitted motion is the strike: asking → signed in one 90ms step where the
    field and the stem land together. No draw-on, no easing curve that reads as
    construction. **A stamp does not ease.**
12. Put the mark inside another container — no circle, no rounded square, no
    badge. The seal is the container.
13. Show the applied strike in product UI, or as the master lockup. A payments
    gate does not get to look approximate about its own verdicts.
14. Restore the second impression below 20px, or raise it above 34%. It is a
    printing artifact, not a shadow.
