# Day 7 — reserve sizing and the OC-228 constraint proof

```
npm run oc228          # or: npx tsx scripts/run-oc228.ts [sequences] [trials] [seed]
```

## The headline number

**Constraint-violation rate: 0.0000%** — 3,899 simulated block-and-debit
sequences, sized by the sizer, judged by an independent verifier. Seed 20260901.

That number is worth exactly nothing on its own, so it is never reported alone.

## Why a violation rate of 0 is not a claim

A verifier whose body is `return []` scores 0.0000% on every corpus ever
generated. So does a simulation that only ever constructs legal inputs. The
number only means something if the *same* verifier demonstrably catches
violations when they are there.

So the harness measures two things and the build gate requires both:

| | What it asks | Requirement |
|---|---|---|
| **Soundness** | over legal sequences, does the verifier find anything? | must be **0** |
| **Sensitivity** | with one breach injected per rule, does it catch that rule? | must be **100%**, per rule |

Sensitivity, seed 20260902, 500 trials per rule:

| Rule | Caught |
|---|---|
| `AMOUNT_EXCEEDS_MAX` — block over ₹10,000 | 500/500 |
| `VALIDITY_EXCEEDS_MAX` — over 90 days | 500/500 |
| `CONCURRENT_BLOCK_FOR_PAIR` — second block, same merchant + customer | 500/500 |
| `DEBIT_EXCEEDS_BLOCK` — drawing more than was blocked | 500/500 |
| `DEBIT_AFTER_EXPIRY` | 500/500 |
| `DEBIT_AFTER_REVOKE` | 500/500 |
| `DEBIT_BEFORE_BLOCK` | 500/500 |
| `DEBIT_NOT_POSITIVE` | 500/500 |
| `DEBIT_ON_UNKNOWN_BLOCK` | 500/500 |
| `AMOUNT_NOT_POSITIVE` | 500/500 |
| `AMOUNT_NOT_INTEGER` — fractional paisa | 500/500 |
| `VALIDITY_NOT_POSITIVE` | 500/500 |

A test asserts that **every** violation code the verifier declares has an
injection exercising it. A rule with no injection is a rule whose enforcement is
untested, and the headline number would silently exclude it.

### The gate was checked against a sabotaged verifier

Blinding `verifyBlock` to return early was tried deliberately. The soundness
half still reported **0.0000%** — unchanged, perfect, meaningless. The
sensitivity half reported 6 rules MISS and the run exited non-zero.

That is the evidence that the number is load-bearing rather than decorative.

## Separation of duty is structural, not asserted

Clark-Wilson E3. `src/verifier/oc228.ts` **has no imports at all** — a test reads
the source and asserts it. The regulatory constants are duplicated in the sizer
rather than shared, and that duplication is the mechanism: two independent
statements of ₹10,000 can disagree and be caught; one shared constant is a typo
in both places at once.

A second test asserts the verifier exports nothing that proposes, adjusts,
clamps or repairs. Its only output is a list of violations, and an empty list is
the only way to pass. A verifier that could correct its input would be a second
sizer wearing a badge.

## What the sizer does, and what it refuses to do

| Rationale | When | Amount |
|---|---|---|
| `CART_PLUS_HEADROOM` | comfortably under the ceiling | cart + 5%, rounded up |
| `HEADROOM_TRIMMED_TO_CAP` | headroom would breach ₹10,000 | exactly ₹10,000 |
| `CAPPED_AT_REGULATORY_MAX` | cart is exactly ₹10,000 | ₹10,000 |
| `CART_EXCEEDS_MAX_BLOCK` | cart is over ₹10,000 | **0, and `fundable: false`** |
| `EMPTY_CART` | nothing to fund | 0 |

The last one matters. An over-ceiling cart is **refused, not clamped**: blocking
the maximum would look like a funded purchase and then fail at debit time, which
is the worst of both outcomes. In the simulation 6,101 of 10,000 random carts hit
this path — those are counted and reported, not quietly dropped, so the
denominator stays honest.

Rounding is up, and integer throughout. 1 paisa at 5% is 0.05 paise; rounding
down would give zero headroom while the certificate still claimed 5%.

## The 5% headroom is a policy, not a result

It covers movement between blocking and debit — shipping computed at checkout,
tax rounding, a small price change. It is **not** a buffer for the agent buying
something different; that is a conformance question the gate already answered.

Choosing it properly needs the stranded-capital versus re-authorisation-rate
frontier, and that needs real debit data we do not have. It is a named parameter
so it can be tuned against numbers later rather than quietly baked in now.
Calling it optimised would be a claim we cannot support.

## The certificate now carries the proof

`reserve` was an explicit `null` from Day 5 waiting for this. It now holds the
amount, the rationale, the sizer's policy version, and the verifier's own
version and verdict — the number and the judgement on it, from different
modules, both inside the signature. A test confirms that editing
`reserve.amount_paise` after issuance breaks verification.

Reserve sizing is **off by default**. A reserve on a plain card order would put a
number on the certificate that nothing acts on.

## Provenance, and the risk if it is wrong

NPCI/UPI/OC-228/2025-26, *"Enhancement in UPI Single Block Multiple Debits (UPI
Reserve Pay)"*, 08-Oct-2025: one block per merchant per customer, maximum
₹10,000, validity up to 90 days, multiple and partial debits until used, revoked
or expired, unused remainder auto-released.

**The NPCI PDF returns HTTP 403 to automated fetching.** These parameters are
verified by triangulation across three independent secondary sources that agree
verbatim, two of them payment-aggregator developer documentation. That is stated
here rather than hidden.

If the circular differs, `src/verifier/oc228.ts` is the single place it is wrong,
and the conformance half of the project is untouched. That isolation was the
reason for the separation before it was a reason for confidence in it.

## Not claimed

- **Not** a proof that a real UPI Reserve Pay integration is compliant. This
  checks proposals against the constraints as we understand them; it does not
  talk to NPCI, and no issuer has validated it.
- **Not** an optimal sizing policy. See the headroom note above.
- **Not** coverage of every OC-228 obligation. Customer notification on block
  creation, modification, debit, revoke and expiry is a member obligation in the
  circular and is not modelled here. The retry rule (3 attempts in 24 hours)
  rests on a single source and is deliberately not enforced.
