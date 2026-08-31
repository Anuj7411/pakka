/**
 * Semantic judging: which lines get sent, and what a verdict becomes.
 *
 * This module was at 0% coverage while it decided every provider call and
 * turned every model verdict into a finding — the same hole a coverage run
 * found in evaluate.ts, in a module that spends money and produces published
 * numbers. It is also the module the abstention band was removed from, so the
 * "any confidence still becomes a finding" test below is load-bearing: it is
 * what stops the band growing back by accident.
 */
import { describe, it, expect } from 'vitest';
import { judgeCart } from '../src/semantic/judge.js';
import { assessCart } from '../src/deterministic/checkers.js';
import { SOURCE_DECISION } from '../src/gate/compose.js';
import type { JudgeVerdict } from '../src/semantic/prompt.js';
import type { Provider, ProviderRequest } from '../src/semantic/provider.js';
import type { Cart, CartLine, Mandate, MandateItem } from '../src/corpus/types.js';

// ---------------------------------------------------------------------------
// Fixtures. Names and item texts share tokens, so assignLines pairs them.
// ---------------------------------------------------------------------------

const item = (id: string, text: string, over: Partial<MandateItem> = {}): MandateItem => ({
  itemId: id,
  text,
  statedAttributes: [],
  statedOptions: [],
  statedQuantity: null,
  sourceAsin: `B0000000${id}`,
  ...over,
});

const line = (id: string, name: string, over: Partial<CartLine> = {}): CartLine => ({
  lineId: id,
  answersItemId: null,
  sku: `sku-${id}`,
  name,
  brand: null,
  priceMinor: 1000,
  quantity: 1,
  categoryPath: ['Electronics'],
  options: [],
  attributes: [],
  ...over,
});

const mandate = (items: MandateItem[]): Mandate => ({
  mandateId: 'm0',
  text: items.map((i) => i.text).join('; '),
  items,
  authorisedCategory: 'Electronics',
});

const cart = (lines: CartLine[]): Cart => ({ cartId: 'c0', lines });

/** Records every request, so "was this line sent?" is directly observable. */
function spy(verdict: (req: ProviderRequest, n: number) => JudgeVerdict): Provider & {
  requests: ProviderRequest[];
} {
  const p = {
    id: 'spy',
    requests: [] as ProviderRequest[],
    judge: async (req: ProviderRequest) => {
      p.requests.push(req);
      return verdict(req, p.requests.length - 1);
    },
  };
  return p;
}

const says = (v: Partial<JudgeVerdict>): JudgeVerdict => ({
  verdict: 'satisfies',
  confidence: 1,
  reason: 'fine',
  failed: false,
  ...v,
});

// ---------------------------------------------------------------------------

