/**
 * The headline safety metric: constraint-violation rate.
 *
 * Simulates blocks and debit sequences, sizes each with the sizer, and checks
 * every one with the independent verifier. The number we report is the share of
 * simulated sequences in which the verifier found an OC-228 violation. It must
 * be exactly 0, and one violation fails the build.
 *
 * ── Why the second half of this file exists ─────────────────────────────────
 * A violation rate of 0 is worthless on its own. A verifier with `return []` in
 * it scores 0 on every corpus ever generated, and so does a simulation that
 * only ever builds legal inputs. The number means something only if the same
 * verifier demonstrably CATCHES violations when they are present.
 *
 * So there are two measurements, and both are reported:
 *
 *   soundness  — over legal sequences, the verifier finds nothing.  Must be 0.
 *   sensitivity — over sequences with a violation deliberately injected, the
 *                 verifier finds it.  Must be 100%, per violation class.
 *
 * Quoting the first without the second would be the same mistake as publishing
 * a false-positive rate computed on labels we had not verified.
 */
import { Rng } from '../corpus/rng.js';
import { sizeReserve } from '../sizer/reserve.js';
import {
  verifyLifecycle,
  type Block,
  type BlockLifecycle,
  type Debit,
  type Violation,
  type ViolationCode,
  OC228_MAX_BLOCK_PAISE,
  OC228_MAX_VALIDITY_DAYS,
} from './oc228.js';
import type { Cart, CartLine, Mandate } from '../corpus/types.js';

const MANDATE: Mandate = {
  mandateId: 'sim',
  text: 'simulated delegated purchase',
  items: [
    {
      itemId: 'i0',
      text: 'simulated item',
      statedAttributes: [],
      statedOptions: [],
      statedQuantity: null,
      sourceAsin: 'B0SIM',
    },
  ],
  authorisedCategory: 'Electronics',
};

function line(rng: Rng, i: number): CartLine {
  return {
    lineId: `l${i}`,
    answersItemId: null,
    sku: `sku-${i}`,
    name: `simulated item ${i}`,
    brand: null,
    // Spans the interesting range: well under the cap, near it, and over it.
    priceMinor: rng.int(1, 700_000),
    quantity: rng.int(1, 3),
    categoryPath: ['Electronics'],
    options: [],
    attributes: [],
  };
}

function randomCart(rng: Rng, n: number): Cart {
  return { cartId: `c${n}`, lines: Array.from({ length: rng.int(1, 3) }, (_, i) => line(rng, i)) };
}

/**
 * Draw down a block the way a merchant legitimately would: partial debits, in
 * order, never exceeding what remains, never after expiry.
 */
function legalDebits(rng: Rng, block: Block): Debit[] {
  const out: Debit[] = [];
  let remaining = block.amountPaise;
  let day = block.createdOnDay;
  const lastLegalDay = block.createdOnDay + block.validityDays - 1;

  const draws = rng.int(0, 4);
  for (let i = 0; i < draws && remaining > 0; i++) {
    const amount = rng.int(1, remaining);
    day = Math.min(day + rng.int(0, 5), lastLegalDay);
    out.push({ blockId: block.blockId, amountPaise: amount, onDay: day });
    remaining -= amount;
  }
  return out;
}

export interface SimulationResult {
  readonly sequences: number;
  /** Sequences where the verifier found any violation. Must be 0. */
  readonly violating: number;
  readonly violationRate: number;
  /** Every violation found, so a failure can be read rather than guessed at. */
  readonly violations: readonly { readonly sequence: number; readonly found: Violation[] }[];
  /** Sequences skipped because the cart could not be funded by one block. */
  readonly unfundable: number;
}

/**
 * SOUNDNESS: over legal, sizer-produced sequences, the verifier finds nothing.
 */
export function simulateLegal(seed: number, sequences: number): SimulationResult {
  const rng = new Rng(seed);
  const violations: { sequence: number; found: Violation[] }[] = [];
  let unfundable = 0;

  for (let n = 0; n < sequences; n++) {
    const cart = randomCart(rng, n);
    const proposal = sizeReserve(cart, MANDATE, {
      headroomBps: rng.int(0, 1000),
      requestedValidityDays: rng.int(1, 120), // deliberately exceeds 90 sometimes
    });

    if (!proposal.fundable || proposal.amountPaise === 0) {
      // The sizer refused. There is no block, so there is nothing to verify —
      // counted, not silently dropped, so the denominator stays honest.
      unfundable++;
      continue;
    }

    const block: Block = {
      blockId: `b${n}`,
      merchantId: `m${rng.int(0, 5)}`,
      customerId: `c${rng.int(0, 50)}`,
      amountPaise: proposal.amountPaise,
      validityDays: proposal.validityDays,
      createdOnDay: rng.int(0, 500),
    };
    const lifecycle: BlockLifecycle = { block, debits: legalDebits(rng, block) };
    const found = verifyLifecycle(lifecycle);
    if (found.length > 0) violations.push({ sequence: n, found });
  }

  const checked = sequences - unfundable;
  return {
    sequences: checked,
    violating: violations.length,
    violationRate: checked === 0 ? 0 : violations.length / checked,
    violations,
    unfundable,
  };
}

// ---------------------------------------------------------------------------
// Sensitivity
// ---------------------------------------------------------------------------

export interface Injection {
  readonly code: ViolationCode;
  readonly describe: string;
  readonly apply: (l: BlockLifecycle, rng: Rng) => { lifecycle: BlockLifecycle; existing?: Block[] };
}

