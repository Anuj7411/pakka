/**
 * Deterministic conformance checkers.
 *
 * Pure functions. No I/O, no clock, no randomness, no model. Everything here
 * is re-derivable from its inputs, which is what makes the certificate's
 * `policy_version` meaningful.
 *
 * ── Three-valued, deliberately ──────────────────────────────────────────────
 * A checker returns `violation`, `clear`, or `undecidable`. The third is the
 * important one: in a money gate, "I cannot tell" must never be recorded as
 * "no problem". `undecidable` is what the semantic layer is FOR, and under the
 * monotonic-permission rule (ARCHITECTURE §2.2) the semantic layer can only
 * add violations, never remove one this layer found.
 *
 * ── Precision first ─────────────────────────────────────────────────────────
 * These checkers fire only when certain. A deterministic false positive blocks
 * a good cart, which is the failure a payments company actually fears; a
 * deterministic miss merely defers to the model. So every rule below prefers
 * `undecidable` to a guess.
 */
import type { Mandate, MandateItem, Cart, CartLine } from '../corpus/types.js';
import { similarity } from '../corpus/similarity.js';
import { parseOption } from '../corpus/webshop.js';
import { classify, type DivergenceClass, type ClassSignals } from '../taxonomy/classes.js';

export type Decision = 'violation' | 'clear' | 'undecidable';

/** Named so the numbers in results can be traced to a decision, not a vibe. */
export const THRESHOLDS = {
  /**
   * Below this, a line shares so little with every request that we treat it as
   * answering none of them. Set at 0 — literally no shared token — because any
   * higher value starts guessing, and a wrong guess here blocks a good cart.
   * Its precision is measured and reported rather than assumed.
   */
  UNREQUESTED_MAX_SIMILARITY: 0,
} as const;

export interface LineAssessment {
  readonly lineId: string;
  /** Which request this line appears to answer. A deterministic guess. */
  readonly assignedItemId: string | null;
  readonly assignedSimilarity: number;
  readonly decisions: Readonly<Record<keyof ClassSignals, Decision>>;
  /** Non-null only when some decision is `violation`. */
  readonly class: DivergenceClass | null;
  readonly evidence: readonly string[];
}

