// Stock-brain seeding — copies bundled knowledge packs into the user's
// writable brains dir before the server forks (stock-brains spec D1).
//
// Electron-free by design, same pattern as config.ts: both directories are
// injected so the logic runs under plain vitest. serverManager owns the real
// paths (process.resourcesPath/stock-brains → <userData>/data/brains) and the
// app.isPackaged gate (D5 — dev never auto-seeds; `npm run seed:dev` covers it).
//
// The ledger (sgc-config.json seededBrains, D2) is the tombstone: a pack is
// copied iff ledger[id] !== pack.version. So a user-deleted stock brain stays
// deleted across launches, and bumping a pack's version re-seeds it on upgrade
// (overwrite-by-id, same semantics as the import route).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

// Mirrors the server's brain-id rule (brains-routes.ts BRAIN_ID_RE) — the id
// becomes the destination filename, so it must be validated here too.
const BRAIN_ID_RE = /^[a-z0-9-]{1,64}$/;
const BRAIN_PACK_SCHEMA = 'sgc-brain/1';

/** packId → seeded pack version (sgc-config.json `seededBrains`). */
export type SeededBrainsLedger = Record<string, string>;

export interface SeedResult {
  /** Ledger AFTER this run — persist it iff `seeded` is non-empty. */
  ledger: SeededBrainsLedger;
  /** Pack ids copied this run (fresh installs and version bumps). */
  seeded: string[];
  /** Pack ids left alone because the ledger already records their version. */
  skipped: string[];
  /** Stock FILE names that failed parsing/validation — logged, never ledgered. */
  failed: string[];
}

// A stock pack only needs the fields the seeder acts on; the full sgc-brain/1
// contract is enforced by step-6 verification (a malformed committed pack is a
// build-time bug, not a runtime input).
function stockPackProblem(pack: unknown): string | null {
  if (!pack || typeof pack !== 'object') return 'not a JSON object';
  const p = pack as Record<string, unknown>;
  if (p.schema !== BRAIN_PACK_SCHEMA) return `schema must be "${BRAIN_PACK_SCHEMA}"`;
  if (typeof p.id !== 'string' || !BRAIN_ID_RE.test(p.id)) return 'id must match [a-z0-9-]{1,64}';
  if (typeof p.version !== 'string' || !p.version) return 'version must be a non-empty string';
  return null;
}

/** Copy every valid pack in stockDir whose version the ledger doesn't already
 *  record into brainsDir as <id>.json (atomic tmp + rename, raw bytes — the
 *  committed pack lands verbatim). Pure with respect to its arguments; a copy
 *  failure propagates to the caller (which boots anyway — an unledgered copy
 *  is simply retried next launch). */
export function seedStockBrains(
  stockDir: string,
  brainsDir: string,
  ledger: SeededBrainsLedger,
): SeedResult {
  const result: SeedResult = { ledger: { ...ledger }, seeded: [], skipped: [], failed: [] };
  if (!existsSync(stockDir)) return result;
  const files = readdirSync(stockDir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  for (const file of files) {
    let raw: string;
    let pack: unknown;
    try {
      raw = readFileSync(join(stockDir, file), 'utf8');
      pack = JSON.parse(raw);
    } catch (err) {
      console.error(`stock brain ${file} is unreadable, skipping:`, err);
      result.failed.push(file);
      continue;
    }
    const problem = stockPackProblem(pack);
    if (problem) {
      console.error(`stock brain ${file} is invalid (${problem}), skipping`);
      result.failed.push(file);
      continue;
    }
    const { id, version } = pack as { id: string; version: string };
    if (result.ledger[id] === version) {
      result.skipped.push(id);
      continue;
    }
    mkdirSync(brainsDir, { recursive: true });
    const dest = join(brainsDir, `${id}.json`);
    const tmp = `${dest}.tmp`;
    writeFileSync(tmp, raw, 'utf8');
    renameSync(tmp, dest);
    result.ledger[id] = version;
    result.seeded.push(id);
  }
  return result;
}
