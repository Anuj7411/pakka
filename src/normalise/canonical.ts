/**
 * Canonical serialisation and hashing.
 *
 * Everything downstream rests on this. A certificate binds `sha256(cart)` and
 * `sha256(mandate)`; if the same logical value can serialise two ways, the
 * hash chain proves nothing and the audit claim is void.
 *
 * Rules, and the reason for each:
 *  - Object keys sorted by UTF-16 code unit. Insertion order is not semantic.
 *  - Strings normalised to Unicode NFC. "é" as one code point and as e+U+0301
 *    are the same text and must hash the same.
 *  - Numbers must be finite. NaN and ±Infinity have no canonical form, and
 *    JSON.stringify silently turns them into null — a silent corruption we
 *    refuse instead.
 *  - -0 and 0 serialise identically. String(-0) is already "0"; no guard needed.
 *  - `undefined` properties are dropped; an explicit `null` is kept. Absent and
 *    null-valued are different statements.
 *  - Arrays keep order. Order is semantic for cart lines.
 *  - No whitespace. Formatting is not part of the value.
 */
import { createHash } from 'node:crypto';

export class CanonicalisationError extends Error {
  override readonly name = 'CanonicalisationError';
}

export type Canonical =
  | string
  | number
  | boolean
  | null
  | readonly Canonical[]
  | { readonly [k: string]: Canonical | undefined };

/**
 * Deterministic JSON. Same logical value ⇒ byte-identical output, on any
 * platform, in any key order.
 */
export function canonicalise(value: unknown, path = '$'): string {
  if (value === null) return 'null';

  const t = typeof value;

  if (t === 'string') return JSON.stringify((value as string).normalize('NFC'));

  if (t === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new CanonicalisationError(
        `Non-finite number at ${path}: ${String(n)}. Refusing to serialise — ` +
          `JSON.stringify would silently write null.`,
      );
    }
    // -0 needs no special case: String(-0) is already "0", so 0 and -0 both
    // serialise identically. A guard here was dead code — mutation testing
    // surfaced it by mutating the guard with no test able to notice.
    return String(n);
  }

  if (t === 'boolean') return value ? 'true' : 'false';

  if (t === 'bigint') {
    throw new CanonicalisationError(
      `BigInt at ${path} has no JSON representation. Convert to a number or string first.`,
    );
  }

  if (t === 'undefined') {
    throw new CanonicalisationError(
      `undefined at ${path}. Top-level and array-element undefined is ambiguous; ` +
        `use null to mean "known to be absent".`,
    );
  }

  if (t === 'function' || t === 'symbol') {
    throw new CanonicalisationError(`Cannot canonicalise ${t} at ${path}.`);
  }

  if (Array.isArray(value)) {
    // Indexed loop, not .map(): map SKIPS holes in a sparse array, so
    // [1,,3].map(f).join(',') yields "1,,3" — not valid JSON, and it would
    // throw in any consumer parsing our canonical form.
    // Found by test, not by inspection.
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      const v = (value as unknown[])[i];
      parts.push(v === undefined ? 'null' : canonicalise(v, `${path}[${i}]`));
    }
    return `[${parts.join(',')}]`;
  }

  // Plain object.
  const obj = value as Record<string, unknown>;
  // Default sort is ALREADY UTF-16 code-unit order, and unlike localeCompare
  // it does not vary by ICU build — so hashes stay machine-independent. A
  // hand-written comparator carried an unreachable equal-branch (Object.keys
  // never repeats a key), which mutation testing exposed as dead code.
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();

  const parts = keys.map(
    (k) => `${JSON.stringify(k.normalize('NFC'))}:${canonicalise(obj[k], `${path}.${k}`)}`,
  );
  return `{${parts.join(',')}}`;
}

/** `sha256:<hex>` over the canonical form. */
export function hashOf(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalise(value), 'utf8').digest('hex')}`;
}

/** Hash of an already-canonical string. For chaining hashes of hashes. */
export function hashOfString(s: string): string {
  return `sha256:${createHash('sha256').update(s.normalize('NFC'), 'utf8').digest('hex')}`;
}
