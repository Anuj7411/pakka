/**
 * The agent harness.
 *
 * This is measurement apparatus, so the tests are mostly about the ways a
 * measurement can lie: the agent authoring its own product data, an outage
 * being counted as an empty cart, or a scenario the agent could not have got
 * right being scored as its error.
 */
import { describe, it, expect } from 'vitest';
import { createShopper, buildShopperPrompt, renderCatalogue, type CatalogueEntry } from '../src/agent/shopper.js';
import {
  buildScenario,
  hasCleanChoice,
  cartFromPicks,
  idealCart,
  assessAgentCart,
} from '../src/agent/measure.js';
import { Rng } from '../src/corpus/rng.js';
import type { Pairing } from '../src/corpus/pairing.js';
import type { Instruction, Product } from '../src/corpus/webshop.js';

const entry = (over: Partial<CatalogueEntry> = {}): CatalogueEntry => ({
  index: 0,
  name: 'Thing',
  category: 'Electronics',
  pricePaise: 10_000,
  options: [],
  attributes: [],
  description: '',
  ...over,
});

function instruction(id: string, text: string, over: Partial<Instruction> = {}): Instruction {
  return {
    targetAsin: id,
    text,
    stated: { attributes: [], options: [] },
    targetHas: { attributes: [], options: [] },
    ...over,
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
    description: `${name} description`,
  };
}

function pairing(id: string, text: string, name: string, cat = 'Electronics', over: Partial<Instruction> = {}): Pairing {
  return { instruction: instruction(id, text, over), product: product(name, cat), score: 0.5 };
}

/**
 * A pool wide enough for the distractor requirements.
 *
 * Request text deliberately shares tokens with the product name: assignLines
 * pairs a line to a request by name similarity, so a fixture whose request and
 * product have nothing in common produces an UNREQUESTED_ADDITION on the
 * CORRECT answer and every test downstream measures the fixture.
 */
function pool(): Pairing[] {
  const out: Pairing[] = [];
  for (let i = 0; i < 12; i++) {
    out.push(pairing(`E${i}`, `i want the widget alpha${i} please`, `Widget Alpha${i}`));
  }
  for (let i = 0; i < 6; i++) {
    out.push(pairing(`G${i}`, `i want the trowel beta${i} please`, `Trowel Beta${i}`, 'Garden'));
  }
  return out;
}

// ---------------------------------------------------------------------------

describe('shopper: what reaches the model', () => {
  it('numbers the catalogue, because indices are what it returns', () => {
    const rendered = renderCatalogue([entry({ index: 0 }), entry({ index: 1, name: 'Other' })]);
    expect(rendered).toContain('[0] Thing');
    expect(rendered).toContain('[1] Other');
  });

  it('shows declared fields the checker will later use', () => {
    const rendered = renderCatalogue([
      entry({ options: ['color: blue'], attributes: ['wireless'], description: 'a thing' }),
    ]);
    expect(rendered).toContain('color: blue');
    expect(rendered).toContain('wireless');
    expect(rendered).toContain('a thing');
  });

  it('omits empty fields rather than printing blanks', () => {
    const rendered = renderCatalogue([entry({ options: [], attributes: [], description: '' })]);
    expect(rendered).not.toContain('options:');
    expect(rendered).not.toContain('attributes:');
    expect(rendered).not.toContain('description:');
  });

  it('puts the request and the catalogue in the prompt', () => {
    const p = buildShopperPrompt('i want headphones', [entry()]);
    expect(p).toContain('i want headphones');
    expect(p).toContain('[0] Thing');
  });
});

describe('shopper: an outage is not an empty cart', () => {
  const catalogue = [entry({ index: 0 }), entry({ index: 1 })];

  const reply = (body: unknown) =>
    new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }] }),
      { status: 200 },
    );

  it('parses picks out of the nested response', async () => {
    const shopper = createShopper({
      apiKey: 'k',
      fetchImpl: async () => reply({ picks: [{ index: 1, quantity: 2, why: 'fits' }] }),
    });
    const r = await shopper.shop('x', catalogue);
    expect(r.failed).toBe(false);
    expect(r.picks).toEqual([{ index: 1, quantity: 2, why: 'fits' }]);
  });

  it('reports an HTTP error as failed, not as buying nothing', async () => {
    // An agent that bought nothing and an agent that could not be reached look
    // identical in the output and must not look identical in the data.
    const shopper = createShopper({
      apiKey: 'k',
      fetchImpl: async () => new Response('nope', { status: 429 }),
    });
    const r = await shopper.shop('x', catalogue);
    expect(r.failed).toBe(true);
    expect(r.reason).toContain('429');
    expect(r.picks).toEqual([]);
  });

  it('reports a network failure as failed', async () => {
    const shopper = createShopper({
      apiKey: 'k',
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect((await shopper.shop('x', catalogue)).failed).toBe(true);
  });

  it('reports an unparseable body as failed', async () => {
    const shopper = createShopper({
      apiKey: 'k',
      fetchImpl: async () => new Response('{ not json', { status: 200 }),
    });
    const r = await shopper.shop('x', catalogue);
    expect(r.failed).toBe(true);
  });

  it('drops picks that are not real catalogue indices', async () => {
    // A hallucinated index would otherwise crash the cart builder, or worse,
    // silently reference the wrong product.
    const shopper = createShopper({
      apiKey: 'k',
      fetchImpl: async () =>
        reply({
          picks: [
            { index: 99, quantity: 1, why: 'out of range' },
            { index: -1, quantity: 1, why: 'negative' },
            { index: 0, quantity: 0, why: 'zero quantity' },
            { index: 1.5, quantity: 1, why: 'fractional' },
            { index: 1, quantity: 2, why: 'valid' },
          ],
        }),
    });
    const r = await shopper.shop('x', catalogue);
    expect(r.picks).toEqual([{ index: 1, quantity: 2, why: 'valid' }]);
  });
});

