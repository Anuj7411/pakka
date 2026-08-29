/**
 * Corpus generator.
 *
 * Produces (mandate, cart) pairs with exact per-line ground truth, seeded and
 * reproducible. Real human instructions and real products come from WebShop;
 * only the divergence is ours, which is what makes the label exact.
 *
 * DIFFICULTY IS BUILT IN, NOT BOLTED ON. Every injector takes a tier and
 * chooses its perturbation by DETECTION MARGIN — how far the injected value
 * sits from the conforming one. The hard tier is genuinely hard: quantity +1,
 * a price 3% over, an out-of-scope product whose name looks like it belongs.
 *
 * The catalogue has 739 distinct brands across 804 products, so "same brand,
 * adjacent variant" is rarely available. The hard tier therefore uses
 * name-token similarity as its near-miss measure, which is available for every
 * product and is a defensible proxy for "looks like the right thing".
 */
import {
  type WebShopData,
  type Product,
  richInstructions,
  usableProducts,
  byTopCategory,
  parseOption,
} from './webshop.js';
import { Rng } from './rng.js';
import { similarity } from './similarity.js';
import { pairInstructions, pairablePool as poolFor, type Pairing } from './pairing.js';
import { hashOf } from '../normalise/canonical.js';
import { DIVERGENCE_CLASSES, type DivergenceClass } from '../taxonomy/classes.js';
import {
  TIERS,
  type Tier,
  type Mandate,
  type MandateItem,
  type Cart,
  type CartLine,
  type Case,
  type Corpus,
  type ExpectedDivergence,
} from './types.js';

export const GENERATOR_VERSION = 1;

export { similarity, tokenise } from './similarity.js';
export { pairInstructions, MIN_PAIR_SIMILARITY, type Pairing } from './pairing.js';

/** Instructions that can be paired at all, memoised on the corpus. */
export function pairablePool(data: WebShopData) {
  return poolFor(data, richInstructions);
}

/**
 * Pick by similarity rank: hard = most similar (smallest margin), easy = least.
 * Sampling from a band rather than taking the extreme keeps variety.
 */
function pickByMargin<T>(
  rng: Rng,
  pool: readonly T[],
  score: (item: T) => number,
  tier: Tier,
): T | null {
  if (pool.length === 0) return null;
  const ranked = [...pool].sort((x, y) => score(y) - score(x));
  const n = ranked.length;
  const band =
    tier === 'hard'
      ? ranked.slice(0, Math.max(1, Math.ceil(n * 0.15)))
      : tier === 'medium'
        ? ranked.slice(Math.floor(n * 0.35), Math.max(Math.floor(n * 0.35) + 1, Math.ceil(n * 0.65)))
        : ranked.slice(Math.floor(n * 0.85));
  return band.length === 0 ? ranked[n - 1]! : rng.pick(band);
}

// ---------------------------------------------------------------------------
// Building a conforming cart
// ---------------------------------------------------------------------------

/**
 * Allocates line ids. Held per-generation rather than module-global: a module
 * that documents its functions as pure must not carry mutable state, and a
 * shared counter would make two concurrent generations interfere.
 */
export type LineIds = (tag: string) => { lineId: string; n: number };

export function makeLineIds(): LineIds {
  let n = 0;
  return (tag) => {
    n++;
    return { lineId: `${tag}-${n}`, n };
  };
}

function makeLine(p: Product, over: Partial<CartLine>, tag: string, ids: LineIds): CartLine {
  const { lineId, n } = ids(tag);
  return {
    lineId,
    answersItemId: null,
    sku: p.asin ?? `sku-${n}`,
    name: p.name,
    brand: p.brand,
    priceMinor: p.priceMinor ?? 0,
    quantity: 1,
    categoryPath: p.categoryPath,
    options: [],
    attributes: [],
    ...over,
  };
}

/**
 * The conforming cart: exactly one line per requested item, nothing else.
 *
 * No filler lines. A filler answers no request, and by our own taxonomy a line
 * filling no requested slot IS an UNREQUESTED_ADDITION — so fillers placed
 * unlabelled violations inside cases marked conforming. Dropping them without
 * making mandates multi-item would have been worse still: cart size would then
 * leak the label, since one line would mean clean and two would mean a
 * violation.
 */
