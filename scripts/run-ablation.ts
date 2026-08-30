/**
 * Day 4 ablation: deterministic / semantic / both.
 *
 * The point is not "does adding a model help". It is to show exactly WHAT the
 * model contributes, so the contribution can be argued with. Day 3 measured
 * pure code at 100% on four classes and 0% on ITEM_SUBSTITUTION; if the
 * combined run does not move that class, the model earns nothing here and we
 * say so.
 *
 *   npx tsx scripts/run-ablation.ts [dataDir] [mandateCount] [budget]
 */
import { loadWebShop } from '../src/corpus/webshop.js';
import { generateCorpus } from '../src/corpus/generator.js';
import { assessCart, assignLines } from '../src/deterministic/checkers.js';
import { evaluate, formatReport, type Checker } from '../src/harness/evaluate.js';
import { fmtRate } from '../src/harness/metrics.js';
import { createGeminiProvider } from '../src/semantic/gemini.js';
import { CallBudget, VerdictCache, withCacheAndBudget, withRateLimit } from '../src/semantic/provider.js';
import { toModelView } from '../src/semantic/redact.js';
import { buildPrompt, SYSTEM_INSTRUCTION, type JudgeVerdict } from '../src/semantic/prompt.js';
import type { Case } from '../src/corpus/types.js';
import type { DivergenceClass } from '../src/taxonomy/classes.js';

const dir = process.argv[2] ?? 'tests/fixtures';
const mandateCount = Number(process.argv[3] ?? 20);
const budgetLimit = Number(process.argv[4] ?? 1200);

const data = loadWebShop(dir);
const corpus = generateCorpus(data, { seed: 20260829, mandateCount });

const budget = new CallBudget(budgetLimit);
const cache = new VerdictCache('llm-cache');
const paceMs = Number(process.argv[5] ?? 4500);
const model = process.argv[6] ?? 'gemini-3.1-flash-lite';
const provider = withCacheAndBudget(
  withRateLimit(createGeminiProvider({ model }), { minIntervalMs: paceMs }),
  cache,
  budget,
);

console.log(`corpus: ${corpus.cases.length} cases (${corpus.generatedWith.hash.slice(0, 20)}…)`);
console.log(`budget: ${budgetLimit} provider calls, cache at llm-cache/\n`);

// ---------------------------------------------------------------------------
// Precompute every verdict once, then run the three configurations offline.
// A configuration must not be able to spend a different number of calls than
// another, or the comparison measures budget rather than method.
// ---------------------------------------------------------------------------

const verdicts = new Map<string, JudgeVerdict>();
const allConfidences: { verdict: string; confidence: number; correct: boolean }[] = [];
let failures = 0;

let done = 0;
for (const c of corpus.cases) {
  const assignment = assignLines(c.cart, c.mandate);
  for (const line of c.cart.lines) {
    const assigned = assignment.get(line.lineId);
    if (!assigned) continue;
    const key = `${c.caseId}::${line.lineId}`;
    if (verdicts.has(key)) continue;
    const v = await provider.judge({
      system: SYSTEM_INSTRUCTION,
      user: buildPrompt(toModelView(assigned.item, line)),
    });
    verdicts.set(key, v);


    if (v.failed) failures++;

    const expected = c.expected.find((e) => e.lineId === line.lineId);
    const shouldBeWrong = expected?.class === 'ITEM_SUBSTITUTION';
    allConfidences.push({
      verdict: v.verdict,
      confidence: v.confidence,
      correct: (v.verdict === 'wrong_product') === shouldBeWrong,
    });
  }
  if (++done % 100 === 0) {
    const s = cache.stats;
    console.log(`  ${done}/${corpus.cases.length} cases · calls ${budget.used} · cache ${s.hits}h/${s.misses}m`);
  }
}
console.log(
  `\nprovider calls: ${budget.used} · cache hits: ${cache.stats.hits} · failures: ${failures}`,
);

