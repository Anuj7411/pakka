/**
 * Day 6 demo: the gate in front of real Razorpay test rails.
 *
 * Creates orders in TEST mode only — `razorpayCredentials()` refuses anything
 * that is not `rzp_test_`. No money moves.
 *
 *   npx tsx scripts/demo-order.ts
 */
import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import { evaluate, createOrder, recheckAtAuthorisation, GateRefusal } from '../src/gate/pipeline.js';
import { createRazorpayClient } from '../src/razorpay/client.js';
import { AuditLog } from '../src/audit/log.js';
import { signerFromEnv, verifierFromPublicKey } from '../src/cert/signing.js';
import { certificateHash } from '../src/cert/certificate.js';
import { NULL_PROVIDER, CallBudget, VerdictCache, withCacheAndBudget, withRateLimit } from '../src/semantic/provider.js';
import { createGeminiProvider } from '../src/semantic/gemini.js';
import { hasGeminiKey } from '../src/config/env.js';
import type { Cart, Mandate } from '../src/corpus/types.js';

const signer = signerFromEnv();
const verifier = verifierFromPublicKey(signer.publicKeyBase64());
const client = createRazorpayClient();

mkdirSync('audit', { recursive: true });
const log = new AuditLog('audit/demo.jsonl');

// Use the real model when a key is present. Without one the run is DEGRADED and
// capped at escalate — which is the correct fail-safe, not a broken demo.
const MODEL_ID = 'gemini-3.1-flash-lite';
const provider = hasGeminiKey()
  ? withCacheAndBudget(
      withRateLimit(createGeminiProvider({ model: MODEL_ID }), { minIntervalMs: 2200 }),
      new VerdictCache('llm-cache'),
      new CallBudget(20),
    )
  : NULL_PROVIDER;
const model = hasGeminiKey() ? { id: MODEL_ID, temperature: 0 } : null;

const mandate: Mandate = {
  mandateId: 'm-demo',
  text: 'a pair of wireless bluetooth headphones, under 15000 rupees',
  items: [
    {
      itemId: 'i0',
      text: 'wireless bluetooth headphones',
      statedAttributes: ['wireless bluetooth'],
      statedOptions: [],
      statedQuantity: 1,
      sourceAsin: 'B09QKP7XQL',
    },
  ],
  authorisedCategory: 'Electronics',
};

const conforming: Cart = {
  cartId: 'cart-ok',
  lines: [
    {
      lineId: 'l0',
      answersItemId: null,
      sku: 'SKU-WH-1000',
      name: 'Wireless Bluetooth Headphones, Over-Ear',
      brand: 'Acme',
      priceMinor: 1_299_00,
      quantity: 1,
      categoryPath: ['Electronics'],
      options: [],
      attributes: ['wireless bluetooth'],
    },
  ],
};

/** Same request, but the agent wandered out of the authorised category. */
const outOfScope: Cart = {
  cartId: 'cart-scope',
  lines: [{ ...conforming.lines[0]!, categoryPath: ['Garden'], name: 'Teak Garden Bench' }],
};

function rule(title: string): void {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);
}

// ---------------------------------------------------------------------------

rule('1. Conforming cart — gate allows, order is created');

const ok = await evaluate({ mandate, cart: conforming, provider, signer, log, model });
console.log(`decision      : ${ok.decision}`);
console.log(`model         : ${model?.id ?? 'none — run is degraded by design'}`);
console.log(`degraded      : ${ok.degraded}`);
console.log(`certificate   : ${ok.certificate.certificate_id}`);
console.log(`cart hash     : ${ok.certificate.cart_hash}`);
console.log(`policy version: ${ok.certificate.policy_version}`);
console.log(`audit records : ${log.length}  <- written BEFORE any order exists`);

let orderId: string | null = null;
try {
  const order = await createOrder({
    certified: ok,
    client,
    receipt: `rcpt_${Date.now()}`,
    // Only needed when the run is degraded — a run with no model is capped at
    // escalate, and proceeding then is a human's call, made explicitly.
    allowEscalated: ok.decision === 'escalate',
  });
  orderId = order.id;
  console.log(`\norder created : ${order.id}  amount ${order.amount} ${order.currency}`);
  console.log('notes on the order (this is the audit link Razorpay keeps):');
  for (const [k, v] of Object.entries(order.notes)) console.log(`  ${k} = ${v}`);
} catch (e) {
  console.log(`order refused : ${(e as Error).message}`);
}

rule('2. The order round-trips — notes survived Razorpay');

if (orderId) {
  const fetched = await client.fetchOrder(orderId);
  const hashOnOrder = fetched.notes['conformance_certificate_hash'];
  console.log(`fetched       : ${fetched.id} (${fetched.status})`);
  console.log(`hash on order : ${hashOnOrder}`);
  console.log(`hash computed : ${certificateHash(ok.certificate)}`);
  console.log(`match         : ${hashOnOrder === certificateHash(ok.certificate) ? 'YES' : 'NO'}`);
}

rule('3. Re-check at authorisation — unchanged cart passes');

if (orderId) {
  const fetched = await client.fetchOrder(orderId);
  const pass = recheckAtAuthorisation({
    order: fetched,
    cartAtAuthorisation: conforming,
    original: ok.certificate,
    signer,
    log,
  });
  console.log(`outcome       : ${pass.ok ? 'ok' : `BLOCK (${pass.reason})`}`);
  console.log(`certificate   : ${pass.certificate.certificate_id}`);
  console.log(`names order   : ${pass.certificate.order_id}`);
}

rule('4. Re-check at authorisation — one paisa changed, hard block');

if (orderId) {
  const fetched = await client.fetchOrder(orderId);
  const mutated: Cart = {
    ...conforming,
    lines: [{ ...conforming.lines[0]!, priceMinor: conforming.lines[0]!.priceMinor + 1 }],
  };
  const blocked = recheckAtAuthorisation({
    order: fetched,
    cartAtAuthorisation: mutated,
    original: ok.certificate,
    signer,
    log,
  });
  console.log(`outcome       : ${blocked.ok ? 'ok' : `BLOCK (${blocked.reason})`}`);
  if (!blocked.ok) {
    console.log(`expected      : ${blocked.expected}`);
    console.log(`found         : ${blocked.found}`);
  }
  console.log('There is nothing to weigh here: either the bytes authorised are');
  console.log('the bytes being charged for, or they are not.');
}

rule('5. Out-of-scope cart — gate blocks, NO order reaches Razorpay');

const bad = await evaluate({ mandate, cart: outOfScope, provider, signer, log, model });
console.log(`decision      : ${bad.decision}`);
console.log(`violations    : ${bad.certificate.violations.map((v) => v.class).join(', ')}`);
try {
  await createOrder({ certified: bad, client, receipt: 'rcpt_never', allowEscalated: true });
  console.log('ERROR: an order was created for a blocked cart.');
} catch (e) {
  if (e instanceof GateRefusal) {
    console.log(`order refused : ${e.message}`);
    console.log('The refusal is on the record too — refusing is not forgetting.');
  } else {
    throw e;
  }
}

rule('Audit chain');

const validation = AuditLog.verify(log.path, verifier);
console.log(`records       : ${validation.length}`);
console.log(`chain valid   : ${validation.ok}`);
console.log(`breaks        : ${validation.breaks.length}`);
console.log(`head          : ${validation.head}`);
console.log(`\nPin that head externally. A chain of N valid records is`);
console.log(`indistinguishable from the first N of an original M without it.`);
