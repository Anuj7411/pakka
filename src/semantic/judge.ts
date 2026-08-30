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
 */
import type { Cart, Mandate } from '../corpus/types.js';
import type { CartAssessment } from '../deterministic/checkers.js';
import { assignLines } from '../deterministic/checkers.js';
import { toModelView } from './redact.js';
import { buildPrompt, SYSTEM_INSTRUCTION, type JudgeVerdict } from './prompt.js';
import type { Provider } from './provider.js';
import type { Finding } from '../gate/compose.js';

/**
 * Confidence below which a `wrong_product` verdict is treated as abstention.
 *
 * Provisional. The abstention band is CALIBRATED against measured data in the
 * coverage-risk sweep, not chosen by feel — see docs/RESULTS-DAY4.md. Named
 * here so the number in the results traces to a decision.
 */
export const ABSTAIN_BELOW = 0.5;

export interface SemanticResult {
  readonly findings: readonly Finding[];
  /** Every verdict, for calibration. Abstentions included. */
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
  opts: { abstainBelow?: number } = {},
): Promise<SemanticResult> {
  const abstainBelow = opts.abstainBelow ?? ABSTAIN_BELOW;
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
      // Unassigned lines are already UNREQUESTED_ADDITION deterministically.
      // If we reach here the deterministic layer declined to say so, and the
      // model has no request to compare against either.
      continue;
    }

    const view = toModelView(assigned.item, line);
    const verdict = await provider.judge({
      system: SYSTEM_INSTRUCTION,
      user: buildPrompt(view),
    });
    called++;
    verdicts.push({ lineId: line.lineId, verdict });

    if (verdict.verdict === 'wrong_product') {
      if (verdict.confidence >= abstainBelow) {
        findings.push({
          lineId: line.lineId,
          source: 'semantic',
          detail: `does not answer "${assigned.item.text.slice(0, 60)}": ${verdict.reason.slice(0, 120)}`,
        });
      } else {
        // Below the band: recorded as abstention, which still escalates. A
        // low-confidence accusation is not evidence, but it is not nothing.
        findings.push({
          lineId: line.lineId,
          source: 'abstention',
          detail: `low-confidence (${verdict.confidence.toFixed(2)}) doubt about fit`,
        });
      }
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
