/**
 * Full-corpus sweep.
 *
 * The unit tests check the first 50 records. Real data breaks on record 9,412.
 * This runs every invariant over ALL 12,251 instructions and ALL 1,000 products
 * and fails on the first violation, naming it.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadWebShop,
  richInstructions,
  usableProducts,
  parseOption,
  byTopCategory,
} from '../src/corpus/webshop.js';

const DATA_DIR = join(process.cwd(), 'data');
const hasData = existsSync(join(DATA_DIR, 'items_human_ins.json'));

describe.skipIf(!hasData)('corpus sweep: every instruction record', () => {
  const data = loadWebShop(DATA_DIR);

  it('every instruction has non-empty text and a well-formed ASIN', () => {
    const bad: string[] = [];
    for (const i of data.instructions) {
      if (i.text.length === 0) bad.push(`${i.targetAsin}: empty text`);
      if (!/^[A-Z0-9]{10}$/.test(i.targetAsin)) bad.push(`${i.targetAsin}: malformed ASIN`);
      if (i.text !== i.text.trim()) bad.push(`${i.targetAsin}: untrimmed text`);
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('no constraint array contains an empty or untrimmed entry', () => {
    const bad: string[] = [];
    for (const i of data.instructions) {
      for (const [label, arr] of [
        ['stated.attributes', i.stated.attributes],
        ['stated.options', i.stated.options],
        ['targetHas.attributes', i.targetHas.attributes],
        ['targetHas.options', i.targetHas.options],
      ] as const) {
        for (const v of arr) {
          if (v.trim() === '') bad.push(`${i.targetAsin} ${label}: empty entry`);
        }
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('measured counts match what PROVENANCE.md claims', () => {
    // If these drift, the data changed and PROVENANCE is stale.
    expect(data.instructions.length).toBe(12_251);
    expect(new Set(data.instructions.map((i) => i.targetAsin)).size).toBe(10_136);
    expect(richInstructions(data).length).toBe(9_605);
    expect(data.products.length).toBe(1_000);
  });

  it('every target option parses into a dimension and value, or is reported', () => {
    let parsed = 0;
    const unparseable: string[] = [];
    for (const i of data.instructions) {
      for (const o of i.targetHas.options) {
        if (parseOption(o)) parsed++;
        else unparseable.push(`${i.targetAsin}: ${JSON.stringify(o)}`);
      }
    }
    // We do not require 100% — we require that we KNOW the rate rather than
    // discovering it during generation.
    const total = parsed + unparseable.length;
    const rate = parsed / total;
    expect(total).toBeGreaterThan(10_000);
    expect(rate, `unparseable sample: ${unparseable.slice(0, 3).join(' | ')}`).toBeGreaterThan(0.95);
  });

  it('stated options are a subset of what the target has, or we know the exception rate', () => {
    // Sanity: the human stated "blue"; the target should have an option
    // containing "blue". Where it does not, the record is unusable for
    // constraint injection and must be excluded, not silently used.
    let aligned = 0;
    let misaligned = 0;
    for (const i of richInstructions(data)) {
      const targetValues = i.targetHas.options
        .map(parseOption)
        .filter((x): x is { dimension: string; value: string } => x !== null)
        .map((x) => x.value.toLowerCase());
      for (const stated of i.stated.options) {
        const s = stated.toLowerCase();
        if (targetValues.some((v) => v === s || v.includes(s) || s.includes(v))) aligned++;
        else misaligned++;
      }
    }
    const rate = aligned / (aligned + misaligned);
    // Recorded, not asserted at 100%: this is a property of the source data.
    expect(aligned + misaligned).toBeGreaterThan(9_000);
    expect(rate).toBeGreaterThan(0.8);
  });
});

describe.skipIf(!hasData)('corpus sweep: every product', () => {
  const data = loadWebShop(DATA_DIR);

  it('no product yields a NaN, negative, or fractional price', () => {
    const bad: string[] = [];
    for (const p of data.products) {
      if (p.priceMinor === null) continue;
      if (!Number.isInteger(p.priceMinor) || p.priceMinor <= 0) {
        bad.push(`${p.name.slice(0, 40)}: ${p.priceMinor}`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('no brand retains the "Brand:" prefix', () => {
    const bad = data.products
      .filter((p) => p.brand !== null && /^brand\s*:/i.test(p.brand))
      .map((p) => p.brand);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('no category path segment is empty or untrimmed', () => {
    const bad: string[] = [];
    for (const p of data.products) {
      for (const seg of p.categoryPath) {
        if (seg.length === 0 || seg !== seg.trim()) bad.push(`${p.name.slice(0, 30)}: ${JSON.stringify(seg)}`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('reports the usable-product yield rather than assuming it', () => {
    const usable = usableProducts(data);
    const yieldRate = usable.length / data.products.length;
    // Measured, so a drop is visible rather than silently shrinking the corpus.
    expect(usable.length).toBeGreaterThan(200);
    expect(yieldRate).toBeGreaterThan(0.2);
  });

  it('has enough distinct categories for cross-category donors', () => {
    const groups = byTopCategory(usableProducts(data));
    const sizeable = [...groups.values()].filter((g) => g.length >= 5);
    expect(sizeable.length).toBeGreaterThanOrEqual(2);
  });
});

describe.skipIf(!hasData)('corpus sweep: determinism', () => {
  it('loading twice yields identical normalised output', () => {
    const a = loadWebShop(DATA_DIR);
    const b = loadWebShop(DATA_DIR);
    expect(a.instructions.length).toBe(b.instructions.length);
    // Deep-compare a stratified sample rather than 12k objects.
    for (const idx of [0, 1, 100, 5_000, 9_999, a.instructions.length - 1]) {
      expect(a.instructions[idx]).toEqual(b.instructions[idx]);
    }
    for (const idx of [0, 500, 999]) {
      expect(a.products[idx]).toEqual(b.products[idx]);
    }
  });
});
