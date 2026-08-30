/**
 * Evaluation harness.
 *
 * Built before the model, deliberately: a real number from deterministic code
 * alone is the floor everything else is measured against, and it is what makes
 * the Day 4 ablation meaningful.
 *
 * Two levels are reported separately, because conflating them flatters:
 *   DETECTION      — did we flag the cart at all?
 *   CLASSIFICATION — did we flag the RIGHT line with the RIGHT class?
 * A checker that flags everything scores 100% detection and is useless. The
 * trivial baselines make that visible instead of leaving it implied.
 */
import type { Case, Corpus, Tier } from '../corpus/types.js';
import { DIVERGENCE_CLASSES, type DivergenceClass } from '../taxonomy/classes.js';
import { TIERS } from '../corpus/types.js';
import { rate, macroAverage, type Rate } from './metrics.js';

/** What a checker returns for one case. */
export interface Prediction {
  readonly caseId: string;
  readonly violations: readonly { lineId: string; class: DivergenceClass }[];
}

export type Checker = (c: Case) => Prediction;

/**
 * Does this checker read the product NAME?
 *
 * It decides whether a false-positive rate means anything. A conforming case is
 * built by attaching a human instruction, and its gold target's attributes, to
 * the nearest product we actually hold — because WebShop's gold target is in
 * our catalogue for 4 instructions out of 10,136. The declared fields are
 * internally consistent, so a checker that reads only those is measuring itself
 * when it reports a false positive.
 *
 * The product NAME is not consistent with them. It names a different object,
 * and it says so out loud: "full sized bed frame" paired with "Cole Frame Queen
 * Bed", "butter pecan coffee" with "Pilon Espresso Coffee". A checker that
 * reads names is right to flag those, and counting that as a false positive
 * measures our corpus, not the checker.
 *
 * So the rate is withheld rather than printed with a caveat underneath it. A
 * number in a table gets quoted; a caveat does not.
 */
export interface CheckerFacts {
  readonly readsProductName: boolean;
}

export interface Report {
  readonly name: string;
  /** Flagged a divergent cart at all, regardless of line or class. */
  readonly detection: Rate;
  /** Flagged the right line with the right class. */
  readonly classification: Rate;
  /**
   * Conforming carts wrongly flagged. The number a payments company cares
   * about — and null when it cannot be measured; see CheckerFacts.
   */
  readonly falsePositive: Rate | null;
  readonly byClass: Readonly<Record<DivergenceClass, Rate>>;
  readonly byTier: Readonly<Record<Tier, Rate>>;
  readonly byClassTier: Readonly<Record<string, Rate>>;
  /** Macro-average of per-tier classification. The headline. */
  readonly macroByTier: number;
  /** Macro-average over every non-empty class x tier cell. */
  readonly macroByClassTier: number;
  /** Share of divergent cases where the checker abstained entirely. */
  readonly silent: Rate;
  readonly prevalence: number;
  /**
   * Precision, meaningless without prevalence — always read them together.
   * Null whenever falsePositive is, since it is computed from it.
   */
  readonly precision: Rate | null;
}

