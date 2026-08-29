import { describe, it, expect } from 'vitest';
import { canonicalise, hashOf, hashOfString, CanonicalisationError } from '../src/normalise/canonical.js';

describe('canonical: determinism', () => {
  it('is independent of key insertion order', () => {
    const a = { b: 1, a: 2, c: 3 };
    const b = { c: 3, a: 2, b: 1 };
    expect(canonicalise(a)).toBe(canonicalise(b));
    expect(hashOf(a)).toBe(hashOf(b));
  });

  it('sorts keys recursively, at every depth', () => {
    const v = { z: { y: 1, x: 2 }, a: [{ q: 1, p: 2 }] };
    expect(canonicalise(v)).toBe('{"a":[{"p":2,"q":1}],"z":{"x":2,"y":1}}');
  });

  it('preserves array order, because order is semantic for cart lines', () => {
    expect(canonicalise([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalise([1, 2, 3])).not.toBe(canonicalise([3, 2, 1]));
  });

  it('produces byte-identical output across repeated calls', () => {
    const v = { lines: [{ sku: 'a', qty: 2 }, { sku: 'b', qty: 1 }], total: 1234 };
    const first = canonicalise(v);
    for (let i = 0; i < 100; i++) expect(canonicalise(v)).toBe(first);
  });

  it('emits no whitespace — formatting is not part of the value', () => {
    expect(canonicalise({ a: 1, b: [1, 2] })).toBe('{"a":1,"b":[1,2]}');
  });
});

describe('canonical: Unicode', () => {
  it('normalises to NFC so equal text hashes equally', () => {
    const composed = 'café'; // é as one code point
    const decomposed = 'café'; // e + combining acute
    expect(composed).not.toBe(decomposed); // different strings...
    expect(canonicalise(composed)).toBe(canonicalise(decomposed)); // ...same text
    expect(hashOf(composed)).toBe(hashOf(decomposed));
  });

  it('normalises object KEYS too', () => {
    const a = { ['café']: 1 };
    const b = { ['café']: 1 };
    expect(canonicalise(a)).toBe(canonicalise(b));
  });

  it('handles emoji and surrogate pairs', () => {
    expect(() => canonicalise({ x: '🛒💰' })).not.toThrow();
    expect(hashOf({ x: '🛒' })).toBe(hashOf({ x: '🛒' }));
  });
});

describe('canonical: numbers', () => {
  it('treats -0 and 0 as the same quantity', () => {
    expect(canonicalise(-0)).toBe('0');
    expect(hashOf({ amount: -0 })).toBe(hashOf({ amount: 0 }));
  });

  it('REFUSES non-finite numbers instead of silently writing null', () => {
    // JSON.stringify({x: NaN}) gives '{"x":null}' — a silent corruption of a
    // money field. We refuse.
    expect(() => canonicalise(NaN)).toThrow(CanonicalisationError);
    expect(() => canonicalise(Infinity)).toThrow(CanonicalisationError);
    expect(() => canonicalise(-Infinity)).toThrow(CanonicalisationError);
    expect(() => canonicalise({ amount: NaN })).toThrow(/Non-finite/);
  });

  it('names the path of the offending value', () => {
    expect(() => canonicalise({ cart: { lines: [{ price: NaN }] } })).toThrow(
      /\$\.cart\.lines\[0\]\.price/,
    );
  });

  it('serialises integers exactly', () => {
    expect(canonicalise(9007199254740991)).toBe('9007199254740991');
    expect(canonicalise(0)).toBe('0');
  });
});

describe('canonical: absent vs null', () => {
  it('drops undefined properties but keeps explicit null', () => {
    expect(canonicalise({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('treats an absent key and an undefined key as the same', () => {
    expect(canonicalise({ a: 1, b: undefined })).toBe(canonicalise({ a: 1 }));
  });

  it('distinguishes absent from null — they are different statements', () => {
    expect(canonicalise({ a: 1 })).not.toBe(canonicalise({ a: 1, b: null }));
  });

  it('refuses a bare undefined rather than guessing', () => {
    expect(() => canonicalise(undefined)).toThrow(CanonicalisationError);
  });

  it('writes a sparse array hole as null, preserving length', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(canonicalise([1, , 3])).toBe('[1,null,3]');
  });
});

describe('canonical: rejected types', () => {
  it('refuses BigInt, functions and symbols', () => {
    expect(() => canonicalise(1n)).toThrow(/BigInt/);
    expect(() => canonicalise(() => 1)).toThrow(/function/);
    expect(() => canonicalise(Symbol('s'))).toThrow(/symbol/);
    expect(() => canonicalise({ f: () => 1 })).toThrow(CanonicalisationError);
  });
});

describe('canonical: hashing', () => {
  it('produces a prefixed 64-hex digest', () => {
    expect(hashOf({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is sensitive to any semantic change', () => {
    const base = { sku: 'A', qty: 1, price: 100 };
    expect(hashOf(base)).not.toBe(hashOf({ ...base, qty: 2 }));
    expect(hashOf(base)).not.toBe(hashOf({ ...base, sku: 'B' }));
    expect(hashOf(base)).not.toBe(hashOf({ ...base, price: 101 }));
  });

  it('is insensitive to key order', () => {
    expect(hashOf({ sku: 'A', qty: 1 })).toBe(hashOf({ qty: 1, sku: 'A' }));
  });

  it('hashOfString also NFC-normalises', () => {
    expect(hashOfString('café')).toBe(hashOfString('café'));
  });

  it('distinguishes a string from a number that looks like it', () => {
    expect(hashOf({ q: '1' })).not.toBe(hashOf({ q: 1 }));
  });

  it('distinguishes nesting shapes', () => {
    expect(hashOf({ a: [1] })).not.toBe(hashOf({ a: 1 }));
    expect(hashOf([[1, 2]])).not.toBe(hashOf([1, 2]));
  });
});

describe('canonical: adversarial keys', () => {
  it('is not confused by keys that collide after naive concatenation', () => {
    // A serialiser that joined keys and values without quoting could make
    // these identical. They must not be.
    expect(canonicalise({ 'a:1,b': 2 })).not.toBe(canonicalise({ a: 1, b: 2 }));
    expect(hashOf({ 'a"': 1 })).not.toBe(hashOf({ a: 1 }));
  });

  it('escapes quotes and backslashes in keys and values', () => {
    expect(canonicalise({ 'a"b': 'c\\d' })).toBe('{"a\\"b":"c\\\\d"}');
  });

  it('handles a key literally named __proto__ without prototype pollution', () => {
    const o: Record<string, unknown> = {};
    Object.defineProperty(o, '__proto__', { value: 1, enumerable: true, configurable: true });
    expect(() => canonicalise(o)).not.toThrow();
    expect(canonicalise(o)).toContain('__proto__');
  });

  it('sorts by code unit, not locale', () => {
    // Under some locales "a" < "B"; by code unit "B" (0x42) < "a" (0x61).
    expect(canonicalise({ a: 1, B: 2 })).toBe('{"B":2,"a":1}');
  });
});

describe('canonical: output is always valid JSON', () => {
  it('round-trips through JSON.parse for every shape we emit', () => {
    // The sparse-array bug produced "[1,,3]", which JSON.parse rejects. Any
    // canonical output that cannot be parsed back is unusable as an audit
    // artifact, so this is checked structurally rather than case by case.
    const shapes: unknown[] = [
      {},
      [],
      { a: 1 },
      [1, 2, 3],
      // eslint-disable-next-line no-sparse-arrays
      [1, , 3],
      // eslint-disable-next-line no-sparse-arrays
      [, , ,],
      { a: [1, undefined, 3] },
      { nested: { deep: [{ x: null }] } },
      { 'key with "quotes"': 'value\with\backslash' },
      { unicode: 'café 🛒', empty: '' },
      [{ a: undefined }],
      { a: -0, b: 0 },
    ];
    for (const s of shapes) {
      const out = canonicalise(s);
      expect(() => JSON.parse(out), `unparseable: ${out}`).not.toThrow();
    }
  });

  it('preserves array length through holes', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(JSON.parse(canonicalise([1, , 3]))).toHaveLength(3);
    // eslint-disable-next-line no-sparse-arrays
    expect(JSON.parse(canonicalise([, , ,]))).toHaveLength(3);
  });

  it('is idempotent: canonicalising a parsed canonical form reproduces it', () => {
    const v = { z: 1, a: [{ c: 2, b: 3 }], n: null };
    const once = canonicalise(v);
    expect(canonicalise(JSON.parse(once))).toBe(once);
  });
});
