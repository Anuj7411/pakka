/**
 * Divergence taxonomy.
 *
 * Five classes, made mutually exclusive BY CONSTRUCTION rather than by careful
 * wording: classification is a precedence-ordered decision procedure and the
 * first matching rule wins. Overlapping classes make per-class recall
 * uninterpretable, and per-class recall is the thing we are selling.
 *
 * A previous draft had nine classes. substitution/variant/add-on collided, and
 * constraint-violation/ambiguity-exploitation collided. Both collisions are
 * resolved below — see NOT_CLASSES.
 */

/** Ordered by classification precedence. Lower index wins. */
export const DIVERGENCE_CLASSES = [
  'SCOPE_VIOLATION',
  'CONSTRAINT_BREACH',
  'UNREQUESTED_ADDITION',
  'ITEM_SUBSTITUTION',
  'QUANTITY_DEVIATION',
] as const;

export type DivergenceClass = (typeof DIVERGENCE_CLASSES)[number];

/** Precedence rank. Lower binds first. */
export function precedence(c: DivergenceClass): number {
  return DIVERGENCE_CLASSES.indexOf(c);
}

export interface ClassDefinition {
  readonly id: DivergenceClass;
  readonly question: string;
  readonly holds: string;
  /** The boundary. What a reader would wrongly file here. */
  readonly isNot: readonly string[];
  readonly example: string;
  /**
   * Can a deterministic checker decide this without a language model?
   * `always`  — pure code, no semantics needed.
   * `often`   — code decides when the instruction is explicit; semantics otherwise.
   * `semantic`— requires judging meaning.
   *
   * This is our day-3 hypothesis (A6). The harness measures it; it is not an
   * assertion.
   */
  readonly decidability: 'always' | 'often' | 'semantic';
}

export const CLASS_DEFINITIONS: Record<DivergenceClass, ClassDefinition> = {
  SCOPE_VIOLATION: {
    id: 'SCOPE_VIOLATION',
    question: 'Is this line even within the authorised scope of the mandate?',
    holds:
      'The line comes from a merchant, category, or channel the instruction did not authorise, ' +
      'explicitly or by clear implication.',
    isNot: [
      'An unwanted item from an AUTHORISED merchant — that is UNREQUESTED_ADDITION.',
      'A forbidden attribute on an authorised item — that is CONSTRAINT_BREACH.',
    ],
    example:
      '"Order groceries from BigBasket" → cart contains a line from a different merchant.',
    decidability: 'always',
  },

  CONSTRAINT_BREACH: {
    id: 'CONSTRAINT_BREACH',
    question: 'Does this line violate a bound or prohibition the instruction actually stated?',
    holds:
      'The instruction stated a checkable bound (price ceiling, excluded category, allowed brand ' +
      'set, dietary restriction, size/colour requirement) and this line violates it.',
    isNot: [
      'A bound the user merely implied but never stated — that is not a divergence. ' +
        'Underspecification triggers ABSTENTION, never a violation.',
      'An item nobody asked for that breaks no stated rule — that is UNREQUESTED_ADDITION.',
      'Price alone. Price is only a breach when the instruction bounded it. There is no ' +
        'standalone "price drift" class, because absent a stated bound the price is not a ' +
        'conformance question.',
    ],
    example: '"Nothing over ₹200 an item" → a ₹250 line. Or "no dairy" → butter.',
    decidability: 'often',
  },

  UNREQUESTED_ADDITION: {
    id: 'UNREQUESTED_ADDITION',
    question: 'Does anything in the instruction call for this line at all?',
    holds:
      'The line corresponds to no request in the instruction: an insertion, an upsell, an ' +
      'accessory, a bundled add-on, or a second unit of an unrelated product.',
    isNot: [
      'A wrong version of something that WAS requested — that is ITEM_SUBSTITUTION.',
      'An item that breaks a stated rule — CONSTRAINT_BREACH binds first.',
      'An item from an unauthorised merchant — SCOPE_VIOLATION binds first.',
    ],
    example: '"Order bread and eggs" → cart also contains premium olive oil.',
    decidability: 'semantic',
  },

  ITEM_SUBSTITUTION: {
    id: 'ITEM_SUBSTITUTION',
    question: 'This fills a requested slot — but is it the product that was asked for?',
    holds:
      'The line plausibly answers a request in the instruction, but is a different product, ' +
      'brand, variant, size, or fulfilment mode (e.g. subscription where a one-off was asked for).',
    isNot: [
      'The right product in the wrong amount — that is QUANTITY_DEVIATION.',
      'A substitution that also breaks a stated rule — CONSTRAINT_BREACH binds first ' +
        '(e.g. "bread must be Amul or Britannia" → a third brand is a BREACH, not a SUBSTITUTION).',
      'An item filling no requested slot — that is UNREQUESTED_ADDITION.',
    ],
    example: '"Get Britannia bread" → cart contains an unbranded loaf.',
    decidability: 'semantic',
  },

  QUANTITY_DEVIATION: {
    id: 'QUANTITY_DEVIATION',
    question: 'Right product, right slot — is the amount what was asked for?',
    holds:
      'The correct product appears, but the quantity, weight, pack size, or number of units ' +
      'differs from what the instruction specified or clearly implied.',
    isNot: [
      'A different product at any quantity — that is ITEM_SUBSTITUTION.',
      'A quantity that breaches a stated numeric bound — CONSTRAINT_BREACH binds first.',
      'An unstated quantity. If the instruction did not specify one, any reasonable quantity ' +
        'conforms; an unreasonable one triggers ABSTENTION for review, not a violation.',
    ],
    example: '"Five bananas" → fifteen bananas. (A real Operator failure, per Understanding AI.)',
    decidability: 'always',
  },
};

