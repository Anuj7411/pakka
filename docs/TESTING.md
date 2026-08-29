# Testing report — Day 1

A project whose entire claim is "we measure honestly" cannot ship a test suite it has not
measured. This is what was done and what it found.

## Summary

| Measure | Result |
|---|---|
| Tests | **87** across 7 files |
| Line / branch / function coverage | **100 / 100 / 100** |
| Mutation score (Stryker, `coverageAnalysis: off`) | **94.14%** (305/324) |
| Behavioural mutants surviving | **3 reported — all three investigated by hand; 0 are real gaps** |
| Real defects found by testing | **1** (money precision, see below) |

## Layers

1. **Unit** — the cases we thought of.
2. **Property / fuzz** — 5,500+ generated inputs against a seeded PRNG (never `Math.random`,
   so a failure is reproducible), plus a hostile-string corpus: unicode, full-width digits,
   `__proto__`, 10,000-character strings, emoji, script tags, currency symbols.
3. **Full-corpus sweep** — every invariant over **all 12,251 instructions and all 1,000
   products**, not a sample of 50. Real data breaks on record 9,412, not record 3.
4. **Coverage** — to find untested lines.
5. **Mutation** — to find untested *behaviour*, which coverage cannot see.

## The defect property testing found

`parsePriceMinor("$999999999999999999999.99")` returned `1e+23` — past `MAX_SAFE_INTEGER`.
Beyond that boundary integer arithmetic silently loses precision, so a price comparison could
return the wrong answer **with no error raised**. In a money path that is the worst failure
shape: wrong and quiet.

Fixed by refusing rather than returning an unsafe integer. An unparseable price is visible; a
wrong price is not.

The regression test also records a fact we cannot fix: `$90071992547409.90` and
`$90071992547409.91` both round to the same integer. That is IEEE-754, not a bug — noted so
nobody later assumes minor-unit arithmetic is exact at any magnitude.

## Why mutation testing, and what it showed

**100% coverage, and 29 behavioural mutations still survived.** Coverage proves a line *ran*.
It does not prove a bug in that line would be *caught*.

The most alarming survivor: in `byTopCategory`, mutating `m.set(p.topCategory, [p])` to
`m.set(p.topCategory, [])` survived — the code would have **silently dropped the first product
of every category** and the entire suite would still have passed green.

| Round | Mutation score | Behavioural survivors |
|---|---|---|
| Initial | 76.54% | 29 |
| After targeted kill tests | 93.52% | 5 |
| After second round | **94.14%** | **3** |

## The three remaining survivors — investigated, not excused

**1. `webshop.ts:250` — `idx <= 0` → `idx < 0`. Proven EQUIVALENT MUTANT.**
Verified by running both variants over the input space: identical output on every case. The two
differ only at `idx === 0` (`":blue"`), and the very next line — `if (dimension === '' || value
=== '')` — already returns null there. Equivalent mutants are unkillable by definition; the
guard is redundant but harmless, and removing it *is* killable (tested).

**2 and 3. `webshop.ts:111` and `webshop.ts:135` — Stryker false positives.**
Both were applied to the source **by hand**, and both cause **6 test failures**. They are killed
by this suite. Stryker's vitest runner reports them as survivors under both
`coverageAnalysis: perTest` and `off`.

⇒ The true behavioural mutation score is higher than 94.14%. **Every killable behavioural
mutant in our logic is dead.**

The remaining reported survivors beyond these three are `StringLiteral` mutations inside the
taxonomy's documentation prose (`holds`, `example`, `isNot`). Those are tested for substance —
length and enum-membership — but a prose edit that preserves length is not behaviourally
detectable, and pretending otherwise would be theatre.

## Reproducing

```bash
npm run check          # typecheck + 87 tests
npm run data:verify    # corpus SHA-256 integrity
npx vitest run --coverage --coverage.provider=v8 --coverage.include='src/**'
npx stryker run        # ~2 minutes
```

## Standing rules
- **Property tests use a seeded PRNG.** A fuzz failure that cannot be reproduced is a rumour.
- **Sweeps run over the whole corpus**, and report rates rather than asserting perfection —
  e.g. option parse rate is asserted `> 0.95` and printed, so a drop is visible rather than
  silent.
- **When a property test and the code disagree, fix the code** unless the test's expectation is
  provably wrong. On Day 1 that happened once in each direction: the code was wrong about
  `MAX_SAFE_INTEGER`; the test was wrong about where the boundary lay.
- **Investigate every surviving mutant.** "Probably equivalent" is not a finding; running it is.
