/**
 * Decision lattice and composition.
 *
 * ── The core security property ──────────────────────────────────────────────
 *
 *   allow < escalate < block            (totally ordered)
 *   decision = max(deterministic, semantic)
 *
 * Composition is a JOIN. For any semantic output s, max(d, s) >= d, so the
 * semantic layer can only ever move a decision UP the lattice. It cannot turn
 * a block into an allow, whatever it returns and whatever an attacker persuaded
 * it to say.
 *
 * That is why a language model is safe to place in a money path here. The worst
 * a successful prompt injection achieves is a false positive: a good cart gets
 * escalated to a human. A false positive is a UX cost. An approval would be a
 * money loss.
 *
 * It is also the honest answer to "isn't this just an LLM-as-judge wrapper?".
 * A wrapper trusts the model. This one structurally cannot.
 *
 * SECURITY-MODEL.md, Unit III. Related to Biba's no-write-up in spirit,
 * implemented as lattice monotonicity rather than a full labelling scheme —
 * stated that way because claiming Biba compliance we have not built would be
 * worse than claiming nothing.
 */

/** Ordered weakest to strongest. Index IS the rank. */
export const DECISIONS = ['allow', 'escalate', 'block'] as const;
export type GateDecision = (typeof DECISIONS)[number];

export function rank(d: GateDecision): number {
  return DECISIONS.indexOf(d);
}

/** Join: the stricter of two decisions. Commutative, associative, idempotent. */
export function join(a: GateDecision, b: GateDecision): GateDecision {
  return rank(a) >= rank(b) ? a : b;
}

/** Join over many. `allow` is the identity, so an empty list is `allow`. */
export function joinAll(decisions: readonly GateDecision[]): GateDecision {
  return decisions.reduce<GateDecision>(join, 'allow');
}

/**
 * Deterministic findings BLOCK; semantic findings ESCALATE.
 *
 * Not timidity — the two have different epistemic status. A category mismatch
 * or a quantity that differs from a stated number is exact and re-derivable, so
 * blocking on it is safe. A model's judgement that a product does not answer a
 * request is an inference, and inferences belong in front of a human rather
 * than in front of a refused payment.
 *
 * This also puts the asymmetry the right way round for a payments company:
 * we block only what we can prove, and escalate what we merely believe.
 *
 * There was a third source, `abstention`, for model verdicts below a confidence
 * band. The band was removed once Day 4 measured the confidence signal as
 * degenerate (see judge.ts), and the source went with it: nothing could produce
 * one, and a decision-table row no code path can reach is a claim about
 * behaviour that does not exist.
 */
export const SOURCE_DECISION = {
  deterministic: 'block',
  semantic: 'escalate',
} as const satisfies Record<string, GateDecision>;

export type FindingSource = keyof typeof SOURCE_DECISION;

export interface Finding {
  readonly lineId: string;
  readonly source: FindingSource;
  readonly detail: string;
}

export interface Composed {
  readonly decision: GateDecision;
  readonly findings: readonly Finding[];
  /** Set when the semantic layer was unavailable or declined to answer. */
  readonly degraded: boolean;
}

/**
 * Compose a final decision.
 *
 * `degraded` is carried, never hidden: if the model was unreachable the
 * deterministic verdict still stands, the run is marked, and the outcome is
 * capped at `escalate` rather than being allowed to look like a clean pass.
 */
export function compose(findings: readonly Finding[], degraded: boolean): Composed {
  const fromFindings = joinAll(findings.map((f) => SOURCE_DECISION[f.source]));
  // A degraded run can never come back as a clean allow.
  const decision = degraded ? join(fromFindings, 'escalate') : fromFindings;
  return { decision, findings, degraded };
}