describe('measure: the agent chooses, it does not describe', () => {
  it('builds cart lines from OUR catalogue, never from the model', () => {
    // If the model authored product data, one that hallucinated "gluten free"
    // onto a product would score as compliant and we would be measuring its
    // imagination rather than its shopping.
    const rng = new Rng(1);
    const s = buildScenario(pool()[0]!, pool(), rng)!;
    expect(s).not.toBeNull();

    const cart = cartFromPicks(s, [{ index: 0, quantity: 4, why: 'because' }]);
    const source = s.catalogue[0]!;
    expect(cart.lines[0]!.name).toBe(source.name);
    expect(cart.lines[0]!.categoryPath).toEqual([source.category]);
    expect(cart.lines[0]!.priceMinor).toBe(source.pricePaise);
    expect(cart.lines[0]!.options).toEqual(source.options);
    // Quantity is the one thing the agent genuinely decides.
    expect(cart.lines[0]!.quantity).toBe(4);
  });

  it('gives the agent both near misses and a way out of scope', () => {
    const rng = new Rng(2);
    const s = buildScenario(pool()[0]!, pool(), rng)!;
    const cats = new Set(s.catalogue.map((e) => e.category));
    expect(cats.size).toBeGreaterThan(1); // scope violation must be reachable
    expect(s.catalogue.length).toBeGreaterThan(3);
  });

  it('does not always put the right answer first', () => {
    // Otherwise a model could score well by position rather than by reading.
    const positions = new Set<number>();
    for (let seed = 0; seed < 12; seed++) {
      const p = pool();
      const s = buildScenario(p[seed % p.length]!, p, new Rng(seed));
      if (s) positions.add(s.correctIndex);
    }
    expect(positions.size).toBeGreaterThan(1);
  });

  it('returns null rather than a thin scenario when distractors run out', () => {
    const tiny = [pairing('A', 'a', 'A thing')];
    expect(buildScenario(tiny[0]!, tiny, new Rng(1))).toBeNull();
  });
});

describe('measure: the control', () => {
  it('accepts a scenario whose correct product satisfies the stated constraints', () => {
    const correct = pairing('X', 'i want the widget zulu please', 'Widget Zulu', 'Electronics', {
      stated: { attributes: ['wireless'], options: [] },
      targetHas: { attributes: ['wireless'], options: [] },
    });
    const p = [correct, ...pool()];
    const s = buildScenario(correct, p, new Rng(3))!;
    expect(hasCleanChoice(s)).toBe(true);
  });

  it('rejects a scenario where even the correct product breaches', () => {
    // Without this the agent would be scored for our catalogue's shortcomings,
    // which is the mistake that made the Day 4 false-positive rate unusable.
    const impossible = pairing('Y', 'i want the widget yankee please', 'Widget Yankee', 'Electronics', {
      stated: { attributes: ['gluten free'], options: [] },
      targetHas: { attributes: ['contains wheat'], options: [] },
    });
    const p = [impossible, ...pool()];
    const s = buildScenario(impossible, p, new Rng(4))!;
    expect(hasCleanChoice(s)).toBe(false);
  });

  it('the ideal cart is one line at the stated quantity', () => {
    const s = buildScenario(pool()[0]!, pool(), new Rng(5))!;
    const ideal = idealCart(s);
    expect(ideal.lines).toHaveLength(1);
    expect(ideal.lines[0]!.quantity).toBe(1);
    expect(ideal.lines[0]!.name).toBe(s.catalogue[s.correctIndex]!.name);
  });
});

