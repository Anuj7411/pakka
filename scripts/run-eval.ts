/**
 * Day 3 evaluation: deterministic checkers alone, against trivial baselines.
 * A6 resolves here — how much of the taxonomy pure code can decide.
 */
import { loadWebShop } from '../src/corpus/webshop.js';
import { generateCorpus } from '../src/corpus/generator.js';
import { assessCart } from '../src/deterministic/checkers.js';
import { evaluate, formatReport, BASELINES, type Checker } from '../src/harness/evaluate.js';
import { fmtRate } from '../src/harness/metrics.js';

const dir = process.argv[2] ?? 'data';
const data = loadWebShop(dir);
const corpus = generateCorpus(data, { seed: 20260829, mandateCount: 60 });

console.log(`corpus: ${corpus.cases.length} cases  (${corpus.generatedWith.hash.slice(0, 22)}…)`);
console.log(`  divergent ${corpus.cases.filter((c) => !c.conforming).length}` +
            `  conforming ${corpus.cases.filter((c) => c.conforming).length}\n`);

const deterministic: Checker = (c) => ({
  caseId: c.caseId,
  violations: assessCart(c.cart, c.mandate).violations.map((v) => ({ lineId: v.lineId, class: v.class })),
});

for (const [name, checker] of [
  ['baseline: neverFlag', BASELINES['neverFlag']!],
  ['baseline: alwaysFlag', BASELINES['alwaysFlag']!],
  ['baseline: biggestCart (leakage probe)', BASELINES['biggestCart']!],
  ['DETERMINISTIC CHECKERS', deterministic],
] as const) {
  console.log(formatReport(evaluate(corpus, checker, name), fmtRate).join('\n'));
  console.log();
}

console.log('── per class x tier, deterministic ──');
const r = evaluate(corpus, deterministic, 'd');
for (const [cell, v] of Object.entries(r.byClassTier)) {
  console.log(`  ${cell.padEnd(32)} ${fmtRate(v)}`);
}
