/**
 * The headline safety metric.
 *
 *   npx tsx scripts/run-oc228.ts [sequences] [trialsPerCode] [seed]
 *
 * Exits non-zero on a single violation, or on any rule the verifier fails to
 * catch. Both halves must hold: a verifier that never rejects would score a
 * perfect violation rate and be worthless.
 */
import { simulateLegal, measureSensitivity } from '../src/verifier/simulate.js';

const sequences = Number(process.argv[2] ?? 10_000);
const trials = Number(process.argv[3] ?? 500);
const seed = Number(process.argv[4] ?? 20260901);

console.log(`OC-228 constraint check  (seed ${seed})\n`);

const legal = simulateLegal(seed, sequences);
console.log('SOUNDNESS — legal sequences, sized by the sizer, checked by the verifier');
console.log(`  sequences checked      : ${legal.sequences}`);
console.log(`  unfundable, skipped    : ${legal.unfundable}`);
console.log(`  sequences violating    : ${legal.violating}`);
console.log(`  CONSTRAINT-VIOLATION RATE : ${(legal.violationRate * 100).toFixed(4)}%\n`);

for (const v of legal.violations.slice(0, 10)) {
  console.log(`  seq ${v.sequence}: ${v.found.map((f) => `${f.code} (${f.detail})`).join('; ')}`);
}

const sens = measureSensitivity(seed + 1, trials);
console.log('SENSITIVITY — one deliberate breach per rule; the verifier must catch it');
let blind = 0;
for (const s of sens) {
  const ok = s.rate === 1;
  if (!ok) blind++;
  console.log(
    `  ${ok ? 'ok  ' : 'MISS'} ${s.code.padEnd(28)} ${s.caught}/${s.trials}  ${s.describe}`,
  );
}

console.log();
if (legal.violating > 0) {
  console.error(`FAIL: ${legal.violating} sequence(s) violated OC-228.`);
  process.exit(1);
}
if (blind > 0) {
  console.error(`FAIL: the verifier is blind to ${blind} rule(s). A zero rate would be meaningless.`);
  process.exit(1);
}
console.log('PASS: violation rate 0, and every rule demonstrably enforced.');
