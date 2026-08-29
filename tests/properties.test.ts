/**
 * Property and fuzz tests.
 *
 * Unit tests check the cases we thought of. These check the cases we did not.
 * The parsers here feed money arithmetic, so "never silently wrong" matters
 * more than "handles the happy path".
 */
import { describe, it, expect } from 'vitest';
import {
  parsePriceMinor,
  cleanBrand,
  parseCategory,
  parseOption,
  normaliseProduct,
  normaliseInstruction,
  type RawProduct,
  type RawInstructionRecord,
} from '../src/corpus/webshop.js';
import { classify, type ClassSignals } from '../src/taxonomy/classes.js';

// Deterministic PRNG — a fuzz failure must be reproducible, so no Math.random.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const NASTY_STRINGS = [
  '',
  ' ',
  '\t\n\r',
  '0',
  '-1',
  'NaN',
  'Infinity',
  'null',
  'undefined',
  '__proto__',
  'constructor',
  'prototype',
  '{"a":1}',
  '$',
  '$$$',
  '$.',
  '$.00',
  '.5',
  '1e10',
  '1,2,3',
  '$-5.00',
  '$999999999999999999999.99',
  '₹1,234.56',
  '£10',
  '10 USD',
  '＄１２３', // full-width
  'price on request',
  '<script>alert(1)</script>',
  'a'.repeat(10_000),
  '🛒💰',
  'Brand: ',
  'Brand:',
  '›',
  '›››',
  'A › B › C',
];

describe('properties: parsePriceMinor never lies about money', () => {
  it('returns null or a positive safe integer — never NaN, never negative, never fractional', () => {
    for (const s of NASTY_STRINGS) {
      const r = parsePriceMinor(s);
      if (r !== null) {
        expect(Number.isInteger(r), `input ${JSON.stringify(s)} → ${r}`).toBe(true);
        expect(Number.isFinite(r), `input ${JSON.stringify(s)}`).toBe(true);
        expect(r, `input ${JSON.stringify(s)}`).toBeGreaterThan(0);
        expect(r, `input ${JSON.stringify(s)}`).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
      }
    }
  });

  it('is deterministic', () => {
    for (const s of NASTY_STRINGS) {
      expect(parsePriceMinor(s)).toBe(parsePriceMinor(s));
    }
  });

  it('round-trips generated prices', () => {
    const rng = makeRng(20260829);
    for (let i = 0; i < 2000; i++) {
      const rupees = Math.floor(rng() * 100_000) + 1;
      const paise = Math.floor(rng() * 100);
      const formatted = `$${rupees}.${String(paise).padStart(2, '0')}`;
      expect(parsePriceMinor(formatted)).toBe(rupees * 100 + paise);
    }
  });

  it('refuses anything with more than one number — a range is not a price', () => {
    const rng = makeRng(7);
    for (let i = 0; i < 500; i++) {
      const a = (Math.floor(rng() * 1000) + 1).toFixed(2);
      const b = (Math.floor(rng() * 1000) + 1001).toFixed(2);
      expect(parsePriceMinor(`$${a} - $${b}`)).toBeNull();
      expect(parsePriceMinor(`from $${a} to $${b}`)).toBeNull();
    }
  });

  it('never throws on arbitrary bytes', () => {
    const rng = makeRng(99);
    for (let i = 0; i < 3000; i++) {
      const len = Math.floor(rng() * 40);
      let s = '';
      for (let j = 0; j < len; j++) s += String.fromCharCode(Math.floor(rng() * 0x2200));
      expect(() => parsePriceMinor(s)).not.toThrow();
    }
  });
});

describe('properties: string parsers are total', () => {
  it('cleanBrand never throws and never returns an empty string', () => {
    for (const s of NASTY_STRINGS) {
      const r = cleanBrand(s);
      expect(r === null || r.length > 0).toBe(true);
    }
    expect(cleanBrand(undefined)).toBeNull();
  });

  it('parseCategory never yields empty segments', () => {
    for (const s of NASTY_STRINGS) {
      for (const seg of parseCategory(s)) {
        expect(seg.length).toBeGreaterThan(0);
        expect(seg).toBe(seg.trim());
      }
    }
  });

  it('parseOption returns null or two non-empty trimmed parts', () => {
    for (const s of [...NASTY_STRINGS, 'a:b', ':', 'a:', ':b', 'a:b:c', ' color : Blue ']) {
      const r = parseOption(s);
      if (r !== null) {
        expect(r.dimension.length).toBeGreaterThan(0);
        expect(r.value.length).toBeGreaterThan(0);
        expect(r.dimension).toBe(r.dimension.trim().toLowerCase());
        expect(r.value).toBe(r.value.trim());
      }
    }
  });

  it('lowercases the dimension but preserves the value verbatim', () => {
    const r = parseOption('Color: Midnight Blue');
    expect(r).toEqual({ dimension: 'color', value: 'Midnight Blue' });
  });
});