function buildBaseCart(
  mandate: Mandate,
  pairings: readonly Pairing[],
  rng: Rng,
  ids: LineIds,
): { cart: Cart; lineForItem: Map<string, string> } {
  const lineForItem = new Map<string, string>();
  const lines: CartLine[] = [];

  for (const [i, item] of mandate.items.entries()) {
    const pairing = pairings[i]!;
    const line = makeLine(
      pairing.product,
      {
        answersItemId: item.itemId,
        options: [...pairing.instruction.targetHas.options],
        attributes: [...pairing.instruction.targetHas.attributes],
        quantity: item.statedQuantity ?? 1,
      },
      'tgt',
      ids,
    );
    lines.push(line);
    lineForItem.set(item.itemId, line.lineId);
  }

  return {
    cart: { cartId: `cart-${mandate.mandateId}`, lines: rng.shuffle(lines) },
    lineForItem,
  };
}

function replaceLine(cart: Cart, lineId: string, next: CartLine): Cart {
  return { ...cart, lines: cart.lines.map((l) => (l.lineId === lineId ? next : l)) };
}

// ---------------------------------------------------------------------------
// Injectors — one per class, each tier-aware
// ---------------------------------------------------------------------------

interface InjectContext {
  readonly mandate: Mandate;
  /** The item whose line this injector perturbs. */
  readonly targetItem: MandateItem;
  readonly targetLineId: string;
  readonly cart: Cart;
  readonly inScope: readonly Product[];
  readonly outOfScope: readonly Product[];
  readonly tier: Tier;
  readonly rng: Rng;
  readonly ids: LineIds;
}

type Injector = (c: InjectContext) => { cart: Cart; expected: ExpectedDivergence } | null;

const ALT_VALUES: Record<string, string[]> = {
  color: ['red', 'green', 'yellow', 'orange', 'purple', 'pink', 'brown', 'white', 'black'],
  size: ['xx-large', 'small', '3 inch', '48 inch', 'one size'],
  flavor: ['unflavored', 'liquorice', 'wasabi'],
  style: ['industrial', 'rustic'],
};

function alternativeValue(dimension: string, current: string, rng: Rng): string {
  const pool = (ALT_VALUES[dimension] ?? ALT_VALUES['color']!).filter(
    (v) => v.toLowerCase() !== current.toLowerCase(),
  );
  return rng.pick(pool);
}

const injectConstraintBreach: Injector = (c) => {
  const line = c.cart.lines.find((l) => l.lineId === c.targetLineId)!;

  if (c.tier === 'hard') {
    // Prose-level: drop a stated ATTRIBUTE. No field changes value, so a
    // field-comparison checker sees nothing move.
    const stated = c.targetItem.statedAttributes;
    if (stated.length === 0) return null;
    const drop = c.rng.pick(stated);
    const attrs = line.attributes.filter((a) => a.toLowerCase() !== drop.toLowerCase());
    if (attrs.length === line.attributes.length) return null;
    return {
      cart: replaceLine(c.cart, line.lineId, { ...line, attributes: attrs }),
      expected: {
        lineId: line.lineId,
        class: 'CONSTRAINT_BREACH',
        tier: c.tier,
        detail: `dropped stated attribute "${drop}"`,
      },
    };
  }

  const parsed = line.options
    .map((o) => ({ raw: o, p: parseOption(o) }))
    .filter((x): x is { raw: string; p: { dimension: string; value: string } } => x.p !== null);
  const statedLower = c.targetItem.statedOptions.map((v) => v.toLowerCase());
  const hit = parsed.find((x) =>
    statedLower.some((v) => x.p.value.toLowerCase() === v || x.p.value.toLowerCase().includes(v)),
  );
  if (!hit) return null;

  const replacement = alternativeValue(hit.p.dimension, hit.p.value, c.rng);
  const options = line.options.map((o) => (o === hit.raw ? `${hit.p.dimension}: ${replacement}` : o));
  const attrs =
    c.tier === 'easy' && c.targetItem.statedAttributes.length > 0
      ? line.attributes.filter(
          (a) => a.toLowerCase() !== c.targetItem.statedAttributes[0]!.toLowerCase(),
        )
      : line.attributes;

  return {
    cart: replaceLine(c.cart, line.lineId, { ...line, options, attributes: attrs }),
    expected: {
      lineId: line.lineId,
      class: 'CONSTRAINT_BREACH',
      tier: c.tier,
      detail:
        `stated "${hit.p.value}" on ${hit.p.dimension}, cart has "${replacement}"` +
        (c.tier === 'easy' ? ' and a stated attribute was dropped' : ''),
    },
  };
};

