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

/** One thing the human asked for, with the bounds they stated about it. */
export interface MandateItem {
  readonly itemId: string;
  /** Verbatim human text for this request. */
  readonly text: string;
  readonly statedAttributes: readonly string[];
  readonly statedOptions: readonly string[];
  /**
   * Order quantity, or null when unstated.
   *
   * SYNTHESIZED. WebShop states pack SIZES as product options ("12 count
   * (pack of 2)" describes the SKU) but essentially never an order quantity.
   * Our taxonomy holds that an unstated quantity cannot be a violation, so a
   * QUANTITY_DEVIATION case built on one would carry a label no honest checker
   * could match. Measured before fixing: 62% of quantity cases had none.
   * When synthesized it is appended to `text`, so what a judge reads and what
   * a checker enforces are the same statement.
   */
  readonly statedQuantity: number | null;
  readonly sourceAsin: string;
}

/**
 * What the human asked for.
 *
 * Mandates are MULTI-ITEM (1-3 requests). This is not decoration:
 *
 *  - A single-item mandate whose conforming cart holds filler lines is
 *    mislabelled, because by our own taxonomy a line filling no requested slot
 *    IS an UNREQUESTED_ADDITION. The earlier corpus had exactly that bug.
 *  - Dropping fillers instead would make cart SIZE leak the label: one line
 *    means clean, two means a violation. A checker could score well by
 *    counting lines.
 *
 * With multi-item mandates every conforming line answers a request, cart size
 * varies independently of whether a violation exists, and real delegated
 * mandates ("fill my cart") look like this anyway.
 */
export interface Mandate {
  readonly mandateId: string;
  /** All requests, joined. What a judge reads. */
  readonly text: string;
  readonly items: readonly MandateItem[];
  /**
   * Category the agent is authorised to buy within.
   *
   * SYNTHESIZED — WebShop instructions name no merchant or scope. Derived from
   * the matched products' category so SCOPE_VIOLATION is expressible.
   */
  readonly authorisedCategory: string;
}

export interface CartLine {
  readonly lineId: string;
  /**
   * The mandate item this line answers, or null when it answers none.
   * Ground truth only — never given to a checker or a judge.
   */
  readonly answersItemId: string | null;
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
