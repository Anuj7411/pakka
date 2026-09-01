/**
 * Measuring what a real shopping agent does wrong.
 *
 * Every other number in this project is computed on divergences we injected.
 * These are observed: a model is given a human instruction and a catalogue, it
 * fills a cart, and the deterministic checkers say what it did.
 *
 * ── The control that makes this honest ──────────────────────────────────────
 * A scenario is only used when a CLEAN CHOICE EXISTS — the correct product,
 * taken alone at the stated quantity, produces zero violations. Without that
 * check, an unsatisfiable scenario would score as an agent error, and the
 * headline rate would be measuring our catalogue rather than the agent.
 *
 * Scenarios failing the check are counted and reported, never silently dropped.
 *
 * ── What can and cannot be measured this way ────────────────────────────────
 * SCOPE_VIOLATION, CONSTRAINT_BREACH and QUANTITY_DEVIATION are decided by
 * comparing what the human STATED against fields the merchant DECLARES. Both
 * sides are data, so these rates are objective.
 *
 * ITEM_SUBSTITUTION is not. Deciding it needs a judgement about whether a
 * product answers a request, which is the semantic layer, whose false-positive
 * rate is unverified (docs/RESULTS-DAY4-RERUN.md). It is therefore reported
 * separately and labelled, never folded into the headline.
 */
import { assessCart } from '../deterministic/checkers.js';
import { similarity } from '../corpus/similarity.js';
import { Rng } from '../corpus/rng.js';
import type { CatalogueEntry, Pick } from './shopper.js';
import type { Cart, CartLine, Mandate } from '../corpus/types.js';
import type { Pairing } from '../corpus/pairing.js';
import type { DivergenceClass } from '../taxonomy/classes.js';

export interface Scenario {
  readonly scenarioId: string;
  readonly request: string;
  readonly mandate: Mandate;
  readonly catalogue: readonly CatalogueEntry[];
  /** Index of the product that satisfies the request. Never shown to the agent. */
  readonly correctIndex: number;
  /**
   * Null, always.
   *
   * A first version hardcoded 1, and the agent was then scored QUANTITY_DEVIATION
   * for ordering three units of "i would like THREE traditional vanity lights" —
   * which is what the human asked for. The label was wrong, not the agent.
   *
   * WebShop states pack SIZES as product options ("36 pack") and essentially
   * never an order quantity, and this project's own taxonomy holds that an
   * unstated quantity cannot be a violation. So it is null, checkQuantity
   * returns `undecidable`, and QUANTITY_DEVIATION is simply not measurable in
   * this setup. Reported as unmeasurable rather than reported wrong.
   */
  readonly statedQuantity: number | null;
}

/**
 * A catalogue entry built from a real pairing.
 *
 * Declared options and attributes come from the instruction's `targetHas` —
 * what the dataset says that product actually has — exactly as the corpus
 * generator sources them. Distractors are therefore other REAL products with
 * their own real declared fields, not blanks. A distractor with no declared
 * options could never breach a stated constraint, and a measurement where the
 * wrong answers are incapable of being wrong measures nothing.
 */
function toEntry(index: number, pairing: Pairing): CatalogueEntry {
  return {
    index,
    name: pairing.product.name,
    category: pairing.product.topCategory,
    pricePaise: pairing.product.priceMinor ?? 99900,
    options: [...pairing.instruction.targetHas.options],
    attributes: [...pairing.instruction.targetHas.attributes],
    description: pairing.product.description.slice(0, 240),
  };
}

function toLine(lineId: string, e: CatalogueEntry, quantity: number): CartLine {
  return {
    lineId,
    answersItemId: null,
    sku: `sku-${e.index}`,
    name: e.name,
    brand: null,
    priceMinor: e.pricePaise,
    quantity,
    categoryPath: [e.category],
    options: e.options,
    attributes: e.attributes,
  };
}

export interface BuildOptions {
  readonly sameCategoryDistractors?: number;
  readonly otherCategoryDistractors?: number;
}

/**
 * Build one scenario: a request, a catalogue containing the right answer and
 * plausible wrong ones, and the mandate the gate will check against.
 *
 * Distractors are what make divergence POSSIBLE without making it likely. An
 * agent shown only the correct product cannot err, and a rate measured that way
 * would be zero for reasons that have nothing to do with the agent.
 *
 * ── Near misses, not random junk ────────────────────────────────────────────
 * Same-category distractors are the ones most SIMILAR to the request, not a
 * uniform sample. A first version drew them at random and the agent scored 8/8
 * — unsurprising, because the wrong answers were from unrelated aisles. Real
 * catalogues are full of adjacent variants of the same product, and that is
 * where an agent actually errs. Ranking by similarity makes the task the one a
 * shopping agent faces rather than the one that flatters it.
 *
 * A handful of cross-category entries stay in, because scope violation has to
 * remain reachable for its rate to mean anything.
 */
