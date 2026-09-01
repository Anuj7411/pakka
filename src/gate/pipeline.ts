/**
 * The gate, end to end: decide, certify, record, and only then create an order.
 *
 * ── The ordering is the security property ───────────────────────────────────
 * The certificate is issued and written to the audit log BEFORE the order
 * exists. That ordering is not a convention to be remembered — `createOrder`
 * below takes a `Certified` value that only `evaluate()` can produce, so there
 * is no call sequence that creates an order without a decision behind it. A
 * comment saying "call these in order" would have been a suggestion.
 *
 * ── Why the certificate has no order id ─────────────────────────────────────
 * It cannot. The gate runs before the order, so at signing time there is no
 * order to name, and the certificate is immutable afterwards. The link runs the
 * other way: the order's `notes` carry the certificate id and the cart hash.
 * Given an order you can find its certificate; given a certificate you can
 * prove which cart it covered. The one direction we do not get is
 * certificate → order without consulting Razorpay, and that is stated rather
 * than papered over with a re-signed record.
 *
 * The re-check at authorisation DOES carry an order id, because by then the
 * order exists. That is the certificate that proves the cart did not change
 * between decision and payment.
 */
import { assessCart } from '../deterministic/checkers.js';
import { judgeCart } from '../semantic/judge.js';
import { compose, type Finding, type GateDecision } from './compose.js';
import {
  issueCertificate,
  certificateHash,
  GENESIS_HASH,
  POLICY_VERSION,
  type Certificate,
  type CertificateViolation,
  type CertificateReserve,
} from '../cert/certificate.js';
import { hashOf } from '../normalise/canonical.js';
import { sizeReserve, SIZER_POLICY_VERSION } from '../sizer/reserve.js';
import { verifyBlock, OC228_VERIFIER_VERSION } from '../verifier/oc228.js';
import type { Signer } from '../cert/signing.js';
import type { AuditLog } from '../audit/log.js';
import type { Provider } from '../semantic/provider.js';
import type { Cart, Mandate } from '../corpus/types.js';
import type { RazorpayClient, Order, LineItem } from '../razorpay/client.js';

/**
 * A decision that has been certified and recorded.
 *
 * Only `evaluate()` constructs one. The private brand is what makes "gate
 * before order" unforgeable by a caller assembling the shape by hand.
 */
export interface Certified {
  readonly certificate: Certificate;
  readonly decision: GateDecision;
  readonly findings: readonly Finding[];
  readonly degraded: boolean;
  readonly cart: Cart;
  readonly [BRAND]: true;
}

declare const BRAND: unique symbol;

export interface EvaluateOptions {
  readonly mandate: Mandate;
  readonly cart: Cart;
  readonly provider: Provider;
  readonly signer: Signer;
  readonly log: AuditLog;
  readonly model?: { readonly id: string; readonly temperature: number } | null;
  /**
   * Size a reserve for this cart and record the independent OC-228 proof.
   *
   * Off by default. A reserve is only meaningful for a UPI Reserve Pay flow,
   * and computing one for a plain card order would put a number on the
   * certificate that nothing acts on.
   */
  readonly reserve?: { readonly merchantId: string; readonly customerId: string; readonly validityDays?: number } | null;
}

/**
 * Size a reserve, then have the independent verifier judge it.
 *
 * Clark-Wilson E3 in one function: `sizeReserve` proposes, `verifyBlock`
 * disposes, and they share no code. The certificate carries both the number and
 * the judgement, so a reader need not trust either module on its own.
 *
 * A verifier rejection here is an internal inconsistency — our own sizer
 * proposing something unlawful — so it is recorded as a fail rather than
 * silently corrected. Correcting it would collapse the separation into one
 * module that grades its own work.
 */
