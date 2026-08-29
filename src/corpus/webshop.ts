/**
 * WebShop loader.
 *
 * Source: WebShop (Yao et al., NeurIPS 2022), princeton-nlp/WebShop, MIT licence.
 * See data/PROVENANCE.md for how the files were obtained and why.
 *
 * Why this matters: the corpus is grounded in REAL human-authored shopping
 * instructions with REAL stated constraints, not in constraints we invented.
 * An invented corpus can only demonstrate that our checker catches our own
 * imagination. See research/validation/EVAL-METHODOLOGY.md, step 2.
 *
 * Every field here reflects the actual on-disk shape, verified by inspection —
 * not the shape the paper describes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// On-disk shapes (verified against the real files)
// ---------------------------------------------------------------------------

/** One record in items_human_ins.json. Keyed by target ASIN. */
export interface RawInstructionRecord {
  readonly asin: string;
  /** The human's free-text request, verbatim. */
  readonly instruction: string;
  /** Attributes the TARGET PRODUCT has. */
  readonly attributes: readonly string[];
  /** Options the TARGET PRODUCT has, as "dimension: value". */
  readonly options: readonly string[];
  /** Attributes the human explicitly STATED. This is the constraint set. */
  readonly instruction_attributes: readonly string[];
  /** Option values the human explicitly STATED. */
  readonly instruction_options: readonly string[];
  readonly assignment_id?: string;
  readonly worker_id?: string;
}

/** One product in items_shuffle_1000.json. */
export interface RawProduct {
  readonly name: string;
  readonly product_information: Record<string, string> | string | null;
  readonly brand: string;
  readonly full_description?: string;
  /** Often an empty string. Never assume it parses. */
  readonly pricing: string;
  readonly list_price?: string;
  /** Hierarchical, separated by U+203A "›". */
  readonly product_category: string;
  readonly small_description?: unknown;
}

// ---------------------------------------------------------------------------
// Normalised shapes
// ---------------------------------------------------------------------------

/** A stated constraint, split by kind because they check differently. */
export interface StatedConstraints {
  /** Free-text attributes: "gluten free", "long sleeve", "machine wash". */
  readonly attributes: readonly string[];
  /** Option values: "blue", "12 inch (pack of 1)". */
  readonly options: readonly string[];
}

export interface Instruction {
  readonly targetAsin: string;
  readonly text: string;
  /** What the human stated. Violating these is CONSTRAINT_BREACH. */
  readonly stated: StatedConstraints;
  /** What the correct product actually has. Ground truth for conformance. */
  readonly targetHas: StatedConstraints;
}