const injectQuantityDeviation: Injector = (c) => {
  // Only meaningful against a STATED quantity. Our taxonomy holds that an
  // unstated quantity cannot be a violation, so deviating from one would
  // produce a label no honest checker could ever match. Measured before this
  // guard existed: 62% of quantity cases had no stated quantity.
  if (c.targetItem.statedQuantity === null) return null;
  const line = c.cart.lines.find((l) => l.lineId === c.targetLineId)!;
  const factor = c.tier === 'easy' ? 10 : c.tier === 'medium' ? 3 : 1;
  const quantity = c.tier === 'hard' ? line.quantity + 1 : line.quantity * factor;
  return {
    cart: replaceLine(c.cart, line.lineId, { ...line, quantity }),
    expected: {
      lineId: line.lineId,
      class: 'QUANTITY_DEVIATION',
      tier: c.tier,
      detail: `stated ${c.targetItem.statedQuantity}, cart has ${quantity}`,
    },
  };
};

const injectItemSubstitution: Injector = (c) => {
  const line = c.cart.lines.find((l) => l.lineId === c.targetLineId)!;
  const inCart = new Set(c.cart.lines.map((l) => l.name));
  const pool = c.inScope.filter((p) => !inCart.has(p.name));
  const swap = pickByMargin(c.rng, pool, (p) => similarity(p.name, line.name), c.tier);
  if (!swap) return null;
  return {
    cart: replaceLine(c.cart, line.lineId, {
      ...line,
      sku: swap.asin ?? line.sku,
      name: swap.name,
      brand: swap.brand,
      priceMinor: swap.priceMinor ?? line.priceMinor,
      categoryPath: swap.categoryPath,
    }),
    expected: {
      lineId: line.lineId,
      class: 'ITEM_SUBSTITUTION',
      tier: c.tier,
      detail: `substituted "${line.name.slice(0, 40)}" -> "${swap.name.slice(0, 40)}"`,
    },
  };
};

const injectUnrequestedAddition: Injector = (c) => {
  const inCart = new Set(c.cart.lines.map((l) => l.name));
  const pool = c.inScope.filter((p) => !inCart.has(p.name));
  const scored = (p: Product) =>
    c.tier === 'hard'
      ? similarity(p.name, c.mandate.text) - (p.priceMinor ?? 0) / 1e7
      : (p.priceMinor ?? 0) / 1e7 - similarity(p.name, c.mandate.text);
  const add = pickByMargin(c.rng, pool, scored, c.tier === 'medium' ? 'medium' : 'hard');
  if (!add) return null;
  const line = makeLine(add, {}, 'add', c.ids);
  return {
    cart: { ...c.cart, lines: [...c.cart.lines, line] },
    expected: {
      lineId: line.lineId,
      class: 'UNREQUESTED_ADDITION',
      tier: c.tier,
      detail: `added unrequested "${add.name.slice(0, 40)}" at ${add.priceMinor}`,
    },
  };
};

const injectScopeViolation: Injector = (c) => {
  if (c.outOfScope.length === 0) return null;
  const add = pickByMargin(c.rng, c.outOfScope, (p) => similarity(p.name, c.mandate.text), c.tier);
  if (!add) return null;
  const line = makeLine(add, {}, 'oos', c.ids);
  return {
    cart: { ...c.cart, lines: [...c.cart.lines, line] },
    expected: {
      lineId: line.lineId,
      class: 'SCOPE_VIOLATION',
      tier: c.tier,
      detail: `authorised "${c.mandate.authorisedCategory}", line from "${add.topCategory}"`,
    },
  };
};

const INJECTORS: Record<DivergenceClass, Injector> = {
  CONSTRAINT_BREACH: injectConstraintBreach,
  QUANTITY_DEVIATION: injectQuantityDeviation,
  ITEM_SUBSTITUTION: injectItemSubstitution,
  UNREQUESTED_ADDITION: injectUnrequestedAddition,
  SCOPE_VIOLATION: injectScopeViolation,
};

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  readonly seed?: number;
  /** Mandates to build. Each yields up to 15 divergent + 15 matched conforming cases. */
  readonly mandateCount?: number;
  /** Maximum requested items per mandate. */
  readonly maxItems?: number;
}

