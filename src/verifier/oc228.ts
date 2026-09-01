/**
 * OC-228 constraint verifier.
 *
 * ── It can only reject ──────────────────────────────────────────────────────
 * There is no function here that proposes an amount, adjusts one, or returns a
 * "corrected" block. The only output is a list of violations, and an empty list
 * is the only way to pass. A verifier that could repair its input would be a
 * second sizer wearing a badge.
 *
 * ── It shares no code with the sizer ────────────────────────────────────────
 * Clark-Wilson E3. This file imports nothing from `src/sizer/`. The regulatory
 * constants are DUPLICATED here rather than imported, and that duplication is
 * the point: if the sizer's ceiling is wrong, an imported constant makes the
 * verifier wrong in exactly the same way and the check proves nothing. Two
 * independent statements of ₹10,000 can disagree. One shared statement cannot.
 *
 * The types below are also declared locally for the same reason.
 *
 * ── Provenance of the constraints ───────────────────────────────────────────
 * NPCI/UPI/OC-228/2025-26, "Enhancement in UPI Single Block Multiple Debits
 * (UPI Reserve Pay)", 08-Oct-2025.
 *
 * The NPCI PDF returns HTTP 403 to automated fetching, so these are verified by
 * triangulation across three independent secondary sources that agree verbatim,
 * two of them payment-aggregator developer documentation. That is stated rather
 * than hidden: if the circular differs, this module is where it is wrong, and
 * the conformance half of the project is unaffected.
 *
 *   - one block per merchant per customer
 *   - maximum ₹10,000 per block
 *   - validity up to 90 days
 *   - multiple and partial debits until the amount is used, revoked, or expires
 *   - the unused remainder is auto-released
 */

/** ₹10,000 in paise. Stated here independently of the sizer. */
export const OC228_MAX_BLOCK_PAISE = 10_000_00;

/** Maximum block validity in days, stated here independently of the sizer. */
export const OC228_MAX_VALIDITY_DAYS = 90;

export const OC228_VERIFIER_VERSION = 'oc228-verifier/1';

/** A block as the verifier understands it. Declared locally, deliberately. */
export interface Block {
  readonly blockId: string;
  readonly merchantId: string;
  readonly customerId: string;
  readonly amountPaise: number;
  readonly validityDays: number;
  /** Whole days since an arbitrary epoch. Integer arithmetic only. */
  readonly createdOnDay: number;
}

export interface Debit {
  readonly blockId: string;
  readonly amountPaise: number;
  readonly onDay: number;
}

export type BlockEndReason = 'revoked' | 'expired' | 'exhausted';

export interface BlockLifecycle {
  readonly block: Block;
  readonly debits: readonly Debit[];
  /** Day the block was revoked, if it was. */
  readonly revokedOnDay?: number;
}

export type ViolationCode =
  | 'AMOUNT_EXCEEDS_MAX'
  | 'AMOUNT_NOT_POSITIVE'
  | 'AMOUNT_NOT_INTEGER'
  | 'VALIDITY_EXCEEDS_MAX'
  | 'VALIDITY_NOT_POSITIVE'
  | 'CONCURRENT_BLOCK_FOR_PAIR'
  | 'DEBIT_EXCEEDS_BLOCK'
  | 'DEBIT_AFTER_EXPIRY'
  | 'DEBIT_AFTER_REVOKE'
  | 'DEBIT_BEFORE_BLOCK'
  | 'DEBIT_NOT_POSITIVE'
  | 'DEBIT_ON_UNKNOWN_BLOCK';

export interface Violation {
  readonly code: ViolationCode;
  readonly blockId: string;
  /** Enough to re-derive the judgement without re-running the simulation. */
  readonly detail: string;
}

/**
 * Check one proposed block in isolation.
 *
 * `existing` is every block already live for this merchant-customer pair. The
 * caller supplies it; the verifier does not query anything, because a verifier
 * that reads state is a verifier whose answer depends on when you asked.
 */
