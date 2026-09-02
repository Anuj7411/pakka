/**
 * Instruction↔product pairing.
 *
 * Whole-repo mutation testing scored this file at 23.8% with 47 surviving
 * LOGIC mutants and only one string mutant — the signature of a module with no
 * tests of its own, exercised only incidentally through the generator.
 *
 * It is the wrong module to leave that way. Pairing decides which
 * (instruction, product) pairs exist, so it decides what the corpus IS, and the
 * corpus is what every published number in this project was measured on. Two
 * changes here have already invalidated three result documents.
 */
import { describe, it, expect } from 'vitest';
import { pairInstructions, pairablePool, MIN_PAIR_SIMILARITY } from '../src/corpus/pairing.js';
import type { Instruction, Product, WebShopData } from '../src/corpus/webshop.js';

function instruction(asin: string, text: string, hasOptions = ['color: blue']): Instruction {
  return {
    targetAsin: asin,
    text,
    stated: { attributes: [], options: [] },
    targetHas: { attributes: [], options: hasOptions },
  };
}

function product(name: string, topCategory = 'Electronics'): Product {
  return {
    asin: name,
    name,
    brand: null,
    topCategory,
    categoryPath: [topCategory],
    priceMinor: 10_000,
    description: '',
  };
}

describe('pairInstructions: what qualifies as a pair', () => {
  it('pairs an instruction with the product that answers it', () => {
    const ins = [instruction('A', 'i want wireless bluetooth headphones')];
    const prods = [product('Wireless Bluetooth Headphones')];
    const pairs = pairInstructions(ins, prods);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.product.name).toBe('Wireless Bluetooth Headphones');
    expect(pairs[0]!.score).toBeGreaterThanOrEqual(MIN_PAIR_SIMILARITY);
  });

  it('chooses the BEST match, not the first acceptable one', () => {
    const ins = [instruction('A', 'i want wireless bluetooth headphones')];
    const prods = [
      product('Bluetooth Speaker Portable'),
      product('Wireless Bluetooth Headphones Over Ear'),
      product('Wireless Mouse'),
    ];
    expect(pairInstructions(ins, prods)[0]!.product.name).toBe(
      'Wireless Bluetooth Headphones Over Ear',
    );
  });

  it('drops a pair below the similarity floor', () => {
    const ins = [instruction('A', 'i want wireless bluetooth headphones')];
    // Shares "headphones" but little else, so Jaccard stays under the floor.
    const prods = [product('Industrial Ear Defenders Safety Headphones Construction Site Grade')];
    expect(pairInstructions(ins, prods, 0.9)).toHaveLength(0);
  });

  it('honours a caller-supplied floor', () => {
    // Not the identical-token product: tokenise strips stopwords, so "i want
    // wireless bluetooth headphones" and "Wireless Bluetooth Headphones" reduce
    // to the SAME set and score exactly 1.0, which no floor can exclude.
    const ins = [instruction('A', 'i want wireless bluetooth headphones')];
    const prods = [product('Wireless Bluetooth Headphones Over Ear Black Edition')];
    expect(pairInstructions(ins, prods, 0.3).length).toBe(1);
    expect(pairInstructions(ins, prods, 0.9).length).toBe(0);
  });

  it('scores an exact token match at 1.0', () => {
    const ins = [instruction('A', 'i want wireless bluetooth headphones')];
    const prods = [product('Wireless Bluetooth Headphones')];
    expect(pairInstructions(ins, prods)[0]!.score).toBe(1);
  });

  it('drops a pair that clears the floor but carries the wrong head noun', () => {
    // The Day 4 failure. "nut free gluten free chocolate" matched almond
    // crackers on three MODIFIERS while the thing asked for matched nothing.
    // Similarity alone cannot see that; the head-noun gate can.
    const ins = [instruction('A', 'i am looking for nut free and gluten free chocolate')];
    const prods = [product('Blue Diamond Almonds Nut Thins Gluten Free Cracker Crisps')];
    expect(pairInstructions(ins, prods, 0.0001)).toHaveLength(0);
  });

  it('skips an instruction with no usable tokens', () => {
    expect(pairInstructions([instruction('A', 'a of the')], [product('Anything')])).toHaveLength(0);
    expect(pairInstructions([instruction('A', '')], [product('Anything')])).toHaveLength(0);
  });

  it('skips a product with no usable tokens', () => {
    const ins = [instruction('A', 'i want wireless bluetooth headphones')];
    expect(pairInstructions(ins, [product('')])).toHaveLength(0);
  });

  it('skips a pair with no shared tokens at all', () => {
    const ins = [instruction('A', 'i want wireless bluetooth headphones')];
    expect(pairInstructions(ins, [product('Garden Trowel Spade')], 0.0001)).toHaveLength(0);
  });

  it('handles empty inputs without throwing', () => {
    expect(pairInstructions([], [product('Thing')])).toEqual([]);
    expect(pairInstructions([instruction('A', 'i want a thing')], [])).toEqual([]);
  });
});

