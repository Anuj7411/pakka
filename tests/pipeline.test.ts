/**
 * The gate end to end: decide, certify, record, then create an order.
 *
 * The ordering is the security property, so most of these tests are about what
 * exists at the moment something fails. A gate that decides correctly but
 * records nothing when it refuses is a gate with no evidence for the refusal.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluate,
  createOrder,
  recheckAtAuthorisation,
  certificateNotes,
  toLineItems,
  lineItemsTotal,
  GateRefusal,
} from '../src/gate/pipeline.js';
import { AuditLog } from '../src/audit/log.js';
import { generateSigner, verifierFromPublicKey } from '../src/cert/signing.js';
import { certificateHash, POLICY_VERSION, verifyCertificate } from '../src/cert/certificate.js';
import { SIZER_POLICY_VERSION } from '../src/sizer/reserve.js';
import { OC228_VERIFIER_VERSION } from '../src/verifier/oc228.js';
import { assertNotesFit, RazorpayError, type Order, type RazorpayClient, type CreateOrderInput } from '../src/razorpay/client.js';
import type { Provider } from '../src/semantic/provider.js';
import type { Cart, CartLine, Mandate, MandateItem } from '../src/corpus/types.js';

const signer = generateSigner();
const verifier = verifierFromPublicKey(signer.publicKeyBase64());

const HONEST: Provider = {
  id: 'honest',
  judge: async () => ({ verdict: 'satisfies', confidence: 1, reason: 'ok', failed: false }),
};
const OBJECTS: Provider = {
  id: 'objects',
  judge: async () => ({ verdict: 'wrong_product', confidence: 1, reason: 'no', failed: false }),
};
const DOWN: Provider = {
  id: 'down',
  judge: async () => ({ verdict: 'unsure', confidence: 0, reason: 'HTTP 429', failed: true }),
};

const item = (id: string, text: string): MandateItem => ({
  itemId: id,
  text,
  statedAttributes: [],
  statedOptions: [],
  statedQuantity: null,
  sourceAsin: `B0000${id}`,
});

const line = (id: string, name: string, over: Partial<CartLine> = {}): CartLine => ({
  lineId: id,
  answersItemId: null,
  sku: `sku-${id}`,
  name,
  brand: null,
  priceMinor: 129900,
  quantity: 1,
  categoryPath: ['Electronics'],
  options: [],
  attributes: [],
  ...over,
});

const mandate: Mandate = {
  mandateId: 'm0',
  text: 'bluetooth headphones',
  items: [item('i0', 'bluetooth headphones')],
  authorisedCategory: 'Electronics',
};
const cleanCart: Cart = { cartId: 'c0', lines: [line('l0', 'bluetooth headphones')] };
const scopeViolatingCart: Cart = {
  cartId: 'c1',
  lines: [line('l0', 'bluetooth headphones', { categoryPath: ['Garden'] })],
};

/** Records what was sent without touching the network. */
function fakeClient(): RazorpayClient & { created: CreateOrderInput[] } {
  const c = {
    created: [] as CreateOrderInput[],
    createOrder: async (input: CreateOrderInput): Promise<Order> => {
      c.created.push(input);
      return {
        id: `order_${c.created.length}`,
        amount: input.amount,
        currency: input.currency,
        status: 'created',
        receipt: input.receipt,
        notes: input.notes,
        created_at: 1_756_000_000,
      };
    },
    fetchOrder: async (): Promise<Order> => {
      throw new Error('not used');
    },
  };
  return c;
}