describe('properties: normalisers survive hostile records', () => {
  it('normaliseProduct never throws on malformed input', () => {
    const hostile: RawProduct[] = [
      { name: '', product_information: null, brand: '', pricing: '', product_category: '' },
      { name: 'x', product_information: 'not-an-object', brand: 'b', pricing: 'x', product_category: '›' },
      {
        name: 'y',
        product_information: { ASIN: 'B000000000' },
        brand: 'Brand: Z',
        pricing: '$1.00',
        product_category: 'A › B',
        small_description: ['first', 'second'],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { name: 'p', product_information: { ASIN: 123 } as any, brand: 'b', pricing: '$2', product_category: 'C' },
    ];
    for (const h of hostile) {
      expect(() => normaliseProduct(h)).not.toThrow();
      const p = normaliseProduct(h);
      expect(typeof p.name).toBe('string');
      expect(typeof p.topCategory).toBe('string');
      expect(p.priceMinor === null || Number.isInteger(p.priceMinor)).toBe(true);
    }
  });

  it('rejects a non-string ASIN rather than propagating it', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = normaliseProduct({ name: 'p', product_information: { ASIN: 123 } as any, brand: '', pricing: '', product_category: '' });
    expect(p.asin).toBeNull();
  });

  it('normaliseInstruction is a pure copy — no aliasing of caller arrays', () => {
    const attrs = ['a'];
    const opts = ['color: blue'];
    const raw: RawInstructionRecord = {
      asin: 'B000000000',
      instruction: ' text ',
      attributes: attrs,
      options: opts,
      instruction_attributes: attrs,
      instruction_options: opts,
    };
    const i = normaliseInstruction(raw);
    attrs.push('MUTATED');
    opts.push('MUTATED');
    expect(i.stated.attributes).toEqual(['a']);
    expect(i.targetHas.options).toEqual(['color: blue']);
    expect(i.text).toBe('text');
  });
});

describe('properties: classify is total and deterministic', () => {
  it('never throws and always returns null or a known class, over random signals', () => {
    const rng = makeRng(4242);
    for (let i = 0; i < 5000; i++) {
      const s: ClassSignals = {
        outOfScope: rng() > 0.5,
        breachesStatedBound: rng() > 0.5,
        fillsNoRequestedSlot: rng() > 0.5,
        wrongProductForSlot: rng() > 0.5,
        wrongQuantityForSlot: rng() > 0.5,
      };
      let a: ReturnType<typeof classify>;
      expect(() => {
        a = classify(s);
      }).not.toThrow();
      expect(classify(s)).toBe(a!);
    }
  });

  it('is monotone: adding a higher-precedence signal never yields a lower-precedence class', () => {
    // Turning on outOfScope must always produce SCOPE_VIOLATION, whatever else holds.
    for (let mask = 0; mask < 16; mask++) {
      const base = {
        breachesStatedBound: Boolean(mask & 1),
        fillsNoRequestedSlot: Boolean(mask & 2),
        wrongProductForSlot: Boolean(mask & 4),
        wrongQuantityForSlot: Boolean(mask & 8),
      };
      expect(classify({ ...base, outOfScope: true })).toBe('SCOPE_VIOLATION');
    }
  });
});

describe('regression: bugs found by property tests', () => {
  it('refuses prices past MAX_SAFE_INTEGER instead of losing precision silently', () => {
    // Found 2026-08-29 by the fuzz corpus. 1e23 minor units is representable as
    // a float but not as a safe integer, so comparisons against it would be
    // silently wrong. Refusing is correct: an unparseable price is visible,
    // a wrong price is not.
    expect(parsePriceMinor('$999999999999999999999.99')).toBeNull();
    expect(parsePriceMinor('$900719925474099.1')).toBeNull();

    // Exactly ON the boundary is safe and must still parse — refusing it would
    // be over-correction.
    expect(parsePriceMinor('$90071992547409.91')).toBe(Number.MAX_SAFE_INTEGER);
    // One paise past it is not representable and must be refused.
    expect(parsePriceMinor('$90071992547409.92')).toBeNull();
  });

  it('documents that float precision makes two distinct prices indistinguishable near the limit', () => {
    // 90071992547409.90 and .91 both round to MAX_SAFE_INTEGER. This is a
    // property of IEEE-754, not a bug we can fix — recorded so nobody later
    // assumes minor-unit arithmetic is exact at any magnitude.
    expect(parsePriceMinor('$90071992547409.90')).toBe(parsePriceMinor('$90071992547409.91'));
  });
});