export function buildScenario(
  correct: Pairing,
  pool: readonly Pairing[],
  rng: Rng,
  opts: BuildOptions = {},
): Scenario | null {
  const sameN = opts.sameCategoryDistractors ?? 6;
  const otherN = opts.otherCategoryDistractors ?? 2;

  const seen = new Set([correct.product.name]);

  // Nearest same-category products by name similarity to the request: the
  // adjacent variants a real shopper has to choose between.
  const same = pool
    .filter(
      (p) =>
        p.product.topCategory === correct.product.topCategory &&
        p.product.name !== correct.product.name,
    )
    .map((p) => ({ p, score: similarity(correct.instruction.text, p.product.name) }))
    .sort((a, b) => b.score - a.score);

  const other = pool.filter((p) => p.product.topCategory !== correct.product.topCategory);
  if (same.length < sameN || other.length < otherN) return null;

  const chosen: Pairing[] = [correct];
  for (const { p } of same) {
    if (chosen.length >= 1 + sameN) break;
    if (seen.has(p.product.name)) continue;
    seen.add(p.product.name);
    chosen.push(p);
  }
  let guard = 0;
  let added = 0;
  while (added < otherN && guard++ < 500) {
    const cand = rng.pick(other);
    if (seen.has(cand.product.name)) continue;
    seen.add(cand.product.name);
    chosen.push(cand);
    added++;
  }
  if (chosen.length < 2) return null;

  // Deterministic shuffle, so the correct answer is not always index 0 and the
  // agent cannot score well by position.
  for (let i = chosen.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [chosen[i], chosen[j]] = [chosen[j]!, chosen[i]!];
  }
  const catalogue = chosen.map((p, i) => toEntry(i, p));
  const correctIndex = chosen.findIndex((p) => p.product.name === correct.product.name);
  if (correctIndex < 0) return null;

  const statedQuantity = null;
  const instruction = correct.instruction;
  const mandate: Mandate = {
    mandateId: `agent-${instruction.targetAsin}`,
    text: instruction.text,
    items: [
      {
        itemId: 'i0',
        text: instruction.text,
        statedAttributes: instruction.stated.attributes,
        statedOptions: instruction.stated.options,
        statedQuantity,
        sourceAsin: instruction.targetAsin,
      },
    ],
    authorisedCategory: correct.product.topCategory,
  };

  return {
    scenarioId: `agent-${instruction.targetAsin}`,
    request: instruction.text,
    mandate,
    catalogue,
    correctIndex,
    statedQuantity,
  };
}

/** The cart an ideal agent would build: the right product, one unit. */
export function idealCart(s: Scenario): Cart {
  return {
    cartId: `${s.scenarioId}-ideal`,
    lines: [toLine('l0', s.catalogue[s.correctIndex]!, s.statedQuantity ?? 1)],
  };
}

/**
 * Is a clean choice actually available?
 *
 * The control. A scenario where even the correct product violates the stated
 * constraints would score the agent for our catalogue's shortcomings.
 */
export function hasCleanChoice(s: Scenario): boolean {
  return assessCart(idealCart(s), s.mandate).violations.length === 0;
}

/** Turn the agent's picks into a cart, using OUR catalogue data throughout. */
export function cartFromPicks(s: Scenario, picks: readonly Pick[]): Cart {
  return {
    cartId: `${s.scenarioId}-agent`,
    lines: picks.map((p, i) => toLine(`l${i}`, s.catalogue[p.index]!, p.quantity)),
  };
}

export interface ScenarioOutcome {
  readonly scenarioId: string;
  readonly request: string;
  readonly pickedIndices: readonly number[];
  readonly correctIndex: number;
  readonly pickedCorrect: boolean;
  readonly lineCount: number;
  readonly classes: readonly DivergenceClass[];
  readonly evidence: readonly string[];
  readonly failed: boolean;
}

/** Run the deterministic checkers over what the agent built. */
export function assessAgentCart(s: Scenario, picks: readonly Pick[], failed: boolean): ScenarioOutcome {
  const cart = cartFromPicks(s, picks);
  const assessment = failed ? { violations: [] } : assessCart(cart, s.mandate);
  return {
    scenarioId: s.scenarioId,
    request: s.request,
    pickedIndices: picks.map((p) => p.index),
    correctIndex: s.correctIndex,
    pickedCorrect: picks.some((p) => p.index === s.correctIndex),
    lineCount: picks.length,
    classes: assessment.violations.map((v) => v.class),
    evidence: assessment.violations.flatMap((v) => v.evidence),
    failed,
  };
}
