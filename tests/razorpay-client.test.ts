/**
 * The Razorpay Orders client.
 *
 * Coverage showed this module at 29.6% — the whole HTTP body had never run.
 * That is the wrong module to leave untested: its error branches decide whether
 * a failed order looks like a failed order or like a successful one, and the
 * request it builds is the one carrying the certificate link into Razorpay's
 * own records.
 *
 * No network here. `fetchImpl` is injected.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createRazorpayClient,
  RazorpayError,
  type CreateOrderInput,
  type FetchLike,
} from '../src/razorpay/client.js';

const KEY_ID = 'rzp_test_abcdef123456';
const KEY_SECRET = 'sekrit_value_do_not_leak';

beforeEach(() => {
  process.env['RAZORPAY_KEY_ID'] = KEY_ID;
  process.env['RAZORPAY_KEY_SECRET'] = KEY_SECRET;
});
afterEach(() => {
  delete process.env['RAZORPAY_KEY_ID'];
  delete process.env['RAZORPAY_KEY_SECRET'];
});

/** Captures what was sent and replies with whatever the test wants. */
function stubFetch(reply: { status: number; body: string }): FetchLike & {
  calls: { url: string; init: RequestInit }[];
} {
  const f = Object.assign(
    async (url: string, init: RequestInit) => {
      f.calls.push({ url, init });
      return new Response(reply.body, { status: reply.status });
    },
    { calls: [] as { url: string; init: RequestInit }[] },
  );
  return f;
}


/** Awaits a rejection and hands back a typed error, so tests read as assertions. */
async function rejection(p: Promise<unknown>): Promise<RazorpayError> {
  try {
    await p;
  } catch (e) {
    return e as RazorpayError;
  }
  throw new Error('expected a rejection, got a resolved value');
}

const ORDER_JSON = JSON.stringify({
  id: 'order_ABC123',
  amount: 129900,
  currency: 'INR',
  status: 'created',
  receipt: 'rcpt_1',
  notes: { conformance_decision: 'allow' },
  created_at: 1_756_000_000,
});

const validInput: CreateOrderInput = {
  amount: 129900,
  currency: 'INR',
  receipt: 'rcpt_1',
  notes: { conformance_decision: 'allow' },
  lineItems: [{ sku: 'a', name: 'Headphones', price: 129900, quantity: 1 }],
  lineItemsTotal: 129900,
};

describe('createOrder: the request it builds', () => {
  it('sends line_items and line_items_total in Razorpay shape', async () => {
    const f = stubFetch({ status: 200, body: ORDER_JSON });
    const client = createRazorpayClient({ fetchImpl: f });
    await client.createOrder({
      ...validInput,
      lineItems: [
        { sku: 'a', name: 'Headphones', price: 100, quantity: 2 },
        { sku: 'b', name: 'Cable', price: 50, quantity: 1, description: 'braided' },
      ],
      amount: 250,
      lineItemsTotal: 250,
    });

    const sent = JSON.parse(String(f.calls[0]!.init.body));
    expect(f.calls[0]!.url).toBe('https://api.razorpay.com/v1/orders');
    expect(f.calls[0]!.init.method).toBe('POST');
    expect(sent.line_items_total).toBe(250);
    expect(sent.amount).toBe(250);
    expect(sent.line_items).toEqual([
      { sku: 'a', name: 'Headphones', price: 100, quantity: 2 },
      { sku: 'b', name: 'Cable', price: 50, quantity: 1, description: 'braided' },
    ]);
  });

  it('omits description rather than sending null', async () => {
    const f = stubFetch({ status: 200, body: ORDER_JSON });
    await createRazorpayClient({ fetchImpl: f }).createOrder(validInput);
    const sent = JSON.parse(String(f.calls[0]!.init.body));
    expect('description' in sent.line_items[0]).toBe(false);
  });

  it('authenticates with basic auth over key id and secret', async () => {
    const f = stubFetch({ status: 200, body: ORDER_JSON });
    await createRazorpayClient({ fetchImpl: f }).createOrder(validInput);
    const auth = (f.calls[0]!.init.headers as Record<string, string>)['Authorization'];
    expect(auth).toBe(`Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`);
  });

  it('refuses a live key before it can reach the network', () => {
    process.env['RAZORPAY_KEY_ID'] = 'rzp_live_abcdef123456';
    const f = stubFetch({ status: 200, body: ORDER_JSON });
    // Not downgradable to a warning: the alternative is a project that can move
    // real money by typo.
    expect(() => createRazorpayClient({ fetchImpl: f })).toThrow();
    expect(f.calls).toHaveLength(0);
  });
});