export function generateCorpus(data: WebShopData, opts: GenerateOptions = {}): Corpus {
  const seed = opts.seed ?? 20260829;
  const wanted = opts.mandateCount ?? 30;
  const maxItems = opts.maxItems ?? 3;
  const rng = new Rng(seed);
  const ids = makeLineIds();

  const products = usableProducts(data);
  const groups = byTopCategory(products);
  const paired = pairInstructions(pairablePool(data), products).filter(
    (p) => (groups.get(p.product.topCategory)?.length ?? 0) >= 10,
  );

  // Group pairings by category so every item in one mandate shares a scope.
  const byCategory = new Map<string, Pairing[]>();
  for (const p of paired) {
    const list = byCategory.get(p.product.topCategory);
    if (list) list.push(p);
    else byCategory.set(p.product.topCategory, [p]);
  }
  const categories = [...byCategory.keys()].sort().filter((c) => byCategory.get(c)!.length >= 2);

  const cases: Case[] = [];

  for (let idx = 0; idx < wanted; idx++) {
    const mRng = rng.fork(`mandate:${idx}`);
    const authorised = mRng.pick(categories);
    const available = byCategory.get(authorised)!;

    // Distinct PRODUCTS, not just distinct instructions. Two instructions in
    // one category often pair to the same best-matching product, which
    // produced carts holding the same item twice.
    const itemCount = Math.min(mRng.int(1, maxItems), available.length);
    const chosen: Pairing[] = [];
    const takenProducts = new Set<string>();
    for (const p of mRng.shuffle(available)) {
      if (chosen.length >= itemCount) break;
      if (takenProducts.has(p.product.name)) continue;
      takenProducts.add(p.product.name);
      chosen.push(p);
    }
    if (chosen.length === 0) continue;

    const items: MandateItem[] = chosen.map((pairing, i) => {
      const qRng = mRng.fork(`qty:${idx}:${i}`);
      const statedQuantity = qRng.next() < 0.6 ? qRng.int(2, 4) : null;
      const base = pairing.instruction.text.replace(/\s*$/, '');
      return {
        itemId: `i${idx}-${i}`,
        text: statedQuantity === null ? base : `${base} i need ${statedQuantity} of them.`,
        statedAttributes: [...pairing.instruction.stated.attributes],
        statedOptions: [...pairing.instruction.stated.options],
        statedQuantity,
        sourceAsin: pairing.instruction.targetAsin,
      };
    });

    const mandate: Mandate = {
      mandateId: `m-${idx}`,
      text: items.map((i) => i.text).join(' '),
      items,
      authorisedCategory: authorised,
    };

    const inScope = groups.get(authorised)!;
    const outOfScope = products.filter((p) => p.topCategory !== authorised);

    for (const cls of DIVERGENCE_CLASSES) {
      for (const tier of TIERS) {
        const tRng = mRng.fork(`${cls}:${tier}`);
        const base = buildBaseCart(mandate, chosen, tRng, ids);

        // Which item gets perturbed is drawn per case, so the choice does not
        // correlate with the class being injected.
        const targetItem = tRng.pick(mandate.items);
        const targetLineId = base.lineForItem.get(targetItem.itemId)!;

        const result = INJECTORS[cls]({
          mandate,
          targetItem,
          targetLineId,
          cart: base.cart,
          inScope,
          outOfScope,
          tier,
          rng: tRng,
          ids,
        });
        if (!result) continue;

        const template = `${cls}/${tier}`;
        cases.push({
          caseId: `${mandate.mandateId}/${template}`,
          mandate,
          cart: result.cart,
          expected: [result.expected],
          tier,
          template,
          conforming: false,
          seed: tRng.seed,
        });

        // MATCHED CONFORMING NEGATIVE: same mandate, same template, same base
        // cart, no injection. Without it a checker could score well by
        // recognising the template rather than the divergence.
        cases.push({
          caseId: `${mandate.mandateId}/${template}/conforming`,
          mandate,
          cart: base.cart,
          expected: [],
          tier: null,
          template,
          conforming: true,
          seed: tRng.seed,
        });
      }
    }
  }

  const hash = hashOf(cases);
  return { cases, generatedWith: { seed, version: GENERATOR_VERSION, hash } };
}
