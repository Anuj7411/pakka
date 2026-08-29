import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadWebShop, usableProducts, richInstructions } from '../src/corpus/webshop.js';
import {
  generateCorpus,
  similarity,
  tokenise,
  pairInstructions,
  MIN_PAIR_SIMILARITY,
} from '../src/corpus/generator.js';
import { Rng } from '../src/corpus/rng.js';
import { DIVERGENCE_CLASSES } from '../src/taxonomy/classes.js';
import { TIERS } from '../src/corpus/types.js';

const DATA_DIR = join(process.cwd(), 'data');
const hasData = existsSync(join(DATA_DIR, 'items_human_ins.json'));

// Loaded ONCE. The pairing cache keys on array identity, so a per-describe
// load would recompute 9,605 x 804 comparisons three times over.
const DATA = hasData ? loadWebShop(DATA_DIR) : null;

describe('rng: determinism', () => {
  it('same seed yields the same sequence', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 200; i++) expect(a.next()).toBe(b.next());
  });

  it('different seeds diverge', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    const seqA = Array.from({ length: 50 }, () => a.next());
    const seqB = Array.from({ length: 50 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it('int() stays within bounds inclusive', () => {
    const r = new Rng(7);
    for (let i = 0; i < 5000; i++) {
      const v = r.int(3, 9);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(9);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('int(n, n) is n', () => {
    expect(new Rng(1).int(5, 5)).toBe(5);
  });

  it('rejects an inverted range rather than looping oddly', () => {
    expect(() => new Rng(1).int(9, 3)).toThrow(RangeError);
  });

  it('rejects a non-integer seed', () => {
    expect(() => new Rng(1.5)).toThrow(TypeError);
  });

  it('pick throws on an empty array instead of returning undefined', () => {
    expect(() => new Rng(1).pick([])).toThrow(RangeError);
  });

  it('shuffle never mutates its input and preserves multiset', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const frozen = [...input];
    const out = new Rng(3).shuffle(input);
    expect(input).toEqual(frozen);
    expect([...out].sort()).toEqual([...input].sort());
  });

  it('fork is deterministic and label-sensitive', () => {
    const base = new Rng(11);
    expect(base.fork('a').seed).toBe(new Rng(11).fork('a').seed);
    expect(base.fork('a').seed).not.toBe(base.fork('b').seed);
  });
});

describe('similarity', () => {
  it('drops stopwords and short tokens', () => {
    expect(tokenise('i am looking for a blue wireless headphone')).toEqual([
      'blue',
      'wireless',
      'headphone',
    ]);
  });

  it('is 0 against an empty side and 1 against itself', () => {
    expect(similarity('', 'anything')).toBe(0);
    expect(similarity('the a of', 'blue headphones')).toBe(0);
    expect(similarity('blue headphones', 'blue headphones')).toBe(1);
  });

  it('is symmetric and bounded', () => {
    const pairs = [
      ['blue wireless headphones', 'wireless headphone blue'],
      ['spring coil mattress', 'Spring Coil 1 Mattress, Queen'],
      ['carbon fiber tripod', 'kitchen cart white'],
    ];
    for (const [a, b] of pairs) {
      const s = similarity(a!, b!);
      expect(s).toBe(similarity(b!, a!));
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it('ranks a real match above an unrelated product', () => {
    const text = 'i am looking for a carbon fiber tripod.';
    expect(similarity('Leupold, Tripod, Carbon Fiber Kit', text)).toBeGreaterThan(
      similarity('Seacrest White Kitchen Cart by Linon', text),
    );
  });
});

describe.skipIf(!hasData)('generator: corpus', () => {
  const data = DATA!;
  const corpus = generateCorpus(data, { seed: 20260829, instructionCount: 30 });
  const divergent = corpus.cases.filter((c) => !c.conforming);
  const conforming = corpus.cases.filter((c) => c.conforming);

  it('is reproducible from the seed', () => {
    const again = generateCorpus(data, { seed: 20260829, instructionCount: 30 });
    expect(again.generatedWith.hash).toBe(corpus.generatedWith.hash);
    expect(again.cases.length).toBe(corpus.cases.length);
  });

  it('changes with the seed', () => {
    const other = generateCorpus(data, { seed: 99, instructionCount: 30 });
    expect(other.generatedWith.hash).not.toBe(corpus.generatedWith.hash);
  });

  it('pins a corpus hash', () => {
    expect(corpus.generatedWith.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('produces a matched conforming negative for EVERY divergent case', () => {
    // Without matched negatives a checker could score well by recognising the
    // template rather than the divergence.
    expect(conforming.length).toBe(divergent.length);
    for (const d of divergent) {
      const mate = conforming.find(
        (c) => c.mandate.mandateId === d.mandate.mandateId && c.template === d.template,
      );
      expect(mate, `no matched negative for ${d.caseId}`).toBeDefined();
    }
  });

  it('covers every class at every tier', () => {
    for (const cls of DIVERGENCE_CLASSES) {
      for (const tier of TIERS) {
        const n = divergent.filter((c) => c.template === `${cls}/${tier}`).length;
        expect(n, `${cls}/${tier} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it('labels conforming cases with no expected divergence and no tier', () => {
    for (const c of conforming) {
      expect(c.expected).toEqual([]);
      expect(c.tier).toBeNull();
    }
  });

  it('every expected divergence points at a line that exists in its cart', () => {
    for (const c of divergent) {
      for (const e of c.expected) {
        const line = c.cart.lines.find((l) => l.lineId === e.lineId);
        expect(line, `${c.caseId}: expected line ${e.lineId} missing`).toBeDefined();
      }
    }
  });

  it('every divergent case declares exactly one divergence with a matching tier', () => {
    for (const c of divergent) {
      expect(c.expected).toHaveLength(1);
      expect(c.expected[0]!.tier).toBe(c.tier);
      expect(c.template).toBe(`${c.expected[0]!.class}/${c.tier}`);
    }
  });

  it('every line has a sane price and quantity', () => {
    for (const c of corpus.cases) {
      for (const l of c.cart.lines) {
        expect(Number.isInteger(l.priceMinor)).toBe(true);
        expect(l.priceMinor).toBeGreaterThan(0);
        expect(Number.isInteger(l.quantity)).toBe(true);
        expect(l.quantity).toBeGreaterThan(0);
      }
    }
  });

  it('gives every line in a cart a unique id', () => {
    for (const c of corpus.cases) {
      const ids = c.cart.lines.map((l) => l.lineId);
      expect(new Set(ids).size, `${c.caseId} has duplicate line ids`).toBe(ids.length);
    }
  });

  it('assigns a scope the mandate can actually be served from', () => {
    // The scope is the matched product's category, so the conforming cart's
    // target line must lie inside it.
    for (const c of conforming) {
      const target = c.cart.lines.find((l) => l.lineId.startsWith('tgt'));
      expect(target).toBeDefined();
      expect(target!.categoryPath[0]).toBe(c.mandate.authorisedCategory);
    }
  });

  it('puts the scope-violating line OUTSIDE the authorised category', () => {
    for (const c of divergent.filter((x) => x.expected[0]!.class === 'SCOPE_VIOLATION')) {
      const line = c.cart.lines.find((l) => l.lineId === c.expected[0]!.lineId)!;
      expect(line.categoryPath[0]).not.toBe(c.mandate.authorisedCategory);
    }
  });
});

describe.skipIf(!hasData)('generator: difficulty is graded, not merely labelled', () => {
  const data = DATA!;
  const corpus = generateCorpus(data, { seed: 20260829, instructionCount: 30 });
  const divergent = corpus.cases.filter((c) => !c.conforming);

  it('quantity margins are ordered easy > medium > hard', () => {
    const factorFor = (tier: string): number[] =>
      divergent
        .filter((c) => c.template === `QUANTITY_DEVIATION/${tier}`)
        .map((c) => c.cart.lines.find((l) => l.lineId === c.expected[0]!.lineId)!.quantity);
    const easy = factorFor('easy');
    const medium = factorFor('medium');
    const hard = factorFor('hard');
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    // x10, x3, +1 from a base quantity of 1.
    expect(mean(easy)).toBeGreaterThan(mean(medium));
    expect(mean(medium)).toBeGreaterThan(mean(hard));
    expect(hard.every((q) => q === 2)).toBe(true);
  });

  it('substitution margins narrow as difficulty rises', () => {
    // Hard substitutions replace a product with a more similar one, so the
    // detection margin is smaller. This asserts the tier means something.
    const meanSim = (tier: string): number => {
      const vals: number[] = [];
      for (const c of divergent.filter((x) => x.template === `ITEM_SUBSTITUTION/${tier}`)) {
        const swapped = c.cart.lines.find((l) => l.lineId === c.expected[0]!.lineId)!;
        const mate = corpus.cases.find(
          (x) => x.conforming && x.mandate.mandateId === c.mandate.mandateId && x.template === c.template,
        )!;
        const original = mate.cart.lines.find((l) => l.lineId === c.expected[0]!.lineId);
        if (original) vals.push(similarity(original.name, swapped.name));
      }
      return vals.reduce((s, v) => s + v, 0) / Math.max(1, vals.length);
    };
    expect(meanSim('hard')).toBeGreaterThan(meanSim('easy'));
  });

  it('hard scope violations look more like the mandate than easy ones', () => {
    const meanSim = (tier: string): number => {
      const vals = divergent
        .filter((c) => c.template === `SCOPE_VIOLATION/${tier}`)
        .map((c) => {
          const line = c.cart.lines.find((l) => l.lineId === c.expected[0]!.lineId)!;
          return similarity(line.name, c.mandate.text);
        });
      return vals.reduce((s, v) => s + v, 0) / Math.max(1, vals.length);
    };
    expect(meanSim('hard')).toBeGreaterThan(meanSim('easy'));
  });
});

describe.skipIf(!hasData)('generator: pairing', () => {
  const data = DATA!;

  it('only pairs instructions the catalogue can actually answer', () => {
    const pairs = pairInstructions(richInstructions(data), usableProducts(data));
    expect(pairs.length).toBeGreaterThan(500);
    for (const p of pairs) {
      expect(p.score).toBeGreaterThanOrEqual(MIN_PAIR_SIMILARITY);
      expect(similarity(p.product.name, p.instruction.text)).toBeCloseTo(p.score, 10);
    }
  });

  it('is deterministic and order-stable', () => {
    const products = usableProducts(data);
    const ins = richInstructions(data).slice(0, 400);
    const a = pairInstructions(ins, products);
    const b = pairInstructions([...ins].reverse(), products);
    expect(a.map((p) => p.instruction.targetAsin)).toEqual(b.map((p) => p.instruction.targetAsin));
  });

  it('a higher threshold yields a subset', () => {
    const products = usableProducts(data);
    const ins = richInstructions(data).slice(0, 800);
    const loose = new Set(pairInstructions(ins, products, 0.15).map((p) => p.instruction.targetAsin));
    const tight = pairInstructions(ins, products, 0.3);
    for (const p of tight) expect(loose.has(p.instruction.targetAsin)).toBe(true);
  });
});
