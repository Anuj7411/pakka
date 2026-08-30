import { describe, it, expect } from 'vitest';
import {
  assignLines,
  assessCart,
  assessLine,
  checkScope,
  checkStatedBounds,
  checkQuantity,
  checkAnswersARequest,
  checkProductForSlot,
} from '../src/deterministic/checkers.js';
import type { Mandate, MandateItem, Cart, CartLine } from '../src/corpus/types.js';

const item = (over: Partial<MandateItem> = {}): MandateItem => ({
  itemId: 'i0',
  text: 'blue wireless bluetooth headphones',
  statedAttributes: ['wireless bluetooth'],
  statedOptions: ['blue'],
  statedQuantity: null,
  sourceAsin: 'B000000000',
  ...over,
});

const mandate = (over: Partial<Mandate> = {}): Mandate => ({
  mandateId: 'm0',
  text: 'blue wireless bluetooth headphones',
  items: [item()],
  authorisedCategory: 'Electronics',
  ...over,
});

const line = (over: Partial<CartLine> = {}): CartLine => ({
  lineId: 'l0',
  answersItemId: null,
  sku: 'SKU',
  name: 'Acme Wireless Bluetooth Headphones',
  brand: 'Acme',
  priceMinor: 5000,
  quantity: 1,
  categoryPath: ['Electronics', 'Headphones'],
  options: ['color: blue'],
  attributes: ['wireless bluetooth'],
  ...over,
});

const cart = (lines: CartLine[]): Cart => ({ cartId: 'c0', lines });

describe('checkers: scope', () => {
  it('clears a line inside the authorised category', () => {
    expect(checkScope(line(), mandate()).decision).toBe('clear');
  });

  it('flags a line from another category, naming both', () => {
    const r = checkScope(line({ categoryPath: ['Grocery & Gourmet Food', 'Snacks'] }), mandate());
    expect(r.decision).toBe('violation');
    expect(r.evidence).toContain('Electronics');
    expect(r.evidence).toContain('Grocery & Gourmet Food');
  });

  it('is undecidable, NOT clear, when the line has no category', () => {
    // "Cannot tell" must never be recorded as "no problem".
    expect(checkScope(line({ categoryPath: [] }), mandate()).decision).toBe('undecidable');
  });
});

describe('checkers: stated bounds', () => {
  it('clears a line carrying the stated option and attribute', () => {
    expect(checkStatedBounds(line(), item()).decision).toBe('clear');
  });

  it('flags a changed option value', () => {
    const r = checkStatedBounds(line({ options: ['color: red'] }), item());
    expect(r.decision).toBe('violation');
    expect(r.evidence[0]).toContain('blue');
  });

  it('flags a dropped attribute when others are declared', () => {
    const r = checkStatedBounds(line({ attributes: ['noise cancelling'] }), item());
    expect(r.decision).toBe('violation');
    expect(r.evidence[0]).toContain('wireless bluetooth');
  });

  it('is undecidable when the line declares NO options to compare against', () => {
    const r = checkStatedBounds(line({ options: [] }), item());
    expect(r.decision).toBe('undecidable');
  });

  it('is undecidable when the line declares no attributes', () => {
    const r = checkStatedBounds(line({ attributes: [] }), item({ statedOptions: [] }));
    expect(r.decision).toBe('undecidable');
  });

  it('accepts containment in either direction', () => {
    // "blue" stated, "midnight blue" present — and the reverse.
    expect(checkStatedBounds(line({ options: ['color: midnight blue'] }), item()).decision).toBe('clear');
    expect(
      checkStatedBounds(line({ options: ['color: blue'] }), item({ statedOptions: ['midnight blue'] }))
        .decision,
    ).toBe('clear');
  });

  it('clears when nothing was stated', () => {
    const r = checkStatedBounds(line(), item({ statedOptions: [], statedAttributes: [] }));
    expect(r.decision).toBe('clear');
  });
});

describe('checkers: quantity', () => {
  it('is undecidable when no quantity was stated', () => {
    // Our taxonomy: an unstated quantity cannot be a violation.
    expect(checkQuantity(line({ quantity: 99 }), item()).decision).toBe('undecidable');
  });

  it('clears a matching quantity', () => {
    expect(checkQuantity(line({ quantity: 3 }), item({ statedQuantity: 3 })).decision).toBe('clear');
  });

  it('flags any mismatch, including off-by-one', () => {
    const r = checkQuantity(line({ quantity: 4 }), item({ statedQuantity: 3 }));
    expect(r.decision).toBe('violation');
    expect(r.evidence).toContain('stated 3');
  });
});

describe('checkers: answers-a-request and product-for-slot', () => {
  it('flags an unassigned line as answering nothing', () => {
    expect(checkAnswersARequest(false, 0).decision).toBe('violation');
  });

  it('defers on an assigned line rather than clearing it', () => {
    // Assigned means "plausibly answers this request", not "is correct".
    expect(checkAnswersARequest(true, 0.4).decision).toBe('undecidable');
  });

  it('never decides whether the product is right for the slot', () => {
    // This is the class the deterministic layer cannot decide. Keeping it
    // explicit lets the ablation show what the model adds.
    expect(checkProductForSlot().decision).toBe('undecidable');
  });
});

