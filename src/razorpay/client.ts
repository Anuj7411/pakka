/**
 * Razorpay Orders API client.
 *
 * Deliberately thin: no SDK, no retry-everything wrapper, no ambient state. The
 * gate's correctness must not depend on a third-party client's behaviour under
 * error, and a hand-rolled 200 lines we can read beats a dependency we cannot.
 *
 * ── What this file refuses to do ────────────────────────────────────────────
 *  - Log or embed the key secret. Errors name the field, never the value.
 *  - Run against a live key. `razorpayCredentials()` throws on anything that is
 *    not `rzp_test_`, and that guard is not downgradable to a warning: the
 *    alternative is a project that can move real money by typo.
 *  - Retry a non-idempotent create. A retried order creation is a duplicate
 *    order, which is worse than a failed one.
 */
import { razorpayCredentials } from '../config/env.js';

const API_BASE = 'https://api.razorpay.com/v1';

/** Razorpay rejects notes values over 512 characters and at most 15 keys. */
const NOTE_VALUE_MAX = 512;
const NOTE_KEY_MAX = 15;

export class RazorpayError extends Error {
  override readonly name = 'RazorpayError';
  readonly status: number;
  /** Razorpay's own error code, when it sent one. */
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface LineItem {
  readonly name: string;
  readonly sku: string;
  /** Minor units (paise). Razorpay speaks only in minor units. */
  readonly price: number;
  readonly quantity: number;
  readonly description?: string;
}

export interface CreateOrderInput {
  /** Minor units. Must equal the sum of line item price x quantity. */
  readonly amount: number;
  readonly currency: string;
  readonly receipt: string;
  readonly notes: Readonly<Record<string, string>>;
  readonly lineItems: readonly LineItem[];
  readonly lineItemsTotal: number;
}

export interface Order {
  readonly id: string;
  readonly amount: number;
  readonly currency: string;
  readonly status: string;
  readonly receipt: string | null;
  readonly notes: Readonly<Record<string, string>>;
  readonly created_at: number;
}

export interface RazorpayClient {
  createOrder(input: CreateOrderInput): Promise<Order>;
  fetchOrder(orderId: string): Promise<Order>;
}

/**
 * Notes are the only field we control that survives into Razorpay's own
 * records, so it is where the certificate reference lives. Validated here
 * because a silently truncated note is a broken audit link.
 */
export function assertNotesFit(notes: Readonly<Record<string, string>>): void {
  const keys = Object.keys(notes);
  if (keys.length > NOTE_KEY_MAX) {
    throw new RazorpayError(
      `notes carries ${keys.length} keys; Razorpay accepts at most ${NOTE_KEY_MAX}.`,
      0,
      null,
    );
  }
  for (const [k, v] of Object.entries(notes)) {
    if (v.length > NOTE_VALUE_MAX) {
      // Names the key and the length, never the value: notes can carry
      // certificate hashes and we do not want them in a stack trace by accident.
      throw new RazorpayError(
        `notes.${k} is ${v.length} characters; Razorpay truncates above ${NOTE_VALUE_MAX}, ` +
          'which would silently break the certificate link.',
        0,
        null,
      );
    }
  }
}

/**
 * The subset of `fetch` this client uses.
 *
 * Injectable so the error paths are testable. An HTTP client for a payments API
 * whose timeout, non-JSON and HTTP-error branches have never run is a client
 * whose failure modes are guesses — and those branches are the ones that decide
 * whether a failed order looks like a failed order or like a successful one.
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchLike;
}

export function createRazorpayClient(opts: ClientOptions = {}): RazorpayClient {
  // Read once, at construction: a credential that changes under a running
  // process is a configuration bug, not a feature.
  const { keyId, keySecret } = razorpayCredentials();
  const authorization = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));

  async function call(path: string, init: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await doFetch(`${API_BASE}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      });
    } catch (e) {
      // The message could otherwise carry the URL with credentials in some
      // runtimes. Report the shape of the failure, not the request.
      const reason = e instanceof Error && e.name === 'AbortError' ? 'timed out' : 'network error';
      throw new RazorpayError(`Razorpay request ${reason} after ${timeoutMs}ms`, 0, null);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new RazorpayError(
        `Razorpay returned HTTP ${response.status} with a body that is not JSON`,
        response.status,
        null,
      );
    }

    if (!response.ok) {
      const err = (body as { error?: { description?: string; code?: string } }).error;
      throw new RazorpayError(
        `Razorpay HTTP ${response.status}: ${err?.description ?? 'no description'}`,
        response.status,
        err?.code ?? null,
      );
    }
    return body;
  }

  return {
    async createOrder(input: CreateOrderInput): Promise<Order> {
      assertNotesFit(input.notes);
      // Checked here rather than trusted from the caller: an order whose total
      // disagrees with its line items is exactly the divergence this project
      // exists to catch, and shipping one would be embarrassing.
      const summed = input.lineItems.reduce((n, l) => n + l.price * l.quantity, 0);
      if (summed !== input.lineItemsTotal) {
        throw new RazorpayError(
          `line_items sum to ${summed} but line_items_total is ${input.lineItemsTotal}`,
          0,
          null,
        );
      }
      if (input.amount !== input.lineItemsTotal) {
        throw new RazorpayError(
          `amount ${input.amount} does not equal line_items_total ${input.lineItemsTotal}`,
          0,
          null,
        );
      }
      return (await call('/orders', {
        method: 'POST',
        body: JSON.stringify({
          amount: input.amount,
          currency: input.currency,
          receipt: input.receipt,
          notes: input.notes,
          line_items_total: input.lineItemsTotal,
          line_items: input.lineItems.map((l) => ({
            sku: l.sku,
            name: l.name,
            price: l.price,
            quantity: l.quantity,
            ...(l.description === undefined ? {} : { description: l.description }),
          })),
        }),
      })) as Order;
    },

    async fetchOrder(orderId: string): Promise<Order> {
      // Path-injected ids are encoded: an order id is caller-supplied and we do
      // not want it steering the request to another endpoint.
      return (await call(`/orders/${encodeURIComponent(orderId)}`)) as Order;
    },
  };
}
