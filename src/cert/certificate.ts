/**
 * The conformance certificate.
 *
 * This is the forensic artifact. It answers "what was asked, what was bought,
 * what did the system decide, and when" without the original system being
 * available — which is the whole point, because a dispute is adjudicated months
 * later by someone who never ran our code.
 *
 * ── What binds what ─────────────────────────────────────────────────────────
 *   mandate_hash  binds the human's request  — answers "I never asked for that"
 *   cart_hash     binds the exact cart       — answers "the cart was changed"
 *   policy_version binds the ruleset          — answers "your rules were different then"
 *   prev_hash     binds the log position     — answers "you inserted this later"
 *   signature     binds all of the above     — answers "you edited the record"
 *
 * ── Why the signature covers the canonical form ─────────────────────────────
 * Signing pretty-printed JSON would mean a certificate that survives a
 * whitespace change verifies, and one that survives a key reorder does not.
 * The signature is over `canonicalise(body)`, so the thing signed is the thing
 * hashed and reordering is not a way to produce a second valid encoding of a
 * different meaning.
 *
 * ── What a certificate does NOT prove ───────────────────────────────────────
 * That the process which issued it was uncompromised. Certificates are
 * tamper-EVIDENT: an alteration is detectable after the fact. They are not
 * tamper-proof, and nothing here attests the running binary.
 */
import { randomUUID, randomBytes } from 'node:crypto';
import { canonicalise, hashOf } from '../normalise/canonical.js';
import { DIVERGENCE_CLASSES, precedence } from '../taxonomy/classes.js';
import { SOURCE_DECISION, DECISIONS, type GateDecision, type FindingSource } from '../gate/compose.js';
import type { Signer, Verifier } from './signing.js';

export const CERTIFICATE_VERSION = 1;

/**
 * First link in the chain. All-zero rather than a random value so a fresh log
 * is recognisable as fresh, and cannot be confused with one whose head was
 * truncated.
 */
export const GENESIS_HASH = `sha256:${'0'.repeat(64)}`;

/**
 * The ruleset digest, derived rather than declared.
 *
 * A hand-maintained version string drifts: someone changes a precedence order
 * and forgets to bump it, and every certificate then attests to a policy that
 * was not the one applied. Deriving it from the taxonomy and the decision table
 * means the version cannot disagree with the rules — changing either changes
 * every certificate issued afterwards, visibly.
 *
 * It does not cover checker BODIES. A logic change inside a checker leaves this
 * unchanged, and that is a real limit, stated rather than papered over.
 */
export const POLICY_VERSION = hashOf({
  schema: CERTIFICATE_VERSION,
  classes: DIVERGENCE_CLASSES,
  // Captured as pairs, so reordering precedence changes the version even
  // when the class list itself is untouched.
  precedence: DIVERGENCE_CLASSES.map((c) => [c, precedence(c)]),
  decisions: DECISIONS,
  sourceDecision: SOURCE_DECISION,
});

/**
 * The reserve, and the independent proof that it is lawful.
 *
 * `constraint_proof` is the output of `src/verifier/oc228.ts`, which shares no
 * code with the sizer that produced `amount_paise`. Recording both means a
 * reader does not have to trust either module: the amount and the judgement on
 * it come from different places, and the certificate says so.
 */
export interface CertificateReserve {
  readonly amount_paise: number;
  readonly validity_days: number;
  readonly rationale_code: string;
  readonly fundable: boolean;
  readonly sizer_policy_version: string;
  readonly constraint_proof: {
    readonly oc228: 'pass' | 'fail';
    readonly verifier_version: string;
    /** Violation codes, empty on a pass. Present so a fail can be read. */
    readonly violations: readonly string[];
  };
}

export interface CertificateViolation {
  readonly lineId: string;
  readonly class: string | null;
  readonly source: FindingSource;
  readonly evidence: string;
}

/** Everything the signature covers. */
export interface CertificateBody {
  readonly v: number;
  readonly certificate_id: string;
  /** Null until an order exists — the gate runs BEFORE order creation. */
  readonly order_id: string | null;
  readonly mandate_hash: string;
  readonly cart_hash: string;
  readonly decision: GateDecision;
  readonly violations: readonly CertificateViolation[];
  /** True when the semantic layer was unavailable. Never hidden. */
  readonly degraded: boolean;
  readonly policy_version: string;
  /** Null when no model was consulted, which is a different claim from "a model said nothing". */
  readonly model: { readonly id: string; readonly temperature: number } | null;
  /**
   * Null when no reserve was computed, which is a different statement from a
   * reserve of zero. Widened from `null` in Day 7; certificates issued before
   * that still verify, because they carry an explicit null either way.
   */
  readonly reserve: CertificateReserve | null;
  readonly issued_at: string;
  /** Replay protection: two identical decisions are still two distinct records. */
  readonly nonce: string;
  readonly prev_hash: string;
  /** Digest of the public key. Never the key, and never the private one. */
  readonly key_id: string;
}

