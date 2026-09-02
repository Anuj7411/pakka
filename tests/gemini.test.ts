/**
 * The Gemini adapter.
 *
 * Whole-repo mutation testing scored this file at 10.7%, with 61 mutants having
 * NO COVERAGE AT ALL — the PII egress guard, the 429 handling, the response
 * parse and the catch block had never been executed by a test.
 *
 * That is the wrong file to leave unexercised. Its untested error handling is
 * precisely what produced the fabricated Day 4 ablation: a rate limit came back
 * indistinguishable from a considered judgement, 68 of 74 calls had 429'd, and
 * the run published "the model contributes 0.6%".
 *
 * No network here. `fetchImpl` and `apiKey` are injected.
 */
import { describe, it, expect } from 'vitest';
import { createGeminiProvider } from '../src/semantic/gemini.js';
import { containsForbiddenField } from '../src/semantic/redact.js';
import { ConfigError } from '../src/config/env.js';

const REQ = { system: 'you are a judge', user: 'is this right?' };

/** A well-formed Gemini reply wrapping our verdict schema. */
function ok(verdict: unknown, init: ResponseInit = {}): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(verdict) }] } }] }),
    { status: 200, ...init },
  );
}

function capture(): { calls: { url: string; init: RequestInit }[]; impl: typeof fetch } {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return ok({ verdict: 'satisfies', confidence: 0.9, reason: 'fine' });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe('gemini: the request it builds', () => {
  it('pins the model in the URL and decodes deterministically', async () => {
    // A sampled judge cannot be reproduced, and a result that cannot be
    // reproduced is not a measurement.
    const { calls, impl } = capture();
    await createGeminiProvider({ apiKey: 'k', fetchImpl: impl, model: 'gemini-3.1-flash-lite' }).judge(REQ);

    expect(calls[0]!.url).toContain('gemini-3.1-flash-lite:generateContent');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.generationConfig.temperature).toBe(0);
    expect(body.generationConfig.candidateCount).toBe(1);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema).toBeDefined();
  });

  it('sends the key in a header, never in the URL', async () => {
    // A URL reaches proxy logs and error strings; a header does not.
    const { calls, impl } = capture();
    await createGeminiProvider({ apiKey: 'super-secret-key', fetchImpl: impl }).judge(REQ);
    expect(calls[0]!.url).not.toContain('super-secret-key');
    expect((calls[0]!.init.headers as Record<string, string>)['x-goog-api-key']).toBe(
      'super-secret-key',
    );
  });

  it('carries the system instruction separately from the user content', async () => {
    const { calls, impl } = capture();
    await createGeminiProvider({ apiKey: 'k', fetchImpl: impl }).judge(REQ);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.systemInstruction.parts[0].text).toBe(REQ.system);
    expect(body.contents[0].parts[0].text).toBe(REQ.user);
  });

  it('reports the provider id it was configured with', () => {
    expect(createGeminiProvider({ apiKey: 'k', model: 'gemini-2.5-flash' }).id).toBe(
      'gemini-2.5-flash',
    );
  });
});

describe('gemini: the last gate before egress', () => {
  it('builds a payload with no forbidden field in it, whatever it is handed', async () => {
    // The guard cannot fire through this API and that is deliberate, so what is
    // pinned here is the INVARIANT it protects rather than the guard itself.
    //
    // containsForbiddenField matches a name in unescaped quotes, i.e. a real
    // JSON key. Caller text is a string value, so its quotes are escaped and a
    // product named "Address Book" is not a false alarm. The guard therefore
    // only fires if a refactor puts a personal-data field into the body SHAPE —
    // which is what it is for, and which this test would catch.
    const { calls, impl } = capture();
    const hostile = JSON.stringify({ customer: { email: 'a@b.c' }, shipping_address: 'x' });
    await createGeminiProvider({ apiKey: 'k', fetchImpl: impl }).judge({ system: 's', user: hostile });

    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(containsForbiddenField(body)).toBeNull();
    // The keys the adapter actually sends, so adding one is a visible change.
    expect(Object.keys(body).sort()).toEqual(['contents', 'generationConfig', 'systemInstruction']);
  });

  it('does not false-alarm on product text that merely mentions a forbidden word', async () => {
    // "Address Book", "IP65 rated", "Contact Lens Solution" are real product
    // names. Refusing to send them would break the gate for honest catalogues.
    const { calls, impl } = capture();
    const provider = createGeminiProvider({ apiKey: 'k', fetchImpl: impl });
    for (const text of ['Leather Address Book', 'IP65 Waterproof Speaker', 'Contact Lens Solution']) {
      await provider.judge({ system: 's', user: text });
    }
    expect(calls).toHaveLength(3);
  });

  it('sends ordinary product text without complaint', async () => {
    const { calls, impl } = capture();
    await createGeminiProvider({ apiKey: 'k', fetchImpl: impl }).judge({
      system: 's',
      user: 'Wireless Bluetooth Headphones, Over-Ear, colour blue',
    });
    expect(calls).toHaveLength(1);
  });

  it('refuses without a key rather than calling unauthenticated', async () => {
    const saved = process.env['GEMINI_API_KEY'];
    delete process.env['GEMINI_API_KEY'];
    try {
      const { calls, impl } = capture();
      // ConfigError, from the env reader — the variable is named, the value
      // never is.
      await expect(createGeminiProvider({ fetchImpl: impl }).judge(REQ)).rejects.toThrow(
        ConfigError,
      );
      expect(calls).toHaveLength(0);
    } finally {
      if (saved !== undefined) process.env['GEMINI_API_KEY'] = saved;
    }
  });
});

