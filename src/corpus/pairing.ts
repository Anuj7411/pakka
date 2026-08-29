/**
 * Instruction↔product pairing.
 *
 * Our 804-product subset shares only 4 ASINs with the instruction set, so a
 * target line chosen by category alone was routinely unrelated to the request
 * — a mandate for "icing glitter" with a dining table as its target. Ground
 * truth stayed exact, but a CONFORMING case that looks nothing like its
 * mandate is not conforming in any sense a semantic judge would accept, and it
 * would have poisoned the Day 4 evaluation.
 *
 * Pairing above a similarity floor fixes realism and scope coherence at once:
 * the authorised category is then simply the matched product's own.
 */
import type { WebShopData, Instruction, Product } from './webshop.js';
import { tokenise } from './similarity.js';

/**
 * Minimum instruction↔product similarity for a pairing to be usable.
 *
 * Measured, not guessed. Across 9,605 rich instructions and 804 products:
 *   >= 0.30 : 145    >= 0.25 : 514    >= 0.20 : 1,570    >= 0.15 : 4,016
 *
 * 0.20 was chosen by inspecting pairs at the boundary — e.g. "gold plated,
 * high speed hdmi cable" paired with "QualGear High Speed HDMI 2.0 Cable with
 * Ethernet". Those are genuine matches, and it leaves 1,570 candidates, far
 * more than any corpus we need.
 */
export const MIN_PAIR_SIMILARITY = 0.2;

export interface Pairing {
  readonly instruction: Instruction;
  readonly product: Product;
  readonly score: number;
}

/**
 * Memoised on the IDENTITY of the input arrays, not on a derived key.
 *
 * A key built from length plus endpoint ids would be cheaper but could collide
 * for two genuinely different inputs; a WeakMap cannot. It also lets entries be
 * collected when the corpus goes out of scope.
 */
const pairCache = new WeakMap<readonly Instruction[], Map<string, Pairing[]>>();

export function pairInstructions(
  instructions: readonly Instruction[],
  products: readonly Product[],
  minScore = MIN_PAIR_SIMILARITY,
): Pairing[] {
  // The full comparison is 9,605 x 804. Repeated generation in one process
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
  // Tokenise each product once: the naive form re-tokenises inside an
  // O(n*m) loop.
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

/**
 * Instructions that can be paired at all, memoised on the corpus.
 *
 * Must be memoised on `data`, not composed inline: an inline
 * `richInstructions(data).filter(...)` allocates a fresh array on every call,
 * which misses the identity-keyed pairing cache and silently reintroduces the
 * full comparison each time.
 */
const poolCache = new WeakMap<WebShopData, readonly Instruction[]>();

export function pairablePool(
  data: WebShopData,
  richInstructions: (d: WebShopData) => readonly Instruction[],
): readonly Instruction[] {
  const cached = poolCache.get(data);
  if (cached) return cached;
  const computed = richInstructions(data).filter((i) => i.targetHas.options.length > 0);
  poolCache.set(data, computed);
  return computed;
}
