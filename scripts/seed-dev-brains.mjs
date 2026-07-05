// Dev-mode stock-brain seeding (stock-brains spec D5).
//
// The packaged app seeds resources/stock-brains/*.json into
// <userData>/data/brains on boot, gated by the seededBrains ledger; dev
// deliberately never auto-seeds. This is the explicit dev equivalent: a dumb
// copy into ./data/brains, no ledger — re-running resurrects a deleted pack,
// which is fine in dev.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stockDir = join(root, 'resources', 'stock-brains');
const brainsDir = join(root, 'data', 'brains');

const files = existsSync(stockDir)
  ? readdirSync(stockDir).filter((f) => f.endsWith('.json'))
  : [];
if (files.length === 0) {
  console.log('resources/stock-brains has no packs — nothing to seed');
  process.exit(0);
}

mkdirSync(brainsDir, { recursive: true });
for (const file of files) {
  const raw = readFileSync(join(stockDir, file), 'utf8');
  // Same rule as the packaged seeder: the destination filename is the pack id.
  const id = JSON.parse(raw).id;
  writeFileSync(join(brainsDir, `${id}.json`), raw, 'utf8');
  console.log(`seeded ${file} -> data/brains/${id}.json`);
}