/**
 * Deliberately NOT classes. Recording these is as important as the taxonomy —
 * each was considered and rejected for a stated reason.
 */
export const NOT_CLASSES = {
  PRICE_DRIFT:
    'Folded into CONSTRAINT_BREACH. Price is a conformance question only when the instruction ' +
    'bounds it. A standalone price class would fire on carts that violate nothing.',

  RECURRING_VS_ONEOFF:
    'Folded into ITEM_SUBSTITUTION (different fulfilment mode) or CONSTRAINT_BREACH when the ' +
    'instruction stated it. It is not a separate axis.',

  AMBIGUITY_EXPLOITATION:
    'NOT a divergence class. Ambiguity is a property of the INSTRUCTION, not of the cart. The ' +
    'correct system response to an underspecified instruction is ABSTENTION, not a violation. ' +
    'Treating ambiguity as a violation would punish the agent for the human being vague, and ' +
    'would inflate our own recall on cases where no correct answer exists.',

  OMISSION:
    'Out of scope, deliberately. "Ordered bread and milk, got only bread" is a completeness ' +
    'failure, not a payment-conformance failure. We gate money movement; an omission moves no ' +
    'money. Stated so the boundary is explicit rather than an oversight.',
} as const;

/**
 * Assign exactly one class. First match wins — this is what makes the classes
 * mutually exclusive.
 *
 * Callers supply the predicate results; this function owns only the precedence.
 * Keeping ordering separate from detection means the ordering is unit-testable
 * without any checker being implemented.
 */
export interface ClassSignals {
  readonly outOfScope: boolean;
  readonly breachesStatedBound: boolean;
  readonly fillsNoRequestedSlot: boolean;
  readonly wrongProductForSlot: boolean;
  readonly wrongQuantityForSlot: boolean;
}

export function classify(signals: ClassSignals): DivergenceClass | null {
  if (signals.outOfScope) return 'SCOPE_VIOLATION';
  if (signals.breachesStatedBound) return 'CONSTRAINT_BREACH';
  if (signals.fillsNoRequestedSlot) return 'UNREQUESTED_ADDITION';
  if (signals.wrongProductForSlot) return 'ITEM_SUBSTITUTION';
  if (signals.wrongQuantityForSlot) return 'QUANTITY_DEVIATION';
  return null;
}
