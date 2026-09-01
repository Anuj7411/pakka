/**
 * Print every divergence the agent run recorded, for hand checking.
 *
 *   npx tsx scripts/inspect-agent.ts
 *
 * A rate whose labels nobody read is the mistake this project already made once
 * with the Day 4 false-positive number. Every flagged case gets looked at before
 * anything is published.
 */
import { readFileSync } from 'node:fs';

interface Outcome {
  scenarioId: string;
  request: string;
  pickedIndices: number[];
  correctIndex: number;
  pickedCorrect: boolean;
  lineCount: number;
  classes: string[];
  evidence: string[];
  failed: boolean;
}

const run = JSON.parse(readFileSync('reports/agent-run.json', 'utf8')) as {
  model: string;
  measured: number;
  outcomes: Outcome[];
};

const diverged = run.outcomes.filter((o) => !o.failed && o.classes.length > 0);
console.log(`model ${run.model} · measured ${run.measured} · diverged ${diverged.length}\n`);

for (const [i, o] of diverged.entries()) {
  console.log(`${'─'.repeat(72)}`);
  console.log(`#${i + 1}  ${o.classes.join(', ')}`);
  console.log(`request : ${o.request}`);
  console.log(`picked  : [${o.pickedIndices.join(', ')}]   correct: [${o.correctIndex}]   lines: ${o.lineCount}`);
  for (const e of o.evidence) console.log(`  · ${e}`);
}
console.log('─'.repeat(72));
