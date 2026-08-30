/**
 * Metrics.
 *
 * Per EVAL-METHODOLOGY: no accuracy, no headline F1. Recall is reported per
 * class and per tier with Wilson intervals, precision is never quoted without
 * prevalence beside it, and the headline is the macro-average across difficulty
 * tiers — which is the direct answer to "your synthetic divergences are easier
 * than real ones".
 */

/**
 * Wilson score interval.
 *
 * Not the normal approximation: at the extremes (0/30 correct, 30/30 correct)
 * the normal interval collapses to zero width and claims certainty from a
 * handful of samples. Wilson does not, which matters because several of our
 * per-class-per-tier cells hold ~26-40 cases.
 */
export function wilson(successes: number, total: number, z = 1.96): { lo: number; hi: number } {
  if (total === 0) return { lo: 0, hi: 0 };
  const p = successes / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
  return {
    lo: Math.max(0, (centre - spread) / denom),
    hi: Math.min(1, (centre + spread) / denom),
  };
}

export interface Rate {
  readonly hits: number;
  readonly total: number;
  readonly rate: number;
  readonly lo: number;
  readonly hi: number;
}

export function rate(hits: number, total: number): Rate {
  const { lo, hi } = wilson(hits, total);
  return { hits, total, rate: total === 0 ? 0 : hits / total, lo, hi };
}

export function fmtRate(r: Rate): string {
  if (r.total === 0) return '     n/a';
  return `${(r.rate * 100).toFixed(1)}% [${(r.lo * 100).toFixed(0)}-${(r.hi * 100).toFixed(0)}] n=${r.total}`;
}

/** Unweighted mean over non-empty cells. Empty cells are excluded, not counted as zero. */
export function macroAverage(rates: readonly Rate[]): number {
  const present = rates.filter((r) => r.total > 0);
  if (present.length === 0) return 0;
  return present.reduce((s, r) => s + r.rate, 0) / present.length;
}
