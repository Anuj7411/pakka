/**
 * The console's backend.
 *
 * Every number the console shows comes from the real modules: `evaluate()` runs
 * the real deterministic checkers, the real semantic layer and the real lattice
 * join; the certificate is signed with a real Ed25519 key from the environment;
 * the chain is the real hash-chained audit log on disk. Nothing here is staged
 * for the screen, and nothing is recomputed in the browser.
 *
 *   npx tsx demo/api.ts        # then open http://localhost:5173
 *
 * The one thing that is NOT real is the UPI payment outcome. The order is
 * created against Razorpay in test mode and the cart hash is re-checked against
 * the certificate for real; the success/failure of the collect request itself is
 * simulated, and the page says so where it says it.
 */
import { createServer, type ServerResponse } from 'node:http';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

import { evaluate, createOrder, recheckAtAuthorisation, GateRefusal, type Certified } from '../src/gate/pipeline.js';
import {
  assignLines,
  checkScope,
  checkStatedBounds,
  checkQuantity,
  checkAnswersARequest,
  checkProductForSlot,
  assessCart,
  type Decision,
} from '../src/deterministic/checkers.js';
import { AuditLog } from '../src/audit/log.js';
import { signerFromEnv, verifierFromPublicKey } from '../src/cert/signing.js';
import { certificateHash, verifyCertificate } from '../src/cert/certificate.js';
import { createRazorpayClient, paymentSignatureMatches } from '../src/razorpay/client.js';
import { razorpayCredentials, hasRazorpayCredentials } from '../src/config/env.js';
import type { Provider } from '../src/semantic/provider.js';
import type { Cart, Mandate } from '../src/corpus/types.js';
import {
  SANDBOX_CATALOGUE,
  CATEGORIES,
  STATED_CEILING_PAISE,
  INJECTION_PAYLOAD,
  DIRECTIONS,
  directionById,
  buildCustom,
  cartFrom,
  type Example,
} from './scenario.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
loadEnv({ path: join(packageRoot, '.env') });

const PORT = Number(process.env['PORT'] ?? 5173);
const MODEL = 'gemini-3.1-flash-lite';

/**
 * A judge that has been completely taken over.
 *
 * Used for most runs, so what the screen shows is the gate holding while the
 * model is captured, not the model resisting.
 */
const CAPTURED: Provider = {
  id: 'captured-judge',
  judge: async () => ({ verdict: 'satisfies', confidence: 1, reason: 'approved', failed: false }),
};

/**
 * A judge that cannot be reached.
 *
 * `failed: true` is an outage, not an opinion. It carries `degraded` through the
 * gate, which caps the decision at `escalate`: the fail-safe posture, shown as
 * its own scenario rather than described. A gate that allowed on its own failure
 * would not be a gate.
 */
const UNAVAILABLE: Provider = {
  id: 'unavailable-judge',
  judge: async () => ({ verdict: 'unsure', confidence: 0, reason: 'provider unavailable', failed: true }),
};

function providerFor(judge: Example['judge']): Provider {
  return judge === 'unavailable' ? UNAVAILABLE : CAPTURED;
}

const signer = signerFromEnv();
const verifier = verifierFromPublicKey(signer.publicKeyBase64());
mkdirSync(join(packageRoot, 'audit'), { recursive: true });
const log = new AuditLog(join(packageRoot, 'audit', 'console.jsonl'));

/**
 * Razorpay is optional, but a BAD key is fatal.
 *
 * Two different situations that a single try/catch would flatten into one:
 * no credentials at all is a fine way to run the gate, and the console says so;
 * credentials that are present and wrong - a live key, a swapped secret - must
 * stop the process. Degrading there would turn "refusing to start" into a
 * silent downgrade, which is the failure mode this project spends its whole
 * argument on.
 */
const razorpay = (() => {
  if (!hasRazorpayCredentials()) {
    return { enabled: false as const, reason: 'RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set' };
  }
  // Any error from here is a misconfiguration, not an absence. Let it throw.
  const { keyId, keySecret } = razorpayCredentials();
  return { enabled: true as const, keyId, keySecret, client: createRazorpayClient() };
})();

const RS = (paise: number): string =>
  '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const short = (h: string): string => {
  const bare = h.startsWith('sha256:') ? h.slice(7) : h;
  return bare ? `${bare.slice(0, 8)}·${bare.slice(8, 16)}` : '-';
};

