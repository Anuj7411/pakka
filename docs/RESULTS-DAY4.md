# Day 4 results — semantic layer. A7 answered.

> **⚠️ SUPERSEDED IN PART, 2026-08-31.** Everything below was measured on corpus
> `sha256:4f3acf4e74b8a…`, whose conforming labels were produced by lexical
> pairing alone. That pairing was wrong (see "the 70% false-positive figure"),
> and it has been replaced. **The ablation table describes a corpus that no
> longer exists** — re-run results are in `RESULTS-DAY4-RERUN.md`.
>
> What survives unchanged: the calibration finding, which is label-independent,
> and the architecture argument that follows from it. What does not: every rate
> in the table.

Model `gemini-3.1-flash-lite`, temperature 0, structured output. 160 cases from
6 mandates, seed 20260829, corpus `sha256:4f3acf4e74b8a…`.
**37 provider calls, 255 cache hits, 0 failures.** Reproduce with
`npx tsx scripts/run-ablation.ts tests/fixtures 6 400 2200 gemini-3.1-flash-lite`.

## Ablation

| | A: deterministic | B: semantic only | C: both |
|---|---|---|---|
| Detection | 90.0% | 77.5% | **100.0%** |
| Classification | 77.5% | 10.0% | **87.5%** |
| Silent on a divergent cart | 10.0% | 22.5% | **0.0%** |
| **False positive** | **0.0%** | 70.0% | 70.0% ⚠️ |
| Macro across tiers | 77.4% | 9.9% | **87.4%** |

Per class, classification:

| Class | A | B | C |
|---|---|---|---|
| SCOPE_VIOLATION | 100% | 0% | 100% |
| CONSTRAINT_BREACH | 100% | 0% | 100% |
| QUANTITY_DEVIATION | 100% | 0% | 100% |
| UNREQUESTED_ADDITION | 100% | 0% | 100% |
| **ITEM_SUBSTITUTION** | **0%** | **44.4%** | **44.4%** [25–66] |

Per tier, classification:

| Tier | A | C |
|---|---|---|
| easy | 76.0% | 80.0% |
| medium | 78.6% | 82.1% |
| hard | 77.8% | **100.0%** |

## A7: can the semantic judge be calibrated?

**Two answers, and they point opposite ways.**

### It does the one job code cannot

`ITEM_SUBSTITUTION` goes 0% → **44.4%**, and nothing else moves. That is the
cleanest possible demonstration of what the model is for: Day 3 measured pure
code at 100% on four classes and 0% on this one, and the model recovers only
that class. Detection reaches 100% and the silent rate falls to 0%.

**The gain is largest on the hard tier: 77.8% → 100%.** The difficulty tiers
were flat under deterministic checking, because exact field comparison does not
care about margin. They bite here, in the direction predicted — a
same-brand-adjacent substitution is exactly what a field comparison misses and
a language model catches.

### Its confidence signal is worthless

Across 37 distinct prompts:

| Confidence | Count | Share |
|---|---|---|
| 1.0 | 35 | **94.6%** |
| 0.9 | 2 | 5.4% |

**Two distinct values. 95% of verdicts at exactly 1.0**, including cases it got
wrong and cases it declined. ECE 71.1%.

This is label-independent — it does not depend on whether our labels are right —
and it settles the design question: **the abstention band cannot work as
specified.** `ABSTAIN_BELOW = 0.5` never fires, because nothing is ever below
0.5. Self-reported confidence carries no usable signal, so a coverage-risk curve
over it would be a straight line.

If we want an abstention mechanism it has to come from somewhere else —
agreement across repeated samples, or a second lens — not from asking the model
how sure it is.

## ⚠️ The 70% false-positive figure is NOT a measurement of the model

It is the largest number in the table and it is the one that cannot be reported
as a model error. Inspecting the flagged conforming cases shows the model is
substantially **right**:

> **request:** "i am looking for nut free and gluten free chocolate"
> **product:** "Blue Diamond **Almonds** Nut Thins Gluten Free **Cracker Crisps**"
> **model:** *"The product is a cracker crisp, not chocolate, and it contains almonds, which are nuts."*

> **request:** "an 8 ounce pack of chocolate covered cookies, i need 4 of them"
> **product:** "Goya Chocolate & Vanilla Wafers, 4.9 Ounce (Pack of 24)"
> **model:** *"the product provided is a single 8-ounce pack…"*

Both were labelled **conforming** by our corpus. Neither product answers its
request.

**Root cause is ours.** `MIN_PAIR_SIMILARITY = 0.20` is a *lexical* threshold.
"nut free gluten free chocolate" and "Nut Thins Gluten Free Cracker" share
tokens, so the pairing accepted them — but token overlap is not satisfaction.
Our conforming label means "the best lexical match in the catalogue", not "this
product answers this request".

