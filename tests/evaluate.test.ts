/**
 * Tests for the evaluation harness.
 *
 * This module produces every headline number we publish. A coverage run after
 * the security audit showed it at 0% — untested code generating figures a
 * panel will read. That is precisely the failure this project argues against,
 * so the corpora below are small enough to verify the arithmetic by hand.
 */
import { describe, it, expect } from 'vitest';
import { evaluate, formatReport, BASELINES, type Checker } from '../src/harness/evaluate.js';
import { fmtRate } from '../src/harness/metrics.js';
import { cartTotalMinor, type Case, type Corpus, type CartLine, type Mandate } from '../src/corpus/types.js';
import type { DivergenceClass } from '../src/taxonomy/classes.js';

// ---------------------------------------------------------------------------
// Fixtures small enough to check by eye
// ---------------------------------------------------------------------------

const mandate: Mandate = {
  mandateId: 'm0',
  text: 'blue headphones',
  items: [
    {
      itemId: 'i0',
      text: 'blue headphones',
      statedAttributes: [],
      statedOptions: ['blue'],
      statedQuantity: null,
      sourceAsin: 'B000000000',
    },
  ],
  authorisedCategory: 'Electronics',
};

const line = (lineId: string): CartLine => ({
  lineId,
  answersItemId: null,
  sku: `sku-${lineId}`,
  name: `Product ${lineId}`,
  brand: null,
  priceMinor: 1000,
  quantity: 1,
  categoryPath: ['Electronics'],
  options: [],
  attributes: [],
});

function divergent(id: string, cls: DivergenceClass, tier: 'easy' | 'medium' | 'hard', lines = 2): Case {
  return {
    caseId: id,
    mandate,
    cart: { cartId: `c-${id}`, lines: Array.from({ length: lines }, (_, i) => line(`${id}-l${i}`)) },
    expected: [{ lineId: `${id}-l0`, class: cls, tier, detail: 'injected' }],
    tier,
    template: `${cls}/${tier}`,
    conforming: false,
    seed: 1,
  };
}

function conforming(id: string, cls: DivergenceClass, tier: 'easy' | 'medium' | 'hard', lines = 2): Case {
  return {
    caseId: `${id}/conforming`,
    mandate,
    cart: { cartId: `c-${id}-ok`, lines: Array.from({ length: lines }, (_, i) => line(`${id}-l${i}`)) },
    expected: [],
    tier: null,
    template: `${cls}/${tier}`,
    conforming: true,
    seed: 1,
  };
}

function corpusOf(cases: Case[]): Corpus {
  return { cases, generatedWith: { seed: 1, version: 1, hash: 'sha256:test' } };
}

/** Flags exactly the expected divergence. A perfect checker. */
const perfect: Checker = (c) => ({
  caseId: c.caseId,
  violations: c.expected.map((e) => ({ lineId: e.lineId, class: e.class })),
});

// ---------------------------------------------------------------------------

describe('evaluate: detection vs classification are different things', () => {
  const corpus = corpusOf([
    divergent('a', 'SCOPE_VIOLATION', 'easy'),
    conforming('a', 'SCOPE_VIOLATION', 'easy'),
  ]);

  it('a perfect checker scores 100% on both', () => {
    const r = evaluate(corpus, perfect, 'perfect');
    expect(r.detection.rate).toBe(1);
    expect(r.classification.rate).toBe(1);
    expect(r.falsePositive.rate).toBe(0);
  });

  it('right line, WRONG class counts as detected but NOT classified', () => {
    // The distinction that matters most and is easiest to get wrong: flagging
    // a cart is not the same as knowing what is wrong with it.
    const wrongClass: Checker = (c) => ({
      caseId: c.caseId,
      violations: c.expected.map((e) => ({ lineId: e.lineId, class: 'QUANTITY_DEVIATION' as const })),
    });
    const r = evaluate(corpus, wrongClass, 'wrong-class');
    expect(r.detection.rate).toBe(1);
    expect(r.classification.rate).toBe(0);
  });

  it('right class, WRONG line counts as detected but NOT classified', () => {
    const wrongLine: Checker = (c) => ({
      caseId: c.caseId,
      violations: c.expected.map((e) => ({ lineId: 'nonexistent', class: e.class })),
    });
    const r = evaluate(corpus, wrongLine, 'wrong-line');
    expect(r.detection.rate).toBe(1);
    expect(r.classification.rate).toBe(0);
  });

  it('counts a case as classified when the right pair is among several guesses', () => {
    const shotgun: Checker = (c) => ({
      caseId: c.caseId,
      violations: [
        { lineId: 'noise', class: 'QUANTITY_DEVIATION' },
        ...c.expected.map((e) => ({ lineId: e.lineId, class: e.class })),
      ],
    });
    expect(evaluate(corpus, shotgun, 's').classification.rate).toBe(1);
  });
});