function buildReserve(
  cart: Cart,
  mandate: Mandate,
  ctx: { merchantId: string; customerId: string; validityDays?: number },
): { reserve: CertificateReserve; lawful: boolean } {
  const proposal = sizeReserve(
    cart,
    mandate,
    ctx.validityDays === undefined ? {} : { requestedValidityDays: ctx.validityDays },
  );

  // An unfundable cart has no block to check; there is nothing unlawful about
  // declining to block, so it passes with no violations.
  const violations = proposal.fundable && proposal.amountPaise > 0
    ? verifyBlock({
        blockId: 'proposed',
        merchantId: ctx.merchantId,
        customerId: ctx.customerId,
        amountPaise: proposal.amountPaise,
        validityDays: proposal.validityDays,
        createdOnDay: 0,
      })
    : [];

  return {
    lawful: violations.length === 0,
    reserve: {
      amount_paise: proposal.amountPaise,
      validity_days: proposal.validityDays,
      rationale_code: proposal.rationale,
      fundable: proposal.fundable,
      sizer_policy_version: SIZER_POLICY_VERSION,
      constraint_proof: {
        oc228: violations.length === 0 ? 'pass' : 'fail',
        verifier_version: OC228_VERIFIER_VERSION,
        violations: violations.map((v) => v.code),
      },
    },
  };
}

/**
 * Decide, certify, record. Never talks to Razorpay.
 *
 * The audit record is written before this returns, so a crash between deciding
 * and ordering leaves evidence of the decision rather than a silent gap.
 */
export async function evaluate(opts: EvaluateOptions): Promise<Certified> {
  const assessment = assessCart(opts.cart, opts.mandate);
  const semantic = await judgeCart(opts.cart, opts.mandate, assessment, opts.provider);

  const findings: Finding[] = [
    ...assessment.violations.map((v) => ({
      lineId: v.lineId,
      source: 'deterministic' as const,
      detail: v.evidence.join('; '),
    })),
    ...semantic.findings,
  ];
  const sized = opts.reserve ? buildReserve(opts.cart, opts.mandate, opts.reserve) : null;

  // A reserve our own verifier rejects is an internal inconsistency, and it
  // must not pass silently. It cannot lower the decision — nothing can — it can
  // only raise it, which is the same lattice rule the model obeys.
  const reserveFindings: Finding[] =
    sized && !sized.lawful
      ? [
          {
            lineId: '*',
            source: 'deterministic' as const,
            detail: `reserve proposal violates OC-228: ${sized.reserve.constraint_proof.violations.join(', ')}`,
          },
        ]
      : [];

  const composed = compose([...findings, ...reserveFindings], semantic.degraded);

  const violations: CertificateViolation[] = [
    ...assessment.violations.map((v) => ({
      lineId: v.lineId,
      class: v.class as string,
      source: 'deterministic' as const,
      evidence: v.evidence.join('; '),
    })),
    ...semantic.findings.map((f) => ({
      lineId: f.lineId,
      class: null,
      source: f.source,
      evidence: f.detail,
    })),
  ];

  const certificate = issueCertificate(
    {
      mandate: opts.mandate,
      cart: opts.cart,
      decision: composed.decision,
      violations,
      degraded: composed.degraded,
      model: opts.model ?? null,
      reserve: sized?.reserve ?? null,
      prevHash: opts.log.head(),
    },
    opts.signer,
  );
  opts.log.append(certificate);

  return {
    certificate,
    decision: composed.decision,
    findings: composed.findings,
    degraded: composed.degraded,
    cart: opts.cart,
  } as Certified;
}

export class GateRefusal extends Error {
  override readonly name = 'GateRefusal';
  readonly decision: GateDecision;
  readonly certificateId: string;

  constructor(message: string, decision: GateDecision, certificateId: string) {
    super(message);
    this.decision = decision;
    this.certificateId = certificateId;
  }
}

/** Cart lines as Magic Checkout expects them. Minor units throughout. */
export function toLineItems(cart: Cart): LineItem[] {
  return cart.lines.map((l) => ({
    sku: l.sku,
    name: l.name,
    price: l.priceMinor,
    quantity: l.quantity,
  }));
}

export function lineItemsTotal(cart: Cart): number {
  return cart.lines.reduce((n, l) => n + l.priceMinor * l.quantity, 0);
}

/**
 * The reference that links a Razorpay order back to its certificate.
 *
 * Kept small on purpose: notes are capped at 512 characters per value, and a
 * truncated hash is a broken audit link that looks like a working one.
 */
export function certificateNotes(cert: Certificate): Record<string, string> {
  return {
    conformance_certificate_id: cert.certificate_id,
    conformance_certificate_hash: certificateHash(cert),
    conformance_cart_hash: cert.cart_hash,
    conformance_decision: cert.decision,
    conformance_policy_version: cert.policy_version,
    conformance_degraded: String(cert.degraded),
  };
}

