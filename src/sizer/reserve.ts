/**
 * Reserve sizing: how much to block for a delegated purchase.
 *
 * Pure. No I/O, no clock, no randomness — the same cart and mandate always
 * produce the same proposal, which is what makes a proposal auditable months
 * later.
 *
 * ── This module PROPOSES. It never approves. ────────────────────────────────
 * Clark-Wilson E3, separation of duty. Whether a proposal is lawful under
 * OC-228 is decided by `src/verifier/oc228.ts`, which shares no code with this
 * file — not a helper, not a constant, not a type. The two agree only by both
 * being right. A sizer that also validated itself would be a sizer that could
 * be wrong in the same direction twice.
 *
 * The constants below are therefore DUPLICATED in the verifier on purpose.
 * Extracting them into a shared module would look tidier and would destroy the
 * property the separation exists to buy: a typo in one place must be caught by
 * the other, and a shared constant is a typo in both places at once.
 *
 * ── Why sizing is hard here ─────────────────────────────────────────────────
 * OC-228 permits ONE block per merchant per customer. There is no laddering: a
 * merchant gets a single shot at choosing the number. Too low and a legitimate
 * price movement means a declined debit and a re-authorisation the customer has
 * to approve. Too high and the customer's money is stranded for up to 90 days —
 * and on an overdraft or a credit line, stranded capital has a real cost.
 */
import type { Cart, Mandate } from '../corpus/types.js';

/**
 * Regulatory ceiling on a single block, in paise. ₹10,000.
 *
 * NPCI/UPI/OC-228/2025-26, 08-Oct-2025. The NPCI PDF is 403-gated to automated
 * fetching, so this is triangulated across three independent secondary sources
 * that agree verbatim, two of them payment-aggregator developer documentation.
 * See research/evidence/india-competitors.md §3.1.
 */
const MAX_BLOCK_PAISE = 10_000_00;

/** Regulatory ceiling on block validity, in days. */
const MAX_VALIDITY_DAYS = 90;

/**
 * Headroom over the cart total, in basis points.
 *
 * Covers the movement a legitimate order can show between blocking and debit:
 * shipping computed at checkout, tax rounding, a small price change. It is NOT
 * a buffer for the agent buying something different — that is a conformance
 * question, and the gate has already answered it before we get here.
 *
 * 5% is a starting policy, not a measured optimum. Choosing it properly needs
 * the stranded-capital vs re-authorisation-rate frontier, which needs debit
 * data we do not have. Stated as a parameter so it can be tuned against real
 * numbers rather than quietly baked in.
 */
const DEFAULT_HEADROOM_BPS = 500;

export const SIZER_POLICY_VERSION = 'reserve-sizer/1';

/**
 * Why an amount is what it is. Recorded on the certificate, so a decision can
 * be argued with rather than merely observed.
 */
export type RationaleCode =
  /** Cart plus headroom, comfortably inside the regulatory ceiling. */
  | 'CART_PLUS_HEADROOM'
  /** Headroom would have exceeded the ceiling; trimmed to it. */
  | 'HEADROOM_TRIMMED_TO_CAP'
  /** The cart alone meets or exceeds the ceiling. No headroom is possible. */
  | 'CAPPED_AT_REGULATORY_MAX'
  /** The cart costs more than a single block may hold. Reserve Pay cannot fund this. */
  | 'CART_EXCEEDS_MAX_BLOCK'
  /** Nothing to fund. */
  | 'EMPTY_CART';

export interface ReserveProposal {
  /** Paise to block. Zero when no block should be created. */
  readonly amountPaise: number;
  readonly validityDays: number;
  readonly rationale: RationaleCode;
  /** The cart total this was computed from, so the arithmetic can be re-run. */
  readonly cartTotalPaise: number;
  readonly headroomBps: number;
  /**
   * True when a single block cannot cover the cart. The caller must not treat
   * a partial reserve as a funded one.
   */
  readonly fundable: boolean;
  readonly policyVersion: string;
}

export interface SizerOptions {
  readonly headroomBps?: number;
  /**
   * How long the mandate should stay live. Trimmed to the regulatory ceiling.
   * Defaults to 30 days: a delegated shopping mandate that needs longer is
   * unusual enough to be worth stating explicitly.
   */
  readonly requestedValidityDays?: number;
}

function cartTotalPaise(cart: Cart): number {
  return cart.lines.reduce((n, l) => n + l.priceMinor * l.quantity, 0);
}

/**
 * Propose a block amount for this cart.
 *
 * Never throws on a well-formed cart: an unfundable cart is reported as
 * `fundable: false`, not as an exception, because "this cannot be funded by a
 * block" is an answer the caller needs to act on rather than an error.
 */
export function sizeReserve(
  cart: Cart,
  _mandate: Mandate,
  opts: SizerOptions = {},
): ReserveProposal {
  const headroomBps = opts.headroomBps ?? DEFAULT_HEADROOM_BPS;
  const requested = opts.requestedValidityDays ?? 30;
  const validityDays = Math.max(1, Math.min(requested, MAX_VALIDITY_DAYS));
  const total = cartTotalPaise(cart);

  const base = {
    cartTotalPaise: total,
    headroomBps,
    validityDays,
    policyVersion: SIZER_POLICY_VERSION,
  };

  if (total <= 0) {
    return { ...base, amountPaise: 0, rationale: 'EMPTY_CART', fundable: true };
  }

  if (total > MAX_BLOCK_PAISE) {
    // Reported, not clamped. Blocking the maximum would look like a funded
    // purchase and then fail at debit time, which is the worst of both.
    return {
      ...base,
      amountPaise: 0,
      rationale: 'CART_EXCEEDS_MAX_BLOCK',
      fundable: false,
    };
  }

  if (total === MAX_BLOCK_PAISE) {
    return { ...base, amountPaise: total, rationale: 'CAPPED_AT_REGULATORY_MAX', fundable: true };
  }

  // Integer arithmetic throughout: paise are indivisible, and a floating-point
  // rupee is how money goes missing. Rounding UP means the headroom is never
  // silently smaller than stated.
  const withHeadroom = total + Math.ceil((total * headroomBps) / 10_000);

  if (withHeadroom > MAX_BLOCK_PAISE) {
    return {
      ...base,
      amountPaise: MAX_BLOCK_PAISE,
      rationale: 'HEADROOM_TRIMMED_TO_CAP',
      fundable: true,
    };
  }

  return { ...base, amountPaise: withHeadroom, rationale: 'CART_PLUS_HEADROOM', fundable: true };
}