// ---------------------------------------------------------------------------
// The last run, kept so checkout can reach its `Certified` value.
//
// `Certified` is branded and only `evaluate()` can construct one, which is the
// mechanism that makes "gate before order" unforgeable. It therefore cannot be
// rebuilt from a request body - the server has to hold it.
// ---------------------------------------------------------------------------

interface RunState {
  readonly scenarioId: string;
  readonly certified: Certified;
  readonly cart: Cart;
  readonly view: unknown;
}
let last: RunState | null = null;

/**
 * The order this process created for the current run.
 *
 * A payment callback names an order id. Checking it against this rather than
 * against whatever the browser sent is what stops a caller reporting a payment
 * made on some other order as though it settled this cart.
 */
let lastOrderId: string | null = null;

// ---------------------------------------------------------------------------
// Per-line evidence
// ---------------------------------------------------------------------------

/**
 * The five checks, by the class each one raises.
 *
 * Same mapping `classify()` uses, in the same precedence order. Shown per check
 * rather than per line because the certificate records only the ONE class that
 * won precedence, and a reader deserves to see what the other four said.
 */
function perLineEvidence(cart: Cart, mandate: Mandate, semanticViolatedLineIds: Set<string>) {
  const assignment = assignLines(cart, mandate);
  const assessment = assessCart(cart, mandate);
  const flagged = new Set(assessment.violations.map((v) => v.lineId));

  const rows: { code: string; result: Decision; evidence: string }[] = [];

  for (const line of cart.lines) {
    const a = assignment.get(line.lineId) ?? null;

    const scope = checkScope(line, mandate);
    const bounds = a
      ? checkStatedBounds(line, a.item)
      : { decision: 'undecidable' as Decision, evidence: ['no request to check against'] };
    const answers = checkAnswersARequest(a !== null, a?.score ?? 0);
    const product = checkProductForSlot();
    const qty = a
      ? checkQuantity(line, a.item)
      : { decision: 'undecidable' as Decision, evidence: 'no request to check against' };

    rows.push(
      { code: 'SCOPE_VIOLATION', result: scope.decision, evidence: scope.evidence ?? 'inside the authorised category' },
      { code: 'CONSTRAINT_BREACH', result: bounds.decision, evidence: bounds.evidence.join('; ') || 'every stated bound is satisfied' },
      { code: 'UNREQUESTED_ADDITION', result: answers.decision, evidence: answers.evidence ?? '' },
      { code: 'ITEM_SUBSTITUTION', result: product.decision, evidence: product.evidence ?? '' },
      { code: 'QUANTITY_DEVIATION', result: qty.decision, evidence: qty.evidence ?? 'quantity matches the stated one' },
    );

    // What the model actually did, derived rather than assumed: `judgeCart`
    // skips any line the deterministic layer already flagged, because under the
    // lattice nothing it returned could change that line's decision.
    if (flagged.has(line.lineId)) {
      rows.push({
        code: 'semantic · not consulted',
        result: 'clear',
        evidence:
          'The deterministic layer settled this line, so the judge was never called - ' +
          'under the lattice nothing it returned could have lowered the decision',
      });
    } else if (semanticViolatedLineIds.has(line.lineId)) {
      rows.push({ code: 'semantic · captured stub', result: 'violation', evidence: 'the judge returned wrong_product' });
    } else {
      rows.push({
        code: 'semantic · captured stub',
        result: 'clear',
        evidence:
          'Returned satisfies at confidence 1.00. Under the lattice it could only have escalated, ' +
          'so it changed nothing',
      });
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// A run
// ---------------------------------------------------------------------------

function chainView() {
  const v = AuditLog.verify(log.path, verifier);
  const entries = AuditLog.read(log.path)
    .slice(-12)
    .map((c, i) => ({
      n: String(i + 1).padStart(2, '0'),
      decision: c.decision,
      prev: short(c.prev_hash),
      hash: short(certificateHash(c)),
      time: new Date(c.issued_at).toTimeString().slice(0, 8),
      verifies: verifyCertificate(c, verifier).ok,
    }));
  return { records: v.length, valid: v.ok, breaks: v.breaks.length, head: short(v.head), entries };
}

/** The mandate's checkable bounds, as label/value rows for the mandate panel. */
function mandateConstraints(m: Mandate): [string, string][] {
  return [
    ['authorised category', m.authorisedCategory],
    ['stated quantity', m.items[0]!.statedQuantity === null ? 'unstated' : String(m.items[0]!.statedQuantity)],
    ['stated finish', m.items[0]!.statedOptions.join(', ') || 'none'],
    // Printed as unbound rather than dropped: the instruction says it, and no
    // deterministic checker binds it. Hiding the row would hide the gap.
    ['stated ceiling', `${RS(STATED_CEILING_PAISE)} · stated, not bound by any L1 checker`],
    ['mandate expires', 'task-scoped · TBAC, not object-scoped'],
  ];
}

/**
 * The cart's line against the four bounds, for the "against the bounds" grid.
 *
 * A display comparison, not a decision: the got/want/breach here is what the
 * viewer reads. The verdict still comes from the real checkers, which is why the
 * total row can show a breach (over the stated ceiling) while the certificate
 * records no CONSTRAINT_BREACH for it - the ceiling is stated, not bound by an
 * L1 checker, exactly as the mandate panel says.
 */
function boundsCompare(cart: Cart, mandate: Mandate) {
  const line = cart.lines[0];
  if (!line) return [];
  const item = mandate.items[0]!;
  const total = cart.lines.reduce((n, l) => n + l.priceMinor * l.quantity, 0);
  const finishWanted = item.statedOptions[0] ?? '';
  const optionValues = line.options.map((o) => o.split(':').slice(1).join(':').trim());
  const finishGot = optionValues.join(', ') || '(none declared)';
  const finishOk = finishWanted === '' || optionValues.some((o) => o.includes(finishWanted) || finishWanted.includes(o));
  const stated = item.statedQuantity;
  return [
    { k: 'category', got: line.categoryPath[0] ?? '(none)', want: mandate.authorisedCategory,
      breach: (line.categoryPath[0] ?? '') !== mandate.authorisedCategory },
    { k: 'quantity', got: String(line.quantity), want: stated === null ? 'unstated' : String(stated),
      breach: stated !== null && line.quantity > stated },
    { k: 'total', got: RS(total), want: `<= ${RS(STATED_CEILING_PAISE)}`,
      breach: total > STATED_CEILING_PAISE },
    { k: 'finish', got: finishGot, want: finishWanted || '(none)', breach: !finishOk },
  ];
}

/** Metadata about which direction and example this run came from. */
interface RunMeta {
  readonly id: string;
  readonly title: string;
  readonly blurb: string;
  readonly expect: string;
  readonly domain: string;
  readonly exampleIndex: number;
  readonly exampleCount: number;
}

async function runExample(example: Example, meta: RunMeta) {
  const cart = cartFrom(example);
  const captured = example.judge === 'captured';
  const mandate = example.mandate;

  const certified = await evaluate({
    mandate,
    cart,
    provider: providerFor(example.judge),
    signer,
    log,
    model: captured ? { id: `${MODEL} (captured)`, temperature: 0 } : null,
    reserve: { merchantId: 'merchant-demo', customerId: 'customer-demo' },
  });

  const cert = certified.certificate;
  const semanticLines = new Set(
    cert.violations.filter((v) => v.source === 'semantic').map((v) => v.lineId),
  );
  const total = cart.lines.reduce((n, l) => n + l.priceMinor * l.quantity, 0);
  const reserve = cert.reserve;

  const view = {
    scenario: { id: meta.id, title: meta.title, blurb: meta.blurb, expect: meta.expect },
    domain: meta.domain,
    exampleIndex: meta.exampleIndex,
    exampleCount: meta.exampleCount,
    // Each example brings its own catalogue - the shelf changes per domain.
    catalogue: example.catalogue.map((p, i) => ({
      idx: String(i).padStart(2, '0'),
      name: p.name,
      category: p.category,
      price: RS(p.pricePaise),
    })),
    poisonIndex: example.poisonIndex,
    judge: example.judge,
    instruction: mandate.text,
    constraints: mandateConstraints(mandate),
    pickedIndex: example.picks[0]?.index ?? -1,
    compare: boundsCompare(cart, mandate),
    cart: cart.lines.map((l) => ({
      name: l.name,
      category: l.categoryPath[0] ?? '(none)',
      qty: l.quantity,
      unit: RS(l.priceMinor),
      mismatch: (l.categoryPath[0] ?? '') !== mandate.authorisedCategory,
      total: RS(l.priceMinor * l.quantity),
    })),
    cartTotal: RS(total),
    cartHashShort: short(cert.cart_hash),
    mandateHashShort: short(cert.mandate_hash),
    policyShort: short(cert.policy_version),
    decision: certified.decision,
    degraded: certified.degraded,
    findings: perLineEvidence(cart, mandate, semanticLines),
    certificate: [
      ['decision', cert.decision],
      ['mandate_hash', cert.mandate_hash],
      ['cart_hash', cert.cart_hash],
      ['violations', cert.violations.length ? cert.violations.map((v) => v.class ?? v.source).join(', ') : '[] - none'],
      ['reserve', reserve
        ? `${RS(reserve.amount_paise)} · ${reserve.rationale_code} · fundable ${reserve.fundable}`
        : 'null'],
      ['oc228 proof', reserve
        ? `${reserve.constraint_proof.oc228} · ${reserve.constraint_proof.verifier_version}`
        : '-'],
      ['policy_version', cert.policy_version],
      ['model', cert.model ? `${cert.model.id} · temperature ${cert.model.temperature}` : 'none'],
      ['degraded', String(cert.degraded)],
      ['prev_hash', cert.prev_hash],
      ['hash', certificateHash(cert)],
      ['key_id', cert.key_id],
      ['signature (Ed25519)', cert.signature],
      ['issued_at', cert.issued_at],
    ],
    certShort: short(certificateHash(cert)),
    certVerifies: verifyCertificate(cert, verifier).ok,
    keyId: cert.key_id,
    // The certificate as the v2 zone renders it: nine fields, per-field wrap.
    certV2: [
      { k: 'decision', v: cert.decision, brk: 'normal' },
      { k: 'mandate', v: short(cert.mandate_hash), brk: 'break-all' },
      { k: 'cart', v: short(cert.cart_hash), brk: 'break-all' },
      { k: 'violations', v: cert.violations.length ? cert.violations.map((x) => x.class ?? x.source).join(', ') : '[] none', brk: 'normal' },
      { k: 'reserve', v: reserve ? `${RS(reserve.amount_paise)} · ${reserve.rationale_code}` : 'null', brk: 'normal' },
      { k: 'policy', v: short(cert.policy_version), brk: 'normal' },
      { k: 'prev_hash', v: short(cert.prev_hash), brk: 'break-all' },
      { k: 'hash', v: short(certificateHash(cert)), brk: 'break-all' },
      { k: 'issued', v: cert.issued_at, brk: 'normal' },
    ],
    reserve: reserve
      ? { amount: RS(reserve.amount_paise), rationale: reserve.rationale_code, fundable: reserve.fundable }
      : null,
    chain: chainView(),
  };

  last = { scenarioId: meta.id, certified, cart, view };
  return view;
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

/**
 * Create the order, then prove the cart did not move.
 *
 * `createOrder` takes the branded `Certified` value and throws `GateRefusal` on
 * a blocked decision, so the "no order on block" property is enforced by the
 * gate rather than by this handler remembering to check.
 */
async function createRealOrder() {
  if (last === null) return { ok: false as const, reason: 'no run yet' };
  if (!razorpay.enabled) return { ok: false as const, reason: `Razorpay not configured: ${razorpay.reason}` };

  try {
    const order = await createOrder({
      certified: last.certified,
      client: razorpay.client,
      receipt: `pakka_${Date.now()}`,
      allowEscalated: last.certified.decision === 'escalate',
    });
    const recheck = recheckAtAuthorisation({
      order,
      cartAtAuthorisation: last.cart,
      original: last.certified.certificate,
      signer,
      log,
    });
    lastOrderId = order.id;
    return {
      ok: true as const,
      keyId: razorpay.keyId,
      order: {
        id: order.id,
        amount: RS(order.amount),
        amountPaise: order.amount,
        currency: order.currency,
        status: order.status,
      },
      description: last.cart.lines.map((l) => l.name).join(', '),
      certificateId: last.certified.certificate.certificate_id,
      recheck: recheck.ok
        ? { ok: true as const, certificate: short(certificateHash(recheck.certificate)) }
        : { ok: false as const, reason: recheck.reason, expected: short(recheck.expected), found: short(recheck.found) },
      chain: chainView(),
    };
  } catch (e) {
    if (e instanceof GateRefusal) {
      return { ok: false as const, refused: true as const, decision: e.decision, reason: e.message };
    }
    return { ok: false as const, reason: (e as Error).message };
  }
}

/**
 * Settle a checkout callback, without believing any of it.
 *
 * Razorpay Checkout runs in the customer's browser and hands the page an order
 * id, a payment id and a signature. Three checks, in this order, and each one
 * can only refuse:
 *
 *   1. the order id must be the order THIS process created for this run;
 *   2. on a success callback, the signature must verify under the key secret;
 *   3. the payment is then FETCHED from Razorpay, and its own `status`,
 *      `amount` and `order_id` are what get reported - not the browser's.
 *
 * Step 3 is the one that matters. Without it the page would be reporting what
 * it was told, which is exactly the posture this whole project argues against.
 */
async function confirmPayment(body: {
  payment_id?: unknown;
  order_id?: unknown;
  signature?: unknown;
}) {
  if (!razorpay.enabled) return { ok: false as const, reason: 'Razorpay not configured' };

  const paymentId = typeof body.payment_id === 'string' ? body.payment_id : '';
  const orderId = typeof body.order_id === 'string' ? body.order_id : '';
  const signature = typeof body.signature === 'string' ? body.signature : null;

  if (paymentId === '' || orderId === '') {
    return { ok: false as const, reason: 'payment_id and order_id are required' };
  }
  if (lastOrderId === null || orderId !== lastOrderId) {
    return { ok: false as const, reason: 'order_id is not the order this run created' };
  }

  const signatureVerified =
    signature === null
      ? false
      : paymentSignatureMatches({ orderId, paymentId, signature, keySecret: razorpay.keySecret });

  // A success callback whose signature does not verify is not a payment. It is
  // someone posting three strings.
  if (signature !== null && !signatureVerified) {
    return { ok: false as const, reason: 'payment signature did not verify' };
  }

  let payment;
  try {
    payment = await razorpay.client.fetchPayment(paymentId);
  } catch (e) {
    return { ok: false as const, reason: (e as Error).message };
  }

  if (payment.order_id !== orderId) {
    return { ok: false as const, reason: 'payment belongs to a different order' };
  }

  const cert = last?.certified.certificate ?? null;
  return {
    ok: true as const,
    signatureVerified,
    payment: {
      id: payment.id,
      status: payment.status,
      method: payment.method,
      amount: RS(payment.amount),
      vpa: payment.vpa ?? null,
      errorCode: payment.error_code ?? null,
      errorReason: payment.error_reason ?? null,
      errorStep: payment.error_step ?? null,
      errorDescription: payment.error_description ?? null,
    },
    orderId,
    certificate: cert ? short(certificateHash(cert)) : '-',
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/** Bounded so a request body cannot be used to exhaust memory. */
async function readJsonBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 16_384) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * Security headers set on every response.
 *
 * A bare node:http server sends none, which every scanner flags on a public
 * deployment. These are set once, before routing, so no handler can forget them.
 *
 * The CSP is written for what the page actually loads and NOTHING wider:
 *   - script only from self and Razorpay Checkout;
 *   - Google Fonts stylesheet, and its font files from gstatic;
 *   - `style-src` allows inline because the ported design carries `style=""`
 *     attributes verbatim from the handoff - removing them would be the
 *     redesign the port contract forbids;
 *   - the Razorpay family for the checkout iframe and its XHRs, and no more.
 * `object-src 'none'`, `base-uri 'self'` and `frame-ancestors 'none'` close the
 * usual holes; the last also makes X-Frame-Options redundant but it is sent too
 * for the scanners that still look for it.
 *
 * Verified after adding: the Razorpay modal still opens and settles. A CSP that
 * broke checkout the day before submission would be worse than none.
 */
const CSP = [
  "default-src 'self'",
  // Razorpay Checkout loads from several of its own subdomains - the SDK from
  // checkout., risk-detection from cdn., more as they add them. We already
  // trust Razorpay with the iframe and every XHR, so a compromise of a Razorpay
  // origin already means a compromised checkout; a wildcard over their family
  // adds no risk over that and stops a break the day before submission. It is
  // still worlds tighter than the no-CSP the scanner found.
  "script-src 'self' https://*.razorpay.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: https://*.razorpay.com",
  "connect-src 'self' https://*.razorpay.com",
  "frame-src https://*.razorpay.com",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
}

createServer((req, res) => {
  setSecurityHeaders(res);
  const url = req.url ?? '/';
  const path = url.split('?')[0] ?? '/';

  if (path === '/api/scenario') {
    json(res, {
      directions: DIRECTIONS.map((d) => ({
        id: d.id,
        title: d.title,
        blurb: d.blurb,
        expect: d.expect,
        exampleCount: d.examples.length,
        domains: d.examples.map((e) => e.domain),
      })),
      sandboxCatalogue: SANDBOX_CATALOGUE.map((p, i) => ({
        idx: String(i).padStart(2, '0'),
        name: p.name,
        category: p.category,
        price: RS(p.pricePaise),
      })),
      categories: CATEGORIES,
      payload: INJECTION_PAYLOAD,
      keyId: signer.keyId,
      razorpay: razorpay.enabled ? { enabled: true, keyId: razorpay.keyId } : { enabled: false, reason: razorpay.reason },
      chain: chainView(),
    });
    return;
  }

  // A preset run: GET /api/run?direction=<id>&example=<n>. Custom is a POST.
  if (path === '/api/run' && req.method !== 'POST') {
    const params = new URL(url, 'http://x').searchParams;
    const direction = directionById(params.get('direction') ?? '');
    if (!direction) {
      json(res, { error: `unknown direction: ${params.get('direction')}` }, 400);
      return;
    }
    // The example index wraps, so a repeated press cycles the direction's set.
    const n = ((Number(params.get('example')) || 0) % direction.examples.length + direction.examples.length) % direction.examples.length;
    const example = direction.examples[n]!;
    runExample(example, {
      id: direction.id, title: direction.title, blurb: direction.blurb, expect: direction.expect,
      domain: example.domain, exampleIndex: n, exampleCount: direction.examples.length,
    }).then(
      (r) => json(res, r),
      (e: Error) => json(res, { error: e.message }, 500),
    );
    return;
  }

  // A custom run: POST /api/run with { itemIndex, quantity, statedQuantity, authorisedCategory }.
  if (path === '/api/run' && req.method === 'POST') {
    readJsonBody(req)
      .then((body) => {
        const b = (body ?? {}) as Record<string, unknown>;
        const built = buildCustom({
          itemIndex: b['itemIndex'] as number,
          quantity: b['quantity'] as number,
          statedQuantity: (b['statedQuantity'] ?? null) as number | null,
          authorisedCategory: b['authorisedCategory'] as string,
        });
        if ('error' in built) {
          json(res, { error: built.error }, 400);
          return;
        }
        return runExample(built, {
          id: 'custom', title: 'Your own run', blurb: built.domain, expect: 'allow',
          domain: built.domain, exampleIndex: 0, exampleCount: 1,
        }).then((r) => json(res, r));
      })
      .catch((e: Error) => json(res, { error: e.message }, 400));
    return;
  }

  if (path === '/api/order') {
    createRealOrder().then(
      (r) => json(res, r),
      (e: Error) => json(res, { ok: false, reason: e.message }, 500),
    );
    return;
  }

  if (path === '/api/payment' && req.method === 'POST') {
    readJsonBody(req)
      .then((b) => confirmPayment(b as Record<string, unknown>))
      .then(
        (r) => json(res, r),
        (e: Error) => json(res, { ok: false, reason: e.message }, 400),
      );
    return;
  }

  if (path === '/api/chain') {
    json(res, chainView());
    return;
  }

  if (path === '/pakka.css' || path === '/play.css' || path === '/checkout.css') {
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
    res.end(readFileSync(join(here, path.slice(1)), 'utf8'));
    return;
  }

  if (path === '/app.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    res.end(readFileSync(join(here, 'app.js'), 'utf8'));
    return;
  }

  // Brand artwork. The name is matched rather than joined so a traversal
  // sequence cannot address anything outside demo/assets.
  const asset = /^\/assets\/([A-Za-z0-9._-]+\.svg)$/.exec(path);
  if (asset) {
    const file = join(here, 'assets', asset[1]!);
    if (existsSync(file)) {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end(readFileSync(file));
      return;
    }
  }

  // Three surfaces, one document. The client reads location.pathname on boot
  // and switches views from there, so all three routes return the same page.
  if (path === '/' || path === '/play' || path === '/checkout') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(join(here, 'index.html'), 'utf8'));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}).listen(PORT, '0.0.0.0');

console.log(`signing key : ${signer.keyId} (Ed25519)`);
console.log(`audit log   : ${log.path}`);
console.log(`razorpay    : ${razorpay.enabled ? `${razorpay.keyId} (test mode)` : `off - ${razorpay.reason}`}`);
console.log(`judge       : captured stub · satisfies at 1.00, every line`);
console.log(`serving     : http://localhost:${PORT}`);