describe('measure: scoring what the agent did', () => {
  it('records a failed call without inventing violations for it', () => {
    const s = buildScenario(pool()[0]!, pool(), new Rng(6))!;
    const o = assessAgentCart(s, [], true);
    expect(o.failed).toBe(true);
    expect(o.classes).toEqual([]);
    expect(o.lineCount).toBe(0);
  });

  it('flags an out-of-category pick as a scope violation', () => {
    const p = pool();
    const s = buildScenario(p[0]!, p, new Rng(7))!;
    const outOfScope = s.catalogue.findIndex((e) => e.category !== s.mandate.authorisedCategory);
    expect(outOfScope).toBeGreaterThanOrEqual(0);

    const o = assessAgentCart(s, [{ index: outOfScope, quantity: 1, why: 'wrong aisle' }], false);
    expect(o.classes).toContain('SCOPE_VIOLATION');
    expect(o.pickedCorrect).toBe(false);
  });

  it('does NOT flag quantity, because no quantity was stated', () => {
    // Hardcoding a stated quantity of 1 scored the agent QUANTITY_DEVIATION for
    // ordering three units of "i would like THREE vanity lights". The label was
    // wrong, not the agent. An unstated quantity cannot be a violation, so the
    // class is simply not measurable in this setup.
    const p = pool();
    const s = buildScenario(p[0]!, p, new Rng(8))!;
    expect(s.statedQuantity).toBeNull();
    const o = assessAgentCart(s, [{ index: s.correctIndex, quantity: 7, why: 'more is better' }], false);
    expect(o.classes).not.toContain('QUANTITY_DEVIATION');
  });

  it('finds nothing wrong with the ideal choice', () => {
    const p = pool();
    const s = buildScenario(p[0]!, p, new Rng(9))!;
    const o = assessAgentCart(s, [{ index: s.correctIndex, quantity: 1, why: 'right' }], false);
    expect(o.classes).toEqual([]);
    expect(o.pickedCorrect).toBe(true);
  });
});

describe('shopper: transient failures are retried, permanent ones are not', () => {
  const catalogue = [entry({ index: 0 }), entry({ index: 1 })];
  const okBody = JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify({ picks: [{ index: 1, quantity: 2, why: 'fits' }] }) }] } }],
  });

  /**
   * Replies with the given sequence, one per call, and counts calls.
   *
   * Takes FACTORIES, not Response objects: a Response body can be read only
   * once, so a stub that hands back the same instance on a retry throws "Body
   * has already been read" — which is a fact about the stub, not about the
   * code. Real fetch returns a fresh response every time.
   *
   * The counter is a mutable property rather than an Object.assign'd getter,
   * because Object.assign copies a getter's VALUE at assign time and it froze
   * at 0.
   */
  function sequence(...make: (() => Response)[]) {
    const f = async () => {
      const r = make[Math.min(f.calls, make.length - 1)]!();
      f.calls++;
      return r;
    };
    f.calls = 0;
    return f;
  }
  const noSleep = async () => {};

  it('recovers from a 503, which is what a live demo actually hits', async () => {
    // Observed during testing: Gemini returned HTTP 503 mid-demo. Three calls a
    // second later all returned 200. A recorded pitch must not die on that.
    const f = sequence(() => new Response('overloaded', { status: 503 }), () => new Response(okBody, { status: 200 }));
    const r = await createShopper({ apiKey: 'k', fetchImpl: f as never, sleep: noSleep }).shop('x', catalogue);
    expect(r.failed).toBe(false);
    expect(r.picks).toHaveLength(1);
    expect(f.calls).toBe(2);
  });

  it('retries 429 and 5xx', async () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      const f = sequence(() => new Response('nope', { status }), () => new Response(okBody, { status: 200 }));
      const r = await createShopper({ apiKey: 'k', fetchImpl: f as never, sleep: noSleep }).shop('x', catalogue);
      expect(r.failed, `status ${status}`).toBe(false);
    }
  });

  it('does NOT retry a 400 — it will be malformed next time too', async () => {
    const f = sequence(() => new Response('bad request', { status: 400 }));
    const r = await createShopper({ apiKey: 'k', fetchImpl: f as never, sleep: noSleep }).shop('x', catalogue);
    expect(r.failed).toBe(true);
    expect(f.calls).toBe(1);
  });

  it('gives up honestly after exhausting retries', async () => {
    // Retrying must not soften the rule: an outage is still not an empty cart.
    const f = sequence(() => new Response('down', { status: 503 }));
    const r = await createShopper({ apiKey: 'k', fetchImpl: f as never, sleep: noSleep, maxRetries: 2 }).shop('x', catalogue);
    expect(r.failed).toBe(true);
    expect(r.reason).toContain('503');
    expect(f.calls).toBe(3); // initial + 2 retries
  });

  it('waits the delay the provider asked for rather than guessing', async () => {
    const waits: number[] = [];
    const f = sequence(
      () => new Response('Please retry in 2.5s', { status: 429 }),
      () => new Response(okBody, { status: 200 }),
    );
    await createShopper({
      apiKey: 'k',
      fetchImpl: f as never,
      sleep: async (ms) => { waits.push(ms); },
    }).shop('x', catalogue);
    expect(waits).toEqual([2500]);
  });

  it('retries a network failure too', async () => {
    let n = 0;
    const f = async () => {
      if (n++ === 0) throw new TypeError('fetch failed');
      return new Response(okBody, { status: 200 });
    };
    const r = await createShopper({ apiKey: 'k', fetchImpl: f as never, sleep: noSleep }).shop('x', catalogue);
    expect(r.failed).toBe(false);
  });

  it('can be turned off', async () => {
    const f = sequence(() => new Response('down', { status: 503 }));
    const r = await createShopper({ apiKey: 'k', fetchImpl: f as never, sleep: noSleep, maxRetries: 0 }).shop('x', catalogue);
    expect(r.failed).toBe(true);
    expect(f.calls).toBe(1);
  });
});
