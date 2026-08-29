// Verify the corpus matches the bytes our results were produced from.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const EXPECTED = {
  'items_human_ins.json': 'cf78667548a71786e1d9049c24b802e48e1084ad4bb021cae56ce1f6d96954a3',
  'items_shuffle_1000.json': '30a4765c3a327af72d9a9a95a6b2486d516f0fa1d3ecd83681901ce82a21b269',
  'items_ins_v2_1000.json': 'f88a36314a397b53b3d9c3fa5878e5f7b26d35019a51ec83fbedeca61a948f6f',
};

let ok = true;
for (const [file, want] of Object.entries(EXPECTED)) {
  const path = join('data', file);
  if (!existsSync(path)) {
    console.error(`MISSING  ${file} — run scripts/fetch-data.sh`);
    ok = false;
    continue;
  }
  const got = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (got === want) {
    console.log(`OK       ${file}`);
  } else {
    console.error(`MISMATCH ${file}\n  expected ${want}\n  got      ${got}`);
    ok = false;
  }
}
console.log(ok ? '\nCorpus integrity verified.' : '\nCorpus integrity FAILED.');
process.exit(ok ? 0 : 1);