describe('gemini: a failure must be distinguishable from a judgement', () => {
  const failing = (status: number, body = '') =>
    createGeminiProvider({
      apiKey: 'k',
      fetchImpl: (async () => new Response(body, { status })) as unknown as typeof fetch,
    });

  it('marks an HTTP error as failed, not as an unsure verdict', async () => {
    // The incident: `unsure` with failed unset is indistinguishable from a
    // considered abstention, and the cache then stored it permanently.
    const v = await failing(429).judge(REQ);
    expect(v.failed).toBe(true);
    expect(v.verdict).toBe('unsure');
    expect(v.confidence).toBe(0);
  });

  it('reports the status only, never the response body', async () => {
    // A provider error can echo the request back, and this string reaches logs.
    const v = await failing(400, 'ERROR: user text was "buy me a blue widget"').judge(REQ);
    expect(v.reason).toBe('provider HTTP 400');
    expect(v.reason).not.toContain('blue widget');
  });

  it('surfaces the retry delay the provider asked for, from the body', async () => {
    // Blind exponential backoff reached 60s while the server asked for 4.
    const v = await failing(429, 'Rate limited. Please retry in 3.99s.').judge(REQ);
    expect(v.retryAfterMs).toBe(3990);
  });

  it('reads the delay from a structured retryDelay field too', async () => {
    const v = await failing(429, JSON.stringify({ error: { details: [{ retryDelay: '7s' }] } })).judge(
      REQ,
    );
    expect(v.retryAfterMs).toBe(7000);
  });

  it('prefers the Retry-After header when there is one', async () => {
    const provider = createGeminiProvider({
      apiKey: 'k',
      fetchImpl: (async () =>
        new Response('retry in 99s', {
          status: 429,
          headers: { 'retry-after': '2' },
        })) as unknown as typeof fetch,
    });
    expect((await provider.judge(REQ)).retryAfterMs).toBe(2000);
  });

  it('omits the delay entirely when the provider states none', async () => {
    // Absent, not zero: zero would be read as "retry immediately".
    const v = await failing(500, 'internal error').judge(REQ);
    expect(v.failed).toBe(true);
    expect(v.retryAfterMs).toBeUndefined();
  });

  it('ignores a nonsensical stated delay', async () => {
    const provider = createGeminiProvider({
      apiKey: 'k',
      fetchImpl: (async () =>
        new Response('', { status: 429, headers: { 'retry-after': 'tomorrow' } })) as unknown as typeof fetch,
    });
    expect((await provider.judge(REQ)).retryAfterMs).toBeUndefined();
  });

  it('marks a timeout as a timeout', async () => {
    const provider = createGeminiProvider({
      apiKey: 'k',
      timeoutMs: 5,
      fetchImpl: ((_u: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            rej(e);
          });
        })) as unknown as typeof fetch,
    });
    const v = await provider.judge(REQ);
    expect(v.failed).toBe(true);
    expect(v.reason).toBe('provider timeout');
  });

  it('marks a transport failure distinctly from a timeout', async () => {
    const provider = createGeminiProvider({
      apiKey: 'k',
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    const v = await provider.judge(REQ);
    expect(v.failed).toBe(true);
    expect(v.reason).toBe('provider transport error');
  });
});

describe('gemini: reading the response', () => {
  const replying = (body: string) =>
    createGeminiProvider({
      apiKey: 'k',
      fetchImpl: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
    });

  it('parses a well-formed verdict', async () => {
    const provider = createGeminiProvider({
      apiKey: 'k',
      fetchImpl: (async () =>
        ok({ verdict: 'wrong_product', confidence: 1, reason: 'it is a toaster' })) as unknown as typeof fetch,
    });
    const v = await provider.judge(REQ);
    expect(v.verdict).toBe('wrong_product');
    expect(v.reason).toBe('it is a toaster');
    expect(v.failed).toBe(false);
  });

  it('treats a response with no candidates as unsure rather than crashing', async () => {
    const v = await replying(JSON.stringify({ candidates: [] })).judge(REQ);
    expect(v.verdict).toBe('unsure');
  });

  it('treats a shape surprise as unsure', async () => {
    for (const body of ['{}', JSON.stringify({ candidates: [{}] }), JSON.stringify({ nope: 1 })]) {
      const v = await replying(body).judge(REQ);
      expect(v.verdict, body).toBe('unsure');
    }
  });

  it('treats an unparseable body as unsure, never as an exception', async () => {
    await expect(replying('<html>gateway error</html>').judge(REQ)).resolves.toBeDefined();
    const v = await replying('<html>gateway error</html>').judge(REQ);
    expect(v.verdict).toBe('unsure');
  });

  it('never returns a verdict outside the schema', async () => {
    const v = await replying(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"verdict":"approve_it"}' }] } }] }),
    ).judge(REQ);
    expect(['satisfies', 'wrong_product', 'unsure']).toContain(v.verdict);
  });
});