describe('evaluate: false positives and silence', () => {
  const corpus = corpusOf([
    divergent('a', 'SCOPE_VIOLATION', 'easy'),
    divergent('b', 'SCOPE_VIOLATION', 'easy'),
    conforming('a', 'SCOPE_VIOLATION', 'easy'),
    conforming('b', 'SCOPE_VIOLATION', 'easy'),
  ]);

  it('counts a conforming cart with ANY violation as a false positive', () => {
    const flagsConforming: Checker = (c) => ({
      caseId: c.caseId,
      violations: c.conforming
        ? [{ lineId: c.cart.lines[0]!.lineId, class: 'SCOPE_VIOLATION' }]
        : [],
    });
    const r = evaluate(corpus, flagsConforming, 'fp');
    expect(r.falsePositive.rate).toBe(1);
    expect(r.falsePositive.total).toBe(2);
    expect(r.detection.rate).toBe(0);
  });

  it('counts silence only on divergent carts', () => {
    const r = evaluate(corpus, BASELINES['neverFlag']!, 'never');
    expect(r.silent.rate).toBe(1);
    expect(r.silent.total).toBe(2); // divergent only, not all four
  });

  it('precision is detected / (detected + false positives)', () => {
    // One divergent flagged, one conforming flagged => 1/2.
    const half: Checker = (c) => ({
      caseId: c.caseId,
      violations:
        c.caseId === 'a' || c.caseId === 'a/conforming'
          ? [{ lineId: c.cart.lines[0]!.lineId, class: 'SCOPE_VIOLATION' }]
          : [],
    });
    const r = evaluate(corpus, half, 'half');
    expect(r.detection.hits).toBe(1);
    expect(r.falsePositive.hits).toBe(1);
    expect(r.precision.rate).toBe(0.5);
    expect(r.precision.total).toBe(2);
  });

  it('reports prevalence so precision is never read alone', () => {
    expect(evaluate(corpus, perfect, 'p').prevalence).toBe(0.5);
  });
});