describe('checkers: assignment is a MATCHING, not per-line best', () => {
  const twoItems = mandate({
    items: [
      item({ itemId: 'i0', text: 'wireless bluetooth headphones', statedOptions: ['blue'] }),
      item({ itemId: 'i1', text: 'stainless steel hair cutting scissors', statedOptions: ['silver'] }),
    ],
  });

  it('gives each request at most one line', () => {
    const c = cart([
      line({ lineId: 'a', name: 'Acme Wireless Bluetooth Headphones' }),
      line({ lineId: 'b', name: 'Acme Bluetooth Headphones Pro' }),
    ]);
    const a = assignLines(c, twoItems);
    const assignedItems = [...a.values()].filter(Boolean).map((v) => v!.item.itemId);
    expect(new Set(assignedItems).size).toBe(assignedItems.length);
  });

  it('leaves a line unassigned when every request is better answered elsewhere', () => {
    const c = cart([
      line({ lineId: 'a', name: 'Acme Wireless Bluetooth Headphones' }),
      line({ lineId: 'b', name: 'Acme Bluetooth Headphones Pro' }),
    ]);
    const a = assignLines(c, mandate({ items: [item()] }));
    expect([...a.values()].filter((v) => v === null)).toHaveLength(1);
  });

  it('never assigns on zero token overlap', () => {
    const c = cart([line({ lineId: 'z', name: 'Ceramic Flower Pot' })]);
    const a = assignLines(c, mandate({ items: [item({ text: 'bluetooth headphones' })] }));
    expect(a.get('z')).toBeNull();
  });

  it('is deterministic regardless of line order', () => {
    const l1 = line({ lineId: 'a', name: 'Acme Wireless Bluetooth Headphones' });
    const l2 = line({ lineId: 'b', name: 'Steel Hair Cutting Scissors Silver' });
    const forward = assignLines(cart([l1, l2]), twoItems);
    const reverse = assignLines(cart([l2, l1]), twoItems);
    expect(forward.get('a')?.item.itemId).toBe(reverse.get('a')?.item.itemId);
    expect(forward.get('b')?.item.itemId).toBe(reverse.get('b')?.item.itemId);
  });

  it('REGRESSION: does not judge a line against a request it does not answer', () => {
    // The bug this replaced produced all 30 deterministic false positives: two
    // lines claimed the same request independently, leaving the third judged
    // against bounds ("silver") meant for a different item.
    const c = cart([
      line({ lineId: 'a', name: 'Acme Wireless Bluetooth Headphones', options: ['color: blue'] }),
      line({
        lineId: 'b',
        name: 'JASON Stainless Steel Hair Cutting Scissors',
        options: ['color: silver'],
        attributes: ['wireless bluetooth'],
      }),
    ]);
    const assessed = assessCart(c, twoItems);
    expect(assessed.violations).toEqual([]);
  });
});

describe('checkers: whole-cart assessment', () => {
  it('reports no violation for a conforming single-line cart', () => {
    expect(assessCart(cart([line()]), mandate()).violations).toEqual([]);
  });

  it('reports the unassigned line as UNREQUESTED_ADDITION', () => {
    const c = cart([line(), line({ lineId: 'extra', name: 'Ceramic Flower Pot', options: [], attributes: [] })]);
    const r = assessCart(c, mandate());
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.class).toBe('UNREQUESTED_ADDITION');
    expect(r.violations[0]!.lineId).toBe('extra');
  });

  it('applies taxonomy precedence: scope beats everything', () => {
    const c = cart([
      line({ categoryPath: ['Grocery & Gourmet Food'], options: ['color: red'], quantity: 9 }),
    ]);
    const r = assessCart(c, mandate({ items: [item({ statedQuantity: 1 })] }));
    expect(r.violations[0]!.class).toBe('SCOPE_VIOLATION');
  });

  it('records undecided lines separately from clear ones', () => {
    // A line with nothing declared cannot be cleared — it must land in the
    // semantic layer's queue.
    const c = cart([line({ options: [], attributes: [] })]);
    const r = assessCart(c, mandate());
    expect(r.violations).toEqual([]);
    expect(r.undecidedLineIds).toContain('l0');
  });

  it('assessLine surfaces every decision, not just the firing one', () => {
    const a = assessLine(line(), mandate(), { item: item(), score: 0.5 });
    expect(Object.keys(a.decisions).sort()).toEqual([
      'breachesStatedBound',
      'fillsNoRequestedSlot',
      'outOfScope',
      'wrongProductForSlot',
      'wrongQuantityForSlot',
    ]);
    // wrongProductForSlot is always undecidable — the model's job.
    expect(a.decisions.wrongProductForSlot).toBe('undecidable');
  });

  it('is pure: assessing twice gives identical output', () => {
    const c = cart([line(), line({ lineId: 'x', name: 'Ceramic Flower Pot' })]);
    const m = mandate();
    expect(assessCart(c, m)).toEqual(assessCart(c, m));
  });
});