describe('createOrder: guards that fire before any request', () => {
  it('refuses when line items do not sum to the stated total', async () => {
    const f = stubFetch({ status: 200, body: ORDER_JSON });
    const client = createRazorpayClient({ fetchImpl: f });
    await expect(
      client.createOrder({ ...validInput, lineItemsTotal: 999 }),
    ).rejects.toThrow(/sum to 129900 but line_items_total is 999/);
    expect(f.calls).toHaveLength(0);
  });

  it('refuses when the amount disagrees with the line items', async () => {
    // An order whose total disagrees with its line items is exactly the
    // divergence this project exists to catch.
    const f = stubFetch({ status: 200, body: ORDER_JSON });
    const client = createRazorpayClient({ fetchImpl: f });
    await expect(client.createOrder({ ...validInput, amount: 1 })).rejects.toThrow(
      /amount 1 does not equal line_items_total 129900/,
    );
    expect(f.calls).toHaveLength(0);
  });

  it('refuses a note that Razorpay would truncate', async () => {
    const f = stubFetch({ status: 200, body: ORDER_JSON });
    const client = createRazorpayClient({ fetchImpl: f });
    await expect(
      client.createOrder({ ...validInput, notes: { h: 'x'.repeat(513) } }),
    ).rejects.toThrow(RazorpayError);
    expect(f.calls).toHaveLength(0);
  });
});

describe('error paths: a failure must look like a failure', () => {
  it('propagates the HTTP status and Razorpay error code', async () => {
    const f = stubFetch({
      status: 400,
      body: JSON.stringify({
        error: { code: 'BAD_REQUEST_ERROR', description: 'amount must be at least 100' },
      }),
    });
    try {
      await createRazorpayClient({ fetchImpl: f }).createOrder(validInput);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RazorpayError);
      expect((e as RazorpayError).status).toBe(400);
      expect((e as RazorpayError).code).toBe('BAD_REQUEST_ERROR');
      expect((e as RazorpayError).message).toContain('amount must be at least 100');
    }
  });

  it('survives an error body with no description', async () => {
    const f = stubFetch({ status: 500, body: JSON.stringify({ error: {} }) });
    await expect(createRazorpayClient({ fetchImpl: f }).createOrder(validInput)).rejects.toThrow(
      /no description/,
    );
  });

  it('survives an error body with no error object at all', async () => {
    const f = stubFetch({ status: 502, body: JSON.stringify({ oops: true }) });
    const err = await rejection(createRazorpayClient({ fetchImpl: f }).createOrder(validInput));
    expect(err.status).toBe(502);
    expect(err.code).toBeNull();
  });

  it('reports a non-JSON body as such rather than crashing on the parse', async () => {
    // A gateway HTML error page is the common case, and a raw SyntaxError here
    // would be indistinguishable from a bug in our own serialisation.
    const f = stubFetch({ status: 503, body: '<html>upstream unavailable</html>' });
    const err = await rejection(createRazorpayClient({ fetchImpl: f }).createOrder(validInput));
    expect(err).toBeInstanceOf(RazorpayError);
    expect(err.message).toContain('not JSON');
    expect(err.status).toBe(503);
  });

  it('reports a timeout as a timeout', async () => {
    const slow: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    const err = await rejection(createRazorpayClient({ fetchImpl: slow, timeoutMs: 10 }).createOrder(validInput));
    expect(err.message).toMatch(/timed out after 10ms/);
    expect(err.status).toBe(0);
  });

  it('reports a network failure distinctly from a timeout', async () => {
    const dead: FetchLike = () => Promise.reject(new TypeError('fetch failed'));
    const err = await rejection(createRazorpayClient({ fetchImpl: dead }).createOrder(validInput));
    expect(err.message).toContain('network error');
    expect(err.message).not.toContain('timed out');
  });

  it('never puts the key secret in an error message', async () => {
    // The URL and headers carry credentials; a runtime that echoed the request
    // into the error would leak them into every log line and stack trace.
    const dead: FetchLike = () => Promise.reject(new Error(`connect failed to ${KEY_SECRET}`));
    const err = await rejection(createRazorpayClient({ fetchImpl: dead }).createOrder(validInput));
    expect(err.message).not.toContain(KEY_SECRET);
    expect(err.message).not.toContain(KEY_ID);
  });
});

describe('fetchOrder', () => {
  it('fetches by id', async () => {
    const f = stubFetch({ status: 200, body: ORDER_JSON });
    const order = await createRazorpayClient({ fetchImpl: f }).fetchOrder('order_ABC123');
    expect(f.calls[0]!.url).toBe('https://api.razorpay.com/v1/orders/order_ABC123');
    expect(order.id).toBe('order_ABC123');
  });

  it('encodes an id so it cannot steer the request elsewhere', async () => {
    // An order id arrives from a caller. Without encoding, "../payments/x"
    // would reach a different endpoint entirely.
    const f = stubFetch({ status: 200, body: ORDER_JSON });
    await createRazorpayClient({ fetchImpl: f }).fetchOrder('../payments/pay_evil');
    expect(f.calls[0]!.url).toBe(
      'https://api.razorpay.com/v1/orders/..%2Fpayments%2Fpay_evil',
    );
    expect(f.calls[0]!.url).not.toContain('/payments/pay_evil');
  });
});
