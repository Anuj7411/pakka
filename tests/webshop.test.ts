import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadWebShop,
  richInstructions,
  usableProducts,
  byTopCategory,
  parsePriceMinor,
  cleanBrand,
  parseCategory,
  parseOption,
  normaliseInstruction,
} from '../src/corpus/webshop.js';

const DATA_DIR = join(process.cwd(), 'data');
const hasData = existsSync(join(DATA_DIR, 'items_human_ins.json'));

describe('webshop: pure parsers', () => {
  it('parses prices to minor units', () => {
    expect(parsePriceMinor('$877.80')).toBe(87780);
    expect(parsePriceMinor('$1,234.00')).toBe(123400);
    expect(parsePriceMinor('12')).toBe(1200);
  });

  it('refuses unusable prices rather than guessing', () => {
    expect(parsePriceMinor('')).toBeNull();
    expect(parsePriceMinor(undefined)).toBeNull();
    expect(parsePriceMinor('N/A')).toBeNull();
    expect(parsePriceMinor('$0.00')).toBeNull();
    // A range is not a price. Silently taking the first number would put a
    // wrong figure into money arithmetic.
    expect(parsePriceMinor('$10.00 - $20.00')).toBeNull();
  });

  it('strips the Brand: prefix', () => {
    expect(cleanBrand('Brand: Vhomes Lights')).toBe('Vhomes Lights');
    expect(cleanBrand('brand:  TYX ')).toBe('TYX');
    expect(cleanBrand('')).toBeNull();
    expect(cleanBrand(undefined)).toBeNull();
  });

  it('splits the hierarchical category path', () => {
    const p = parseCategory('Home & Kitchen › Furniture › Tables');
    expect(p).toEqual(['Home & Kitchen', 'Furniture', 'Tables']);
    expect(parseCategory('')).toEqual([]);
  });

  it('splits options into dimension and value', () => {
    expect(parseOption('color: blue')).toEqual({ dimension: 'color', value: 'blue' });
    expect(parseOption('size: 12 inch (pack of 1)')).toEqual({
      dimension: 'size',
      value: '12 inch (pack of 1)',
    });
    expect(parseOption('')).toBeNull();
    expect(parseOption('novalue:')).toBeNull();
  });

  it('drops the empty-string sentinel the source uses for "no options"', () => {
    const i = normaliseInstruction({
      asin: 'X',
      instruction: 'test',
      attributes: ['a', ''],
      options: [''],
      instruction_attributes: ['a'],
      instruction_options: [],
    });
    expect(i.targetHas.options).toEqual([]);
    expect(i.targetHas.attributes).toEqual(['a']);
  });
});

describe.skipIf(!hasData)('webshop: real data', () => {
  const data = loadWebShop(DATA_DIR);

  it('loads the full instruction pool', () => {
    // Verified by inspection: 12,251 records across 10,136 ASINs.
    expect(data.instructions.length).toBeGreaterThan(12_000);
    expect(data.products.length).toBe(1000);
  });

  it('instructions carry real human text and real stated constraints', () => {
    const withBoth = richInstructions(data);
    // Verified by inspection: 9,605.
    expect(withBoth.length).toBeGreaterThan(9_000);
    for (const i of withBoth.slice(0, 50)) {
      expect(i.text.length).toBeGreaterThan(10);
      expect(i.stated.attributes.length).toBeGreaterThan(0);
      expect(i.stated.options.length).toBeGreaterThan(0);
      expect(i.targetAsin).toMatch(/^[A-Z0-9]{10}$/);
    }
  });

  it('yields enough usable products to build carts from', () => {
    const usable = usableProducts(data);
    expect(usable.length).toBeGreaterThan(200);
    for (const p of usable.slice(0, 50)) {
      expect(p.priceMinor).toBeGreaterThan(0);
      expect(p.topCategory).not.toBe('Uncategorised');
    }
  });

  it('has multiple top-level categories, so SCOPE_VIOLATION donors exist', () => {
    const groups = byTopCategory(usableProducts(data));
    // A scope violation needs a product from a different top-level category.
    expect(groups.size).toBeGreaterThanOrEqual(3);
  });

  it('exposes real variant axes to perturb', () => {
    const dims = new Set<string>();
    for (const i of data.instructions) {
      for (const o of i.targetHas.options) {
        const parsed = parseOption(o);
        if (parsed) dims.add(parsed.dimension);
      }
    }
    // Verified by inspection: size and color dominate.
    expect(dims.has('size')).toBe(true);
    expect(dims.has('color')).toBe(true);
  });

  it('never produces a NaN price', () => {
    for (const p of data.products) {
      if (p.priceMinor !== null) {
        expect(Number.isFinite(p.priceMinor)).toBe(true);
        expect(Number.isInteger(p.priceMinor)).toBe(true);
      }
    }
  });
});