So the 70% conflates two different things, and we cannot separate them from this
run:
- the model over-flagging, and
- our conforming cases not actually conforming.

**No false-positive rate for the semantic layer is publishable until conforming
labels are verified.** Reporting 70% as a model weakness would be as wrong as
reporting the earlier rate-limited run as a model result.

The deterministic 0.0% FP is unaffected — those checks compare stated fields
against declared fields and never consult the pairing.

## ★ The architecture decision is vindicated by the data

`SOURCE_DECISION` sends deterministic findings to **block** and semantic
findings to **escalate**. That was argued from epistemics: exact checks are
provable, model judgements are inferences.

The measurement makes it concrete. Had semantic findings blocked, this run would
have **blocked 70% of conforming carts** — and it would have been *partly right
to*, which is worse, because the failure would look like a corpus problem rather
than a policy one. Escalation puts exactly these cases in front of a human, which
is where "is a nut-free chocolate request satisfied by almond crackers?" belongs.

The design was chosen before the number existed. The number says it was correct.

## What changes for the remaining days

1. **Verify conforming labels before quoting any FP rate.** The n=100 human
   validation moves up: it is now load-bearing, not a credibility garnish.
   **Still outstanding.** The pairing fix below reduced the bad-label rate; it
   did not remove it.
2. ~~**Raise or replace the pairing threshold.**~~ **Done** — replaced, not
   raised. See below.
3. ~~**Drop the confidence-based abstention band.**~~ **Done** — removed, along
   with the `abstention` finding source that nothing could then produce.
4. Keep the ablation on constructed-divergence cases, where labels are exact by
   construction: those are the numbers that survive.

## What was done about it, 2026-08-31

### The pairing threshold was replaced, not raised

Raising it cannot work. The bad pair scores *well* by construction — it shares
every modifier the request states. The fix has to look at **which** token
matched, not how many, so pairing now also requires the product to carry the
request's **head noun**: the thing being asked for.

Three attempts, and the first two failed in ways worth recording, because both
looked correct against a hand-picked test set.

| Attempt | Rule | Failed on |
|---|---|---|
| 1 | last content token | `"…permanent hair dye in espresso"` → *espresso* → matched Pilon Espresso Coffee |
| 2 | strip opener, stop at clause boundary | reused `similarity.tokenise`, which **strips stopwords** — so "of", "for", "with", "that" were gone before any boundary could apply, and heads slid to the object of a trailing prepositional phrase: `"curtains FOR my living ROOM"` → *room* |
| 3 | own tokeniser, boundaries, partitive "of", generic-head qualifiers | in use |

Attempt 1 scored 9/9 on cases I chose myself. It scored 4/12 once the cases came
from the corpus. **A hand-picked sample is not evidence** — it is the same error
that produced the 70% figure in the first place, one level up.

Also fixed en route: `stem()` stripped "es" wholesale, so "headphones" became
"headphon" while "headphone" stayed "headphone" and the two stopped matching. It
runs on both sides of a comparison, so symmetry is the only property that
matters.

**Validation protocol.** Random draws, with a fresh seed after every tuning
round, since a seed I have tuned against is no longer evidence.

| Sample | Correct |
|---|---|
| held-out draw, before generic-head rule | 13/20 |
| held-out draw, current rule | **18/20** (1 marginal, 1 wrong) |

Pairings: **1,570 → 705.** Instructions with no recognisable head, dropped
rather than guessed: 8.1%. The remaining known failure is a compound noun whose
second word is packaging — "hair **piece**" → Hair Removal Pads.

**This does not make the conforming labels verified.** Roughly one in ten is
still wrong. No semantic false-positive rate is publishable until the n=100
human validation. The deterministic FP rate is unaffected and re-measures at
**0.0%** — those checks never consult the pairing.

### The abstention band was removed

`ABSTAIN_BELOW = 0.5` gated `wrong_product` verdicts by self-reported
confidence, and its docstring said it had been "CALIBRATED against measured data
in the coverage-risk sweep". It had not been. The measurement above shows
nothing is ever below 0.5, so it could not fire.

Removed rather than lowered — a threshold that never triggers advertises a
calibration we do not have. The `abstention` finding source went with it: once
the band was gone nothing could produce one, and a decision-table row no code
path can reach is a claim about behaviour that does not exist. `SOURCE_DECISION`
is now exactly two rows, and the gate test enumerates sources rather than naming
them, so a source that blocks fails a test instead of a payment.

## Reproducibility
Pinned model id, temperature 0, prompt-hash cache keyed on model, corpus hash
recorded, 0 failed calls. `gemini-2.5-flash` free-tier quota was exhausted by an
earlier broken run, so this used `gemini-3.1-flash-lite`. The cache key includes
the model id, so no verdict from one model can be served as another's.
