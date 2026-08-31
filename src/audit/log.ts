/**
 * Append-only, hash-chained audit log.
 *
 * Each certificate carries the hash of the one before it, so the log is a
 * chain. Altering any record changes its hash, which breaks the link the next
 * record asserts, and every link after that. Deleting a record breaks the chain
 * at the gap. Inserting one requires forging every subsequent signature.
 *
 * ── What this gives and what it does not ────────────────────────────────────
 * Tamper-EVIDENT, not tamper-proof. Anyone with write access to the file can
 * still truncate it — a chain of 5 valid records is indistinguishable from the
 * first 5 of an original 9 unless something outside the file remembers the
 * head. That limit is real, it is why `head()` exists as a value a caller can
 * pin externally, and it is stated rather than glossed.
 *
 * ── Why JSON Lines ──────────────────────────────────────────────────────────
 * Append is a single write with no read-modify-write of the whole file, so a
 * crash mid-append truncates one line rather than corrupting the document. A
 * partial final line is reported as a break at that position instead of
 * silently dropping the record.
 */
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  certificateHash,
  verifyCertificate,
  GENESIS_HASH,
  type Certificate,
} from '../cert/certificate.js';
import type { Verifier } from '../cert/signing.js';

export class AuditLogError extends Error {
  override readonly name = 'AuditLogError';
}

export type ChainBreak =
  | { readonly kind: 'unparseable'; readonly index: number; readonly detail: string }
  | { readonly kind: 'broken-link'; readonly index: number; readonly expected: string; readonly found: string }
  | { readonly kind: 'bad-signature'; readonly index: number; readonly certificateId: string }
  | { readonly kind: 'wrong-genesis'; readonly index: number; readonly found: string };

export interface ChainValidation {
  readonly ok: boolean;
  readonly length: number;
  /** Every break found, not just the first: one tampered record can cause several. */
  readonly breaks: readonly ChainBreak[];
  /** Hash of the last valid record, for pinning externally. */
  readonly head: string;
}

/**
 * Validate a chain of certificates.
 *
 * Reports EVERY break rather than stopping at the first. An investigator needs
 * to know whether one record was edited or the whole tail was rewritten, and
 * stopping early hides the difference.
 *
 * `verifier` is optional: chain continuity and signature validity are separate
 * claims, and a caller who has lost the public key can still check continuity.
 */
export function validateChain(
  certificates: readonly Certificate[],
  verifier?: Verifier,
): ChainValidation {
  const breaks: ChainBreak[] = [];
  let expected = GENESIS_HASH;

  for (let i = 0; i < certificates.length; i++) {
    const cert = certificates[i]!;
    if (cert.prev_hash !== expected) {
      breaks.push(
        i === 0
          ? { kind: 'wrong-genesis', index: 0, found: cert.prev_hash }
          : { kind: 'broken-link', index: i, expected, found: cert.prev_hash },
      );
    }
    if (verifier) {
      const v = verifyCertificate(cert, verifier);
      if (!v.ok) {
        breaks.push({ kind: 'bad-signature', index: i, certificateId: cert.certificate_id });
      }
    }
    // Continue from what this record ACTUALLY hashes to, not from what it
    // claimed. Otherwise one edited record reports as a break at every
    // subsequent position and the real extent of the tampering is unreadable.
    expected = certificateHash(cert);
  }

  return { ok: breaks.length === 0, length: certificates.length, breaks, head: expected };
}

/**
 * A log backed by a JSON Lines file.
 *
 * Reads the whole file on construction to recover the head. That is fine at the
 * scale this runs at (one record per order, a demo corpus) and it is honest
 * about not being a database.
 */
export class AuditLog {
  readonly path: string;
  #head: string;
  #count: number;

  constructor(path: string) {
    this.path = path;
    const existing = AuditLog.read(path);
    this.#count = existing.length;
    this.#head =
      existing.length === 0 ? GENESIS_HASH : certificateHash(existing[existing.length - 1]!);
  }

  /** Hash the next record must reference. Pin this externally to detect truncation. */
  head(): string {
    return this.#head;
  }

  get length(): number {
    return this.#count;
  }

  /**
   * Append a certificate.
   *
   * @throws AuditLogError when `prev_hash` does not reference the current head.
   * Refusing is the point: a log that accepts a record with the wrong
   * predecessor is not a chain, and silently rewriting the field would forge
   * the very link the record is supposed to attest.
   */
  append(cert: Certificate): void {
    if (cert.prev_hash !== this.#head) {
      throw new AuditLogError(
        `Certificate ${cert.certificate_id} references ${cert.prev_hash} but the log head is ${this.#head}. ` +
          'Re-issue against the current head rather than editing the certificate.',
      );
    }
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(cert)}\n`, 'utf8');
    this.#head = certificateHash(cert);
    this.#count++;
  }

  /** Every certificate, in order. A malformed line throws rather than being skipped. */
  static read(path: string): Certificate[] {
    if (!existsSync(path)) return [];
    const text = readFileSync(path, 'utf8');
    const out: Certificate[] = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (line === '') continue;
      try {
        out.push(JSON.parse(line) as Certificate);
      } catch {
        // Never skip. A skipped line is a record that silently left the chain,
        // which is exactly the outcome an attacker wants.
        throw new AuditLogError(`Audit log ${path} line ${i + 1} is not valid JSON.`);
      }
    }
    return out;
  }

  /** Read and validate in one step. */
  static verify(path: string, verifier?: Verifier): ChainValidation {
    return validateChain(AuditLog.read(path), verifier);
  }
}