export interface CartAssessment {
  readonly lines: readonly LineAssessment[];
  /** Lines where a class fired. */
  readonly violations: readonly { lineId: string; class: DivergenceClass; evidence: readonly string[] }[];
  /** Lines where at least one decision was `undecidable`. The semantic layer's queue. */
  readonly undecidedLineIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Assignment: which request does a line answer?
// ---------------------------------------------------------------------------

/**
 * Assign lines to requests as a MATCHING, not independently.
 *
 * Picking each line's best request on its own is wrong, and measurably so: in a
 * multi-item mandate two lines can claim the same request, leaving another line
 * judged against bounds it was never meant to satisfy. That produced every one
 * of our 30 deterministic false positives — a line for "beard scissors" checked
 * against a request stating "silver".
 *
 * Each request can answer at most one line, so this greedily takes the highest
 * similarity pairs first. Greedy rather than optimal: carts here hold 1-4 lines,
 * where the difference is negligible, and a deterministic checker should be
 * simple enough to audit by reading.
 *
 * Lines left unassigned answer no request — which is exactly the definition of
 * UNREQUESTED_ADDITION.
 */
export function assignLines(
  cart: Cart,
  mandate: Mandate,
): Map<string, { item: MandateItem; score: number } | null> {
  const pairs: { lineId: string; item: MandateItem; score: number }[] = [];
  for (const line of cart.lines) {
    for (const item of mandate.items) {
      pairs.push({ lineId: line.lineId, item, score: similarity(line.name, item.text) });
    }
  }
  // Deterministic ordering: score desc, then ids, so ties never depend on
  // input order.
  pairs.sort(
    (a, b) =>
      b.score - a.score ||
      (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0) ||
      (a.item.itemId < b.item.itemId ? -1 : 1),
  );

  const out = new Map<string, { item: MandateItem; score: number } | null>();
  for (const line of cart.lines) out.set(line.lineId, null);
  const usedItems = new Set<string>();

  for (const p of pairs) {
    if (out.get(p.lineId) !== null) continue;
    if (usedItems.has(p.item.itemId)) continue;
    // A pairing with no shared term is no evidence of answering a request.
    if (p.score <= 0) continue;
    out.set(p.lineId, { item: p.item, score: p.score });
    usedItems.add(p.item.itemId);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/** Fully decidable: the category is either inside the authorised scope or not. */
export function checkScope(line: CartLine, mandate: Mandate): { decision: Decision; evidence?: string } {
  const top = line.categoryPath[0];
  if (top === undefined) {
    return { decision: 'undecidable', evidence: 'line has no category path' };
  }
  if (top !== mandate.authorisedCategory) {
    return {
      decision: 'violation',
      evidence: `authorised "${mandate.authorisedCategory}", line is from "${top}"`,
    };
  }
  return { decision: 'clear' };
}

/**
 * Stated option values and stated attributes.
 *
 * ASSUMPTION, stated because it is load-bearing: a line's declared `options`
 * and `attributes` are treated as complete for the dimensions they mention. If
 * a line declares options and none carries the stated value, the product does
 * not have it. If a line declares nothing, we cannot tell — `undecidable`, not
 * `clear`.
 */
export function checkStatedBounds(
  line: CartLine,
  item: MandateItem,
): { decision: Decision; evidence: string[] } {
  const evidence: string[] = [];
  let sawUndecidable = false;

  const lineValues = line.options
    .map(parseOption)
    .filter((o): o is { dimension: string; value: string } => o !== null)
    .map((o) => o.value.toLowerCase());

  for (const stated of item.statedOptions) {
    const s = stated.toLowerCase();
    const satisfied = lineValues.some((v) => v === s || v.includes(s) || s.includes(v));
    if (satisfied) continue;
    if (lineValues.length === 0) {
      sawUndecidable = true;
      evidence.push(`stated option "${stated}" — line declares no options, cannot tell`);
      continue;
    }
    return {
      decision: 'violation',
      evidence: [`stated "${stated}", line options are [${lineValues.join(', ')}]`],
    };
  }

  for (const stated of item.statedAttributes) {
    const s = stated.toLowerCase();
    const satisfied = line.attributes.some((a) => {
      const v = a.toLowerCase();
      return v === s || v.includes(s) || s.includes(v);
    });
    if (satisfied) continue;
    if (line.attributes.length === 0) {
      sawUndecidable = true;
      evidence.push(`stated attribute "${stated}" — line declares no attributes, cannot tell`);
      continue;
    }
    return {
      decision: 'violation',
      evidence: [`stated attribute "${stated}" absent from [${line.attributes.join(', ')}]`],
    };
  }

  return { decision: sawUndecidable ? 'undecidable' : 'clear', evidence };
}

/**
 * Quantity, against a STATED quantity only.
 *
 * Our taxonomy holds that an unstated quantity cannot be a violation — any
 * reasonable amount conforms — so this returns `undecidable` rather than
 * inventing an expectation.
 */
export function checkQuantity(
  line: CartLine,
  item: MandateItem,
): { decision: Decision; evidence?: string } {
  if (item.statedQuantity === null) {
    return { decision: 'undecidable', evidence: 'no quantity stated' };
  }
  if (line.quantity !== item.statedQuantity) {
    return {
      decision: 'violation',
      evidence: `stated ${item.statedQuantity}, cart has ${line.quantity}`,
    };
  }
  return { decision: 'clear' };
}

/**
 * Does this line answer any request at all?
 *
 * Only fires at zero token overlap with EVERY request — no shared word with
 * anything the human asked for. Anything less conservative starts guessing,
 * and a guess here blocks a good cart. Everything else defers.
 */
export function checkAnswersARequest(
  wasAssigned: boolean,
  score: number,
): { decision: Decision; evidence?: string } {
  if (!wasAssigned) {
    // Every request already has a better-matching line, or this line shares no
    // term with any of them. Either way it answers nothing that was asked for.
    return { decision: 'violation', evidence: 'answers none of the requests' };
  }
  return { decision: 'undecidable', evidence: `assigned to a request, overlap ${score.toFixed(3)}` };
}

/**
 * Is this the right product for the slot?
 *
 * Always `undecidable`. Deciding it requires judging whether a different
 * product satisfies the same request — a semantic question with no
 * field-level answer. Recording it as undecidable rather than omitting it
 * keeps the class visible in the results, so the ablation can show exactly
 * what the model contributes.
 */
export function checkProductForSlot(): { decision: Decision; evidence?: string } {
  return { decision: 'undecidable', evidence: 'requires semantic judgement' };
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

export function assessLine(
  line: CartLine,
  mandate: Mandate,
  assigned: { item: MandateItem; score: number } | null,
): LineAssessment {
  const evidence: string[] = [];
  const item = assigned?.item ?? null;
  const score = assigned?.score ?? 0;

  const scope = checkScope(line, mandate);
  if (scope.evidence) evidence.push(scope.evidence);

  const answers = checkAnswersARequest(assigned !== null, score);
  if (answers.evidence) evidence.push(answers.evidence);

  const bounds = item
    ? checkStatedBounds(line, item)
    : { decision: 'undecidable' as Decision, evidence: ['no request to check against'] };
  evidence.push(...bounds.evidence);

  const qty = item
    ? checkQuantity(line, item)
    : { decision: 'undecidable' as Decision, evidence: 'no request to check against' };
  if (qty.evidence) evidence.push(qty.evidence);

  const product = checkProductForSlot();
  if (product.evidence) evidence.push(product.evidence);

  const signals: ClassSignals = {
    outOfScope: scope.decision === 'violation',
    breachesStatedBound: bounds.decision === 'violation',
    fillsNoRequestedSlot: answers.decision === 'violation',
    wrongProductForSlot: product.decision === 'violation',
    wrongQuantityForSlot: qty.decision === 'violation',
  };

  return {
    lineId: line.lineId,
    assignedItemId: item?.itemId ?? null,
    assignedSimilarity: score,
    decisions: {
      outOfScope: scope.decision,
      breachesStatedBound: bounds.decision,
      fillsNoRequestedSlot: answers.decision,
      wrongProductForSlot: product.decision,
      wrongQuantityForSlot: qty.decision,
    },
    class: classify(signals),
    evidence,
  };
}

export function assessCart(cart: Cart, mandate: Mandate): CartAssessment {
  const assignment = assignLines(cart, mandate);
  const lines = cart.lines.map((l) => assessLine(l, mandate, assignment.get(l.lineId) ?? null));
  return {
    lines,
    violations: lines
      .filter((l): l is LineAssessment & { class: DivergenceClass } => l.class !== null)
      .map((l) => ({ lineId: l.lineId, class: l.class, evidence: l.evidence })),
    undecidedLineIds: lines
      .filter((l) => l.class === null && Object.values(l.decisions).includes('undecidable'))
      .map((l) => l.lineId),
  };
}
