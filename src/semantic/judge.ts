/**
 * Semantic judging: orchestration over the deterministic assessment.
 *
 * The model is asked about exactly one thing — ITEM_SUBSTITUTION, the class the
 * Day 3 measurement showed pure code decides 0% of the time. Everything else
 * (scope, stated bounds, quantity, unrequested lines) was 99.4-100% decidable
 * without it, so sending those to a model would spend rate limit and add
 * variance to buy nothing.
 *
 * That focus is also what makes the ablation legible: the model's contribution
 * is one named class, not a diffuse uplift.
 *
 * ── There is no confidence band, deliberately ───────────────────────────────
 * An earlier version treated `wrong_product` below 0.5 confidence as an
 * abstention. Day 4 measured the confidence signal across 37 distinct prompts:
 * two distinct values, 94.6% of them exactly 1.0, ECE 71.1%. Nothing was ever
 * below 0.5, so the band could not fire, and its own docstring claimed it had
 * been calibrated when it had not been. A threshold that never triggers is dead
 * code that advertises a calibration we do not have, so it is gone rather than
 * lowered.
 *
 * An abstention mechanism, if we want one, has to come from a signal that
 * varies — agreement across repeated samples, or a second lens — not from
 * asking the model how sure it is.
 */
import type { Cart, Mandate } from '../corpus/types.js';
import type { CartAssessment } from '../deterministic/checkers.js';
import { assignLines } from '../deterministic/checkers.js';
import { toModelView } from './redact.js';
import { buildPrompt, SYSTEM_INSTRUCTION, type JudgeVerdict } from './prompt.js';
import type { Provider } from './provider.js';
import type { Finding } from '../gate/compose.js';

export interface SemanticResult {
  readonly findings: readonly Finding[];
  /** Every verdict, including `unsure` and failures, for calibration. */
  readonly verdicts: readonly { lineId: string; verdict: JudgeVerdict }[];
  /** True when any call failed or the provider declined. */
  readonly degraded: boolean;
  readonly called: number;
}

/**
 * Judge only the lines the deterministic layer could not settle.
 *
 * A line that already carries a deterministic violation is not sent: the
 * decision is settled and, under the lattice, nothing the model says could
 * change it. Sending it anyway would be a call with no possible effect.
 */
export async function judgeCart(
  cart: Cart,
  mandate: Mandate,
  assessment: CartAssessment,
  provider: Provider,
): Promise<SemanticResult> {
  const alreadyFlagged = new Set(assessment.violations.map((v) => v.lineId));
  const assignment = assignLines(cart, mandate);

  const findings: Finding[] = [];
  const verdicts: { lineId: string; verdict: JudgeVerdict }[] = [];
  let degraded = false;
  let called = 0;

  for (const line of cart.lines) {
    if (alreadyFlagged.has(line.lineId)) continue;

    const assigned = assignment.get(line.lineId);
    if (!assigned) {
      // Currently UNREACHABLE, and deliberately kept.
      //
      // Every unassigned line is flagged UNREQUESTED_ADDITION by the
      // deterministic layer, so `alreadyFlagged` catches it above. This guard
      // exists because that is an invariant of another module, not of this one:
      // if the deterministic layer ever returns `undecidable` for an unassigned
      // line, `assigned` becomes undefined here and the alternative to this
      // branch is a non-null assertion that throws in production.
      //
      // tests/judge.test.ts pins the invariant, so if it breaks the test says
      // so rather than this line silently starting to matter.
      continue;
    }

    const view = toModelView(assigned.item, line);
    const verdict = await provider.judge({
      system: SYSTEM_INSTRUCTION,
      user: buildPrompt(view),
    });
    called++;
    verdicts.push({ lineId: line.lineId, verdict });

    // Every `wrong_product` is a finding, whatever confidence it carries. The
    // reported confidence is not used to gate anything — see the header.
    if (verdict.verdict === 'wrong_product') {
      findings.push({
        lineId: line.lineId,
        source: 'semantic',
        detail: `does not answer "${assigned.item.text.slice(0, 60)}": ${verdict.reason.slice(0, 120)}`,
      });
    }

    // A failure is an outage, not an opinion. Keyed off the explicit flag
    // rather than sniffing the reason string, because an earlier version that
    // could not tell the two apart reported a rate limit as a model result.
    if (verdict.failed) degraded = true;
    // `satisfies` adds nothing. It cannot clear a deterministic finding — the
    // schema has no value that could.
  }

  return { findings, verdicts, degraded, called };
}
