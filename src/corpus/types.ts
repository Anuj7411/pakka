/**
 * Corpus types.
 *
 * A `Case` is one (mandate, cart) pair with exact per-line ground truth. The
 * labels are exact because we constructed the divergence — that is the whole
 * reason for generating rather than collecting.
 */
import type { DivergenceClass } from '../taxonomy/classes.js';

/**
 * Difficulty by DETECTION MARGIN, not by intuition.
 *
 * The margin is how far the injected value sits from the conforming one:
 * quantity x10 is easy, +1 is hard; a cross-category product is easy, a
 * same-brand adjacent variant is hard.
 *
 * This exists because the obvious objection to a generated corpus is "your
 * divergences are easier than real ones". Stratifying by margin and reporting
 * the macro-average across tiers answers that with a number instead of an
 * assurance.
 */
export const TIERS = ['easy', 'medium', 'hard'] as const;
export type Tier = (typeof TIERS)[number];

/** What the human asked for, and the bounds they stated. */
export interface Mandate {
  readonly mandateId: string;
  /** Verbatim human text from WebShop. */
  readonly text: string;
  /** Attributes the human stated, e.g. "wireless bluetooth". */
  readonly statedAttributes: readonly string[];
  /** Option values the human stated, e.g. "blue". */
  readonly statedOptions: readonly string[];
  /**
   * Category the agent is authorised to buy within.
   *
   * SYNTHESIZED — WebShop instructions do not name a merchant or scope. We
   * derive it from the target product's top-level category so SCOPE_VIOLATION
   * is expressible. Recorded here so it is never mistaken for human-authored.
   */
  readonly authorisedCategory: string;
  /** Provenance back to the source record. */
  readonly sourceAsin: string;
}

export interface CartLine {
  readonly lineId: string;
  readonly sku: string;
  readonly name: string;
  readonly brand: string | null;
  readonly priceMinor: number;
  readonly quantity: number;
  readonly categoryPath: readonly string[];
  /** "dimension: value" pairs, as WebShop stores them. */
  readonly options: readonly string[];
  /** Free-text attributes this product claims. */
  readonly attributes: readonly string[];
}

export interface Cart {
  readonly cartId: string;
  readonly lines: readonly CartLine[];
}

/** Ground truth for one line. Exact, because we injected it. */
export interface ExpectedDivergence {
  readonly lineId: string;
  readonly class: DivergenceClass;
  readonly tier: Tier;
  /** Human-readable account of what was done, for the discard review. */
  readonly detail: string;
}

export interface Case {
  readonly caseId: string;
  readonly mandate: Mandate;
  readonly cart: Cart;
  /** Empty for a conforming case. */
  readonly expected: readonly ExpectedDivergence[];
  /** null for conforming cases — they have no difficulty. */
  readonly tier: Tier | null;
  /**
   * The injection template used, e.g. "QUANTITY_DEVIATION/hard". Conforming
   * cases carry the template of the case they are matched to, so a template's
   * positives and negatives can be compared directly.
   */
  readonly template: string;
  /** True when this is the matched conforming negative for `template`. */
  readonly conforming: boolean;
  readonly seed: number;
}

export interface Corpus {
  readonly cases: readonly Case[];
  readonly generatedWith: {
    readonly seed: number;
    readonly version: number;
    /** sha256 of the canonical corpus. Pinned in results. */
    readonly hash: string;
  };
}

export function cartTotalMinor(cart: Cart): number {
  return cart.lines.reduce((sum, l) => sum + l.priceMinor * l.quantity, 0);
}
