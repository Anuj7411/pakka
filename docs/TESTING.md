# Testing report

A project whose entire claim is "we measure honestly" cannot ship a test suite it has not
measured. This is what was done and what it found.

## Summary (through Day 2)

| Measure | Result |
|---|---|
| Tests | **164** across 11 files |
| Line / branch / function coverage (Day 1 modules) | **100 / 100 / 100** |
| Mutation score — `rng.ts` | **95.12%**, 1 survivor (verified killed by hand) |
| Mutation score — `canonical.ts` | **93.48%**, **0 behavioural survivors** |
| Mutation score — `env.ts` | 94.44%, 0 behavioural survivors |
| Mutation score — `webshop.ts` | 95.94% |
| Mutation score — `taxonomy/classes.ts` | 87.01%, 0 behavioural survivors |
| Real defects found by testing | **6** |

## Layers
1. **Unit** — the cases we thought of.
2. **Property / fuzz** — 5,500+ generated inputs from a seeded PRNG (never `Math.random`, so a
   failure is reproducible), plus a hostile-string corpus: unicode, full-width digits,
   `__proto__`, 10,000-character strings, emoji, control characters, currency symbols.
3. **Golden vectors** — exact pinned outputs. See below; this layer exists because of what
   mutation testing found.
4. **Full-corpus sweep** — every invariant over all 12,251 instructions and all 1,000 products.
   Real data breaks on record 9,412, not record 3.
5. **Coverage** — to find untested lines.
6. **Mutation** — to find untested *behaviour*, which coverage cannot see.

## Defects found

**1. Money precision.** `parsePriceMinor("$999999999999999999999.99")` returned `1e+23`, past
`MAX_SAFE_INTEGER`, where integer arithmetic silently loses precision. A price comparison could
have returned the wrong answer with no error. Now refused — an unparseable price is visible, a
wrong price is not.

**2. Invalid JSON from sparse arrays.** `Array.prototype.map` SKIPS holes, so `[1,,3]`
canonicalised to `"[1,,3]"` — not valid JSON. Any consumer parsing our audit artifact would have
thrown. Fixed with an indexed loop plus a structural test that every shape we emit round-trips
through `JSON.parse`.

**3-5. Three corpus labelling bugs** — quantity deviations from unstated quantities (62% of
cases), filler lines that were themselves unlabelled `UNREQUESTED_ADDITION`s inside "conforming"
cases, and duplicate products in one cart. Found by validating the corpus against our own
taxonomy *before* building a checker against it. See the commit for details.

**6. Two pieces of dead code**, both surfaced by mutants that no test could kill:
- `Object.is(n, -0) ? '0' : String(n)` — `String(-0)` is already `"0"`. The guard did nothing.
- A hand-written key comparator with an equal-branch that `Object.keys` can never reach.
  Replaced by the default sort, which is *already* UTF-16 code-unit order and, unlike
  `localeCompare`, does not vary by ICU build.

## ★ What mutation testing taught us that coverage could not

**`rng.ts` had 100% coverage and a 22.92% mutation score.**

The tests asked *"is this a valid PRNG?"* — same seed reproduces, bounds respected, shuffle
preserves the multiset. Every one of those remains true after the arithmetic is changed. So
almost any mutation produced a different-but-still-valid generator that the suite accepted.

That is not cosmetic. Our entire reproducibility claim is *"regenerate the corpus byte-for-byte
from a seed"*. If the RNG drifts, every published corpus hash changes and results stop being
comparable — **silently, with a green suite.**

The fix was **golden vectors**: pin the exact output sequence, the exact shuffle permutation, the
exact derived fork seeds, the exact canonical string and digest. `rng.ts` went 22.92% → **95.12%**.

Golden vectors paid for themselves immediately: when the dead code above was removed, the pinned
hash was unchanged, which *proved* the refactor altered no output.

One subtlety they also caught: a shuffle loop bound of `i >= 0` instead of `i > 0` produces the
**same array** (the last swap is an element with itself) but consumes one extra draw, shifting
every later value. Only asserting the post-shuffle stream state catches it.

## Protocol: every surviving mutant is investigated, never excused

"Probably equivalent" is not a finding; running it is. Three outcomes so far:

**Genuinely equivalent — unkillable by definition.** `parseOption`'s `idx <= 0` → `idx < 0`:
verified by running both variants across the input space, identical output everywhere, because
the next line already catches `idx === 0`.

**Stryker false positives.** `webshop.ts:111` and `:135` were applied to the source by hand and
each caused **6 test failures**. They are killed by this suite. A third, `rng.ts:34`
(`min > max` → `min >= max`), makes the test file fail at *collection* — `generateCorpus` runs in
the describe body — and `perTest` cannot attribute a collection-time crash to any test, so it
reports "Survived" when the file did not run at all.

**Real gaps, found by disbelieving a passing test.** Removing `pick()`'s empty-array guard still
threw `RangeError` — from `int(0, -1)` instead — so a test asserting only the error *type* passed
for the wrong reason. Asserting the message pins the guard. Likewise `hashOfString`'s test only
checked it *differed* from `hashOf`, which an empty function body satisfies, since
`undefined !== string`.

## Cost control
Generator tests run against a small committed fixture (246 ASINs, 234 products, 12 categories,
unused fields stripped: 9.6MB → 288KB), rebuilt deterministically by
`scripts/build-fixture.ts`. A mutation run restarts the suite per mutant; on the full corpus it
projected past **three hours**. Fixtures should be small. Whole-dataset invariants stay in
`corpus-sweep.test.ts`, where they belong.

## Reproducing
```bash
npm run check                      # typecheck + 164 tests
npm run data:verify                # corpus SHA-256 integrity
npm run coverage
npx stryker run stryker-fast.json  # rng + canonical, ~2 min
npx stryker run                    # everything, slow
```

## Standing rules
- **Seeded PRNG only.** A fuzz failure that cannot be reproduced is a rumour.
- **Sweeps cover the whole corpus** and report rates rather than asserting perfection, so a drop
  is visible instead of silent.
- **When a property test and the code disagree, fix the code** — unless the test's expectation is
  provably wrong. Both have happened once each.
- **Investigate every surviving mutant**, and record which of the three outcomes it was.
- **Pin exact outputs for anything a published number depends on.**