export function verifyBlock(block: Block, existing: readonly Block[] = []): Violation[] {
  const out: Violation[] = [];

  if (!Number.isInteger(block.amountPaise)) {
    out.push({
      code: 'AMOUNT_NOT_INTEGER',
      blockId: block.blockId,
      detail: `amount ${block.amountPaise} is not a whole number of paise`,
    });
  }
  if (block.amountPaise <= 0) {
    out.push({
      code: 'AMOUNT_NOT_POSITIVE',
      blockId: block.blockId,
      detail: `amount ${block.amountPaise} must be positive`,
    });
  }
  if (block.amountPaise > OC228_MAX_BLOCK_PAISE) {
    out.push({
      code: 'AMOUNT_EXCEEDS_MAX',
      blockId: block.blockId,
      detail: `amount ${block.amountPaise} exceeds the ${OC228_MAX_BLOCK_PAISE} paise ceiling`,
    });
  }
  if (!Number.isInteger(block.validityDays) || block.validityDays <= 0) {
    out.push({
      code: 'VALIDITY_NOT_POSITIVE',
      blockId: block.blockId,
      detail: `validity ${block.validityDays} days must be a positive whole number`,
    });
  }
  if (block.validityDays > OC228_MAX_VALIDITY_DAYS) {
    out.push({
      code: 'VALIDITY_EXCEEDS_MAX',
      blockId: block.blockId,
      detail: `validity ${block.validityDays} days exceeds the ${OC228_MAX_VALIDITY_DAYS} day ceiling`,
    });
  }

  // One block per merchant per customer. Checked against what the caller says
  // is live, and only for the SAME pair — a merchant may hold blocks for many
  // customers, and a customer may hold blocks with many merchants.
  const clash = existing.find(
    (b) =>
      b.blockId !== block.blockId &&
      b.merchantId === block.merchantId &&
      b.customerId === block.customerId,
  );
  if (clash) {
    out.push({
      code: 'CONCURRENT_BLOCK_FOR_PAIR',
      blockId: block.blockId,
      detail: `block ${clash.blockId} is already live for merchant ${clash.merchantId} and this customer`,
    });
  }

  return out;
}

/**
 * Check a block and every debit taken against it.
 *
 * Debits are processed in the order given, because "does this debit fit in what
 * remains" depends on what came before it. Out-of-order input is the caller's
 * problem to sort, and pretending otherwise would let an over-debit hide behind
 * a re-sort.
 */
export function verifyLifecycle(
  lifecycle: BlockLifecycle,
  existing: readonly Block[] = [],
): Violation[] {
  const { block, debits, revokedOnDay } = lifecycle;
  const out: Violation[] = verifyBlock(block, existing);

  const expiresOnDay = block.createdOnDay + block.validityDays;
  let drawn = 0;

  for (const d of debits) {
    if (d.blockId !== block.blockId) {
      out.push({
        code: 'DEBIT_ON_UNKNOWN_BLOCK',
        blockId: d.blockId,
        detail: `debit references ${d.blockId} but the block is ${block.blockId}`,
      });
      continue;
    }
    if (!Number.isInteger(d.amountPaise) || d.amountPaise <= 0) {
      out.push({
        code: 'DEBIT_NOT_POSITIVE',
        blockId: block.blockId,
        detail: `debit of ${d.amountPaise} must be a positive whole number of paise`,
      });
      continue;
    }
    if (d.onDay < block.createdOnDay) {
      out.push({
        code: 'DEBIT_BEFORE_BLOCK',
        blockId: block.blockId,
        detail: `debit on day ${d.onDay} precedes the block created on day ${block.createdOnDay}`,
      });
    }
    // The block is live for `validityDays` days; a debit ON the expiry day is
    // already outside it.
    if (d.onDay >= expiresOnDay) {
      out.push({
        code: 'DEBIT_AFTER_EXPIRY',
        blockId: block.blockId,
        detail: `debit on day ${d.onDay}; block expired on day ${expiresOnDay}`,
      });
    }
    if (revokedOnDay !== undefined && d.onDay >= revokedOnDay) {
      out.push({
        code: 'DEBIT_AFTER_REVOKE',
        blockId: block.blockId,
        detail: `debit on day ${d.onDay}; block revoked on day ${revokedOnDay}`,
      });
    }

    drawn += d.amountPaise;
    if (drawn > block.amountPaise) {
      // Partial and multiple debits are permitted; drawing MORE than was
      // blocked is not, and it is the violation that costs a customer money.
      out.push({
        code: 'DEBIT_EXCEEDS_BLOCK',
        blockId: block.blockId,
        detail: `debits total ${drawn} against a block of ${block.amountPaise}`,
      });
    }
  }

  return out;
}

/** Convenience for the headline metric: did anything at all go wrong? */
export function isCompliant(violations: readonly Violation[]): boolean {
  return violations.length === 0;
}

/**
 * The remainder that auto-releases when a block ends.
 *
 * Reported, not enforced: the release is the issuer's action, not ours. Stating
 * the number is how a customer can check they got it back.
 */
export function unusedRemainder(lifecycle: BlockLifecycle): number {
  const drawn = lifecycle.debits
    .filter((d) => d.blockId === lifecycle.block.blockId && d.amountPaise > 0)
    .reduce((n, d) => n + d.amountPaise, 0);
  return Math.max(0, lifecycle.block.amountPaise - drawn);
}
