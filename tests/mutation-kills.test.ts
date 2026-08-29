/**
 * Tests written to kill specific surviving mutants.
 *
 * The suite had 100% line, branch and function coverage and still let 29
 * behavioural mutations through — code could be silently broken and every test
 * would still pass. Each test below names the mutant it kills.
 *
 * Run `npx stryker run` to re-check.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  cleanBrand,
  parseOption,
  parseCategory,
  parsePriceMinor,
  normaliseProduct,
  normaliseInstruction,
  usableProducts,
  byTopCategory,
  type Product,
} from '../src/corpus/webshop.js';
import { hasRazorpayCredentials, razorpayCredentials } from '../src/config/env.js';
import { CLASS_DEFINITIONS, DIVERGENCE_CLASSES } from '../src/taxonomy/classes.js';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe('mutation kills: env', () => {
  it('hasRazorpayCredentials requires BOTH values, not either', () => {
    // Kills: LogicalOperator && -> ||, and ConditionalExpression -> true
    delete process.env['RAZORPAY_KEY_ID'];
    delete process.env['RAZORPAY_KEY_SECRET'];
    expect(hasRazorpayCredentials()).toBe(false);

    process.env['RAZORPAY_KEY_ID'] = 'rzp_test_x';
    expect(hasRazorpayCredentials()).toBe(false); // id only

    delete process.env['RAZORPAY_KEY_ID'];
    process.env['RAZORPAY_KEY_SECRET'] = 's';
    expect(hasRazorpayCredentials()).toBe(false); // secret only

    process.env['RAZORPAY_KEY_ID'] = 'rzp_test_x';
    expect(hasRazorpayCredentials()).toBe(true); // both
  });
});

describe('mutation kills: brand parsing', () => {
  it('anchors the Brand: prefix to the START of the string', () => {
    // Kills: Regex /^\s*Brand:\s*/i -> /\s*Brand:\s*/i
    // Without the anchor, "Acme Brand: X" would wrongly become "Acme X".
    expect(cleanBrand('Acme Brand: Widgets')).toBe('Acme Brand: Widgets');
  });

  it('strips leading whitespace before Brand:', () => {
    // Kills: Regex /^\s*/ -> /^\S*/
    expect(cleanBrand('   Brand: Acme')).toBe('Acme');
  });

  it('strips ALL whitespace after the colon, not just one character', () => {
    // Kills: Regex /Brand:\s*/ -> /Brand:\s/ and -> /Brand:\S*/
    expect(cleanBrand('Brand:    Acme')).toBe('Acme');
    expect(cleanBrand('Brand:Acme')).toBe('Acme');
  });
});

describe('mutation kills: option parsing', () => {
  it('rejects an option with an empty dimension', () => {
    // Kills: idx <= 0 -> idx < 0. With ":blue", idx is 0 and must be rejected.
    expect(parseOption(':blue')).toBeNull();
  });

  it('rejects an option with a whitespace-only dimension or value', () => {
    // Kills: ConditionalExpression (dimension === '' || value === '') -> false
    expect(parseOption('   : blue')).toBeNull();
    expect(parseOption('color:    ')).toBeNull();
  });
});

describe('mutation kills: price parsing', () => {
  it('returns null when the string contains no digits at all', () => {
    // Kills: ConditionalExpression (!matches || matches.length === 0) -> false
    expect(parsePriceMinor('no price here')).toBeNull();
    expect(parsePriceMinor('$$$')).toBeNull();
  });
});

describe('mutation kills: category parsing', () => {
  it('returns an empty array for an empty input rather than proceeding', () => {
    // Kills: ConditionalExpression (!raw) -> false
    expect(parseCategory('')).toEqual([]);
    expect(parseCategory(undefined)).toEqual([]);
  });
});

describe('mutation kills: product normalisation', () => {
  const base = { brand: '', pricing: '', product_category: '' };

  it('extracts an ASIN only from an object-shaped product_information', () => {
    // Kills: ConditionalExpression on the pi guard, and typeof !== 'object'
    expect(normaliseProduct({ ...base, name: 'x', product_information: null }).asin).toBeNull();
    expect(normaliseProduct({ ...base, name: 'x', product_information: 'str' }).asin).toBeNull();
    expect(
      normaliseProduct({ ...base, name: 'x', product_information: { ASIN: 'B01ABCDEFG' } }).asin,
    ).toBe('B01ABCDEFG');
  });

  it('trims the product name', () => {
    // Kills: MethodExpression raw.name?.trim() -> raw.name
    const p = normaliseProduct({ ...base, name: '  Widget  ', product_information: null });
    expect(p.name).toBe('Widget');
  });

  it('trims the description and reads the first element of an array description', () => {
    // Kills: MethodExpression firstString(...).trim() -> firstString(...)
    //        and ConditionalExpressions inside firstString
    expect(
      normaliseProduct({ ...base, name: 'x', product_information: null, small_description: '  d  ' })
        .description,
    ).toBe('d');
    expect(
      normaliseProduct({
        ...base,
        name: 'x',
        product_information: null,
        small_description: ['  first  ', 'second'],
      }).description,
    ).toBe('first');
    // Non-string, non-array yields empty rather than throwing.
    expect(
      normaliseProduct({ ...base, name: 'x', product_information: null, small_description: 42 })
        .description,
    ).toBe('');
    // An array whose first element is not a string also yields empty.
    expect(
      normaliseProduct({ ...base, name: 'x', product_information: null, small_description: [7, 'b'] })
        .description,
    ).toBe('');
  });
});

