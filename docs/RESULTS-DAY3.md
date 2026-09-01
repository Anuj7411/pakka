# Day 3 results — deterministic checkers, no model

Full corpus (1,000 products, 12,251 instructions), seed 20260829, 60 mandates,
**1,626 cases: 813 divergent, 813 matched conforming.** Corpus
`sha256:bed6c5ebc2a3d1c…`. Reproduce with `npx tsx scripts/run-eval.ts data`.

> **Re-measured 2026-09-01.** The numbers first published here were computed on
> corpus `sha256:e97eb24b237dc95…`, which no longer exists: the head-noun pairing
> gate (Day 5) and the removal of the compound-suffix rule (Day 6 testing) each
> changed which instruction–product pairs the generator produces.
>
> Nothing caught that. `tests/generator.test.ts` had a test named *"pins a corpus
> hash"* which asserted only that the hash **matched a regex** — it pinned the
> shape and not the value, so the corpus moved twice under every published
> figure and the suite stayed green. The test now pins the value, and changing
> pairing fails the build.
>
> The re-measured figures below are the current ones. The drift was small and
> the conclusions are unchanged, which is luck rather than process: detection
> 91.0% → 92.0%, silent 9.0% → 8.0%, and CONSTRAINT_BREACH / UNREQUESTED_ADDITION
> swapped places at 100% / 99.4%.

## A6 answered: how much can pure code decide?

| Class | Recall | 95% CI | n |
|---|---|---|---|
| SCOPE_VIOLATION | **100.0%** | 98–100 | 180 |
| UNREQUESTED_ADDITION | **100.0%** | 98–100 | 180 |
| QUANTITY_DEVIATION | **100.0%** | 96–100 | 93 |
| CONSTRAINT_BREACH | **99.4%** | 97–100 | 180 |
| **ITEM_SUBSTITUTION** | **0.0%** | 0–2 | 180 |

**Four of five classes are decided by code, with no model and no false
positives. The fifth is decided not at all.**

That is the cleanest possible statement of what the semantic layer is for, and
it was measured rather than assumed — the taxonomy's `decidability` field
predicted it, and the harness confirmed it.

## Headline

| | |
|---|---|
| Detection (flagged the cart at all) | **92.0%** [90–94] |
| Classification (right line AND right class) | **77.7%** [75–80] |
| **False positive rate** | **0.0%** [0–0], n=813 |
| Precision, at 50% prevalence | **100.0%** [99–100], n=748 |
| Silent on a divergent cart | 8.0% [6–10] |
| Macro across tiers | **77.7%** |
| Macro across class × tier | **79.9%** |

Precision is quoted with prevalence beside it, always. At 50% prevalence a
coin-flip scores 50% precision; the number only means something next to it.

## Trivial baselines — the floor

| Checker | Detection | Classification | False positive |
|---|---|---|---|
| neverFlag | 0.0% | 0.0% | 0.0% |
| alwaysFlag | 100.0% | 22.1% | **100.0%** |
| biggestCart (leakage probe) | 38.3% | 13.7% | 19.8% |
| **Deterministic** | **92.0%** | **77.7%** | **0.0%** |

`alwaysFlag` scores perfect detection and is worthless. It is here so that a
detection number is never read without its false-positive rate.

## ★ Leakage, disclosed rather than hidden

An `UNREQUESTED_ADDITION` or `SCOPE_VIOLATION` always adds a line, so cart size
carries real signal about the label — the largest carts are divergent-only.
`biggestCart` measures exactly how much that is worth: **13.7% classification at
19.8% false positives.** The leak is real, it is small, and it is reported. We
did not engineer it away, because doing so would have defeated the audit that
found it.

## Difficulty tiers: flat here, and that is the finding

| Tier | Classification |
|---|---|
| easy | 77.9% |
| medium | 78.0% |
| hard | 77.3% |

Detection margin does **not** degrade exact field comparison. Category equality,
option matching and quantity arithmetic are exact — a quantity off by one is as
detectable as one off by ten.

The tiers were built to test the *semantic* layer, and this is the control
showing they do not confound the deterministic one. Whether they bite is a Day 4
question. The one place a gradient does appear is `UNREQUESTED_ADDITION/hard`
(98.3%), where the added product is chosen to look plausible.

## What changed a wrong number into a right one

The first run reported **3.7% false positives** — above our stated ≤2% target.
Rather than report it, we traced all 30.

Every one was `CONSTRAINT_BREACH`, and the cause was in our checker, not the
data: each line picked its own best-matching request *independently*, so in a
multi-item mandate two lines could claim the same request and a third would be
judged against bounds meant for something else — a line of beard scissors
checked against a request stating "silver".

Replacing per-line assignment with a proper **matching** (each request answers at
most one line) fixed it:

| | Before | After |
|---|---|---|
| Classification | 65.3% | **77.7%** |
| False positives | 3.7% | **0.0%** |
| Precision | 95.8% | **100%** |
| UNREQUESTED_ADDITION | 44.4% | **100.0%** |

Unassigned lines *are* the definition of `UNREQUESTED_ADDITION`, which is why
that class jumped: the fix did not add a rule, it made the existing one correct.

## Design choices behind these numbers

**Three-valued decisions.** Checkers return `violation`, `clear`, or
`undecidable`. In a money gate "I cannot tell" must never be recorded as "no
problem". `wrongProductForSlot` is *always* `undecidable` — kept explicit rather
than omitted, so the Day 4 ablation can show precisely what the model adds.

**Precision first.** A deterministic false positive blocks a good cart, the
failure a payments company actually fears; a deterministic miss merely defers to
the model. Every rule prefers `undecidable` to a guess. The 0.0% FP rate is that
choice paying off.

**One stated assumption.** A line's declared `options` and `attributes` are
treated as complete for the dimensions they mention. A line that declares
nothing is `undecidable`, never `clear`.

## Limitations
- Quantity cases are n=93, not 180: the injector refuses to fire without a stated
  quantity, so only mandates that state one contribute.
- `ITEM_SUBSTITUTION` at 0% is by design, not a defect — but it means the
  headline classification figure is capped near 80% until the semantic layer
  lands.
- The corpus is US/Amazon catalogue data. The conformance mechanism is
  market-independent; the India argument concerns the rails, not the products.
