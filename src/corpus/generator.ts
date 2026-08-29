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
  type Instruction,
  type Product,
  richInstructions,
  usableProducts,
  byTopCategory,
  parseOption,
} from './webshop.js';
import { Rng } from './rng.js';
import { hashOf } from '../normalise/canonical.js';
import { DIVERGENCE_CLASSES, type DivergenceClass } from '../taxonomy/classes.js';
import {
  TIERS,
  type Tier,
  type Mandate,
  type Cart,
  type CartLine,
  type Case,
  type Corpus,
  type ExpectedDivergence,
} from './types.js';

export const GENERATOR_VERSION = 1;

// ---------------------------------------------------------------------------
// Similarity — drives the hard tier across every class
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'with', 'of', 'in', 'to', 'i', 'am',
  'is', 'my', 'me', 'looking', 'need', 'want', 'would', 'like', 'get', 'buy',
  'that', 'are', 'be', 'it', 'this', 'some',
]);

export function tokenise(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/** Jaccard overlap in [0, 1]. 0 when either side is empty. */
export function similarity(a: string, b: string): number {
  const A = new Set(tokenise(a));
  const B = new Set(tokenise(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
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
  const ranked = [...pool].sort((x, y) => score(y) - score(x)); // most similar first
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
 * The conforming cart: one target line carrying the instruction's stated
 * properties, plus 0-2 filler lines that satisfy nothing but violate nothing.
 *
 * The target line's product is drawn from the authorised category so the cart
 * is realistic; its options and attributes come from the instruction's own
 * target record, so conformance is grounded rather than asserted.
 */
function buildBaseCart(
  ins: Instruction,
  mandate: Mandate,
  targetProduct: Product,
  inScope: readonly Product[],
  rng: Rng,
  ids: LineIds,
): { cart: Cart; targetLineId: string } {
  const target = makeLine(
    targetProduct,
    {
      options: [...ins.targetHas.options],
      attributes: [...ins.targetHas.attributes],
      quantity: 1,
    },
    'tgt',
    ids,
  );

  const fillerCount = rng.int(0, 2);
  const fillers: CartLine[] = [];
  for (let i = 0; i < fillerCount; i++) {
    const p = rng.pickOther(inScope, (q) => q.name === targetProduct.name);
    if (p) fillers.push(makeLine(p, {}, 'fil', ids));
  }

  return {
    cart: { cartId: `cart-${mandate.mandateId}`, lines: rng.shuffle([target, ...fillers]) },
    targetLineId: target.lineId,
  };
}

function replaceLine(cart: Cart, lineId: string, next: CartLine): Cart {
  return { ...cart, lines: cart.lines.map((l) => (l.lineId === lineId ? next : l)) };
}

// ---------------------------------------------------------------------------
// Injectors — one per class, each tier-aware
// ---------------------------------------------------------------------------

interface InjectContext {
  readonly ins: Instruction;
  readonly mandate: Mandate;
  readonly cart: Cart;
  readonly targetLineId: string;
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

/** A value on the same dimension that is definitely different. */
function alternativeValue(dimension: string, current: string, rng: Rng): string {
  const pool = (ALT_VALUES[dimension] ?? ALT_VALUES['color']!).filter(
    (v) => v.toLowerCase() !== current.toLowerCase(),
  );
  return rng.pick(pool);
}

const injectConstraintBreach: Injector = (c) => {
  const line = c.cart.lines.find((l) => l.lineId === c.targetLineId)!;

  if (c.tier === 'hard') {
    // Prose-level: silently drop a stated ATTRIBUTE. No field changes value,
    // so a field-comparison checker sees nothing.
    const stated = c.ins.stated.attributes;
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

  // easy/medium: change a stated OPTION value on its own dimension.
  const parsed = line.options
    .map((o) => ({ raw: o, p: parseOption(o) }))
    .filter((x): x is { raw: string; p: { dimension: string; value: string } } => x.p !== null);
  const statedLower = c.ins.stated.options.map((s) => s.toLowerCase());
  const hit = parsed.find((x) =>
    statedLower.some((s) => x.p.value.toLowerCase() === s || x.p.value.toLowerCase().includes(s)),
  );
  if (!hit) return null;

  const replacement = alternativeValue(hit.p.dimension, hit.p.value, c.rng);
  const options = line.options.map((o) =>
    o === hit.raw ? `${hit.p.dimension}: ${replacement}` : o,
  );

  // easy also strips a stated attribute, so two signals point the same way.
  const attrs =
    c.tier === 'easy' && c.ins.stated.attributes.length > 0
      ? line.attributes.filter(
          (a) => a.toLowerCase() !== c.ins.stated.attributes[0]!.toLowerCase(),
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
  const line = c.cart.lines.find((l) => l.lineId === c.targetLineId)!;
  const factor = c.tier === 'easy' ? 10 : c.tier === 'medium' ? 3 : 1;
  const quantity = c.tier === 'hard' ? line.quantity + 1 : line.quantity * factor;
  return {
    cart: replaceLine(c.cart, line.lineId, { ...line, quantity }),
    expected: {
      lineId: line.lineId,
      class: 'QUANTITY_DEVIATION',
      tier: c.tier,
      detail: `quantity ${line.quantity} -> ${quantity}`,
    },
  };
};

const injectItemSubstitution: Injector = (c) => {
  const line = c.cart.lines.find((l) => l.lineId === c.targetLineId)!;
  const pool = c.inScope.filter((p) => p.name !== line.name);
  // hard = most similar name (an adjacent variant); easy = least similar.
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
  // hard = cheap and plausible (small margin); easy = expensive and unrelated.
  const scored = (p: Product) =>
    c.tier === 'hard'
      ? similarity(p.name, c.ins.text) - (p.priceMinor ?? 0) / 1e7
      : (p.priceMinor ?? 0) / 1e7 - similarity(p.name, c.ins.text);
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
  // hard = an out-of-scope product whose name looks like it belongs to the
  // mandate; easy = obviously foreign.
  const add = pickByMargin(c.rng, c.outOfScope, (p) => similarity(p.name, c.ins.text), c.tier);
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
// Scope assignment
// ---------------------------------------------------------------------------

/**
 * Minimum instruction↔product similarity for a pairing to be usable.
 *
 * Measured, not guessed. Across 9,605 rich instructions and 804 products:
 *   >= 0.30 : 145    >= 0.25 : 514    >= 0.20 : 1,570    >= 0.15 : 4,016
 *
 * 0.20 was chosen by inspecting pairs at the boundary — e.g. "gold plated,
 * high speed hdmi cable" paired with "QualGear High Speed HDMI 2.0 Cable with
 * Ethernet". Those are genuine matches. It leaves 1,570 candidates, far more
 * than any corpus we need.
 */
export const MIN_PAIR_SIMILARITY = 0.2;

export interface Pairing {
  readonly instruction: Instruction;
  readonly product: Product;
  readonly score: number;
}

/**
 * Pair each instruction with the catalogue product that best answers it.
 *
 * Why this exists: our 804-product subset shares only 4 ASINs with the
 * instruction set, so a target line chosen by category alone was frequently
 * unrelated to the request — a mandate for "icing glitter" with a dining table
 * as its target. Ground truth stayed exact, but a CONFORMING case that looks
 * nothing like the mandate is not conforming in any sense a semantic judge
 * would accept, and it would have poisoned the Day 4 evaluation.
 *
 * Pairing above a similarity floor fixes both realism and scope coherence at
 * once: the authorised category is then simply the matched product's own.
 *
 * Deterministic and RNG-free.
 */
/**
 * Memoised on the IDENTITY of the input arrays, not on a derived key.
 *
 * A key built from length plus endpoint ids would be cheaper but could collide
 * for two genuinely different inputs; a WeakMap cannot. It also lets the
 * entries be collected when the corpus arrays go out of scope.
 */
const pairCache = new WeakMap<readonly Instruction[], Map<string, Pairing[]>>();

export function pairInstructions(
  instructions: readonly Instruction[],
  products: readonly Product[],
  minScore = MIN_PAIR_SIMILARITY,
): Pairing[] {
  // 9,605 x 804 comparisons take ~2.5s. Repeated generation in one process
  // (tests, seed sweeps, the eval harness) should pay that once.
  let byOpts = pairCache.get(instructions);
  if (!byOpts) {
    byOpts = new Map();
    pairCache.set(instructions, byOpts);
  }
  const key = `${products.length}:${minScore}`;
  const cached = byOpts.get(key);
  if (cached) return cached;

  const computed = computePairings(instructions, products, minScore);
  byOpts.set(key, computed);
  return computed;
}

function computePairings(
  instructions: readonly Instruction[],
  products: readonly Product[],
  minScore: number,
): Pairing[] {
  // Tokenise each product once: the naive form is O(n*m) tokenisations and
  // this loop is 9,605 x 804.
  const productTokens = products.map((p) => new Set(tokenise(p.name)));
  const out: Pairing[] = [];

  for (const instruction of instructions) {
    const iTokens = new Set(tokenise(instruction.text));
    if (iTokens.size === 0) continue;

    let best: Product | null = null;
    let bestScore = 0;
    for (let i = 0; i < products.length; i++) {
      const pTokens = productTokens[i]!;
      if (pTokens.size === 0) continue;
      let inter = 0;
      for (const t of iTokens) if (pTokens.has(t)) inter++;
      if (inter === 0) continue;
      const score = inter / (iTokens.size + pTokens.size - inter);
      if (score > bestScore) {
        bestScore = score;
        best = products[i]!;
      }
    }
    if (best && bestScore >= minScore) {
      out.push({ instruction, product: best, score: bestScore });
    }
  }
  // Stable order regardless of input order, so seeding alone fixes the sample.
  out.sort((a, b) => (a.instruction.targetAsin < b.instruction.targetAsin ? -1 : 1));
  return out;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  readonly seed?: number;
  /** Instructions to draw from. Each yields up to 15 divergent + 15 matched conforming cases. */
  readonly instructionCount?: number;
}

/**
 * Instructions that can be paired at all, memoised on the corpus.
 *
 * This must be memoised on `data`, not composed inline: an inline
 * `richInstructions(data).filter(...)` allocates a fresh array on every call,
 * which misses the identity-keyed pairing cache and silently reintroduces the
 * full 9,605 x 804 comparison each time. Caching richInstructions alone was not
 * enough, because the filter downstream of it produced the new array.
 */
const poolCache = new WeakMap<WebShopData, readonly Instruction[]>();

export function pairablePool(data: WebShopData): readonly Instruction[] {
  const cached = poolCache.get(data);
  if (cached) return cached;
  const computed = richInstructions(data).filter((i) => i.targetHas.options.length > 0);
  poolCache.set(data, computed);
  return computed;
}

export function generateCorpus(data: WebShopData, opts: GenerateOptions = {}): Corpus {
  const seed = opts.seed ?? 20260829;
  const wanted = opts.instructionCount ?? 30;
  const rng = new Rng(seed);
  const ids = makeLineIds();

  const products = usableProducts(data);
  const groups = byTopCategory(products);

  const pool = pairablePool(data);
  // Pair first, then sample. Only instructions the catalogue can actually
  // answer are usable, and the pairing fixes both realism and scope coherence.
  const paired = pairInstructions(pool, products).filter(
    (p) => (groups.get(p.product.topCategory)?.length ?? 0) >= 10,
  );
  const chosen = rng.shuffle(paired).slice(0, wanted);

  const cases: Case[] = [];

  for (const [idx, pairing] of chosen.entries()) {
    const ins = pairing.instruction;
    const insRng = rng.fork(`ins:${ins.targetAsin}:${idx}`);

    // Scope is the matched product's own category, so the mandate, the target
    // line and the authorised scope are coherent by construction rather than
    // by a second similarity search.
    const authorised = pairing.product.topCategory;
    const inScope = groups.get(authorised)!;
    const outOfScope = products.filter((p) => p.topCategory !== authorised);

    const mandate: Mandate = {
      mandateId: `m-${idx}-${ins.targetAsin}`,
      text: ins.text,
      statedAttributes: [...ins.stated.attributes],
      statedOptions: [...ins.stated.options],
      authorisedCategory: authorised,
      sourceAsin: ins.targetAsin,
    };

    for (const cls of DIVERGENCE_CLASSES) {
      for (const tier of TIERS) {
        const tRng = insRng.fork(`${cls}:${tier}`);
        const base = buildBaseCart(ins, mandate, pairing.product, inScope, tRng, ids);
        const result = INJECTORS[cls]({
          ins,
          mandate,
          cart: base.cart,
          targetLineId: base.targetLineId,
          inScope,
          outOfScope,
          tier,
          rng: tRng,
          ids,
        });
        if (!result) continue; // injection not applicable to this record

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
        // cart, no injection. Controls for template artefacts — without it, a
        // classifier could score well by recognising the template rather than
        // the divergence.
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
