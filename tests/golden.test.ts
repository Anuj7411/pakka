/**
 * Golden vectors.
 *
 * Property tests ask "is this a valid PRNG?" and "is this valid JSON?" — both
 * remain true after the algorithm is changed. Mutation testing exposed the
 * consequence: rng.ts scored 22.92%, because almost any arithmetic mutation
 * produces a different-but-still-valid generator that every property test
 * accepts.
 *
 * That is not a cosmetic gap. The whole reproducibility claim is "regenerate
 * the corpus byte-for-byte from a seed". If the RNG's arithmetic drifts, every
 * published corpus hash changes and results stop being comparable — silently,
 * with a green suite.
 *
 * These tests pin the exact output. If one fails, the algorithm changed: either
 * revert it, or re-publish every corpus hash and say so.
 */
import { describe, it, expect } from 'vitest';
import { Rng } from '../src/corpus/rng.js';
import { canonicalise, hashOf } from '../src/normalise/canonical.js';

describe('golden: Rng is pinned to an exact sequence', () => {
  const POST_SHUFFLE_DRAW = 0.729822089896;
  it('next() from seed 20260829', () => {
    const r = new Rng(20260829);
    const got = Array.from({ length: 8 }, () => Number(r.next().toFixed(12)));
    expect(got).toEqual([
      0.936238700757, 0.826447488274, 0.95230648946, 0.732031105785,
      0.064278324367, 0.391442527995, 0.596451169346, 0.824031537632,
    ]);
  });

  it('int() from seed 1', () => {
    const r = new Rng(1);
    const got = Array.from({ length: 12 }, () => r.int(1, 100));
    expect(got).toEqual([63, 1, 53, 99, 97, 29, 62, 73, 43, 100, 46, 49]);
  });

  it('shuffle() from seed 7', () => {
    // Pins the Fisher-Yates direction and bounds. A mutated loop that still
    // permutes would pass a "same multiset" property test but fail here.
    expect(new Rng(7).shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual([
      7, 6, 9, 2, 3, 4, 5, 8, 10, 1,
    ]);
  });

  it('fork() derives pinned seeds from labels', () => {
    const r = new Rng(99);
    expect(['a', 'b', 'mandate:0', 'QUANTITY_DEVIATION:hard'].map((l) => r.fork(l).seed)).toEqual([
      33555239, 16777620, 1240070942, 3155772204,
    ]);
  });

  it('pick() from seed 5', () => {
    const r = new Rng(5);
    const got = Array.from({ length: 6 }, () => r.pick(['a', 'b', 'c', 'd']));
    expect(got).toEqual(['c', 'd', 'a', 'c', 'a', 'c']);
  });

  it('shuffle consumes an exact number of draws', () => {
    // A loop bound of `i >= 0` instead of `i > 0` produces the SAME array (the
    // final swap is out[0] with itself) but consumes one extra draw, shifting
    // every later value. Only the post-shuffle stream state catches it.
    const r = new Rng(7);
    r.shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(Number(r.next().toFixed(12))).toBe(POST_SHUFFLE_DRAW);
  });

  it('fork() does not disturb the parent stream', () => {
    const a = new Rng(3);
    const before = a.next();
    a.fork('x');
    a.fork('y');
    const b = new Rng(3);
    b.next();
    expect(a.next()).toBe(b.next());
    expect(before).toBe(new Rng(3).next());
  });
});

describe('golden: canonical form is pinned', () => {
  const struct = { z: 1, a: [3, { y: 'café', x: -0 }], n: null, u: undefined };

  it('serialises to an exact string', () => {
    // Encodes every rule at once: keys sorted at both levels, -0 written as 0,
    // undefined dropped, explicit null kept, array order preserved, NFC applied.
    expect(canonicalise(struct)).toBe('{"a":[3,{"x":0,"y":"café"}],"n":null,"z":1}');
  });

  it('hashes to an exact digest', () => {
    // If this changes, every certificate and corpus hash we have published is
    // no longer reproducible.
    expect(hashOf(struct)).toBe(
      'sha256:53f04ff3cca3832d59a6639fd35662b1051aa0c71966fed41f59a8cda1cd70be',
    );
  });
});

describe('canonical: comparator and -0 handling, directly', () => {
  it('orders keys strictly by code unit in all three directions', () => {
    // Kills comparator mutations that collapse a branch: a stable-but-wrong
    // comparator still produces valid JSON, so only ordering pins it.
    expect(canonicalise({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalise({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
    expect(canonicalise({ a: 1 })).toBe('{"a":1}');
    // Uppercase sorts before lowercase by code unit; under many locales it does not.
    expect(canonicalise({ a: 1, B: 2, A: 3 })).toBe('{"A":3,"B":2,"a":1}');
    // Digits before letters.
    expect(canonicalise({ z: 1, '1': 2 })).toBe('{"1":2,"z":1}');
  });

  it('distinguishes -0 from 0 only in input, never in output', () => {
    // Kills the unary mutation on Object.is(n, -0).
    expect(canonicalise(-0)).toBe('0');
    expect(canonicalise(0)).toBe('0');
    expect(canonicalise({ a: -0 })).toBe(canonicalise({ a: 0 }));
    // A negative number that is NOT -0 must keep its sign.
    expect(canonicalise(-1)).toBe('-1');
    expect(canonicalise(-0.5)).toBe('-0.5');
  });

  it('emits booleans exactly', () => {
    expect(canonicalise(true)).toBe('true');
    expect(canonicalise(false)).toBe('false');
    expect(canonicalise({ t: true, f: false })).toBe('{"f":false,"t":true}');
  });

  it('hashOfString returns a real digest, not merely something different', () => {
    // An earlier version only asserted inequality with hashOf, which an empty
    // function body satisfies (undefined !== string). Mutation testing caught
    // it. Assert the actual value.
    expect(hashOfStringViaModule('abc')).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(hashOfStringViaModule('')).toMatch(/^sha256:[0-9a-f]{64}$/);
    // hashOf JSON-quotes the string; hashOfString does not. Conflating them
    // would break chain verification.
    expect(hashOf('abc')).not.toBe(hashOfStringViaModule('abc'));
  });
});

// Imported separately so the test above reads clearly.
import { hashOfString as hashOfStringViaModule } from '../src/normalise/canonical.js';
