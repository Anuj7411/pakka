/**
 * Ed25519 signing for certificates.
 *
 * The private key comes from the environment and goes nowhere else: not into
 * the repository, not into a log line, not into the certificate it signs. The
 * certificate carries a `key_id` — a digest of the PUBLIC key — so a verifier
 * can tell which key to check against without the signer ever publishing the
 * secret.
 *
 * ── Why raw seeds rather than PEM ───────────────────────────────────────────
 * An Ed25519 private key is 32 bytes. Node will only import it wrapped in
 * PKCS#8 DER, so the wrapper is prepended here rather than making an operator
 * paste a multi-line PEM into a .env file, where newlines get mangled and the
 * failure surfaces as an unrelated parse error. The prefix is a fixed 16-byte
 * header; nothing about it is secret.
 *
 * ── What this does not claim ────────────────────────────────────────────────
 * A signature proves the certificate was issued by a holder of this key and has
 * not changed since. It does NOT attest the process that produced it. The
 * SECURITY-MODEL says certificates are tamper-EVIDENT, not tamper-proof, and
 * that distinction is the whole of it.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';
import { ConfigError } from '../config/env.js';

/** DER header for a PKCS#8-wrapped Ed25519 private key, followed by 32 seed bytes. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** DER header for an SPKI-wrapped Ed25519 public key, followed by 32 key bytes. */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const SEED_BYTES = 32;

export interface Signer {
  /** Digest of the public key. Safe to publish; identifies which key signed. */
  readonly keyId: string;
  /** Base64 Ed25519 signature over the UTF-8 bytes of `message`. */
  sign(message: string): string;
  /** The public key, base64, for handing to a verifier. */
  publicKeyBase64(): string;
}

export interface Verifier {
  readonly keyId: string;
  verify(message: string, signatureBase64: string): boolean;
}

/**
 * `key_id` is a digest, never the key itself.
 *
 * Truncated to 16 hex characters: it is an identifier for selecting a key, not
 * a security boundary, and a full digest makes certificates noisier to read
 * without making them harder to forge — the signature does that.
 */
export function keyIdOf(publicKey: KeyObject): string {
  const raw = publicKey.export({ format: 'der', type: 'spki' });
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function privateFromSeed(seed: Buffer): KeyObject {
  if (seed.length !== SEED_BYTES) {
    // Names the length, never the bytes.
    throw new ConfigError(
      `Signing key must be ${SEED_BYTES} bytes, got ${seed.length}. ` +
        'Expected base64 of a raw Ed25519 seed.',
    );
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

function signerFrom(privateKey: KeyObject): Signer {
  const publicKey = createPublicKey(privateKey);
  const keyId = keyIdOf(publicKey);
  return {
    keyId,
    sign(message: string): string {
      return edSign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64');
    },
    publicKeyBase64(): string {
      const der = publicKey.export({ format: 'der', type: 'spki' });
      return Buffer.from(der.subarray(SPKI_ED25519_PREFIX.length)).toString('base64');
    },
  };
}

/**
 * Signer from `CONFORMANCE_SIGNING_KEY`, a base64 32-byte Ed25519 seed.
 *
 * @throws ConfigError when absent or the wrong length. Deliberately fatal: a
 * gate that silently stops signing produces certificates that look like
 * certificates and prove nothing.
 */
export function signerFromEnv(varName = 'CONFORMANCE_SIGNING_KEY'): Signer {
  const raw = process.env[varName];
  if (raw === undefined || raw.trim() === '') {
    throw new ConfigError(
      `Missing required environment variable: ${varName}. ` +
        'Generate one with: node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  return signerFrom(privateFromSeed(Buffer.from(raw.trim(), 'base64')));
}

/** Signer from a raw 32-byte seed. For tests and for callers holding their own key. */
export function signerFromSeed(seed: Buffer): Signer {
  return signerFrom(privateFromSeed(seed));
}

/** A fresh random key. Used by tests; never used to sign anything durable. */
export function generateSigner(): Signer {
  const { privateKey } = generateKeyPairSync('ed25519');
  return signerFrom(privateKey);
}

/** Verifier from a base64 raw 32-byte Ed25519 public key. */
export function verifierFromPublicKey(publicKeyBase64: string): Verifier {
  const raw = Buffer.from(publicKeyBase64, 'base64');
  if (raw.length !== SEED_BYTES) {
    throw new ConfigError(`Public key must be ${SEED_BYTES} bytes, got ${raw.length}.`);
  }
  const publicKey = createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
  return {
    keyId: keyIdOf(publicKey),
    verify(message: string, signatureBase64: string): boolean {
      // A malformed signature is a failed verification, not an exception. A
      // verifier that throws on hostile input is a verifier that can be made
      // to skip the check by whoever supplies the input.
      try {
        return edVerify(
          null,
          Buffer.from(message, 'utf8'),
          publicKey,
          Buffer.from(signatureBase64, 'base64'),
        );
      } catch {
        return false;
      }
    },
  };
}
