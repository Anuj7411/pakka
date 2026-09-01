/**
 * Reserve sizing and the OC-228 constraint verifier.
 *
 * The headline claim of this half of the project is a constraint-violation rate
 * of exactly 0, machine-checked. These tests exist to stop that number being
 * true for the wrong reason — a verifier that never rejects, or a simulation
 * that only ever builds legal inputs, would both score a perfect 0.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { sizeReserve, SIZER_POLICY_VERSION } from '../src/sizer/reserve.js';
import {
  verifyBlock,
  verifyLifecycle,
  isCompliant,
  unusedRemainder,
  OC228_MAX_BLOCK_PAISE,
  OC228_MAX_VALIDITY_DAYS,
  OC228_VIOLATION_CODES,
  type Block,
} from '../src/verifier/oc228.js';
import { simulateLegal, measureSensitivity, INJECTIONS } from '../src/verifier/simulate.js';
import { Rng } from '../src/corpus/rng.js';
import type { Cart, CartLine, Mandate } from '../src/corpus/types.js';

const mandate: Mandate = {
  mandateId: 'm',
  text: 'x',
  items: [
    {
      itemId: 'i0',
      text: 'x',
      statedAttributes: [],
      statedOptions: [],
      statedQuantity: null,
      sourceAsin: 'B0',
    },
  ],
  authorisedCategory: 'Electronics',
};

const line = (priceMinor: number, quantity = 1): CartLine => ({
  lineId: 'l0',
  answersItemId: null,
  sku: 's',
  name: 'thing',
  brand: null,
  priceMinor,
  quantity,
  categoryPath: ['Electronics'],
  options: [],
  attributes: [],
});

const cartOf = (...lines: CartLine[]): Cart => ({ cartId: 'c', lines });

const block = (over: Partial<Block> = {}): Block => ({
  blockId: 'b0',
  merchantId: 'm0',
  customerId: 'c0',
  amountPaise: 100_000,
  validityDays: 30,
  createdOnDay: 100,
  ...over,
});

// ---------------------------------------------------------------------------

describe('separation of duty: the verifier is independent by construction', () => {
  it('imports nothing at all', () => {
    // Clark-Wilson E3. If the verifier imported the sizer's ceiling, a wrong
    // ceiling would be wrong in both places and the check would prove nothing.
    // Two independent statements of ₹10,000 can disagree; one shared statement
    // cannot, and disagreement is the whole mechanism.
    const source = readFileSync('src/verifier/oc228.ts', 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
  });

  it('states the regulatory constants independently, and they agree', () => {
    // Read from the sizer's source rather than imported, so this test compares
    // two separately-written numbers instead of one number with itself.
    const sizerSource = readFileSync('src/sizer/reserve.ts', 'utf8');
    expect(sizerSource).toContain('const MAX_BLOCK_PAISE = 10_000_00');
    expect(sizerSource).toContain('const MAX_VALIDITY_DAYS = 90');
    expect(OC228_MAX_BLOCK_PAISE).toBe(1_000_000);
    expect(OC228_MAX_VALIDITY_DAYS).toBe(90);
  });

  it('exposes no way to propose or repair an amount', () => {
    // A verifier that could correct its input would be a second sizer wearing
    // a badge. Every export either inspects or reports.
    const source = readFileSync('src/verifier/oc228.ts', 'utf8');
    const exported = [...source.matchAll(/export (?:function|const) (\w+)/g)].map((m) => m[1]);
    expect(exported).toEqual(
      expect.arrayContaining(['verifyBlock', 'verifyLifecycle', 'isCompliant', 'unusedRemainder']),
    );
    for (const name of exported) {
      expect(name, `${name} sounds like it proposes rather than checks`).not.toMatch(
        /^(size|propose|adjust|clamp|fix|repair|correct)/i,
      );
    }
  });
});

describe('sizer: what it proposes and why', () => {
  it('adds headroom below the ceiling', () => {
    const p = sizeReserve(cartOf(line(100_000)), mandate, { headroomBps: 500 });
    expect(p.rationale).toBe('CART_PLUS_HEADROOM');
    expect(p.amountPaise).toBe(105_000);
    expect(p.fundable).toBe(true);
    expect(p.policyVersion).toBe(SIZER_POLICY_VERSION);
  });

  it('rounds headroom up, so it is never quietly smaller than stated', () => {
    // 1 paisa at 500bps is 0.05 paise. Rounding down would give zero headroom
    // while the certificate still claimed 5%.
    const p = sizeReserve(cartOf(line(1)), mandate, { headroomBps: 500 });
    expect(p.amountPaise).toBe(2);
    expect(Number.isInteger(p.amountPaise)).toBe(true);
  });

  it('trims headroom to the ceiling rather than exceeding it', () => {
    const p = sizeReserve(cartOf(line(990_000)), mandate, { headroomBps: 500 });
    expect(p.rationale).toBe('HEADROOM_TRIMMED_TO_CAP');
    expect(p.amountPaise).toBe(OC228_MAX_BLOCK_PAISE);
    expect(p.fundable).toBe(true);
  });

  it('handles a cart exactly at the ceiling', () => {
    const p = sizeReserve(cartOf(line(1_000_000)), mandate);
    expect(p.rationale).toBe('CAPPED_AT_REGULATORY_MAX');
    expect(p.amountPaise).toBe(OC228_MAX_BLOCK_PAISE);
  });

  it('refuses a cart a single block cannot cover, rather than under-blocking', () => {
    // Blocking the maximum would look like a funded purchase and then fail at
    // debit time, which is the worst of both.
    const p = sizeReserve(cartOf(line(1_000_001)), mandate);
    expect(p.rationale).toBe('CART_EXCEEDS_MAX_BLOCK');
    expect(p.fundable).toBe(false);
    expect(p.amountPaise).toBe(0);
  });

  it('handles an empty cart', () => {
    const p = sizeReserve(cartOf(), mandate);
    expect(p.rationale).toBe('EMPTY_CART');
    expect(p.amountPaise).toBe(0);
  });

  it('multiplies by quantity', () => {
    expect(sizeReserve(cartOf(line(1000, 3)), mandate, { headroomBps: 0 }).amountPaise).toBe(3000);
  });

  it('trims validity to the regulatory ceiling', () => {
    expect(sizeReserve(cartOf(line(1000)), mandate, { requestedValidityDays: 365 }).validityDays).toBe(
      OC228_MAX_VALIDITY_DAYS,
    );
    expect(sizeReserve(cartOf(line(1000)), mandate, { requestedValidityDays: 7 }).validityDays).toBe(7);
    expect(sizeReserve(cartOf(line(1000)), mandate, { requestedValidityDays: 0 }).validityDays).toBe(1);
  });

  it('is pure: the same input always gives the same proposal', () => {
    const cart = cartOf(line(123_456, 2));
    expect(sizeReserve(cart, mandate)).toEqual(sizeReserve(cart, mandate));
  });

  it('records the arithmetic, so a proposal can be re-derived', () => {
    const p = sizeReserve(cartOf(line(50_000, 2)), mandate, { headroomBps: 250 });
    expect(p.cartTotalPaise).toBe(100_000);
    expect(p.headroomBps).toBe(250);
    expect(p.amountPaise).toBe(102_500);
  });

  it('never proposes above the ceiling, over a wide random sweep', () => {
    const rng = new Rng(4242);
    for (let i = 0; i < 3000; i++) {
      const p = sizeReserve(
        cartOf(line(rng.int(1, 2_000_000), rng.int(1, 4))),
        mandate,
        { headroomBps: rng.int(0, 5000), requestedValidityDays: rng.int(1, 400) },
      );
      expect(p.amountPaise).toBeLessThanOrEqual(OC228_MAX_BLOCK_PAISE);
      expect(p.validityDays).toBeLessThanOrEqual(OC228_MAX_VALIDITY_DAYS);
      expect(Number.isInteger(p.amountPaise)).toBe(true);
      if (!p.fundable) expect(p.amountPaise).toBe(0);
    }
  });
});

describe('verifier: each rule', () => {
  it('passes a lawful block with no debits', () => {
    expect(verifyBlock(block())).toEqual([]);
    expect(isCompliant(verifyBlock(block()))).toBe(true);
  });

  it('rejects a block over the ceiling', () => {
    const v = verifyBlock(block({ amountPaise: OC228_MAX_BLOCK_PAISE + 1 }));
    expect(v.map((x) => x.code)).toContain('AMOUNT_EXCEEDS_MAX');
  });

  it('accepts a block exactly at the ceiling', () => {
    expect(verifyBlock(block({ amountPaise: OC228_MAX_BLOCK_PAISE }))).toEqual([]);
  });

  it('rejects a non-positive or fractional amount', () => {
    expect(verifyBlock(block({ amountPaise: 0 })).map((x) => x.code)).toContain(
      'AMOUNT_NOT_POSITIVE',
    );
    expect(verifyBlock(block({ amountPaise: -5 })).map((x) => x.code)).toContain(
      'AMOUNT_NOT_POSITIVE',
    );
    expect(verifyBlock(block({ amountPaise: 10.5 })).map((x) => x.code)).toContain(
      'AMOUNT_NOT_INTEGER',
    );
  });

  it('rejects validity over 90 days and accepts exactly 90', () => {
    expect(verifyBlock(block({ validityDays: 91 })).map((x) => x.code)).toContain(
      'VALIDITY_EXCEEDS_MAX',
    );
    expect(verifyBlock(block({ validityDays: 90 }))).toEqual([]);
    expect(verifyBlock(block({ validityDays: 0 })).map((x) => x.code)).toContain(
      'VALIDITY_NOT_POSITIVE',
    );
  });

  it('allows one block per merchant per customer and rejects a second', () => {
    const first = block({ blockId: 'b1' });
    expect(verifyBlock(block({ blockId: 'b2' }), [first]).map((x) => x.code)).toContain(
      'CONCURRENT_BLOCK_FOR_PAIR',
    );
  });

  it('allows the same merchant to hold blocks for different customers', () => {
    const other = block({ blockId: 'b1', customerId: 'someone-else' });
    expect(verifyBlock(block({ blockId: 'b2' }), [other])).toEqual([]);
  });

  it('allows the same customer to hold blocks with different merchants', () => {
    const other = block({ blockId: 'b1', merchantId: 'other-merchant' });
    expect(verifyBlock(block({ blockId: 'b2' }), [other])).toEqual([]);
  });

  it('does not treat a block as clashing with itself', () => {
    const b = block();
    expect(verifyBlock(b, [b])).toEqual([]);
  });
});

describe('verifier: debits against a block', () => {
  const b = block({ amountPaise: 1000, validityDays: 10, createdOnDay: 100 });

  it('permits multiple partial debits until the amount is used', () => {
    const v = verifyLifecycle({
      block: b,
      debits: [
        { blockId: 'b0', amountPaise: 400, onDay: 100 },
        { blockId: 'b0', amountPaise: 400, onDay: 103 },
        { blockId: 'b0', amountPaise: 200, onDay: 109 },
      ],
    });
    expect(v).toEqual([]);
  });

  it('rejects the debit that takes the total past the block', () => {
    const v = verifyLifecycle({
      block: b,
      debits: [
        { blockId: 'b0', amountPaise: 900, onDay: 100 },
        { blockId: 'b0', amountPaise: 200, onDay: 101 },
      ],
    });
    expect(v.map((x) => x.code)).toContain('DEBIT_EXCEEDS_BLOCK');
  });

  it('accepts a debit on the last live day and rejects one on the expiry day', () => {
    // The block is live for validityDays days from creation, so day 109 is the
    // last one inside it and day 110 is already outside.
    expect(
      verifyLifecycle({ block: b, debits: [{ blockId: 'b0', amountPaise: 1, onDay: 109 }] }),
    ).toEqual([]);
    expect(
      verifyLifecycle({
        block: b,
        debits: [{ blockId: 'b0', amountPaise: 1, onDay: 110 }],
      }).map((x) => x.code),
    ).toContain('DEBIT_AFTER_EXPIRY');
  });

  it('rejects a debit after revocation', () => {
    const v = verifyLifecycle({
      block: b,
      revokedOnDay: 105,
      debits: [{ blockId: 'b0', amountPaise: 1, onDay: 106 }],
    });
    expect(v.map((x) => x.code)).toContain('DEBIT_AFTER_REVOKE');
  });

  it('accepts a debit before revocation', () => {
    expect(
      verifyLifecycle({
        block: b,
        revokedOnDay: 105,
        debits: [{ blockId: 'b0', amountPaise: 1, onDay: 104 }],
      }),
    ).toEqual([]);
  });

  it('rejects a debit predating the block', () => {
    expect(
      verifyLifecycle({ block: b, debits: [{ blockId: 'b0', amountPaise: 1, onDay: 99 }] }).map(
        (x) => x.code,
      ),
    ).toContain('DEBIT_BEFORE_BLOCK');
  });

  it('rejects a debit for a different block', () => {
    expect(
      verifyLifecycle({ block: b, debits: [{ blockId: 'elsewhere', amountPaise: 1, onDay: 100 }] })
        .map((x) => x.code),
    ).toContain('DEBIT_ON_UNKNOWN_BLOCK');
  });

  it('reports the remainder that auto-releases', () => {
    expect(
      unusedRemainder({ block: b, debits: [{ blockId: 'b0', amountPaise: 300, onDay: 100 }] }),
    ).toBe(700);
    expect(unusedRemainder({ block: b, debits: [] })).toBe(1000);
    // Never negative, even when the debits are themselves a violation.
    expect(
      unusedRemainder({ block: b, debits: [{ blockId: 'b0', amountPaise: 5000, onDay: 100 }] }),
    ).toBe(0);
  });
});

describe('★ headline metric: constraint-violation rate is 0, and means something', () => {
  it('finds no violation across simulated legal sequences', () => {
    const r = simulateLegal(20260901, 5000);
    expect(r.sequences).toBeGreaterThan(1000); // the denominator is real
    expect(r.violations).toEqual([]);
    expect(r.violationRate).toBe(0);
  });

  it('holds under a different seed', () => {
    const r = simulateLegal(777, 5000);
    expect(r.violationRate).toBe(0);
  });

  it('catches every injected violation, so a rate of 0 is not vacuous', () => {
    // Without this, `return []` in the verifier would score a perfect rate.
    const results = measureSensitivity(31337, 200);
    for (const r of results) {
      expect(r.rate, `${r.code}: ${r.describe}`).toBe(1);
    }
  });

  it('injects a breach for every rule the verifier claims to enforce', () => {
    // A rule with no injection is a rule whose enforcement is untested, and the
    // headline number would silently exclude it.
    //
    // Compared against a runtime value, not a regex over the verifier's source.
    // The source-reading version broke under mutation testing, which rewrites
    // the file — a test that reads source fails for reasons unrelated to what
    // it checks.
    const injected = new Set(INJECTIONS.map((i) => i.code));
    expect(OC228_VIOLATION_CODES.length).toBeGreaterThan(0);
    for (const code of OC228_VIOLATION_CODES) {
      expect(injected.has(code), `no injection exercises ${code}`).toBe(true);
    }
  });

  it('injects nothing the verifier does not declare', () => {
    const declared = new Set<string>(OC228_VIOLATION_CODES);
    for (const i of INJECTIONS) {
      expect(declared.has(i.code), `${i.code} is injected but not declared`).toBe(true);
    }
  });
});
