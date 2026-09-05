# Contributing to Pakka

Thanks for looking. This is a research build for the Razorpay AI Buildathon 2026,
but it is written to be read and extended.

## Ground rules

1. **Every number has a caveat, and the caveat lives next to the number.** If you
   add a measurement, add how it was measured and where it is weak. See the
   "What it does not do" section of the [README](README.md) for the standard.
2. **The model may never lower a decision.** The lattice is `allow < escalate <
   block` and the join is `max`. A new checker may raise the decision; nothing a
   checker returns may lower it. This is enforced by types, not by convention.
3. **The verifier imports nothing from the sizer.** The OC-228 ceiling is stated
   twice on purpose (`src/verifier/oc228.ts` and `src/sizer/reserve.ts`) so the
   two can disagree and be caught. Do not "DRY" that duplication away.
4. **No em dashes** in source or docs.

## Setup

```bash
npm install
cp .env.example .env      # add a rzp_test_ key pair; GEMINI_API_KEY is optional
```

## The gate you must pass before opening a PR

```bash
npm run check             # typecheck + 556 tests + the OC-228 proof
```

This is the same command CI runs. If it is green locally, the badge stays green.

## Useful commands

| Command | What it does |
|---|---|
| `npx tsx demo/api.ts` | the live console at http://localhost:5173 |
| `npm run eval` | deterministic results on the full corpus |
| `npm run oc228` | the reserve-constraint proof |
| `npm run coverage` | statement coverage |
| `npm run mutation` | mutation testing (used as a finding tool) |

## Filing an issue

Include the run: the mandate, the cart, and the decision. A one-line repro from
the sandbox tab of the playground is ideal.