describe('judgeCart: which lines are worth a provider call', () => {
  it('does not send a line the deterministic layer already settled', async () => {
    // Under the lattice, nothing the model could say would change a block. The
    // call would cost rate limit and buy no possible outcome.
    const m = mandate([item('i0', 'wireless bluetooth headphones')]);
    const c = cart([
      line('l0', 'wireless bluetooth headphones', { categoryPath: ['Garden'] }), // scope violation
    ]);
    const assessment = assessCart(c, m);
    expect(assessment.violations.length).toBeGreaterThan(0);

    const provider = spy(() => says({ verdict: 'wrong_product' }));
    const result = await judgeCart(c, m, assessment, provider);

    expect(provider.requests).toHaveLength(0);
    expect(result.called).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it('does not send a line that answers no request', async () => {
    // An unassigned line is already UNREQUESTED_ADDITION deterministically, and
    // the model has no request to compare it against either.
    const m = mandate([item('i0', 'wireless bluetooth headphones')]);
    const c = cart([
      line('l0', 'wireless bluetooth headphones'),
      line('l1', 'garden gnome statue ornament'),
    ]);
    const provider = spy(() => says({}));
    await judgeCart(c, m, assessCart(c, m), provider);

    const sent = provider.requests.map((r) => r.user);
    expect(sent.some((u) => u.includes('headphones'))).toBe(true);
    expect(sent.some((u) => u.includes('gnome'))).toBe(false);
  });

  it('sends each surviving line exactly once and counts the calls', async () => {
    const m = mandate([item('i0', 'bluetooth headphones'), item('i1', 'usb charging cable')]);
    const c = cart([line('l0', 'bluetooth headphones'), line('l1', 'usb charging cable')]);
    const provider = spy(() => says({}));
    const result = await judgeCart(c, m, assessCart(c, m), provider);

    expect(provider.requests).toHaveLength(2);
    expect(result.called).toBe(2);
    expect(result.verdicts).toHaveLength(2);
    expect(result.verdicts.map((v) => v.lineId).sort()).toEqual(['l0', 'l1']);
  });
});

describe('judgeCart: what a verdict becomes', () => {
  const m = mandate([item('i0', 'bluetooth headphones')]);
  const c = cart([line('l0', 'bluetooth headphones')]);

  it('turns wrong_product into a semantic finding', async () => {
    const provider = spy(() => says({ verdict: 'wrong_product', reason: 'it is a toaster' }));
    const result = await judgeCart(c, m, assessCart(c, m), provider);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.source).toBe('semantic');
    expect(result.findings[0]!.lineId).toBe('l0');
    expect(result.findings[0]!.detail).toContain('toaster');
  });

  it('turns wrong_product into a finding at ANY confidence', async () => {
    // The removed abstention band gated this at 0.5. Day 4 measured the
    // confidence signal as degenerate — two distinct values, 94.6% at exactly
    // 1.0 — so the band could not fire and implied a calibration we do not
    // have. If a band ever comes back, this test fails first.
    for (const confidence of [0, 0.01, 0.2, 0.49, 0.5, 0.51, 1]) {
      const provider = spy(() => says({ verdict: 'wrong_product', confidence }));
      const result = await judgeCart(c, m, assessCart(c, m), provider);
      expect(result.findings, `confidence ${confidence}`).toHaveLength(1);
      expect(result.findings[0]!.source).toBe('semantic');
    }
  });

  it('never emits a source the gate cannot decide', async () => {
    const provider = spy(() => says({ verdict: 'wrong_product', confidence: 0.1 }));
    const result = await judgeCart(c, m, assessCart(c, m), provider);
    for (const f of result.findings) {
      expect(Object.keys(SOURCE_DECISION)).toContain(f.source);
    }
  });

  it('emits nothing for satisfies', async () => {
    const provider = spy(() => says({ verdict: 'satisfies' }));
    const result = await judgeCart(c, m, assessCart(c, m), provider);
    expect(result.findings).toHaveLength(0);
    expect(result.verdicts).toHaveLength(1); // recorded for calibration regardless
  });

  it('emits nothing for unsure', async () => {
    // "Cannot tell" is not an accusation. It is also not a clearance: the
    // deterministic verdict stands untouched either way.
    const provider = spy(() => says({ verdict: 'unsure', reason: 'ambiguous' }));
    const result = await judgeCart(c, m, assessCart(c, m), provider);
    expect(result.findings).toHaveLength(0);
  });

  it('cannot clear a deterministic finding, whatever it says', async () => {
    // The schema has no verdict that could, and satisfies must not become one.
    const scoped = mandate([item('i0', 'bluetooth headphones')]);
    const bad = cart([line('l0', 'bluetooth headphones', { categoryPath: ['Garden'] })]);
    const assessment = assessCart(bad, scoped);
    const provider = spy(() => says({ verdict: 'satisfies', confidence: 1 }));
    const result = await judgeCart(bad, scoped, assessment, provider);

    expect(assessment.violations.length).toBeGreaterThan(0);
    expect(result.findings).toHaveLength(0);
  });
});

describe('judgeCart: an outage is not an opinion', () => {
  const m = mandate([item('i0', 'bluetooth headphones')]);
  const c = cart([line('l0', 'bluetooth headphones')]);

  it('marks the run degraded when a call failed', async () => {
    // Keyed off the explicit flag, not the reason string. An earlier adapter
    // could not tell a rate limit from a judgement and published an ablation
    // in which 68 of 74 calls had 429'd.
    const provider = spy(() => says({ verdict: 'unsure', failed: true, reason: 'provider HTTP 429' }));
    const result = await judgeCart(c, m, assessCart(c, m), provider);
    expect(result.degraded).toBe(true);
  });

  it('does not mark a clean run degraded', async () => {
    const provider = spy(() => says({ verdict: 'satisfies' }));
    expect((await judgeCart(c, m, assessCart(c, m), provider)).degraded).toBe(false);
  });

  it('stays degraded when only one call of several failed', async () => {
    const two = mandate([item('i0', 'bluetooth headphones'), item('i1', 'usb charging cable')]);
    const c2 = cart([line('l0', 'bluetooth headphones'), line('l1', 'usb charging cable')]);
    const provider = spy((_req, n) =>
      n === 0 ? says({}) : says({ verdict: 'unsure', failed: true, reason: 'timeout' }),
    );
    const result = await judgeCart(c2, two, assessCart(c2, two), provider);
    expect(result.called).toBe(2);
    expect(result.degraded).toBe(true);
  });

  it('records a failed verdict rather than dropping it', async () => {
    const provider = spy(() => says({ verdict: 'unsure', failed: true, reason: 'provider HTTP 429' }));
    const result = await judgeCart(c, m, assessCart(c, m), provider);
    expect(result.verdicts).toHaveLength(1);
    expect(result.verdicts[0]!.verdict.failed).toBe(true);
  });
});

describe('judgeCart: what reaches the provider', () => {
  it('sends the redacted view, never the ground-truth assignment', async () => {
    const m = mandate([item('i0', 'bluetooth headphones')]);
    const c = cart([line('l0', 'bluetooth headphones', { answersItemId: 'i0', sku: 'SECRET-SKU' })]);
    const provider = spy(() => says({}));
    await judgeCart(c, m, assessCart(c, m), provider);

    const sent = `${provider.requests[0]!.system}\n${provider.requests[0]!.user}`;
    expect(sent).not.toContain('answersItemId');
    expect(sent).not.toContain('SECRET-SKU');
    expect(sent).not.toContain('lineId');
  });

  it('handles an empty cart without calling the provider', async () => {
    const m = mandate([item('i0', 'bluetooth headphones')]);
    const c = cart([]);
    const provider = spy(() => says({}));
    const result = await judgeCart(c, m, assessCart(c, m), provider);
    expect(provider.requests).toHaveLength(0);
    expect(result.findings).toHaveLength(0);
    expect(result.degraded).toBe(false);
  });
});
