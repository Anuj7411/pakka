/**
 * Live demo server: the gate, then Razorpay Checkout.
 *
 * Runs the gate on a cart, creates a TEST-mode order carrying the certificate
 * reference, and serves a checkout page bound to that order. The point of the
 * page is the failure path — a declined or timed-out payment must leave the
 * certificate and the audit chain intact and readable.
 *
 *   npx tsx demo/server.ts      # then open http://localhost:5173
 *
 * Test mode only. `razorpayCredentials()` refuses anything that is not
 * `rzp_test_`, so no money can move from here.
 */
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { evaluate, createOrder } from '../src/gate/pipeline.js';
import { createRazorpayClient } from '../src/razorpay/client.js';
import { AuditLog } from '../src/audit/log.js';
import { signerFromEnv, verifierFromPublicKey } from '../src/cert/signing.js';
import { certificateHash } from '../src/cert/certificate.js';
import {
  NULL_PROVIDER,
  CallBudget,
  VerdictCache,
  withCacheAndBudget,
  withRateLimit,
} from '../src/semantic/provider.js';
import { createGeminiProvider } from '../src/semantic/gemini.js';
import { hasGeminiKey } from '../src/config/env.js';
import { razorpayCredentials } from '../src/config/env.js';
import type { Cart, Mandate } from '../src/corpus/types.js';

// Paths are resolved from this file, not from the working directory: the
// preview runner launches from the repository root, and a server that only
// works when started from one directory is a server that fails in the demo.
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
loadEnv({ path: join(packageRoot, '.env') });

const PORT = 5173;

const signer = signerFromEnv();
const verifier = verifierFromPublicKey(signer.publicKeyBase64());
const client = createRazorpayClient();
mkdirSync(join(packageRoot, 'audit'), { recursive: true });
const log = new AuditLog(join(packageRoot, 'audit', 'demo.jsonl'));

// The real model when a key is present. Without one the run is DEGRADED and
// capped at escalate, which is the correct fail-safe rather than a broken demo.
const MODEL_ID = 'gemini-3.1-flash-lite';
const provider = hasGeminiKey()
  ? withCacheAndBudget(
      withRateLimit(createGeminiProvider({ model: MODEL_ID }), { minIntervalMs: 2200 }),
      new VerdictCache(join(packageRoot, 'llm-cache')),
      new CallBudget(20),
    )
  : NULL_PROVIDER;
const model = hasGeminiKey() ? { id: MODEL_ID, temperature: 0 } : null;

const mandate: Mandate = {
  mandateId: 'm-live',
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

const cart: Cart = {
  cartId: 'cart-live',
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

/** Built once at boot so the page always reflects a real gated decision. */
async function prepare() {
  const certified = await evaluate({ mandate, cart, provider, signer, log, model });
  const order = await createOrder({
    certified,
    client,
    receipt: `live_${Date.now()}`,
    allowEscalated: certified.decision === 'escalate',
  });
  return { certified, order };
}

const { certified, order } = await prepare();
const { keyId } = razorpayCredentials();

console.log(`gate decision : ${certified.decision}`);
console.log(`model         : ${model?.id ?? 'none (degraded by design)'}`);
console.log(`certificate   : ${certified.certificate.certificate_id}`);
console.log(`order         : ${order.id}`);
console.log(`serving       : http://localhost:${PORT}`);

createServer((req, res) => {
  const url = req.url ?? '/';

  if (url.startsWith('/state')) {
    const chain = AuditLog.verify(log.path, verifier);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        {
          decision: certified.decision,
          degraded: certified.degraded,
          certificate_id: certified.certificate.certificate_id,
          certificate_hash: certificateHash(certified.certificate),
          cart_hash: certified.certificate.cart_hash,
          policy_version: certified.certificate.policy_version,
          order_id: order.id,
          amount: order.amount,
          notes: order.notes,
          chain: { records: chain.length, valid: chain.ok, head: chain.head },
        },
        null,
        2,
      ),
    );
    return;
  }

  if (url.startsWith('/site.css')) {
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
    res.end(readFileSync(join(here, 'site.css'), 'utf8'));
    return;
  }

  if (url === '/' || url.startsWith('/index')) {
    const html = readFileSync(join(here, 'checkout.html'), 'utf8')
      .replaceAll('__KEY_ID__', keyId)
      .replaceAll('__ORDER_ID__', order.id)
      .replaceAll('__AMOUNT__', String(order.amount))
      .replaceAll('__DECISION__', certified.decision)
      .replaceAll('__CERT_ID__', certified.certificate.certificate_id)
      .replaceAll('__CERT_HASH__', certificateHash(certified.certificate))
      .replaceAll('__CART_HASH__', certified.certificate.cart_hash);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}).listen(PORT);
