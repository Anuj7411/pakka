/**
 * Rebuild the committed test fixture from the full WebShop corpus.
 *
 *   npx tsx scripts/build-fixture.ts
 *
 * Deterministic: seeded, sorted iteration, no Math.random. Re-running on the
 * same corpus produces byte-identical output.
 *
 * The fixture keeps up to 30 pairings and 16 products per top-level category
 * so that every property the generator tests rely on survives: several
 * categories with enough products for filler lines and substitution pools, and
 * instructions carrying both stated attributes and stated options.
 *
 * Unused product fields (full_description, images, most of
 * product_information) are stripped - the loader never reads them, and they
 * were 90% of the size.
 *
 * INSTRUCTION records are stripped of `worker_id` and `assignment_id`.
 *
 * Those are Amazon Mechanical Turk identifiers for real people. They are
 * persistent and pseudonymous, and published research has shown MTurk worker
 * IDs can be cross-referenced against public Amazon profiles - so publishing
 * them de-anonymises crowdworkers and ties each one to the instruction they
 * wrote. This repo is public.
 *
 * A security audit found 414 such records covering 60 distinct workers in the
 * committed fixture. `normaliseInstruction()` already dropped both fields, so
 * nothing in the codebase ever read them - but this builder copied raw records
 * wholesale, and the protection sat one layer above the leak.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { loadWebShop, usableProducts } from '../src/corpus/webshop.js';
import { pairInstructions, pairablePool } from '../src/corpus/generator.js';
import { Rng } from '../src/corpus/rng.js';

const PAIRS_PER_CATEGORY = 30;
const PRODUCTS_PER_CATEGORY = 16;

const data = loadWebShop('data');
const products = usableProducts(data);
const pairs = pairInstructions(pairablePool(data), products);
const rng = new Rng(20260829);

const pairsByCat = new Map<string, typeof pairs>();
for (const p of pairs) {
  const list = pairsByCat.get(p.product.topCategory);
  if (list) list.push(p);
  else pairsByCat.set(p.product.topCategory, [p]);
}
const keptPairs = [...pairsByCat.entries()]
  .sort(([a], [b]) => (a < b ? -1 : 1))
  .flatMap(([, ps]) => rng.shuffle(ps).slice(0, PAIRS_PER_CATEGORY));
const keptAsins = new Set(keptPairs.map((p) => p.instruction.targetAsin));

const keptProductNames = new Set(keptPairs.map((p) => p.product.name));
const prodsByCat = new Map<string, typeof products>();
for (const p of products) {
  const list = prodsByCat.get(p.topCategory);
  if (list) list.push(p);
  else prodsByCat.set(p.topCategory, [p]);
}
for (const [, ps] of [...prodsByCat.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
  for (const p of rng.shuffle(ps).slice(0, PRODUCTS_PER_CATEGORY)) keptProductNames.add(p.name);
}

/** Fields the loader reads. Anything else is dropped, including identifiers. */
const KEEP_INSTRUCTION_FIELDS = [
  'asin',
  'instruction',
  'attributes',
  'options',
  'instruction_attributes',
  'instruction_options',
] as const;

/** Never emitted. Personal data with no purpose here. */
const DROP_INSTRUCTION_FIELDS = ['worker_id', 'assignment_id'] as const;

const rawIns = JSON.parse(readFileSync('data/items_human_ins.json', 'utf8')) as Record<string, unknown[]>;
const outIns: Record<string, unknown[]> = {};
for (const asin of Object.keys(rawIns).sort()) {
  if (!keptAsins.has(asin)) continue;
  outIns[asin] = (rawIns[asin] as Record<string, unknown>[]).map((rec) => {
    const o: Record<string, unknown> = {};
    for (const k of KEEP_INSTRUCTION_FIELDS) if (k in rec) o[k] = rec[k];
    return o;
  });
}

// Fail loudly rather than emit a fixture carrying identifiers.
const leaked = JSON.stringify(outIns);
for (const field of DROP_INSTRUCTION_FIELDS) {
  if (leaked.includes(field)) {
    throw new Error(`build-fixture: ${field} survived the strip. Refusing to write.`);
  }
}

const KEEP_FIELDS = ['name', 'product_information', 'brand', 'pricing', 'list_price', 'product_category', 'small_description'] as const;
const rawProds = JSON.parse(readFileSync('data/items_shuffle_1000.json', 'utf8')) as Record<string, unknown>[];
const outProds = rawProds
  .filter((p) => keptProductNames.has(String(p['name'] ?? '').trim()))
  .map((p) => {
    const o: Record<string, unknown> = {};
    for (const k of KEEP_FIELDS) if (k in p) o[k] = p[k];
    const pi = o['product_information'];
    if (pi && typeof pi === 'object' && 'ASIN' in (pi as Record<string, unknown>)) {
      o['product_information'] = { ASIN: (pi as Record<string, unknown>)['ASIN'] };
    } else if (pi && typeof pi === 'object') {
      o['product_information'] = {};
    }
    const sd = o['small_description'];
    if (Array.isArray(sd)) o['small_description'] = sd.slice(0, 1).map((x) => String(x).slice(0, 200));
    else if (typeof sd === 'string') o['small_description'] = sd.slice(0, 200);
    return o;
  });

writeFileSync('tests/fixtures/items_human_ins.json', JSON.stringify(outIns));
writeFileSync('tests/fixtures/items_shuffle_1000.json', JSON.stringify(outProds));
console.log(`fixture: ${Object.keys(outIns).length} asins, ${outProds.length} products, ${pairsByCat.size} categories`);