describe('evaluate: per-class and per-tier breakdown', () => {
  const corpus = corpusOf([
    divergent('a', 'SCOPE_VIOLATION', 'easy'),
    divergent('b', 'ITEM_SUBSTITUTION', 'easy'),
    divergent('c', 'ITEM_SUBSTITUTION', 'hard'),
    conforming('a', 'SCOPE_VIOLATION', 'easy'),
  ]);

  /** Catches scope only — models the real deterministic layer's blind spot. */
  const scopeOnly: Checker = (c) => ({
    caseId: c.caseId,
    violations: c.expected
      .filter((e) => e.class === 'SCOPE_VIOLATION')
      .map((e) => ({ lineId: e.lineId, class: e.class })),
  });

  it('splits recall by class', () => {
    const r = evaluate(corpus, scopeOnly, 'scope-only');
    expect(r.byClass.SCOPE_VIOLATION.rate).toBe(1);
    expect(r.byClass.SCOPE_VIOLATION.total).toBe(1);
    expect(r.byClass.ITEM_SUBSTITUTION.rate).toBe(0);
    expect(r.byClass.ITEM_SUBSTITUTION.total).toBe(2);
  });

  it('reports empty classes as n=0 rather than omitting them', () => {
    // A silently missing class reads as "not measured" instead of "not present".
    const r = evaluate(corpus, scopeOnly, 's');
    expect(r.byClass.CONSTRAINT_BREACH.total).toBe(0);
    expect(r.byClass.QUANTITY_DEVIATION.total).toBe(0);
  });

  it('splits recall by tier', () => {
    const r = evaluate(corpus, scopeOnly, 's');
    expect(r.byTier.easy.total).toBe(2);
    expect(r.byTier.easy.rate).toBe(0.5); // scope hit, substitution missed
    expect(r.byTier.hard.total).toBe(1);
    expect(r.byTier.hard.rate).toBe(0);
    expect(r.byTier.medium.total).toBe(0);
  });

  it('splits by class x tier cell', () => {
    const r = evaluate(corpus, scopeOnly, 's');
    expect(r.byClassTier['SCOPE_VIOLATION/easy']!.rate).toBe(1);
    expect(r.byClassTier['ITEM_SUBSTITUTION/hard']!.rate).toBe(0);
    expect(r.byClassTier['CONSTRAINT_BREACH/easy']).toBeUndefined();
  });

  it('macro-averages weight cells equally, ignoring cell size', () => {
    // easy has 2 cases at 50%, hard has 1 case at 0%. Macro is (0.5 + 0) / 2,
    // NOT weighted by count. That is the point: a large easy cell must not
    // drown a small hard one.
    const r = evaluate(corpus, scopeOnly, 's');
    expect(r.macroByTier).toBeCloseTo(0.25, 10);
    // Micro-average would be 1/3 = 0.333. They must differ.
    expect(r.macroByTier).not.toBeCloseTo(r.classification.rate, 5);
  });
});

describe('evaluate: trivial baselines are honest floors', () => {
  const corpus = corpusOf([
    divergent('a', 'CONSTRAINT_BREACH', 'easy', 3),
    divergent('b', 'CONSTRAINT_BREACH', 'easy', 1),
    conforming('a', 'CONSTRAINT_BREACH', 'easy', 3),
    conforming('b', 'CONSTRAINT_BREACH', 'easy', 1),
  ]);

  it('neverFlag scores zero on everything, including false positives', () => {
    const r = evaluate(corpus, BASELINES['neverFlag']!, 'never');
    expect(r.detection.rate).toBe(0);
    expect(r.classification.rate).toBe(0);
    expect(r.falsePositive.rate).toBe(0);
  });

  it('alwaysFlag scores PERFECT detection and 100% false positives', () => {
    // The reason this baseline exists: a detection number without its
    // false-positive rate beside it is meaningless.
    const r = evaluate(corpus, BASELINES['alwaysFlag']!, 'always');
    expect(r.detection.rate).toBe(1);
    expect(r.falsePositive.rate).toBe(1);
    expect(r.precision.rate).toBe(0.5); // exactly prevalence
    expect(r.precision.rate).toBeCloseTo(r.prevalence, 10);
  });

  it('biggestCart measures the cart-size leak rather than hiding it', () => {
    // An addition always adds a line, so size carries signal. This baseline
    // quantifies it. It fires only on carts with more than two lines.
    const r = evaluate(corpus, BASELINES['biggestCart']!, 'size');
    expect(r.detection.hits).toBe(1); // only the 3-line divergent case
    expect(r.falsePositive.hits).toBe(1); // and the 3-line conforming one
  });

  it('a checker cannot beat alwaysFlag on detection without beating it on FP', () => {
    const always = evaluate(corpus, BASELINES['alwaysFlag']!, 'a');
    const good = evaluate(corpus, perfect, 'p');
    expect(good.detection.rate).toBeLessThanOrEqual(always.detection.rate);
    expect(good.falsePositive.rate).toBeLessThan(always.falsePositive.rate);
  });
});

