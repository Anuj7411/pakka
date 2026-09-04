/**
 * Payment-callback signature verification, and fetching a payment.
 *
 * Razorpay Checkout runs in the customer's browser and hands the page an order
 * id, a payment id and a signature. Those are three strings from an untrusted
 * place. This module is what makes them evidence rather than assertions, so its
 * failure modes are worth pinning individually: a verifier that throws instead
 * of returning false is a verifier an attacker can switch off with bad input.
 *
 * No network. `fetchImpl` is injected.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  createRazorpayClient,
  paymentSignatureMatches,
  type FetchLike,
} from '../src/razorpay/client.js';

const KEY_ID = 'rzp_test_abcdef123456';
const KEY_SECRET = 'sekrit_value_do_not_leak';

const ORDER = 'order_PinnedOrder01';
const PAYMENT = 'pay_PinnedPayment1';

const sign = (body: string, secret = KEY_SECRET): string =>
  createHmac('sha256', secret).update(body).digest('hex');

beforeEach(() => {
  process.env['RAZORPAY_KEY_ID'] = KEY_ID;
  process.env['RAZORPAY_KEY_SECRET'] = KEY_SECRET;
});
afterEach(() => {
  delete process.env['RAZORPAY_KEY_ID'];
  delete process.env['RAZORPAY_KEY_SECRET'];
});

describe('paymentSignatureMatches', () => {
  it('accepts the signature Razorpay would send', () => {
    expect(
      paymentSignatureMatches({
        orderId: ORDER,
        paymentId: PAYMENT,
        signature: sign(`${ORDER}|${PAYMENT}`),
        keySecret: KEY_SECRET,
      }),
    ).toBe(true);
  });

  /**
   * The concatenation order is pinned to a literal, not recomputed.
   *
   * Recomputing it with the same helper the implementation uses would pass just
   * as happily if both were `payment|order`, which verifies against a different
   * message and would accept a signature minted for a different pairing.
   */
  it('signs order_id|payment_id, in that order', () => {
    expect(
      paymentSignatureMatches({
        orderId: ORDER,
        paymentId: PAYMENT,
        signature: '2f4a5a77f4ae222c9a2d3af28e156ac8537e483529aceb47e7d3c7e200d68a54',
        keySecret: KEY_SECRET,
      }),
    ).toBe(true);

    // The same two ids the other way round must NOT verify.
    expect(
      paymentSignatureMatches({
        orderId: ORDER,
        paymentId: PAYMENT,
        signature: '4ffe4ddbc061a69ed9e4258e2b4ab9154ed858b4a7d2cda3789dcb182f9cd6ae',
        keySecret: KEY_SECRET,
      }),
    ).toBe(false);
  });

  it('rejects a signature minted under a different secret', () => {
    expect(
      paymentSignatureMatches({
        orderId: ORDER,
        paymentId: PAYMENT,
        signature: sign(`${ORDER}|${PAYMENT}`, 'not_the_secret'),
        keySecret: KEY_SECRET,
      }),
    ).toBe(false);
  });

  it('binds the order id: a signature for another order does not verify', () => {
    expect(
      paymentSignatureMatches({
        orderId: 'order_SomethingElse',
        paymentId: PAYMENT,
        signature: sign(`${ORDER}|${PAYMENT}`),
        keySecret: KEY_SECRET,
      }),
    ).toBe(false);
  });

  it('binds the payment id: a signature for another payment does not verify', () => {
    expect(
      paymentSignatureMatches({
        orderId: ORDER,
        paymentId: 'pay_SomethingElse',
        signature: sign(`${ORDER}|${PAYMENT}`),
        keySecret: KEY_SECRET,
      }),
    ).toBe(false);
  });

  /**
   * `timingSafeEqual` throws on unequal lengths. A verifier that propagated
   * that would let anyone disable the check by sending a short string, so the
   * length mismatch must return false rather than escape as an exception.
   */
  it('returns false, never throws, on a wrong-length signature', () => {
    for (const bad of ['', 'abc', 'f'.repeat(63), 'f'.repeat(65), 'f'.repeat(128)]) {
      expect(() =>
        paymentSignatureMatches({
          orderId: ORDER,
          paymentId: PAYMENT,
          signature: bad,
          keySecret: KEY_SECRET,
        }),
      ).not.toThrow();
      expect(
        paymentSignatureMatches({
          orderId: ORDER,
          paymentId: PAYMENT,
          signature: bad,
          keySecret: KEY_SECRET,
        }),
      ).toBe(false);
    }
  });

  it('returns false on a non-string signature rather than throwing', () => {
    for (const bad of [undefined, null, 12345, {}, []]) {
      expect(
        paymentSignatureMatches({
          orderId: ORDER,
          paymentId: PAYMENT,
          signature: bad as unknown as string,
          keySecret: KEY_SECRET,
        }),
      ).toBe(false);
    }
  });

  it('a correct signature of the right length but wrong content fails', () => {
    const right = sign(`${ORDER}|${PAYMENT}`);
    const flipped = (right[0] === 'a' ? 'b' : 'a') + right.slice(1);
    expect(flipped).toHaveLength(right.length);
    expect(
      paymentSignatureMatches({
        orderId: ORDER,
        paymentId: PAYMENT,
        signature: flipped,
        keySecret: KEY_SECRET,
      }),
    ).toBe(false);
  });
});

describe('fetchPayment', () => {
  /** A fresh Response per call: a body may only be read once. */
  function stubFetch(body: string): FetchLike & { calls: { url: string }[] } {
    const calls: { url: string }[] = [];
    const f = async (url: string) => {
      calls.push({ url });
      return new Response(body, { status: 200 });
    };
    return Object.assign(f, { calls });
  }

  it('asks Razorpay for the payment and returns what it says', async () => {
    const fetchImpl = stubFetch(
      JSON.stringify({
        id: PAYMENT,
        status: 'captured',
        method: 'upi',
        amount: 349900,
        currency: 'INR',
        order_id: ORDER,
        vpa: 'success@razorpay',
      }),
    );
    const client = createRazorpayClient({ fetchImpl });
    const payment = await client.fetchPayment(PAYMENT);

    expect(fetchImpl.calls[0]!.url).toBe(`https://api.razorpay.com/v1/payments/${PAYMENT}`);
    expect(payment.status).toBe('captured');
    expect(payment.order_id).toBe(ORDER);
    expect(payment.amount).toBe(349900);
  });

  it('encodes the payment id so it cannot steer the request elsewhere', async () => {
    const fetchImpl = stubFetch('{"id":"x","status":"failed","method":"upi","amount":0,"currency":"INR","order_id":null}');
    const client = createRazorpayClient({ fetchImpl });
    await client.fetchPayment('../orders/order_Evil');

    expect(fetchImpl.calls[0]!.url).toBe(
      'https://api.razorpay.com/v1/payments/..%2Forders%2Forder_Evil',
    );
  });

  it('reports a failed payment as data, not as an exception', async () => {
    const fetchImpl = stubFetch(
      JSON.stringify({
        id: PAYMENT,
        status: 'failed',
        method: 'upi',
        amount: 349900,
        currency: 'INR',
        order_id: ORDER,
        error_code: 'BAD_REQUEST_ERROR',
        error_description: 'Payment failed',
        error_reason: 'payment_failed',
        error_step: 'payment_authentication',
      }),
    );
    const client = createRazorpayClient({ fetchImpl });
    const payment = await client.fetchPayment(PAYMENT);

    expect(payment.status).toBe('failed');
    expect(payment.error_reason).toBe('payment_failed');
  });
});
