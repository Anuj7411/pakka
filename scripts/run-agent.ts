/**
 * Day 8: measure what a real shopping agent actually does.
 *
 *   npx tsx scripts/run-agent.ts [scenarios] [paceMs] [model] [seed]
 *
 * Results are written to reports/agent-run.json so the numbers can be re-read
 * without spending the API budget again, and so a claim in the write-up can be
 * traced to the run that produced it.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadWebShop, usableProducts, richInstructions } from '../src/corpus/webshop.js';
import { pairInstructions, pairablePool } from '../src/corpus/pairing.js';
import { Rng } from '../src/corpus/rng.js';
import { createShopper } from '../src/agent/shopper.js';
import {
  buildScenario,
  hasCleanChoice,
  assessAgentCart,
  type Scenario,
  type ScenarioOutcome,
} from '../src/agent/measure.js';
import { rate, fmtRate } from '../src/harness/metrics.js';
import { DIVERGENCE_CLASSES } from '../src/taxonomy/classes.js';

const wanted = Number(process.argv[2] ?? 120);
const paceMs = Number(process.argv[3] ?? 2200);
const model = process.argv[4] ?? 'gemini-3.1-flash-lite';
const seed = Number(process.argv[5] ?? 20260901);

const data = loadWebShop('data');
const pairs = pairInstructions(pairablePool(data, richInstructions), usableProducts(data));
const rng = new Rng(seed);

// ---------------------------------------------------------------------------
// Build scenarios, applying the control
// ---------------------------------------------------------------------------

const scenarios: Scenario[] = [];
let noCleanChoice = 0;
let unbuildable = 0;

for (let i = 0; i < pairs.length && scenarios.length < wanted; i++) {
  const s = buildScenario(pairs[i]!, pairs, rng);
  if (s === null) {
    unbuildable++;
    continue;
  }
  // THE CONTROL. Without it an unsatisfiable scenario scores as an agent error.
  if (!hasCleanChoice(s)) {
    noCleanChoice++;
    continue;
  }
  scenarios.push(s);
}

console.log(`scenarios built    : ${scenarios.length}`);
console.log(`dropped, no clean choice available : ${noCleanChoice}`);
console.log(`dropped, too few distractors       : ${unbuildable}`);
console.log(`model              : ${model}\n`);

// ---------------------------------------------------------------------------

const shopper = createShopper({ model });
const outcomes: ScenarioOutcome[] = [];
let failures = 0;

for (let i = 0; i < scenarios.length; i++) {
  const s = scenarios[i]!;
  const result = await shopper.shop(s.request, s.catalogue);
  if (result.failed) failures++;
  outcomes.push(assessAgentCart(s, result.picks, result.failed));

  if ((i + 1) % 20 === 0) {
    console.log(`  ${i + 1}/${scenarios.length}  failures ${failures}`);
  }
  if (i < scenarios.length - 1) await new Promise((r) => setTimeout(r, paceMs));
}

// An outage is not a measurement. Same rule as the ablation: abort rather than
// report a rate computed on calls that never reached the model.
const failureRate = outcomes.length === 0 ? 0 : failures / outcomes.length;
if (failureRate > 0.02) {
  console.error(
    `\nABORTING: ${(failureRate * 100).toFixed(1)}% of calls failed (${failures}/${outcomes.length}).`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

const measured = outcomes.filter((o) => !o.failed);
const diverged = measured.filter((o) => o.classes.length > 0);
const emptyCarts = measured.filter((o) => o.lineCount === 0);
const pickedCorrect = measured.filter((o) => o.pickedCorrect);

console.log(`\nprovider calls ${outcomes.length} · failures ${failures}\n`);
console.log('── OBSERVED AGENT BEHAVIOUR ──');
console.log(`  scenarios measured        ${measured.length}`);
console.log(`  picked the right product  ${fmtRate(rate(pickedCorrect.length, measured.length))}`);
console.log(`  bought nothing            ${fmtRate(rate(emptyCarts.length, measured.length))}`);
console.log(`  ANY divergence            ${fmtRate(rate(diverged.length, measured.length))}`);

console.log('\n── DIVERGENCE RATE BY CLASS (deterministic, objective) ──');
const perClass = DIVERGENCE_CLASSES.map((cls) => ({
  cls,
  r: rate(measured.filter((o) => o.classes.includes(cls)).length, measured.length),
}));
for (const { cls, r } of perClass) {
  console.log(`  ${cls.padEnd(22)} ${fmtRate(r)}`);
}

console.log('\n── cart shape ──');
const sizes = new Map<number, number>();
for (const o of measured) sizes.set(o.lineCount, (sizes.get(o.lineCount) ?? 0) + 1);
for (const [n, c] of [...sizes.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${n} line(s): ${c}`);
}

console.log('\n── examples of observed divergence ──');
for (const o of diverged.slice(0, 8)) {
  console.log(`\n  ${o.classes.join(', ')}`);
  console.log(`    request : ${o.request.slice(0, 88)}`);
  console.log(`    picked  : [${o.pickedIndices.join(', ')}]  correct was [${o.correctIndex}]`);
  console.log(`    evidence: ${o.evidence.slice(0, 2).join(' | ').slice(0, 130)}`);
}

mkdirSync('reports', { recursive: true });
const out = {
  model,
  seed,
  builtAt: new Date().toISOString(),
  scenariosBuilt: scenarios.length,
  droppedNoCleanChoice: noCleanChoice,
  measured: measured.length,
  failures,
  outcomes,
};
writeFileSync('reports/agent-run.json', JSON.stringify(out, null, 2), 'utf8');
console.log(`\nwrote reports/agent-run.json`);
