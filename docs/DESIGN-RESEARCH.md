# Design research — measured, not guessed

Values below were read out of the live sites with `getComputedStyle`, not
recalled or paraphrased. Captured 2026-09-03.

Benchmarks chosen because they are the reference points for developer-tool and
payments UI, and because two of them (Stripe, Vercel) publish design systems the
industry copies.

## Raw measurements

| | Linear | Vercel | Stripe |
|---|---|---|---|
| Body background | `rgb(8,9,10)` | `rgb(0,0,0)` | light |
| Body text | `rgb(247,248,248)` | `rgb(237,237,237)` | `rgb(0,0,0)` |
| Muted text | `rgb(138,143,152)` | — | `rgb(100,116,141)` |
| Body font | Inter Variable | GeistSans | sohne-var |
| Body size / leading | 16px / 24px | 16px / 24px | 16px |
| **h1 size** | **64px** | **64px** | **48px** |
| **h1 weight** | **510** | **400** | **300** |
| **h1 tracking** | **−0.022em** | **−0.06em** | **−0.02em** |
| h1 leading | 64px (1.0) | 64px (1.0) | 55px (1.15) |
| h2 | 40–48px / 510 / −0.022em | — | 32px / 300 / −0.02em |
| h3 | 20px / 590 / −0.012em | — | — |
| Paragraph | 15px / 24px | — | — |
| Section padding | **128px 0** | 128px token | — |
| Card radius | **8–12px** | — | 4px (button) |
| Card background | `rgb(15,16,17)`, `rgba(255,255,255,0.01)` | — | — |
| Card border | **`rgba(255,255,255,0.05–0.08)`** | alpha scale | — |
| Button | 13px, radius `9999px` | — | 14px, radius 4px, weight 400 |
| Nav height | 72.8px | — | — |

**Vercel exposes 372 CSS custom properties.** Its spacing scale is strictly
4px-based: `4, 8, 12, 16, 24, 32, 36, 40, 64, 96, 128, 192, 256`. Its greys are
defined as **alpha over the background** (`#0000000d`, `#00000014`, `#0000001a`,
`#00000036`, `#00000057`, `#00000070`, `#00000082`, `#000000b3`) rather than as
opaque hexes.

## What this says about the previous build

Seven concrete defects, each measurable rather than a matter of taste.

1. **`h1` at weight 700.** All three benchmarks sit at **300–510**. Heavy weight
   at large size is the single loudest "template" tell — real products get
   presence from *size and tracking*, not from weight.
2. **Body text at 14px.** All three use **16px**. 14px is a dashboard density
   choice applied to a page that is doing marketing work.
3. **Gradient-clipped heading text.** *None* of the three do this anywhere.
   `background-clip: text` on an `h1` is close to a signature of generated
   design. Linear, Vercel and Stripe all use a single solid colour.
4. **Section padding 56–96px.** Linear uses a flat **128px**, and Vercel has a
   128px token for exactly this. Cramped vertical rhythm makes a page feel
   busy no matter how good the components are.
5. **Borders as opaque hex** (`#1a1e27`). All benchmarks use **white at low
   alpha** over the surface. Alpha borders track the surface beneath them and
   never look painted on.
6. **Card radius 14px.** Benchmarks sit at **8–12px**. Oversized radii read as
   consumer-app, not infrastructure.
7. **Arbitrary spacing.** `0.9rem`, `1.15rem`, `1.6rem`, `2.2rem` — no scale.
   Vercel proves the discipline: everything is a multiple of 4.

## What to take, and what to refuse

**Take:** the type scale and weights, the 4px spacing system, alpha borders,
128px section rhythm, 16px body, muted greys around `rgb(138,143,152)`.

**Refuse:** copying Linear's aesthetic wholesale. This is a payments *security*
tool. It should feel closer to a terminal and an audit log than to a project
tracker — so monospace carries every hash and identifier, and the decision
states keep their semantic colour. Restraint everywhere else.

The one place to deliberately exceed the benchmarks: **evidence density**.
Linear and Vercel sell on feel because they cannot show you a number. This can.
The strongest section should be a baseline table, not a hero.