describe('pairInstructions: determinism', () => {
  const ins = [
    instruction('C', 'i want wireless bluetooth headphones'),
    instruction('A', 'i want a usb charging cable'),
    instruction('B', 'i want a carbon fiber tripod'),
  ];
  const prods = [
    product('Wireless Bluetooth Headphones'),
    product('USB Charging Cable'),
    product('Carbon Fiber Tripod'),
  ];

  it('orders by target ASIN, not by input order', () => {
    // Seeding alone must fix the sample. If order depended on input order, a
    // reordered dataset would silently produce a different corpus.
    const asins = pairInstructions(ins, prods).map((p) => p.instruction.targetAsin);
    expect(asins).toEqual([...asins].sort());
  });

  it('gives byte-identical results across calls', () => {
    expect(pairInstructions([...ins], prods)).toEqual(pairInstructions([...ins], prods));
  });
});

describe('pairInstructions: memoisation must not change the answer', () => {
  const ins = [instruction('A', 'i want wireless bluetooth headphones')];
  const prods = [product('Wireless Bluetooth Headphones')];

  it('returns the same result on a repeat call with the same inputs', () => {
    const first = pairInstructions(ins, prods);
    const second = pairInstructions(ins, prods);
    expect(second).toBe(first); // same array identity: the cache was used
  });

  it('recomputes when the threshold differs', () => {
    // The cache key includes the threshold. Without that, the second call would
    // silently return results computed under the first one's floor.
    const partial = [product('Wireless Bluetooth Headphones Over Ear Black Edition')];
    const loose = pairInstructions(ins, partial, 0.3);
    const strict = pairInstructions(ins, partial, 0.9);
    expect(loose).not.toBe(strict);
    expect(loose.length).toBe(1);
    expect(strict.length).toBe(0);
  });

  it('recomputes when the product set differs in size', () => {
    const one = pairInstructions(ins, prods);
    const two = pairInstructions(ins, [...prods, product('Wireless Bluetooth Headphones Pro Max')]);
    expect(two).not.toBe(one);
  });

  it('is keyed on the identity of the instruction array', () => {
    // A structurally equal but distinct array is a different cache entry, which
    // is correct: the WeakMap cannot collide two genuinely different inputs.
    const copy = [instruction('A', 'i want wireless bluetooth headphones')];
    expect(pairInstructions(copy, prods)).not.toBe(pairInstructions(ins, prods));
    expect(pairInstructions(copy, prods)).toEqual(pairInstructions(ins, prods));
  });
});

describe('pairablePool', () => {
  const withOptions = instruction('A', 'i want headphones', ['color: blue']);
  const withoutOptions = instruction('B', 'i want a tripod', []);
  const data = {} as WebShopData;
  const rich = () => [withOptions, withoutOptions];

  it('keeps only instructions that declare options on their target', () => {
    // An instruction whose target declares nothing cannot support a
    // CONSTRAINT_BREACH case, so it is not pairable.
    const pool = pairablePool(data, rich);
    expect(pool.map((i) => i.targetAsin)).toEqual(['A']);
  });

  it('memoises on the corpus, so the pairing cache is not missed', () => {
    // Composing this inline would allocate a fresh array each call, miss the
    // identity-keyed pairing cache, and silently reintroduce the full
    // 9,605 x 804 comparison every time.
    expect(pairablePool(data, rich)).toBe(pairablePool(data, rich));
  });

  it('keys on the data object, not on the function', () => {
    const other = {} as WebShopData;
    expect(pairablePool(other, rich)).not.toBe(pairablePool(data, rich));
  });
});