export interface CreateOrderOptions {
  readonly certified: Certified;
  readonly client: RazorpayClient;
  readonly receipt: string;
  readonly currency?: string;
  /**
   * Create an order for an `escalate` decision.
   *
   * Escalation means a human must look, not that the purchase is forbidden, so
   * a caller with a review workflow may legitimately proceed. It must say so
   * explicitly: the default refuses, because a default that proceeds turns
   * "needs review" into "shipped" for anyone who forgot the flag.
   */
  readonly allowEscalated?: boolean;
}

/**
 * Create the order — only reachable with a `Certified` value.
 *
 * @throws GateRefusal on `block`, and on `escalate` unless explicitly allowed.
 */
export async function createOrder(opts: CreateOrderOptions): Promise<Order> {
  const { certificate, decision, cart } = opts.certified;

  if (decision === 'block') {
    throw new GateRefusal(
      `Gate blocked this cart; no order was created. Certificate ${certificate.certificate_id}.`,
      decision,
      certificate.certificate_id,
    );
  }
  if (decision === 'escalate' && opts.allowEscalated !== true) {
    throw new GateRefusal(
      `Gate escalated this cart for human review; no order was created. ` +
        `Pass allowEscalated to proceed anyway. Certificate ${certificate.certificate_id}.`,
      decision,
      certificate.certificate_id,
    );
  }

  const items = toLineItems(cart);
  const total = lineItemsTotal(cart);
  return opts.client.createOrder({
    amount: total,
    currency: opts.currency ?? 'INR',
    receipt: opts.receipt,
    notes: certificateNotes(certificate),
    lineItems: items,
    lineItemsTotal: total,
  });
}

// ---------------------------------------------------------------------------
// Re-check at authorisation
// ---------------------------------------------------------------------------

export type RecheckOutcome =
  | { readonly ok: true; readonly certificate: Certificate }
  | {
      readonly ok: false;
      readonly reason: 'cart-mutated' | 'certificate-mismatch' | 'policy-changed';
      readonly expected: string;
      readonly found: string;
      readonly certificate: Certificate;
    };

/**
 * Prove the cart did not change between decision and payment.
 *
 * This is the one hard `block` in the system. Everywhere else the gate reasons
 * about whether a cart matches an instruction, which is a judgement with a
 * false-positive cost. Here it compares two hashes: either the bytes authorised
 * are the bytes being charged for, or they are not. There is nothing to weigh,
 * so escalation would be an evasion.
 *
 * Writes a second certificate either way — this one CAN name the order, because
 * by now the order exists. A re-check that recorded nothing on success would
 * leave no evidence that the check ran.
 */
export function recheckAtAuthorisation(args: {
  readonly order: Order;
  readonly cartAtAuthorisation: Cart;
  readonly original: Certificate;
  readonly signer: Signer;
  readonly log: AuditLog;
}): RecheckOutcome {
  const found = hashOf(args.cartAtAuthorisation);
  const expected = args.original.cart_hash;

  const noteHash = args.order.notes['conformance_certificate_hash'];
  const certMatches = noteHash === certificateHash(args.original);
  const policyMatches = args.original.policy_version === POLICY_VERSION;

  const mutated = found !== expected;
  const failed = mutated || !certMatches || !policyMatches;

  const reason: 'cart-mutated' | 'certificate-mismatch' | 'policy-changed' | null = mutated
    ? 'cart-mutated'
    : !certMatches
      ? 'certificate-mismatch'
      : !policyMatches
        ? 'policy-changed'
        : null;

  const certificate = issueCertificate(
    {
      mandate: { recheck_of: args.original.certificate_id },
      cart: args.cartAtAuthorisation,
      decision: failed ? 'block' : 'allow',
      violations: failed
        ? [
            {
              lineId: '*',
              class: 'CART_MUTATED_AFTER_AUTHORISATION',
              source: 'deterministic' as const,
              evidence: `${reason}: expected ${expected}, found ${found}`,
            },
          ]
        : [],
      degraded: false,
      orderId: args.order.id,
      prevHash: args.log.head(),
    },
    args.signer,
  );
  args.log.append(certificate);

  if (!failed) return { ok: true, certificate };
  return {
    ok: false,
    reason: reason ?? 'cart-mutated',
    expected: reason === 'certificate-mismatch' ? certificateHash(args.original) : expected,
    found: reason === 'certificate-mismatch' ? String(noteHash) : found,
    certificate,
  };
}

export { GENESIS_HASH };
