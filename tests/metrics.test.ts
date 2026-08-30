import { describe, it, expect } from 'vitest';
import { wilson, rate, macroAverage } from '../src/harness/metrics.js';

describe('metrics: Wilson interval', () => {
  it('never claims certainty at the extremes', () => {
    // The normal approximation collapses to zero width at 0/n and n/n and
    // asserts certainty from a handful of samples. Several of our
    // class-x-tier cells hold ~29 cases, so that would be badly misleading.
    const perfect = wilson(30, 30);
    expect(perfect.lo).toBeLessThan(1);
    expect(perfect.hi).toBe(1);
    const zero = wilson(0, 30);
    expect(zero.lo).toBe(0);
    expect(zero.hi).toBeGreaterThan(0);
  });

  it('brackets the point estimate', () => {
    for (const [h, n] of [[1, 10], [5, 10], [9, 10], [50, 100], [1, 3]] as const) {
      const w = wilson(h, n);
      expect(w.lo).toBeLessThanOrEqual(h / n);
      expect(w.hi).toBeGreaterThanOrEqual(h / n);
    }
  });

  it('narrows as n grows at a fixed proportion', () => {
    const small = wilson(5, 10);
    const large = wilson(500, 1000);
    expect(large.hi - large.lo).toBeLessThan(small.hi - small.lo);
  });

  it('stays inside [0, 1]', () => {
    for (let n = 1; n <= 60; n++) {
      for (let h = 0; h <= n; h++) {
        const w = wilson(h, n);
        expect(w.lo).toBeGreaterThanOrEqual(0);
        expect(w.hi).toBeLessThanOrEqual(1);
        expect(w.lo).toBeLessThanOrEqual(w.hi);
      }
    }
  });

  it('returns a degenerate interval for an empty sample rather than NaN', () => {
    expect(wilson(0, 0)).toEqual({ lo: 0, hi: 0 });
    expect(rate(0, 0).rate).toBe(0);
  });

  it('matches a known reference value', () => {
    // Wilson 95% for 5/10 is approximately [0.2366, 0.7634].
    const w = wilson(5, 10);
    expect(w.lo).toBeCloseTo(0.2366, 3);
    expect(w.hi).toBeCloseTo(0.7634, 3);
  });
});

describe('metrics: macro average', () => {
  it('weights each cell equally, ignoring cell size', () => {
    // The point of a macro average: a 1000-case easy cell must not drown a
    // 29-case hard cell.
    const big = rate(1000, 1000);
    const small = rate(0, 29);
    expect(macroAverage([big, small])).toBeCloseTo(0.5, 6);
  });

  it('excludes empty cells rather than counting them as zero', () => {
    expect(macroAverage([rate(1, 1), rate(0, 0)])).toBe(1);
  });

  it('is 0 when every cell is empty', () => {
    expect(macroAverage([rate(0, 0)])).toBe(0);
    expect(macroAverage([])).toBe(0);
  });
});
