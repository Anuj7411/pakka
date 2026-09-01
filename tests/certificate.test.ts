/**
 * Certificate, signature, and hash chain.
 *
 * These pin the claims SECURITY-MODEL.md makes about forensics. A failure here
 * means the audit story is not true, which is worse than a metrics dip: the
 * certificate is the artifact a dispute is adjudicated on months later, by
 * someone who cannot re-run our code.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  issueCertificate,
  verifyCertificate,
  certificateHash,
  signingPayload,
  GENESIS_HASH,
  POLICY_VERSION,
  CERTIFICATE_VERSION,
  type Certificate,
} from '../src/cert/certificate.js';
import {
  generateSigner,
  signerFromSeed,
  signerFromEnv,
  verifierFromPublicKey,
} from '../src/cert/signing.js';
import { AuditLog, AuditLogError, validateChain } from '../src/audit/log.js';
import { ConfigError } from '../src/config/env.js';

const signer = generateSigner();
const verifier = verifierFromPublicKey(signer.publicKeyBase64());

const mandate = { mandateId: 'm0', text: 'blue headphones' };
const cart = { cartId: 'c0', lines: [{ sku: 'a', quantity: 1 }] };

let counter = 0;
function issue(over: Partial<Parameters<typeof issueCertificate>[0]> = {}): Certificate {
  counter++;
  return issueCertificate(
    {
      mandate,
      cart,
      decision: 'allow',
      violations: [],
      degraded: false,
      prevHash: GENESIS_HASH,
      now: () => '2026-08-31T00:00:00.000Z',
      newId: () => `cert-${counter}`,
      newNonce: () => `nonce-${counter}`,
      ...over,
    },
    signer,
  );
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'audit-'));
}

// ---------------------------------------------------------------------------

describe('signing: the key never leaves the environment', () => {
  it('carries a key id that is a digest, not the key', () => {
    const cert = issue();
    expect(cert.key_id).toMatch(/^[0-9a-f]{16}$/);
    // The seed is 32 bytes base64; the id must not be derivable from it here.
    const serialised = JSON.stringify(cert);
    expect(serialised).not.toContain(signer.publicKeyBase64());
  });

  it('reads a seed from the environment', () => {
    const seed = randomBytes(32);
    process.env['TEST_SIGNING_KEY'] = seed.toString('base64');
    try {
      const fromEnv = signerFromEnv('TEST_SIGNING_KEY');
      expect(fromEnv.keyId).toBe(signerFromSeed(seed).keyId);
    } finally {
      delete process.env['TEST_SIGNING_KEY'];
    }
  });

  it('refuses to start without a key rather than issuing unsigned records', () => {
    // A gate that quietly stops signing produces things that look like
    // certificates and prove nothing.
    delete process.env['TEST_MISSING_KEY'];
    expect(() => signerFromEnv('TEST_MISSING_KEY')).toThrow(ConfigError);
  });

  it('names the variable and never the value in an error', () => {
    process.env['TEST_SHORT_KEY'] = Buffer.from('too short').toString('base64');
    try {
      expect(() => signerFromEnv('TEST_SHORT_KEY')).toThrow(/got 9/);
      expect(() => signerFromEnv('TEST_SHORT_KEY')).not.toThrow(/too short/);
    } finally {
      delete process.env['TEST_SHORT_KEY'];
    }
  });

  it('is deterministic: the same seed gives the same key id', () => {
    const seed = randomBytes(32);
    expect(signerFromSeed(seed).keyId).toBe(signerFromSeed(seed).keyId);
  });
});

describe('certificate: what it binds', () => {
  it('verifies against the matching public key', () => {
    expect(verifyCertificate(issue(), verifier)).toEqual({ ok: true });
  });

  it('binds the mandate: changing what was asked breaks the signature', () => {
    const cert = issue();
    const forged = { ...cert, mandate_hash: 'sha256:0000' };
    expect(verifyCertificate(forged, verifier)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('binds the cart: changing what was bought breaks the signature', () => {
    const cert = issue();
    expect(verifyCertificate({ ...cert, cart_hash: 'sha256:0000' }, verifier).ok).toBe(false);
  });

  it('binds the decision: an escalate cannot be edited into an allow', () => {
    const cert = issue({ decision: 'escalate' });
    expect(verifyCertificate({ ...cert, decision: 'allow' }, verifier).ok).toBe(false);
  });

  it('binds degraded, so a degraded run cannot be laundered into a clean one', () => {
    const cert = issue({ degraded: true });
    expect(verifyCertificate({ ...cert, degraded: false }, verifier).ok).toBe(false);
  });

  it('binds the violation list', () => {
    const cert = issue({
      decision: 'block',
      violations: [
        { lineId: 'l0', class: 'SCOPE_VIOLATION', source: 'deterministic', evidence: 'Garden' },
      ],
    });
    expect(verifyCertificate({ ...cert, violations: [] }, verifier).ok).toBe(false);
  });

  it('distinguishes a wrong key from a bad signature', () => {
    // Different incidents: one is a key-rotation mistake, the other is tampering.
    const other = verifierFromPublicKey(generateSigner().publicKeyBase64());
    expect(verifyCertificate(issue(), other).reason).toBe('wrong-key');
    expect(verifyCertificate({ ...issue(), decision: 'block' }, verifier).reason).toBe(
      'bad-signature',
    );
  });

  it('refuses a version it does not understand', () => {
    const cert = issue();
    expect(verifyCertificate({ ...cert, v: 99 }, verifier).reason).toBe('unknown-version');
  });

  it('treats a malformed signature as unverified, never as an exception', () => {
    const cert = issue();
    for (const signature of ['', 'not base64 !!!', 'AAAA']) {
      expect(() => verifyCertificate({ ...cert, signature }, verifier)).not.toThrow();
      expect(verifyCertificate({ ...cert, signature }, verifier).ok).toBe(false);
    }
  });

  it('records the model, or explicitly records that there was none', () => {
    expect(issue().model).toBeNull();
    expect(issue({ model: { id: 'gemini-3.1-flash-lite', temperature: 0 } }).model).toEqual({
      id: 'gemini-3.1-flash-lite',
      temperature: 0,
    });
  });

  it('carries a policy version derived from the rules, not declared by hand', () => {
    expect(issue().policy_version).toBe(POLICY_VERSION);
    expect(POLICY_VERSION).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('signs the canonical form, so key order cannot produce a second meaning', () => {
    const cert = issue();
    const { signature, ...body } = cert;
    const reordered = Object.fromEntries(Object.entries(body).reverse());
    expect(signingPayload(reordered as never)).toBe(signingPayload(body as never));
    expect(verifier.verify(signingPayload(reordered as never), signature)).toBe(true);
  });

  it('gives two identical decisions two distinct records', () => {
    // Replay protection: without a nonce, the same cart decided twice would be
    // byte-identical and one could stand in for the other.
    const a = issueCertificate(
      { mandate, cart, decision: 'allow', violations: [], degraded: false, prevHash: GENESIS_HASH },
      signer,
    );
    const b = issueCertificate(
      { mandate, cart, decision: 'allow', violations: [], degraded: false, prevHash: GENESIS_HASH },
      signer,
    );
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.certificate_id).not.toBe(b.certificate_id);
    expect(certificateHash(a)).not.toBe(certificateHash(b));
  });

  it('never puts a secret in the certificate', () => {
    process.env['TEST_SIGNING_KEY'] = randomBytes(32).toString('base64');
    try {
      const secret = process.env['TEST_SIGNING_KEY']!;
      const cert = issueCertificate(
        {
          mandate,
          cart,
          decision: 'allow',
          violations: [],
          degraded: false,
          prevHash: GENESIS_HASH,
        },
        signerFromEnv('TEST_SIGNING_KEY'),
      );
      expect(JSON.stringify(cert)).not.toContain(secret);
    } finally {
      delete process.env['TEST_SIGNING_KEY'];
    }
  });
});

describe('hash chain: tamper evidence', () => {
  function chainOf(n: number): Certificate[] {
    const out: Certificate[] = [];
    let prev = GENESIS_HASH;
    for (let i = 0; i < n; i++) {
      const cert = issue({ prevHash: prev, decision: i % 2 === 0 ? 'allow' : 'escalate' });
      out.push(cert);
      prev = certificateHash(cert);
    }
    return out;
  }

  it('validates a well-formed chain', () => {
    const v = validateChain(chainOf(5), verifier);
    expect(v.ok).toBe(true);
    expect(v.breaks).toEqual([]);
    expect(v.length).toBe(5);
  });

  it('requires the first record to reference genesis', () => {
    const chain = chainOf(3);
    const v = validateChain([{ ...chain[1]! }, chain[2]!], verifier);
    expect(v.breaks.some((b) => b.kind === 'wrong-genesis')).toBe(true);
  });

  it('detects an edited record at that record AND at the link after it', () => {
    const chain = chainOf(4);
    chain[1] = { ...chain[1]!, decision: 'allow' }; // edited, signature now invalid
    const v = validateChain(chain, verifier);

    expect(v.ok).toBe(false);
    expect(v.breaks.some((b) => b.kind === 'bad-signature' && b.index === 1)).toBe(true);
    expect(v.breaks.some((b) => b.kind === 'broken-link' && b.index === 2)).toBe(true);
  });

  it('reports every break, not just the first', () => {
    // One edit versus a rewritten tail are different incidents; stopping at the
    // first break hides which one happened.
    const chain = chainOf(6);
    chain[1] = { ...chain[1]!, decision: 'allow' };
    chain[4] = { ...chain[4]!, degraded: true };
    const v = validateChain(chain, verifier);
    const indices = v.breaks.map((b) => b.index);
    expect(new Set(indices).size).toBeGreaterThanOrEqual(3);
  });

  it('detects a deleted record', () => {
    const chain = chainOf(4);
    const withGap = [chain[0]!, chain[2]!, chain[3]!];
    const v = validateChain(withGap, verifier);
    expect(v.breaks.some((b) => b.kind === 'broken-link' && b.index === 1)).toBe(true);
  });

  it('detects a record re-signed with a different key', () => {
    // The chain hashes the signature too, so a valid signature from the wrong
    // key still breaks every link after it.
    const chain = chainOf(3);
    const attacker = generateSigner();
    const { signature, ...body } = chain[1]!;
    chain[1] = { ...body, signature: attacker.sign(signingPayload(body)) } as Certificate;
    const v = validateChain(chain, verifier);
    expect(v.ok).toBe(false);
    expect(v.breaks.some((b) => b.index === 2 && b.kind === 'broken-link')).toBe(true);
  });

  it('checks continuity without a key, when the key is unavailable', () => {
    const chain = chainOf(3);
    expect(validateChain(chain).ok).toBe(true);
    chain[1] = { ...chain[1]!, cart_hash: 'sha256:0000' };
    expect(validateChain(chain).ok).toBe(false);
  });

  it('an empty chain is valid and its head is genesis', () => {
    const v = validateChain([]);
    expect(v.ok).toBe(true);
    expect(v.head).toBe(GENESIS_HASH);
  });
});

describe('AuditLog: append-only on disk', () => {
  it('round-trips and validates', () => {
    const dir = tmpDir();
    try {
      const log = new AuditLog(join(dir, 'audit.jsonl'));
      expect(log.head()).toBe(GENESIS_HASH);
      for (let i = 0; i < 3; i++) log.append(issue({ prevHash: log.head() }));
      expect(log.length).toBe(3);
      expect(AuditLog.verify(join(dir, 'audit.jsonl'), verifier).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a certificate that does not reference the head', () => {
    // Rewriting prev_hash to make it fit would forge the link the record exists
    // to attest, so this must throw rather than repair.
    const dir = tmpDir();
    try {
      const log = new AuditLog(join(dir, 'audit.jsonl'));
      log.append(issue({ prevHash: GENESIS_HASH }));
      expect(() => log.append(issue({ prevHash: GENESIS_HASH }))).toThrow(AuditLogError);
      expect(log.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers the head from an existing file', () => {
    const dir = tmpDir();
    const path = join(dir, 'audit.jsonl');
    try {
      const first = new AuditLog(path);
      first.append(issue({ prevHash: first.head() }));
      const head = first.head();

      const reopened = new AuditLog(path);
      expect(reopened.head()).toBe(head);
      expect(reopened.length).toBe(1);
      expect(() => reopened.append(issue({ prevHash: head }))).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects tampering done directly to the file', () => {
    const dir = tmpDir();
    const path = join(dir, 'audit.jsonl');
    try {
      const log = new AuditLog(path);
      for (let i = 0; i < 3; i++) log.append(issue({ prevHash: log.head() }));

      const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
      const edited = JSON.parse(lines[1]!) as Certificate;
      lines[1] = JSON.stringify({ ...edited, decision: 'block' });
      writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');

      expect(AuditLog.verify(path, verifier).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on a malformed line rather than skipping it', () => {
    // A skipped line is a record that silently left the chain.
    const dir = tmpDir();
    const path = join(dir, 'audit.jsonl');
    try {
      writeFileSync(path, `${JSON.stringify(issue())}\n{ truncated\n`, 'utf8');
      expect(() => AuditLog.read(path)).toThrow(AuditLogError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats a missing file as an empty log', () => {
    const dir = tmpDir();
    try {
      expect(AuditLog.read(join(dir, 'nope.jsonl'))).toEqual([]);
      expect(new AuditLog(join(dir, 'nope.jsonl')).head()).toBe(GENESIS_HASH);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cannot detect truncation of the tail on its own', () => {
    // Stated as a test so the limit is recorded rather than assumed away: a
    // truncated log is internally consistent. Only an externally pinned head
    // reveals it.
    const dir = tmpDir();
    const path = join(dir, 'audit.jsonl');
    try {
      const log = new AuditLog(path);
      for (let i = 0; i < 4; i++) log.append(issue({ prevHash: log.head() }));
      const pinnedHead = log.head();

      const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
      writeFileSync(path, `${lines.slice(0, 2).join('\n')}\n`, 'utf8');

      const v = AuditLog.verify(path, verifier);
      expect(v.ok).toBe(true); // internally consistent — this is the limitation
      expect(v.head).not.toBe(pinnedHead); // and this is how it is caught
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('certificate: schema surface', () => {
  it('states the version it was issued under', () => {
    expect(issue().v).toBe(CERTIFICATE_VERSION);
  });

  it('leaves reserve explicitly null until Day 7 fills it', () => {
    // Absent and null-valued are different statements; canonicalise keeps null.
    expect(issue().reserve).toBeNull();
    expect(Object.keys(issue())).toContain('reserve');
  });

  it('has no order id before an order exists', () => {
    expect(issue().order_id).toBeNull();
    expect(issue({ orderId: 'order_abc' }).order_id).toBe('order_abc');
  });
});

describe('security audit regressions (2026-08-31)', () => {
  it('a second handle cannot append onto a stale head', () => {
    // Found by /cso. append() compared prev_hash against an in-memory head
    // captured at construction, so two handles on one path both believed they
    // held it and BOTH writes succeeded — leaving a chain that could never
    // validate. A broken chain is worse than a refused write: it is
    // indistinguishable from tampering, and routine false alarms are how a real
    // tamper event gets waved through.
    const dir = tmpDir();
    const path = join(dir, 'audit.jsonl');
    try {
      const a = new AuditLog(path);
      const b = new AuditLog(path);
      const head = a.head();

      a.append(issue({ prevHash: head }));
      expect(() => b.append(issue({ prevHash: head }))).toThrow(AuditLogError);

      expect(AuditLog.read(path)).toHaveLength(1);
      expect(AuditLog.verify(path, verifier).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a handle sees writes made through another handle', () => {
    const dir = tmpDir();
    const path = join(dir, 'audit.jsonl');
    try {
      const a = new AuditLog(path);
      const b = new AuditLog(path);
      a.append(issue({ prevHash: a.head() }));

      expect(b.head()).toBe(a.head());
      expect(b.length).toBe(1);
      expect(() => b.append(issue({ prevHash: b.head() }))).not.toThrow();
      expect(AuditLog.verify(path, verifier).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a wrong-key result says whether the signature ALSO failed', () => {
    // Found by /cso. key_id is inside the signed body, so an attacker editing
    // the decision AND the key id got `wrong-key` — which reads as a rotation
    // mistake and closes the investigation before a tampering ticket is opened.
    const rotated = verifierFromPublicKey(generateSigner().publicKeyBase64());

    // Genuine rotation: untouched certificate, verifier holds the wrong key.
    const honest = verifyCertificate(issue(), rotated);
    expect(honest.reason).toBe('wrong-key');
    expect(honest.alsoFailedUnderSuppliedKey).toBe(true);

    // Tampering hidden behind a rewritten key id, checked against OUR key.
    const tampered = { ...issue({ decision: 'block' }), decision: 'allow' as const, key_id: 'f'.repeat(16) };
    const masked = verifyCertificate(tampered, verifier);
    expect(masked.reason).toBe('wrong-key');
    expect(masked.alsoFailedUnderSuppliedKey).toBe(true);
  });

  it('still reports bad-signature when the key id was not touched', () => {
    const tampered = { ...issue({ decision: 'block' }), decision: 'allow' as const };
    expect(verifyCertificate(tampered, verifier).reason).toBe('bad-signature');
  });

  it('documents the signing key in .env.example', () => {
    // The variable was named only inside a thrown error, so an operator hitting
    // setup would improvise — a key pasted into source, or one copied from a
    // tutorial and shared across environments.
    const example = readFileSync('.env.example', 'utf8');
    expect(example).toContain('CONFORMANCE_SIGNING_KEY');
    expect(example).toMatch(/CONFORMANCE_SIGNING_KEY=\s*$/m); // present, and empty
  });
});

describe('fail-closed paths', () => {
  it('refuses a public key of the wrong length', () => {
    expect(() => verifierFromPublicKey(Buffer.from('short').toString('base64'))).toThrow(
      ConfigError,
    );
    expect(() => verifierFromPublicKey('')).toThrow(/got 0/);
  });

  it('reports a body that cannot be canonicalised as malformed, not as a bad signature', () => {
    // canonicalise refuses NaN and Infinity. Such a body cannot have been
    // signed by us, and calling it "bad signature" would point an investigator
    // at tampering when the record is simply not a certificate.
    const broken = { ...issue(), priceMinor: Number.NaN } as unknown as Certificate;
    expect(verifyCertificate(broken, verifier)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('never throws on a hostile signature, whatever the bytes', () => {
    const cert = issue();
    const hostile = ['', '!!!!', 'AAAA', 'A'.repeat(10_000), '\u0000\u0000'];
    for (const signature of hostile) {
      expect(() => verifyCertificate({ ...cert, signature }, verifier)).not.toThrow();
      expect(verifyCertificate({ ...cert, signature }, verifier).ok).toBe(false);
    }
  });

  it('refuses to append onto a head it cannot read', () => {
    // Appending onto an unreadable last line would silently start a second
    // chain inside the same file.
    const dir = tmpDir();
    const path = join(dir, 'audit.jsonl');
    try {
      writeFileSync(path, `${JSON.stringify(issue())}\n{ truncated\n`, 'utf8');
      expect(() => new AuditLog(path)).toThrow(AuditLogError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats a file of blank lines as an empty log', () => {
    const dir = tmpDir();
    const path = join(dir, 'audit.jsonl');
    try {
      writeFileSync(path, '\n\n   \n', 'utf8');
      const log = new AuditLog(path);
      expect(log.head()).toBe(GENESIS_HASH);
      expect(log.length).toBe(0);
      expect(() => log.append(issue({ prevHash: GENESIS_HASH }))).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mutation-surfaced gaps: assertions that were too shallow', () => {
  it('distinguishes a MALFORMED signature from a wrong one', () => {
    // The guard is `typeof signature !== 'string' || signature === ''`.
    // Only the empty-string half was exercised, so flipping || to && survived:
    // a non-string signature would have been reported as tampering rather than
    // as a record that is not a certificate at all.
    const cert = issue();
    expect(verifyCertificate({ ...cert, signature: '' }, verifier).reason).toBe('malformed');
    for (const signature of [null, undefined, 42, {}, []]) {
      const got = verifyCertificate({ ...cert, signature } as unknown as Certificate, verifier);
      expect(got.reason, `signature ${String(signature)}`).toBe('malformed');
    }
  });

  it('accepts a public key of exactly 32 bytes and nothing else', () => {
    // Inverting the length check survived: a correct key would have been
    // rejected and a malformed one accepted, and no test pinned both sides.
    const good = generateSigner().publicKeyBase64();
    expect(() => verifierFromPublicKey(good)).not.toThrow();
    expect(Buffer.from(good, 'base64')).toHaveLength(32);
    for (const n of [0, 1, 31, 33, 64]) {
      expect(() => verifierFromPublicKey(randomBytes(n).toString('base64')), `${n} bytes`).toThrow(
        ConfigError,
      );
    }
  });

  it('returns a usable signer, not merely an object', () => {
    // `ObjectLiteral -> {}` mutants survived, meaning nothing asserted the
    // shape a signer must actually have.
    const s = generateSigner();
    expect(s.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(Buffer.from(s.publicKeyBase64(), 'base64')).toHaveLength(32);
    const sig = s.sign('hello');
    expect(Buffer.from(sig, 'base64')).toHaveLength(64); // Ed25519 signature size
    expect(verifierFromPublicKey(s.publicKeyBase64()).verify('hello', sig)).toBe(true);
    expect(verifierFromPublicKey(s.publicKeyBase64()).verify('hello!', sig)).toBe(false);
  });

  it('stamps a real timestamp and a real nonce by default', () => {
    // The defaults are injected functions; `() => undefined` survived because
    // nothing looked at what they produced.
    const cert = issueCertificate(
      { mandate, cart, decision: 'allow', violations: [], degraded: false, prevHash: GENESIS_HASH },
      signer,
    );
    expect(cert.issued_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(Number.isNaN(Date.parse(cert.issued_at))).toBe(false);
    expect(cert.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(cert.certificate_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses to append when the head line was corrupted after construction', () => {
    // #headOnDisk has its own catch. It is reachable only when the file changes
    // AFTER the constructor validated it — which is exactly the case that
    // matters, because appending onto an unreadable head would silently start a
    // second chain inside one file.
    const dir = tmpDir();
    const path = join(dir, 'audit.jsonl');
    try {
      const log = new AuditLog(path);
      log.append(issue({ prevHash: GENESIS_HASH }));
      appendFileSync(path, '{ not json\n', 'utf8');
      expect(() => log.head()).toThrow(AuditLogError);
      expect(() => log.append(issue({ prevHash: GENESIS_HASH }))).toThrow(AuditLogError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names the failing line number when the log is unreadable', () => {
    const dir = tmpDir();
    const path = join(dir, 'audit.jsonl');
    try {
      const lines = [JSON.stringify(issue()), JSON.stringify(issue()), 'broken'];
      writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
      expect(() => AuditLog.read(path)).toThrow(/line 3/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