describe('evaluate: determinism and edge cases', () => {
  it('is deterministic', () => {
    const corpus = corpusOf([divergent('a', 'SCOPE_VIOLATION', 'easy'), conforming('a', 'SCOPE_VIOLATION', 'easy')]);
    expect(evaluate(corpus, perfect, 'x')).toEqual(evaluate(corpus, perfect, 'x'));
  });

  it('handles a corpus with no conforming cases without dividing by zero', () => {
    const r = evaluate(corpusOf([divergent('a', 'SCOPE_VIOLATION', 'easy')]), perfect, 'x');
    expect(r.falsePositive.total).toBe(0);
    expect(r.falsePositive.rate).toBe(0);
    expect(Number.isFinite(r.prevalence)).toBe(true);
  });

  it('handles a corpus with no divergent cases', () => {
    const r = evaluate(corpusOf([conforming('a', 'SCOPE_VIOLATION', 'easy')]), perfect, 'x');
    expect(r.detection.total).toBe(0);
    expect(r.macroByTier).toBe(0);
    expect(r.prevalence).toBe(0);
  });

  it('never produces NaN in any reported rate', () => {
    const r = evaluate(corpusOf([]), perfect, 'empty');
    const rates = [r.detection, r.classification, r.falsePositive, r.precision, r.silent];
    for (const x of rates) {
      expect(Number.isFinite(x.rate)).toBe(true);
      expect(Number.isFinite(x.lo)).toBe(true);
      expect(Number.isFinite(x.hi)).toBe(true);
    }
    expect(Number.isFinite(r.macroByTier)).toBe(true);
    expect(Number.isFinite(r.prevalence)).toBe(true);
  });
});

describe('formatReport', () => {
  const corpus = corpusOf([divergent('a', 'SCOPE_VIOLATION', 'easy'), conforming('a', 'SCOPE_VIOLATION', 'easy')]);

  it('always prints precision together with prevalence', () => {
    // Precision without prevalence is not interpretable. If this line ever
    // splits, the report starts misleading its reader.
    const out = formatReport(evaluate(corpus, perfect, 'p'), fmtRate).join('\n');
    const precisionLine = out.split('\n').find((l) => l.includes('precision'))!;
    expect(precisionLine).toMatch(/prevalence/);
  });

  it('prints every class and tier, including empty ones', () => {
    const out = formatReport(evaluate(corpus, perfect, 'p'), fmtRate).join('\n');
    for (const k of ['SCOPE_VIOLATION', 'CONSTRAINT_BREACH', 'ITEM_SUBSTITUTION', 'QUANTITY_DEVIATION', 'UNREQUESTED_ADDITION']) {
      expect(out).toContain(k);
    }
    for (const t of ['easy', 'medium', 'hard']) expect(out).toContain(t);
  });

  it('shows n/a for an empty cell rather than a misleading 0%', () => {
    const out = formatReport(evaluate(corpus, perfect, 'p'), fmtRate).join('\n');
    expect(out).toMatch(/n\/a/);
  });

  it('labels both macro averages', () => {
    const out = formatReport(evaluate(corpus, perfect, 'p'), fmtRate).join('\n');
    expect(out).toContain('MACRO across tiers');
    expect(out).toContain('MACRO across class x tier');
  });
});

describe('cartTotalMinor', () => {
  it('multiplies price by quantity across lines', () => {
    const lines: CartLine[] = [
      { ...line('a'), priceMinor: 1000, quantity: 2 },
      { ...line('b'), priceMinor: 250, quantity: 3 },
    ];
    expect(cartTotalMinor({ cartId: 'c', lines })).toBe(2750);
  });

  it('is 0 for an empty cart', () => {
    expect(cartTotalMinor({ cartId: 'c', lines: [] })).toBe(0);
  });

  it('stays an exact integer — money must not drift', () => {
    const lines = Array.from({ length: 100 }, () => ({ ...line('x'), priceMinor: 333, quantity: 7 }));
    const total = cartTotalMinor({ cartId: 'c', lines });
    expect(total).toBe(333 * 7 * 100);
    expect(Number.isInteger(total)).toBe(true);
  });
});