export interface Product {
  readonly asin: string | null;
  readonly name: string;
  /** Cleaned: the raw field is prefixed "Brand: ". */
  readonly brand: string | null;
  /** Top-level category, e.g. "Home & Kitchen". Used for SCOPE_VIOLATION. */
  readonly topCategory: string;
  readonly categoryPath: readonly string[];
  /** Rupees-equivalent minor units. null when the source price is unusable. */
  readonly priceMinor: number | null;
  readonly description: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const CATEGORY_SEP = '›'; // ›

/** `"Brand: Vhomes Lights"` → `"Vhomes Lights"`. Empty → null. */
export function cleanBrand(raw: string | undefined): string | null {
  if (!raw) return null;
  const v = raw.replace(/^\s*Brand:\s*/i, '').trim();
  return v === '' ? null : v;
}

/**
 * `"$877.80"` → 87780 minor units. Empty, malformed, or ranged → null.
 *
 * We deliberately do NOT convert currency. The catalogue is USD; treating the
 * number as minor units of a single unnamed currency keeps the arithmetic
 * honest and avoids inventing an exchange rate. Stated as a limitation.
 */
export function parsePriceMinor(raw: string | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/,/g, '');
  const matches = cleaned.match(/\d+(?:\.\d+)?/g);
  if (!matches || matches.length === 0) return null;
  // A range ("$10.00 - $20.00") is not a single price. Refuse it.
  if (matches.length > 1) return null;
  const n = Number.parseFloat(matches[0]!);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

export function parseCategory(raw: string | undefined): readonly string[] {
  if (!raw) return [];
  return raw
    .split(CATEGORY_SEP)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function extractAsin(pi: RawProduct['product_information']): string | null {
  if (pi && typeof pi === 'object' && typeof pi['ASIN'] === 'string') return pi['ASIN'];
  return null;
}

function firstString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return '';
}

export function normaliseProduct(raw: RawProduct): Product {
  const path = parseCategory(raw.product_category);
  return {
    asin: extractAsin(raw.product_information),
    name: raw.name?.trim() ?? '',
    brand: cleanBrand(raw.brand),
    topCategory: path[0] ?? 'Uncategorised',
    categoryPath: path,
    priceMinor: parsePriceMinor(raw.pricing) ?? parsePriceMinor(raw.list_price),
    description: firstString(raw.small_description).trim(),
  };
}

export function normaliseInstruction(raw: RawInstructionRecord): Instruction {
  return {
    targetAsin: raw.asin,
    text: raw.instruction.trim(),
    stated: {
      attributes: [...raw.instruction_attributes],
      options: [...raw.instruction_options],
    },
    targetHas: {
      // The source uses [''] to mean "no options". Filter it.
      attributes: [...raw.attributes].filter((s) => s.trim() !== ''),
      options: [...raw.options].filter((s) => s.trim() !== ''),
    },
  };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface WebShopData {
  readonly instructions: readonly Instruction[];
  readonly products: readonly Product[];
}

const DEFAULT_DIR = join(process.cwd(), 'data');

export class CorpusError extends Error {
  override readonly name = 'CorpusError';
}

function readJson<T>(dir: string, file: string): T {
  try {
    return JSON.parse(readFileSync(join(dir, file), 'utf8')) as T;
  } catch (e) {
    throw new CorpusError(
      `Could not read ${file} from ${dir}. See data/PROVENANCE.md for how to obtain it. ` +
        `(${(e as Error).message})`,
    );
  }
}

export function loadWebShop(dir: string = DEFAULT_DIR): WebShopData {
  const rawIns = readJson<Record<string, RawInstructionRecord[]>>(dir, 'items_human_ins.json');
  const rawProds = readJson<RawProduct[]>(dir, 'items_shuffle_1000.json');

  const instructions = Object.values(rawIns).flat().map(normaliseInstruction);
  const products = rawProds.map(normaliseProduct);

  if (instructions.length === 0) throw new CorpusError('No instructions loaded.');
  if (products.length === 0) throw new CorpusError('No products loaded.');

  return { instructions, products };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Instructions carrying BOTH stated attributes and stated options.
 *
 * These are the only ones where a CONSTRAINT_BREACH can be injected against a
 * genuinely human-stated bound rather than one we made up. ~9,605 of 12,251.
 */
export function richInstructions(data: WebShopData): readonly Instruction[] {
  return data.instructions.filter(
    (i) => i.stated.attributes.length > 0 && i.stated.options.length > 0,
  );
}

/** Products usable as cart lines: real price and a real category. */
export function usableProducts(data: WebShopData): readonly Product[] {
  return data.products.filter(
    (p) => p.priceMinor !== null && p.name.length > 0 && p.categoryPath.length > 0,
  );
}

/** Products grouped by top-level category — the SCOPE_VIOLATION donor pool. */
export function byTopCategory(products: readonly Product[]): Map<string, Product[]> {
  const m = new Map<string, Product[]>();
  for (const p of products) {
    const list = m.get(p.topCategory);
    if (list) list.push(p);
    else m.set(p.topCategory, [p]);
  }
  return m;
}

/** Split "color: blue" → { dimension: "color", value: "blue" }. */
export function parseOption(option: string): { dimension: string; value: string } | null {
  const idx = option.indexOf(':');
  if (idx <= 0) return null;
  const dimension = option.slice(0, idx).trim().toLowerCase();
  const value = option.slice(idx + 1).trim();
  if (dimension === '' || value === '') return null;
  return { dimension, value };
}