// ABORT rather than report numbers computed on outages.
//
// An earlier run of this script printed "semantic only: classification 0.6%"
// and "the model adds nothing". 68 of its 74 calls had returned HTTP 429. The
// adapter reported a rate limit as `unsure`, which is indistinguishable from a
// considered judgement, and the cache then stored those failures permanently.
// The whole result was fiction, and it looked exactly like a finding.
const failureRate = verdicts.size === 0 ? 0 : failures / verdicts.size;
if (failureRate > 0.02) {
  console.error(
    `\nABORTING: ${(failureRate * 100).toFixed(1)}% of calls failed (${failures}/${verdicts.size}).\n` +
      `A failed call is an outage, not a judgement. Numbers computed on these would be fiction.\n` +
      `Increase pacing (arg 5, currently ${paceMs}ms) or reduce mandateCount.`,
  );
  process.exit(1);
}
console.log();

// ---------------------------------------------------------------------------

const deterministicOnly: Checker = (c) => ({
  caseId: c.caseId,
  violations: assessCart(c.cart, c.mandate).violations.map((v) => ({ lineId: v.lineId, class: v.class })),
});

/** Semantic alone: every assigned line judged, wrong_product => ITEM_SUBSTITUTION. */
const semanticOnly: Checker = (c: Case) => {
  const out: { lineId: string; class: DivergenceClass }[] = [];
  for (const line of c.cart.lines) {
    const v = verdicts.get(`${c.caseId}::${line.lineId}`);
    if (v?.verdict === 'wrong_product') {
      out.push({ lineId: line.lineId, class: 'ITEM_SUBSTITUTION' });
    }
  }
  return { caseId: c.caseId, violations: out };
};

/** Both: deterministic findings stand; the model speaks only where code could not. */
const both: Checker = (c: Case) => {
  const det = assessCart(c.cart, c.mandate);
  const flagged = new Set(det.violations.map((v) => v.lineId));
  const out = det.violations.map((v) => ({ lineId: v.lineId, class: v.class }));
  for (const line of c.cart.lines) {
    if (flagged.has(line.lineId)) continue;
    const v = verdicts.get(`${c.caseId}::${line.lineId}`);
    if (v?.verdict === 'wrong_product') {
      out.push({ lineId: line.lineId, class: 'ITEM_SUBSTITUTION' });
    }
  }
  return { caseId: c.caseId, violations: out };
};

// `readsProductName` decides whether a false-positive rate is reported at all.
// A conforming case attaches a human instruction to the nearest product we
// hold, so its NAME describes a different object than its declared fields do —
// "butter pecan flavored coffee" paired with "Pilon Espresso Coffee". The
// deterministic checker never sees the name, so its FP rate is about the
// checker; the other two do, and theirs would be about our corpus. See
// CheckerFacts in evaluate.ts.
for (const [name, checker, readsProductName] of [
  ['ABLATION A — deterministic only', deterministicOnly, false],
  ['ABLATION B — semantic only', semanticOnly, true],
  ['ABLATION C — both', both, true],
] as const) {
  console.log(formatReport(evaluate(corpus, checker, name, { readsProductName }), fmtRate).join('\n'));
  console.log();
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

console.log('── calibration of self-reported confidence ──');
const buckets = new Map<string, { n: number; correct: number }>();
for (const c of allConfidences) {
  const b = (Math.floor(c.confidence * 10) / 10).toFixed(1);
  const cur = buckets.get(b) ?? { n: 0, correct: 0 };
  cur.n++;
  if (c.correct) cur.correct++;
  buckets.set(b, cur);
}
let ece = 0;
const total = allConfidences.length;
for (const [b, v] of [...buckets.entries()].sort()) {
  const acc = v.correct / v.n;
  const conf = Number(b) + 0.05;
  ece += (v.n / total) * Math.abs(acc - conf);
  console.log(`  confidence ${b}-${(Number(b) + 0.1).toFixed(1)}  n=${String(v.n).padStart(5)}  accuracy ${(acc * 100).toFixed(1)}%`);
}
console.log(`  ECE (expected calibration error): ${(ece * 100).toFixed(1)}%`);
console.log(`  distinct confidence values observed: ${new Set(allConfidences.map((c) => c.confidence)).size}`);

const byVerdict = new Map<string, number>();
for (const c of allConfidences) byVerdict.set(c.verdict, (byVerdict.get(c.verdict) ?? 0) + 1);
console.log(`  verdict mix: ${[...byVerdict.entries()].sort().map(([k, v]) => `${k}=${v}`).join('  ')}`);