/**
 * One deliberate breach per OC-228 rule.
 *
 * Every constraint the verifier claims to enforce gets an injection here. If a
 * rule has no injection, the verifier's enforcement of it is untested and the
 * violation rate says nothing about that rule.
 */
export const INJECTIONS: readonly Injection[] = [
  {
    code: 'AMOUNT_EXCEEDS_MAX',
    describe: 'block for more than ₹10,000',
    apply: (l, rng) => ({
      lifecycle: {
        ...l,
        block: { ...l.block, amountPaise: OC228_MAX_BLOCK_PAISE + rng.int(1, 100_000) },
        debits: [],
      },
    }),
  },
  {
    code: 'VALIDITY_EXCEEDS_MAX',
    describe: 'block valid for more than 90 days',
    apply: (l, rng) => ({
      lifecycle: {
        ...l,
        block: { ...l.block, validityDays: OC228_MAX_VALIDITY_DAYS + rng.int(1, 100) },
        debits: [],
      },
    }),
  },
  {
    code: 'CONCURRENT_BLOCK_FOR_PAIR',
    describe: 'second live block for the same merchant and customer',
    apply: (l) => ({
      lifecycle: l,
      existing: [{ ...l.block, blockId: `${l.block.blockId}-other` }],
    }),
  },
  {
    code: 'DEBIT_EXCEEDS_BLOCK',
    describe: 'debits drawing more than was blocked',
    apply: (l, rng) => ({
      lifecycle: {
        ...l,
        debits: [
          {
            blockId: l.block.blockId,
            amountPaise: l.block.amountPaise + rng.int(1, 5000),
            onDay: l.block.createdOnDay,
          },
        ],
      },
    }),
  },
  {
    code: 'DEBIT_AFTER_EXPIRY',
    describe: 'debit taken after the block expired',
    apply: (l, rng) => ({
      lifecycle: {
        ...l,
        debits: [
          {
            blockId: l.block.blockId,
            amountPaise: 1,
            onDay: l.block.createdOnDay + l.block.validityDays + rng.int(0, 30),
          },
        ],
      },
    }),
  },
  {
    code: 'DEBIT_AFTER_REVOKE',
    describe: 'debit taken after the block was revoked',
    apply: (l) => ({
      lifecycle: {
        ...l,
        revokedOnDay: l.block.createdOnDay + 1,
        debits: [
          { blockId: l.block.blockId, amountPaise: 1, onDay: l.block.createdOnDay + 2 },
        ],
      },
    }),
  },
  {
    code: 'DEBIT_BEFORE_BLOCK',
    describe: 'debit dated before the block existed',
    apply: (l, rng) => ({
      lifecycle: {
        ...l,
        debits: [
          {
            blockId: l.block.blockId,
            amountPaise: 1,
            onDay: l.block.createdOnDay - rng.int(1, 10),
          },
        ],
      },
    }),
  },
  {
    code: 'DEBIT_NOT_POSITIVE',
    describe: 'debit of zero or a negative amount',
    apply: (l) => ({
      lifecycle: {
        ...l,
        debits: [{ blockId: l.block.blockId, amountPaise: 0, onDay: l.block.createdOnDay }],
      },
    }),
  },
  {
    code: 'DEBIT_ON_UNKNOWN_BLOCK',
    describe: 'debit against a different block id',
    apply: (l) => ({
      lifecycle: {
        ...l,
        debits: [{ blockId: 'not-this-block', amountPaise: 1, onDay: l.block.createdOnDay }],
      },
    }),
  },
  {
    code: 'AMOUNT_NOT_POSITIVE',
    describe: 'block of zero',
    apply: (l) => ({ lifecycle: { ...l, block: { ...l.block, amountPaise: 0 }, debits: [] } }),
  },
  {
    code: 'AMOUNT_NOT_INTEGER',
    describe: 'block of a fractional paisa',
    apply: (l) => ({
      lifecycle: { ...l, block: { ...l.block, amountPaise: 1234.56 }, debits: [] },
    }),
  },
  {
    code: 'VALIDITY_NOT_POSITIVE',
    describe: 'block valid for zero days',
    apply: (l) => ({ lifecycle: { ...l, block: { ...l.block, validityDays: 0 }, debits: [] } }),
  },
];

export interface SensitivityResult {
  readonly code: ViolationCode;
  readonly describe: string;
  readonly trials: number;
  readonly caught: number;
  readonly rate: number;
}

/**
 * SENSITIVITY: for each rule, inject a breach and confirm the verifier reports
 * that specific code. Must be 100% for every class.
 */
export function measureSensitivity(seed: number, trialsPerCode: number): SensitivityResult[] {
  const rng = new Rng(seed);
  const out: SensitivityResult[] = [];

  for (const injection of INJECTIONS) {
    let caught = 0;
    for (let t = 0; t < trialsPerCode; t++) {
      const block: Block = {
        blockId: `b${t}`,
        merchantId: `m${rng.int(0, 5)}`,
        customerId: `c${rng.int(0, 50)}`,
        amountPaise: rng.int(100, OC228_MAX_BLOCK_PAISE),
        validityDays: rng.int(1, OC228_MAX_VALIDITY_DAYS),
        createdOnDay: rng.int(50, 500),
      };
      const clean: BlockLifecycle = { block, debits: [] };
      const { lifecycle, existing } = injection.apply(clean, rng);
      const found = verifyLifecycle(lifecycle, existing ?? []);
      if (found.some((v) => v.code === injection.code)) caught++;
    }
    out.push({
      code: injection.code,
      describe: injection.describe,
      trials: trialsPerCode,
      caught,
      rate: caught / trialsPerCode,
    });
  }
  return out;
}