function withLog<T>(fn: (log: AuditLog) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'pipe-'));
  try {
    return fn(new AuditLog(join(dir, 'audit.jsonl')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

describe('evaluate: decide, certify, record', () => {
  it('records the certificate before anything else can happen', async () => {
    await withLog(async (log) => {
      const certified = await evaluate({ mandate, cart: cleanCart, provider: HONEST, signer, log });
      expect(log.length).toBe(1);
      expect(AuditLog.verify(log.path, verifier).ok).toBe(true);
      expect(certified.decision).toBe('allow');
    });
  });

  it('records a refusal as durably as an approval', async () => {
    // A gate with no evidence for its refusals is a gate nobody can audit.
    await withLog(async (log) => {
      const certified = await evaluate({
        mandate,
        cart: scopeViolatingCart,
        provider: HONEST,
        signer,
        log,
      });
      expect(certified.decision).toBe('block');
      expect(log.length).toBe(1);
      expect(AuditLog.read(log.path)[0]!.decision).toBe('block');
    });
  });

  it('binds the cart it actually saw', async () => {
    await withLog(async (log) => {
      const a = await evaluate({ mandate, cart: cleanCart, provider: HONEST, signer, log });
      const b = await evaluate({
        mandate,
        cart: scopeViolatingCart,
        provider: HONEST,
        signer,
        log,
      });
      expect(a.certificate.cart_hash).not.toBe(b.certificate.cart_hash);
    });
  });

  it('chains successive decisions', async () => {
    await withLog(async (log) => {
      for (let i = 0; i < 3; i++) {
        await evaluate({ mandate, cart: cleanCart, provider: HONEST, signer, log });
      }
      const chain = AuditLog.read(log.path);
      expect(chain).toHaveLength(3);
      expect(chain[1]!.prev_hash).toBe(certificateHash(chain[0]!));
      expect(chain[2]!.prev_hash).toBe(certificateHash(chain[1]!));
      expect(AuditLog.verify(log.path, verifier).ok).toBe(true);
    });
  });

  it('marks a run degraded when the model was unreachable, and caps it at escalate', async () => {
    await withLog(async (log) => {
      const certified = await evaluate({ mandate, cart: cleanCart, provider: DOWN, signer, log });
      expect(certified.degraded).toBe(true);
      expect(certified.certificate.degraded).toBe(true);
      expect(certified.decision).toBe('escalate');
    });
  });

  it('records the model id, or that there was none', async () => {
    await withLog(async (log) => {
      const withModel = await evaluate({
        mandate,
        cart: cleanCart,
        provider: HONEST,
        signer,
        log,
        model: { id: 'gemini-3.1-flash-lite', temperature: 0 },
      });
      expect(withModel.certificate.model).toEqual({ id: 'gemini-3.1-flash-lite', temperature: 0 });
    });
  });
});

describe('createOrder: unreachable without a decision', () => {
  it('creates the order on allow, carrying the certificate reference', async () => {
    await withLog(async (log) => {
      const client = fakeClient();
      const certified = await evaluate({ mandate, cart: cleanCart, provider: HONEST, signer, log });
      const order = await createOrder({ certified, client, receipt: 'rcpt_1' });

      expect(client.created).toHaveLength(1);
      expect(order.notes['conformance_certificate_id']).toBe(certified.certificate.certificate_id);
      expect(order.notes['conformance_cart_hash']).toBe(certified.certificate.cart_hash);
      expect(order.notes['conformance_certificate_hash']).toBe(
        certificateHash(certified.certificate),
      );
    });
  });

  it('refuses to create an order on block, and creates nothing', async () => {
    await withLog(async (log) => {
      const client = fakeClient();
      const certified = await evaluate({
        mandate,
        cart: scopeViolatingCart,
        provider: HONEST,
        signer,
        log,
      });
      await expect(createOrder({ certified, client, receipt: 'r' })).rejects.toThrow(GateRefusal);
      expect(client.created).toHaveLength(0);
      // The decision is still on the record. Refusing is not forgetting.
      expect(log.length).toBe(1);
    });
  });

  it('refuses on escalate unless the caller says so explicitly', async () => {
    // A default that proceeds turns "needs review" into "shipped" for anyone
    // who forgot the flag.
    await withLog(async (log) => {
      const client = fakeClient();
      const certified = await evaluate({ mandate, cart: cleanCart, provider: OBJECTS, signer, log });
      expect(certified.decision).toBe('escalate');

      await expect(createOrder({ certified, client, receipt: 'r' })).rejects.toThrow(GateRefusal);
      expect(client.created).toHaveLength(0);

      const order = await createOrder({ certified, client, receipt: 'r', allowEscalated: true });
      expect(order.id).toBeTruthy();
      expect(client.created).toHaveLength(1);
    });
  });

  it('never lets allowEscalated rescue a block', async () => {
    await withLog(async (log) => {
      const client = fakeClient();
      const certified = await evaluate({
        mandate,
        cart: scopeViolatingCart,
        provider: HONEST,
        signer,
        log,
      });
      await expect(
        createOrder({ certified, client, receipt: 'r', allowEscalated: true }),
      ).rejects.toThrow(GateRefusal);
      expect(client.created).toHaveLength(0);
    });
  });

  it('sends line items whose sum equals the amount it charges', async () => {
    await withLog(async (log) => {
      const client = fakeClient();
      const twoLines: Cart = {
        cartId: 'c2',
        lines: [
          line('l0', 'bluetooth headphones', { priceMinor: 129900, quantity: 2 }),
          line('l1', 'usb charging cable', { priceMinor: 49900, quantity: 3 }),
        ],
      };
      const m: Mandate = {
        ...mandate,
        items: [item('i0', 'bluetooth headphones'), item('i1', 'usb charging cable')],
      };
      const certified = await evaluate({ mandate: m, cart: twoLines, provider: HONEST, signer, log });
      await createOrder({ certified, client, receipt: 'r' });

      const sent = client.created[0]!;
      expect(sent.lineItemsTotal).toBe(129900 * 2 + 49900 * 3);
      expect(sent.amount).toBe(sent.lineItemsTotal);
      expect(sent.lineItems.reduce((n, l) => n + l.price * l.quantity, 0)).toBe(sent.amount);
    });
  });
});

describe('notes: the audit link must survive Razorpay', () => {
  it('fits inside the documented limits', async () => {
    await withLog(async (log) => {
      const certified = await evaluate({ mandate, cart: cleanCart, provider: HONEST, signer, log });
      const notes = certificateNotes(certified.certificate);
      expect(() => assertNotesFit(notes)).not.toThrow();
      expect(Object.keys(notes).length).toBeLessThanOrEqual(15);
      for (const v of Object.values(notes)) expect(v.length).toBeLessThanOrEqual(512);
    });
  });

  it('rejects a note that would be silently truncated', () => {
    // A truncated hash is a broken audit link that looks like a working one.
    expect(() => assertNotesFit({ h: 'x'.repeat(513) })).toThrow(RazorpayError);
    expect(() => assertNotesFit({ h: 'x'.repeat(513) })).toThrow(/513 characters/);
  });

  it('names the key, never the value', () => {
    try {
      assertNotesFit({ secret_ish: 'y'.repeat(600) });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('secret_ish');
      expect((e as Error).message).not.toContain('yyy');
    }
  });

  it('rejects more keys than Razorpay accepts', () => {
    const many = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, 'v']));
    expect(() => assertNotesFit(many)).toThrow(/16 keys/);
  });
});