export interface Certificate extends CertificateBody {
  readonly signature: string;
}

export interface IssueInput {
  readonly mandate: unknown;
  readonly cart: unknown;
  readonly decision: GateDecision;
  readonly violations: readonly CertificateViolation[];
  readonly degraded: boolean;
  readonly model?: { readonly id: string; readonly temperature: number } | null;
  readonly orderId?: string | null;
  readonly reserve?: CertificateReserve | null;
  readonly prevHash: string;
  /** Injectable so tests are deterministic; defaults to real entropy and clock. */
  readonly now?: () => string;
  readonly newId?: () => string;
  readonly newNonce?: () => string;
}

/** The exact bytes the signature covers, and that a verifier must reconstruct. */
export function signingPayload(body: CertificateBody): string {
  return canonicalise(body);
}

export function issueCertificate(input: IssueInput, signer: Signer): Certificate {
  const body: CertificateBody = {
    v: CERTIFICATE_VERSION,
    certificate_id: (input.newId ?? randomUUID)(),
    order_id: input.orderId ?? null,
    mandate_hash: hashOf(input.mandate),
    cart_hash: hashOf(input.cart),
    decision: input.decision,
    violations: input.violations,
    degraded: input.degraded,
    policy_version: POLICY_VERSION,
    model: input.model ?? null,
    reserve: input.reserve ?? null,
    issued_at: (input.now ?? (() => new Date().toISOString()))(),
    nonce: (input.newNonce ?? (() => randomBytes(16).toString('hex')))(),
    prev_hash: input.prevHash,
    key_id: signer.keyId,
  };
  return { ...body, signature: signer.sign(signingPayload(body)) };
}

/**
 * The hash a successor puts in its `prev_hash`.
 *
 * Over the WHOLE certificate including its signature, so replacing a signature
 * with another valid one — from a stolen key, say — still breaks every link
 * after it. Hashing the body alone would let a re-signed record slot in
 * silently.
 */
export function certificateHash(cert: Certificate): string {
  return hashOf(cert);
}

export type VerificationFailure =
  | 'bad-signature'
  | 'wrong-key'
  | 'unknown-version'
  | 'malformed';

export interface VerificationResult {
  readonly ok: boolean;
  readonly reason?: VerificationFailure;
  /**
   * On `wrong-key`: did the signature ALSO fail under the key we were given?
   *
   * "Wrong key" alone reads as a rotation mistake and closes the investigation.
   * But `key_id` is inside the signed body, so an attacker who edits the
   * decision and the key id together lands here — and an operator who stops at
   * "fetch the other key" never opens a tampering ticket. When this is true the
   * record must be re-checked against the key it names, and a failure there is
   * tampering, not rotation.
   */
  readonly alsoFailedUnderSuppliedKey?: boolean;
}

/**
 * Does this certificate verify against this key?
 *
 * Returns a result rather than throwing, and rather than returning a bare
 * boolean: "did not verify" and "verified against a key I was not expecting"
 * are different incidents and an operator needs to tell them apart.
 */
export function verifyCertificate(cert: Certificate, verifier: Verifier): VerificationResult {
  if (cert.v !== CERTIFICATE_VERSION) return { ok: false, reason: 'unknown-version' };

  const { signature, ...body } = cert;
  if (typeof signature !== 'string' || signature === '') {
    return { ok: false, reason: 'malformed' };
  }
  let payload: string;
  try {
    payload = signingPayload(body as CertificateBody);
  } catch {
    // Canonicalisation refuses NaN, Infinity and the like. A body that cannot
    // be canonicalised cannot have been signed by us.
    return { ok: false, reason: 'malformed' };
  }

  // The signature is checked even when the key id does not match, because
  // `key_id` is part of the signed body: returning early on it let a tampered
  // decision be reported as a rotation problem. Verifying against a key that
  // did not sign is cheap and safe, and its result is what tells the two apart.
  const signatureOk = verifier.verify(payload, signature);

  if (cert.key_id !== verifier.keyId) {
    return { ok: false, reason: 'wrong-key', alsoFailedUnderSuppliedKey: !signatureOk };
  }
  return signatureOk ? { ok: true } : { ok: false, reason: 'bad-signature' };
}
