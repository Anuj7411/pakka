/**
 * Provider plumbing: budget, cache, rate limiting.
 *
 * The cache test below exists because of a real incident. An earlier adapter
 * returned a plain `unsure` on HTTP 429, so a rate limit was indistinguishable
 * from a considered judgement — and the cache then stored those failures
 * permanently. An ablation reported "the model contributes 0.6%" when 68 of 74
 * calls had never reached the model. The numbers looked exactly like a finding.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  CallBudget,
  VerdictCache,
  withCacheAndBudget,
  withRateLimit,
  ProviderError,
  NULL_PROVIDER,
  type Provider,
} from '../src/semantic/provider.js';
import type { JudgeVerdict } from '../src/semantic/prompt.js';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ok = (reason = 'fine'): JudgeVerdict => ({
  verdict: 'satisfies',
  confidence: 0.9,
  reason,
  failed: false,
});
const fail = (reason: string): JudgeVerdict => ({
  verdict: 'unsure',
  confidence: 0,
  reason,
  failed: true,
});

function stubProvider(responses: JudgeVerdict[]): Provider & { calls: number } {
  let i = 0;
  const p = {
    id: 'stub',
    calls: 0,
    judge: async () => {
      p.calls++;
      return responses[Math.min(i++, responses.length - 1)]!;
    },
  };
  return p;
}

function tmpCache(): { cache: VerdictCache; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vc-'));
  return { cache: new VerdictCache(dir), dir };
}

describe('CallBudget', () => {
  it('throws on exhaustion rather than degrading quietly', () => {
    // Silently returning `unsure` would look like a calibration result instead
    // of an outage — the exact confusion that produced a fabricated ablation.
    const b = new CallBudget(2);
    b.spend();
    b.spend();
    expect(() => b.spend()).toThrow(ProviderError);
    expect(() => b.spend()).toThrow(/budget exhausted/);
  });

  it('tracks used and remaining', () => {
    const b = new CallBudget(3);
    expect(b.remaining).toBe(3);
    b.spend();
    expect(b.used).toBe(1);
    expect(b.remaining).toBe(2);
  });

  it('a zero budget refuses the first call', () => {
    expect(() => new CallBudget(0).spend()).toThrow(ProviderError);
  });

  it('rejects a nonsensical limit', () => {
    expect(() => new CallBudget(-1)).toThrow(TypeError);
    expect(() => new CallBudget(1.5)).toThrow(TypeError);
  });
});

describe('VerdictCache', () => {
  it('keys on the exact prompt, so any wording change invalidates', () => {
    const a = VerdictCache.key({ system: 's', user: 'u' }, 'm');
    expect(VerdictCache.key({ system: 's', user: 'u' }, 'm')).toBe(a);
    expect(VerdictCache.key({ system: 's!', user: 'u' }, 'm')).not.toBe(a);
    expect(VerdictCache.key({ system: 's', user: 'u!' }, 'm')).not.toBe(a);
    // Model id is part of the key: a verdict from one model must not be served
    // as though it came from another.
    expect(VerdictCache.key({ system: 's', user: 'u' }, 'other')).not.toBe(a);
  });

  it('cannot be confused by moving text across the field boundary', () => {
    // Naive concatenation would make these collide.
    expect(VerdictCache.key({ system: 'ab', user: 'c' }, 'm')).not.toBe(
      VerdictCache.key({ system: 'a', user: 'bc' }, 'm'),
    );
  });

  it('treats a corrupt entry as a miss instead of crashing', () => {
    const { cache, dir } = tmpCache();
    try {
      const key = 'deadbeef';
      writeFileSync(join(dir, `${key}.json`), '{ not json');
      expect(cache.get(key)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('withCacheAndBudget', () => {
  it('serves a hit without spending budget', async () => {
    const { cache, dir } = tmpCache();
    try {
      const inner = stubProvider([ok()]);
      const budget = new CallBudget(10);
      const p = withCacheAndBudget(inner, cache, budget);
      const req = { system: 's', user: 'u' };
      await p.judge(req);
      await p.judge(req);
      await p.judge(req);
      expect(inner.calls).toBe(1);
      expect(budget.used).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('NEVER caches a failure', async () => {
    // The incident: a cached 429 is permanent. Every later run serves it
    // instead of retrying, so one bad minute poisons every result after it.
    const { cache, dir } = tmpCache();
    try {
      const inner = stubProvider([fail('provider HTTP 429')]);
      const p = withCacheAndBudget(inner, cache, new CallBudget(10));
      const req = { system: 's', user: 'u' };
      await p.judge(req);
      await p.judge(req);
      expect(inner.calls).toBe(2); // retried, not served from cache
      expect(readdirSync(dir)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caches a success that follows a failure', async () => {
    const { cache, dir } = tmpCache();
    try {
      const inner = stubProvider([fail('provider HTTP 429'), ok('recovered')]);
      const p = withCacheAndBudget(inner, cache, new CallBudget(10));
      const req = { system: 's', user: 'u' };
      await p.judge(req);
      const second = await p.judge(req);
      expect(second.failed).toBe(false);
      expect(readdirSync(dir)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('withRateLimit', () => {
  it('retries a call that never produced a verdict', async () => {
    vi.useFakeTimers();
    try {
      const inner = stubProvider([fail('provider HTTP 429'), fail('provider HTTP 429'), ok()]);
      const p = withRateLimit(inner, { minIntervalMs: 1, maxRetries: 4 });
      const promise = p.judge({ system: 's', user: 'u' });
      await vi.runAllTimersAsync();
      const v = await promise;
      expect(v.failed).toBe(false);
      expect(inner.calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT retry an error that will not improve', async () => {
    // A 400 is a bad request. Retrying it burns rate limit for nothing.
    vi.useFakeTimers();
    try {
      const inner = stubProvider([fail('provider HTTP 400')]);
      const p = withRateLimit(inner, { minIntervalMs: 1, maxRetries: 4 });
      const promise = p.judge({ system: 's', user: 'u' });
      await vi.runAllTimersAsync();
      const v = await promise;
      expect(v.failed).toBe(true);
      expect(inner.calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after maxRetries and returns the failure honestly', async () => {
    vi.useFakeTimers();
    try {
      const inner = stubProvider([fail('provider HTTP 429')]);
      const p = withRateLimit(inner, { minIntervalMs: 1, maxRetries: 2 });
      const promise = p.judge({ system: 's', user: 'u' });
      await vi.runAllTimersAsync();
      const v = await promise;
      expect(v.failed).toBe(true);
      expect(inner.calls).toBe(3); // initial + 2 retries
    } finally {
      vi.useRealTimers();
    }
  });

  it('never returns a success it did not receive', async () => {
    vi.useFakeTimers();
    try {
      const inner = stubProvider([fail('provider timeout')]);
      const p = withRateLimit(inner, { minIntervalMs: 1, maxRetries: 1 });
      const promise = p.judge({ system: 's', user: 'u' });
      await vi.runAllTimersAsync();
      expect((await promise).verdict).toBe('unsure');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('NULL_PROVIDER', () => {
  it('marks itself failed, so a run without a model reads as degraded', async () => {
    // Used by the deterministic-only ablation. If it reported success, a run
    // with no model would look like a model that always abstains.
    const v = await NULL_PROVIDER.judge({ system: 's', user: 'u' });
    expect(v.failed).toBe(true);
    expect(v.verdict).toBe('unsure');
  });
});