describe('re-check at authorisation: the one hard block', () => {
  async function setup(log: AuditLog) {
    const client = fakeClient();
    const certified = await evaluate({ mandate, cart: cleanCart, provider: HONEST, signer, log });
    const order = await createOrder({ certified, client, receipt: 'r' });
    return { certified, order };
  }

  it('passes when the cart is byte-identical', async () => {
    await withLog(async (log) => {
      const { certified, order } = await setup(log);
      const out = recheckAtAuthorisation({
        order,
        cartAtAuthorisation: cleanCart,
        original: certified.certificate,
        signer,
        log,
      });
      expect(out.ok).toBe(true);
      expect(AuditLog.verify(log.path, verifier).ok).toBe(true);
    });
  });

  it('blocks when a price changed after authorisation', async () => {
    await withLog(async (log) => {
      const { certified, order } = await setup(log);
      const swapped: Cart = {
        ...cleanCart,
        lines: [line('l0', 'bluetooth headphones', { priceMinor: 1 })],
      };
      const out = recheckAtAuthorisation({
        order,
        cartAtAuthorisation: swapped,
        original: certified.certificate,
        signer,
        log,
      });
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe('cart-mutated');
      expect(out.certificate.decision).toBe('block');
    });
  });

  it('blocks on a quantity change, however small', async () => {
    // There is nothing to weigh here: either the bytes authorised are the bytes
    // being charged for, or they are not.
    await withLog(async (log) => {
      const { certified, order } = await setup(log);
      const out = recheckAtAuthorisation({
        order,
        cartAtAuthorisation: {
          ...cleanCart,
          lines: [line('l0', 'bluetooth headphones', { quantity: 2 })],
        },
        original: certified.certificate,
        signer,
        log,
      });
      expect(out.ok).toBe(false);
      expect(out.certificate.decision).toBe('block');
    });
  });

  it('blocks when the order does not reference this certificate', async () => {
    await withLog(async (log) => {
      const { certified, order } = await setup(log);
      const tamperedOrder = { ...order, notes: { ...order.notes, conformance_certificate_hash: 'sha256:0' } };
      const out = recheckAtAuthorisation({
        order: tamperedOrder,
        cartAtAuthorisation: cleanCart,
        original: certified.certificate,
        signer,
        log,
      });
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe('certificate-mismatch');
    });
  });

  it('names the order, which the first certificate could not', async () => {
    await withLog(async (log) => {
      const { certified, order } = await setup(log);
      expect(certified.certificate.order_id).toBeNull();
      const out = recheckAtAuthorisation({
        order,
        cartAtAuthorisation: cleanCart,
        original: certified.certificate,
        signer,
        log,
      });
      expect(out.certificate.order_id).toBe(order.id);
    });
  });

  it('records the check even when it passes', async () => {
    // A re-check that recorded nothing on success would leave no evidence that
    // it ever ran.
    await withLog(async (log) => {
      const { certified, order } = await setup(log);
      const before = log.length;
      recheckAtAuthorisation({
        order,
        cartAtAuthorisation: cleanCart,
        original: certified.certificate,
        signer,
        log,
      });
      expect(log.length).toBe(before + 1);
    });
  });

  it('carries the current policy version so a rule change is visible', async () => {
    await withLog(async (log) => {
      const { certified, order } = await setup(log);
      const out = recheckAtAuthorisation({
        order,
        cartAtAuthorisation: cleanCart,
        original: certified.certificate,
        signer,
        log,
      });
      expect(out.certificate.policy_version).toBe(POLICY_VERSION);
    });
  });
});

