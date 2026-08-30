# Day 4, re-run — after the pairing fix

Supersedes the ablation table in `RESULTS-DAY4.md`, which was measured on a
corpus that no longer exists.

Model `gemini-3.1-flash-lite`, temperature 0, structured output. 160 cases from
6 mandates, seed 20260829, corpus `sha256:1dcce73b32bb2…` (was
`sha256:4f3acf4e74b8a…`). **30 provider calls, 261 cache hits, 0 failures.**

```
npx tsx scripts/run-ablation.ts tests/fixtures 6 400 2200 gemini-3.1-flash-lite
```

## Ablation

| | A: deterministic | B: semantic only | C: both |
|---|---|---|---|
| Detection | 91.3% | 72.5% | **100.0%** |
| Classification | 77.5% | 8.8% | **86.3%** |
| Silent on a divergent cart | 8.8% | 27.5% | **0.0%** |
| False positive | **0.0%** | *not measurable* | *not measurable* |
| Macro across tiers | 77.4% | 8.6% | **86.0%** |

Per class, classification:

| Class | A | B | C |
|---|---|---|---|
| SCOPE_VIOLATION | 100% | 0% | 100% |
| CONSTRAINT_BREACH | 100% | 0% | 100% |
| QUANTITY_DEVIATION | 100% | 0% | 100% |
| UNREQUESTED_ADDITION | 100% | 0% | 100% |
| **ITEM_SUBSTITUTION** | **0%** | **38.9%** | **38.9%** [20–61] |

Per tier, classification:

| Tier | A | C |
|---|---|---|
| easy | 76.0% | 76.0% |
| medium | 78.6% | 82.1% |
| hard | 77.8% | **100.0%** |

The shape is unchanged from the first run and the conclusion holds: the model
moves exactly one class, and it moves the hard tier from 77.8% to 100%. The
point estimate for ITEM_SUBSTITUTION fell from 44.4% to 38.9%, which is one case
out of 18 and sits well inside the interval — not a change worth a story.

## The false-positive rate is withheld, not improved

I set out to fix a 70% false-positive rate by fixing the pairing. **The pairing
fix did not move it. It is still exactly 70.0%.** That is the useful result, and
it took looking at the flagged cases to understand why.

All 56 flagged conforming cases come from **five distinct (request, product)
pairs**:

| Repeats | Request | Paired product | Model's objection |
|---|---|---|---|
| ×15 | bootcut yoga **pants** | Bike **Shorts** … Yoga Pants | "requested bootcut yoga pants, provided product is bike shorts" |
| ×15 | slim fit **t-shirt** | Oxford **Shirt** | "an Oxford shirt, not a t-shirt" |
| ×14 | **butter pecan** coffee | Pilon **Espresso** Coffee | "French Vanilla flavored, not Butter Pecan" |
| ×14 | **full** sized bed frame | Cole Frame **Queen** Bed | "attributes explicitly state 'queen size'" |
| ×13 | **3-drawer** file cabinet | **2-Drawer** File Cabinet | "requested 3-drawer, provided 2-drawer" |

The head noun matches in all five — *pants*, *shirt*, *coffee*, *frame*,
*cabinet*. The head-noun gate did its job. **Every one of the model's objections
is correct.**

### The structural cause

A conforming case takes a human instruction, attaches the **gold target's**
attributes to it, and attaches both to **the nearest product we actually hold**.
It has to: WebShop's gold target is present in our catalogue for **4
instructions out of 10,136** (13 by raw ASIN — see the note below), and the
instruction records carry no product name, so gold-target pairing is not
available at any scale.

The consequence is that a conforming cart line is a splice:

- its **declared fields** come from the gold target and are consistent with the
  mandate — which is why the deterministic layer sees no violation, correctly;
- its **name** belongs to a different product, and says so out loud.

A checker that reads only declared fields is measuring itself. A checker that
reads the name is right to object, and counting that as its error measures our
corpus. There is no threshold that fixes this, because the flaw is in the
construction, not in the cut-off.

### It cannot be repaired by tightening either

The obvious next tightening — require every stated constraint to appear in the
product name — was measured:

| Gate | Pairings |
|---|---|
| similarity ≥ 0.20 | 1,570 |
| + head noun | 705 |
| + every stated value present in the product name | **32**, over 22 distinct products, 6 categories |

32 pairings is not a corpus. And the survivors are not clean either: "5x long
sleeve shirts" survives against a Slim-fit Oxford Shirt because "5x" is not a
value the name carries at all.

### So the harness now refuses to print it

`evaluate()` takes `CheckerFacts { readsProductName }`. When true, `falsePositive`
and `precision` are `null` and the report prints `NOT MEASURABLE — conforming
labels are not verified`.

Withheld rather than printed with a caveat underneath, because **a number in a
table gets quoted and a caveat does not** — and the type is `Rate | null`, so
every consumer has to handle the absence rather than ignore a footnote. This is
the same discipline as the three-valued decision: *cannot tell* must never be
recorded as *no problem*, and it must not be recorded as 70% either.

Deterministic false positives remain **0.0%** and remain meaningful.

## What is publishable from this run

- **Yes:** everything computed on constructed-divergence cases. Those labels are
  exact by construction — we made the perturbation ourselves and know what it
  was. Detection, classification, per-class, per-tier, silence.
- **Yes:** deterministic false positives, 0.0%, because those checks never
  consult the pairing or the name.
- **No:** any semantic or combined false-positive or precision figure, until
  conforming labels are verified by hand.

## Calibration, re-measured

| Confidence | n | Accuracy |
|---|---|---|
| 0.9 | 72 | 95.8% |
| 1.0 | 219 | 36.1% |

Two distinct values again, ECE 52.1%. The signal is not merely flat, it is
**inverted** on this run: the verdicts the model marks 1.0 are the ones it gets
wrong. That accuracy column inherits the label problem above and should not be
read as a model score — but "two distinct values" does not, and it is the same
finding as before. The abstention band is gone; nothing here argues for
bringing it back.

## Note on an unrelated defect found while checking this

`normaliseProduct` reads the ASIN from `product_information`, which carries it
for 481 of 1,000 products, while every product has an authoritative top-level
`asin` field. 12 of the 481 are prefixed with an invisible U+200E left-to-right
mark. Filed separately; it does not affect any number above, and fixing it
raises gold-target overlap from 4 to 13 — still far too few to change the
conclusion.