export function evaluate(
  corpus: Corpus,
  checker: Checker,
  name: string,
  facts: CheckerFacts = { readsProductName: false },
): Report {
  const divergent = corpus.cases.filter((c) => !c.conforming);
  const conforming = corpus.cases.filter((c) => c.conforming);

  let detected = 0;
  let classified = 0;
  let silent = 0;
  const classHits = new Map<DivergenceClass, [number, number]>();
  const tierHits = new Map<Tier, [number, number]>();
  const cellHits = new Map<string, [number, number]>();

  const bump = <K>(m: Map<K, [number, number]>, k: K, hit: boolean) => {
    const cur = m.get(k) ?? [0, 0];
    m.set(k, [cur[0] + (hit ? 1 : 0), cur[1] + 1]);
  };

  for (const c of divergent) {
    const expected = c.expected[0]!;
    const pred = checker(c);
    const flagged = pred.violations.length > 0;
    const exact = pred.violations.some(
      (v) => v.lineId === expected.lineId && v.class === expected.class,
    );
    if (flagged) detected++;
    else silent++;
    if (exact) classified++;
    bump(classHits, expected.class, exact);
    bump(tierHits, expected.tier, exact);
    bump(cellHits, `${expected.class}/${expected.tier}`, exact);
  }

  let falsePositives = 0;
  for (const c of conforming) {
    if (checker(c).violations.length > 0) falsePositives++;
  }

  const byClass = Object.fromEntries(
    DIVERGENCE_CLASSES.map((k) => {
      const [h, t] = classHits.get(k) ?? [0, 0];
      return [k, rate(h, t)];
    }),
  ) as Record<DivergenceClass, Rate>;

  const byTier = Object.fromEntries(
    TIERS.map((k) => {
      const [h, t] = tierHits.get(k) ?? [0, 0];
      return [k, rate(h, t)];
    }),
  ) as Record<Tier, Rate>;

  const byClassTier = Object.fromEntries(
    [...cellHits.entries()].sort().map(([k, [h, t]]) => [k, rate(h, t)]),
  );

  // Precision over CASES: a divergent case counts as a true positive when the
  // checker flagged it; a conforming case flagged is a false positive.
  //
  // Both are withheld from a name-reading checker: the conforming labels are
  // not verified against the product name, so neither number would be about
  // the checker.
  const measurable = !facts.readsProductName;
  const precision = measurable ? rate(detected, detected + falsePositives) : null;

  return {
    name,
    detection: rate(detected, divergent.length),
    classification: rate(classified, divergent.length),
    falsePositive: measurable ? rate(falsePositives, conforming.length) : null,
    byClass,
    byTier,
    byClassTier,
    macroByTier: macroAverage(TIERS.map((t) => byTier[t])),
    macroByClassTier: macroAverage(Object.values(byClassTier)),
    silent: rate(silent, divergent.length),
    // Guard the divide: an empty corpus would otherwise yield 0/0 = NaN, and a
    // NaN in a report is worse than a crash because it propagates silently
    // through every derived figure. Found by test.
    prevalence: corpus.cases.length === 0 ? 0 : divergent.length / corpus.cases.length,
    precision,
  };
}

// ---------------------------------------------------------------------------
// Trivial baselines
// ---------------------------------------------------------------------------

/**
 * The floor any real result must clear.
 *
 * `alwaysFlag` scores perfect detection and is worthless — it exists so that a
 * detection number is never read without its false-positive rate. `biggestCart`
 * is the leakage probe: an addition always adds a line, so cart size carries
 * real signal about the label. Reporting what a size-only classifier achieves
 * is how that leak is disclosed rather than hidden.
 */
export const BASELINES: Readonly<Record<string, Checker>> = {
  neverFlag: (c) => ({ caseId: c.caseId, violations: [] }),

  alwaysFlag: (c) => ({
    caseId: c.caseId,
    violations: c.cart.lines.map((l) => ({ lineId: l.lineId, class: 'CONSTRAINT_BREACH' as const })),
  }),

  /** Flags the last line of any cart with more than 2 lines. */
  biggestCart: (c) => {
    if (c.cart.lines.length <= 2) return { caseId: c.caseId, violations: [] };
    const last = c.cart.lines[c.cart.lines.length - 1]!;
    return {
      caseId: c.caseId,
      violations: [{ lineId: last.lineId, class: 'UNREQUESTED_ADDITION' as const }],
    };
  },
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function formatReport(r: Report, fmt: (x: Rate) => string): string[] {
  const out: string[] = [];
  out.push(`── ${r.name} ──`);
  out.push(`  detection      ${fmt(r.detection)}   (flagged the cart at all)`);
  out.push(`  classification ${fmt(r.classification)}   (right line AND right class)`);
  if (r.falsePositive === null || r.precision === null) {
    out.push('  false positive NOT MEASURABLE — conforming labels are not verified');
    out.push('  precision      NOT MEASURABLE — depends on the false-positive count');
  } else {
    out.push(`  false positive ${fmt(r.falsePositive)}   (conforming carts wrongly flagged)`);
    out.push(`  precision      ${fmt(r.precision)}   at prevalence ${(r.prevalence * 100).toFixed(0)}%`);
  }
  out.push(`  silent         ${fmt(r.silent)}   (divergent carts where it said nothing)`);
  out.push('  by class:');
  for (const k of DIVERGENCE_CLASSES) out.push(`    ${k.padEnd(22)} ${fmt(r.byClass[k])}`);
  out.push('  by tier:');
  for (const t of TIERS) out.push(`    ${t.padEnd(22)} ${fmt(r.byTier[t])}`);
  out.push(`  MACRO across tiers        ${(r.macroByTier * 100).toFixed(1)}%`);
  out.push(`  MACRO across class x tier ${(r.macroByClassTier * 100).toFixed(1)}%`);
  return out;
}