describe('cart to line items', () => {
  it('uses minor units, as Razorpay does', () => {
    const items = toLineItems(cleanCart);
    expect(items[0]!.price).toBe(129900);
    expect(lineItemsTotal(cleanCart)).toBe(129900);
  });

  it('multiplies by quantity', () => {
    const cart: Cart = { cartId: 'c', lines: [line('l0', 'x', { priceMinor: 100, quantity: 7 })] };
    expect(lineItemsTotal(cart)).toBe(700);
  });

  it('is empty for an empty cart rather than throwing', () => {
    expect(toLineItems({ cartId: 'c', lines: [] })).toEqual([]);
    expect(lineItemsTotal({ cartId: 'c', lines: [] })).toBe(0);
  });
});

describe('reserve: the sizer proposes, the verifier disposes', () => {
  const ctx = { merchantId: 'merchant-1', customerId: 'customer-1' };

  it('computes no reserve unless asked', async () => {
    // A reserve on a plain card order would be a number on the certificate that
    // nothing acts on.
    await withLog(async (log) => {
      const c = await evaluate({ mandate, cart: cleanCart, provider: HONEST, signer, log });
      expect(c.certificate.reserve).toBeNull();
    });
  });

  it('records the amount and an independent OC-228 proof', async () => {
    await withLog(async (log) => {
      const c = await evaluate({
        mandate,
        cart: cleanCart,
        provider: HONEST,
        signer,
        log,
        reserve: ctx,
      });
      const r = c.certificate.reserve!;
      expect(r.amount_paise).toBe(136_395); // 129900 + 5% headroom, rounded up
      expect(r.rationale_code).toBe('CART_PLUS_HEADROOM');
      expect(r.fundable).toBe(true);
      expect(r.constraint_proof.oc228).toBe('pass');
      expect(r.constraint_proof.violations).toEqual([]);
      // Both versions recorded, because the number and the judgement on it come
      // from different modules.
      expect(r.sizer_policy_version).toBe(SIZER_POLICY_VERSION);
      expect(r.constraint_proof.verifier_version).toBe(OC228_VERIFIER_VERSION);
    });
  });

  it('reports an unfundable cart as unfundable, and that is not a violation', async () => {
    // Declining to block is lawful. Blocking the maximum and failing at debit
    // time would not be.
    await withLog(async (log) => {
      const huge: Cart = {
        cartId: 'c-huge',
        lines: [line('l0', 'bluetooth headphones', { priceMinor: 50_000_00 })],
      };
      const c = await evaluate({
        mandate,
        cart: huge,
        provider: HONEST,
        signer,
        log,
        reserve: ctx,
      });
      const r = c.certificate.reserve!;
      expect(r.fundable).toBe(false);
      expect(r.amount_paise).toBe(0);
      expect(r.rationale_code).toBe('CART_EXCEEDS_MAX_BLOCK');
      expect(r.constraint_proof.oc228).toBe('pass');
    });
  });

  it('the reserve is inside the signature, so it cannot be edited after the fact', async () => {
    await withLog(async (log) => {
      const c = await evaluate({
        mandate,
        cart: cleanCart,
        provider: HONEST,
        signer,
        log,
        reserve: ctx,
      });
      const inflated = {
        ...c.certificate,
        reserve: { ...c.certificate.reserve!, amount_paise: 1_000_000 },
      };
      expect(verifyCertificate(inflated, verifier).ok).toBe(false);
    });
  });

  it('never proposes a reserve its own verifier rejects', async () => {
    // The pipeline has a branch that raises the decision when the verifier
    // rejects the sizer. It is defensive: the two modules are written to agree,
    // and simulateLegal checks that at scale over thousands of sequences. This
    // pins it at the pipeline level too, across the price range where the
    // ceiling and the headroom interact.
    await withLog(async (log) => {
      for (const priceMinor of [1, 100, 950_00, 999_99, 1_000_00, 9_500_00, 9_999_99, 10_000_00]) {
        const c = await evaluate({
          mandate,
          cart: { cartId: `c-${priceMinor}`, lines: [line('l0', 'bluetooth headphones', { priceMinor })] },
          provider: HONEST,
          signer,
          log,
          reserve: ctx,
        });
        expect(c.certificate.reserve!.constraint_proof.oc228, `at ${priceMinor} paise`).toBe('pass');
      }
    });
  });
});
