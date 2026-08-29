import { describe, it, expect } from 'vitest';
import {
  classify,
  precedence,
  DIVERGENCE_CLASSES,
  CLASS_DEFINITIONS,
  type DivergenceClass,
} from '../src/taxonomy/classes.js';
import { LABELLED_CASES } from './taxonomy.cases.js';

describe('taxonomy: precedence ordering', () => {
  it('assigns every hand-labelled case its expected class', () => {
    const mismatches: string[] = [];
    for (const c of LABELLED_CASES) {
      // ABSTAIN is a gate-level outcome, not a classification outcome: the
      // classifier is asked only whether a divergence class fires.
      const expected = c.expected === 'ABSTAIN' ? null : c.expected;
      const actual = classify(c.signals);
      if (actual !== expected) {
        mismatches.push(`${c.id}: expected ${expected ?? 'conforming'}, got ${actual ?? 'conforming'}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('covers every class at least once', () => {
    const seen = new Set(
      LABELLED_CASES.map((c) => classify(c.signals)).filter((c): c is DivergenceClass => c !== null),
    );
    expect([...seen].sort()).toEqual([...DIVERGENCE_CLASSES].sort());
  });

  it('includes conforming cases, so the fixture is not all-positive', () => {
    const conforming = LABELLED_CASES.filter((c) => c.expected === null);
    expect(conforming.length).toBeGreaterThanOrEqual(4);
  });

  it('includes at least one abstention case', () => {
    expect(LABELLED_CASES.some((c) => c.expected === 'ABSTAIN')).toBe(true);
  });

  it('includes enough precedence probes to exercise the ordering', () => {
    const probes = LABELLED_CASES.filter((c) => c.probesPrecedence);
    expect(probes.length).toBeGreaterThanOrEqual(6);
  });
});

describe('taxonomy: mutual exclusivity', () => {
  it('returns exactly one class for any combination of signals', () => {
    // Exhaustive over all 2^5 signal combinations. classify() is total and
    // single-valued by construction; this proves it over the whole domain.
    for (let mask = 0; mask < 32; mask++) {
      const result = classify({
        outOfScope: Boolean(mask & 1),
        breachesStatedBound: Boolean(mask & 2),
        fillsNoRequestedSlot: Boolean(mask & 4),
        wrongProductForSlot: Boolean(mask & 8),
        wrongQuantityForSlot: Boolean(mask & 16),
      });
      const valid = result === null || DIVERGENCE_CLASSES.includes(result);
      expect(valid, `mask ${mask} produced ${String(result)}`).toBe(true);
    }
  });

  it('always picks the highest-precedence firing signal', () => {
    for (let mask = 1; mask < 32; mask++) {
      const signals = {
        outOfScope: Boolean(mask & 1),
        breachesStatedBound: Boolean(mask & 2),
        fillsNoRequestedSlot: Boolean(mask & 4),
        wrongProductForSlot: Boolean(mask & 8),
        wrongQuantityForSlot: Boolean(mask & 16),
      };
      const firing: DivergenceClass[] = [];
      if (signals.outOfScope) firing.push('SCOPE_VIOLATION');
      if (signals.breachesStatedBound) firing.push('CONSTRAINT_BREACH');
      if (signals.fillsNoRequestedSlot) firing.push('UNREQUESTED_ADDITION');
      if (signals.wrongProductForSlot) firing.push('ITEM_SUBSTITUTION');
      if (signals.wrongQuantityForSlot) firing.push('QUANTITY_DEVIATION');

      const winner = firing.reduce((a, b) => (precedence(a) <= precedence(b) ? a : b));
      expect(classify(signals)).toBe(winner);
    }
  });

  it('returns null when no signal fires', () => {
    expect(
      classify({
        outOfScope: false,
        breachesStatedBound: false,
        fillsNoRequestedSlot: false,
        wrongProductForSlot: false,
        wrongQuantityForSlot: false,
      }),
    ).toBeNull();
  });
});

describe('taxonomy: definitions are complete', () => {
  it('defines every class with a boundary', () => {
    for (const id of DIVERGENCE_CLASSES) {
      const def = CLASS_DEFINITIONS[id];
      expect(def.id).toBe(id);
      expect(def.question.length).toBeGreaterThan(20);
      expect(def.holds.length).toBeGreaterThan(40);
      // Every class states what it is NOT. This is what stops the classes
      // silently drifting back into overlap.
      expect(def.isNot.length).toBeGreaterThanOrEqual(2);
      expect(def.example.length).toBeGreaterThan(10);
    }
  });
});