describe('mutation kills: instruction normalisation', () => {
  it('drops whitespace-only constraint entries, not just empty strings', () => {
    // Kills: MethodExpression .filter(s => s.trim() !== '') -> s
    const i = normaliseInstruction({
      asin: 'B01ABCDEFG',
      instruction: 'x',
      attributes: ['real', '   ', ''],
      options: ['color: blue', '  '],
      instruction_attributes: [],
      instruction_options: [],
    });
    expect(i.targetHas.attributes).toEqual(['real']);
    expect(i.targetHas.options).toEqual(['color: blue']);
  });
});

describe('mutation kills: selection helpers', () => {
  const mk = (over: Partial<Product>): Product => ({
    asin: null,
    name: 'Item',
    brand: null,
    topCategory: 'Cat',
    categoryPath: ['Cat'],
    priceMinor: 100,
    description: '',
    ...over,
  });

  it('excludes products with an empty name', () => {
    // Kills: EqualityOperator p.name.length > 0 -> >= 0
    expect(usableProducts({ instructions: [], products: [mk({ name: '' })] })).toHaveLength(0);
  });

  it('excludes products with an empty category path', () => {
    // Kills: EqualityOperator p.categoryPath.length > 0 -> >= 0
    expect(usableProducts({ instructions: [], products: [mk({ categoryPath: [] })] })).toHaveLength(0);
  });

  it('excludes products with no usable price', () => {
    // Kills: ConditionalExpression on the whole filter -> true
    expect(usableProducts({ instructions: [], products: [mk({ priceMinor: null })] })).toHaveLength(0);
  });

  it('keeps a fully valid product', () => {
    expect(usableProducts({ instructions: [], products: [mk({})] })).toHaveLength(1);
  });

  it('byTopCategory does not lose the FIRST product in each category', () => {
    // Kills: ArrayDeclaration m.set(p.topCategory, [p]) -> []
    // The surviving mutant silently dropped the first product of every group.
    const a = mk({ name: 'A', topCategory: 'X' });
    const b = mk({ name: 'B', topCategory: 'X' });
    const c = mk({ name: 'C', topCategory: 'Y' });
    const groups = byTopCategory([a, b, c]);
    expect(groups.get('X')?.map((p) => p.name)).toEqual(['A', 'B']);
    expect(groups.get('Y')?.map((p) => p.name)).toEqual(['C']);
    // Total must be conserved.
    expect([...groups.values()].flat()).toHaveLength(3);
  });
});

describe('mutation kills: taxonomy definitions are real prose, not placeholders', () => {
  it('every isNot boundary is non-empty', () => {
    // Kills: StringLiteral mutations that blank an individual boundary while
    // leaving the array length intact.
    for (const id of DIVERGENCE_CLASSES) {
      for (const boundary of CLASS_DEFINITIONS[id].isNot) {
        expect(boundary.trim().length, `${id} has a blank boundary`).toBeGreaterThan(15);
      }
    }
  });

  it('every definition field is substantive', () => {
    // Kills: StringLiteral mutations on one half of a concatenated string.
    for (const id of DIVERGENCE_CLASSES) {
      const d = CLASS_DEFINITIONS[id];
      expect(d.question.trim().length, `${id}.question`).toBeGreaterThan(25);
      expect(d.holds.trim().length, `${id}.holds`).toBeGreaterThan(90);
      expect(d.example.trim().length, `${id}.example`).toBeGreaterThan(20);
    }
  });

  it('decidability is one of the three declared values', () => {
    // Kills: StringLiteral decidability: 'always' -> ""
    for (const id of DIVERGENCE_CLASSES) {
      expect(['always', 'often', 'semantic']).toContain(CLASS_DEFINITIONS[id].decidability);
    }
  });
});

describe('mutation kills: second round', () => {
  it('env read() trims the RETURNED value, not just the emptiness check', () => {
    // Kills: MethodExpression v.trim() -> v on the return branch.
    // A padded credential must come back trimmed, or Basic-auth encoding breaks.
    process.env['RAZORPAY_KEY_ID'] = '  rzp_test_Padded123  ';
    process.env['RAZORPAY_KEY_SECRET'] = '  secretWithSpaces  ';
    const { keyId, keySecret } = razorpayCredentials();
    expect(keyId).toBe('rzp_test_Padded123');
    expect(keySecret).toBe('secretWithSpaces');
  });

  it('parseOption returns null when there is NO colon at all', () => {
    // Kills: ConditionalExpression (idx <= 0) -> false.
    // Without the guard, indexOf returns -1 and slice(0,-1) silently yields
    // {dimension:'nocolo', value:'nocolon'} — a fabricated option.
    expect(parseOption('nocolon')).toBeNull();
    expect(parseOption('just some text')).toBeNull();
  });
});
