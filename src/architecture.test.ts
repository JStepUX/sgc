import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================
// ANTI-GOD-OBJECT RATCHET
//
// SalienceGatedCognition.tsx once held 9 components + a 1,100-line root with
// 31 useStates (2,244 lines total — see docs/ignored/client-split-spec.yaml).
// The split fixed it once; this test keeps it fixed. Core Value #3: build the
// check, don't trust the diligence.
//
// Every non-test source file must stay under DEFAULT_MAX_LINES. Files with a
// granted exception get their own budget below. The budgets RATCHET: shrink
// them when a file shrinks, never grow one to silence a failure — a failure
// here is the signal to split along an axis (see src/client/hooks/ for the
// pattern), not to raise the ceiling.
// ============================================================

const DEFAULT_MAX_LINES = 500;

// Granted exceptions — repo-relative posix paths. Keep each budget within
// RATCHET_SLACK of the file's actual size so shrinkage gets locked in.
const EXCEPTIONS: Record<string, number> = {
  'src/client/components/ChatMemoryEditor.tsx': 700,
  'src/client/components/ChatHistoryModal.tsx': 570,
  'src/server/index.ts': 920,
  'src/server/db.ts': 730,
};

// An exception budget may exceed the file's actual size by at most this many
// lines. When a file shrinks past that, the test fails until the budget is
// ratcheted down — so headroom never quietly re-accumulates.
const RATCHET_SLACK = 150;

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCAN_ROOTS = ['src', 'electron'];
const SKIP_DIRS = new Set(['node_modules', 'dist']);

function isSource(name: string): boolean {
  if (!/\.(ts|tsx)$/.test(name)) return false;
  if (/\.(test|spec)\.(ts|tsx)$/.test(name)) return false;
  if (name.endsWith('.d.ts')) return false;
  return true;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(full);
    } else if (entry.isFile() && isSource(entry.name)) {
      yield full;
    }
  }
}

function countLines(file: string): number {
  const content = readFileSync(file, 'utf8');
  const parts = content.split('\n');
  return content.endsWith('\n') ? parts.length - 1 : parts.length;
}

function relPosix(file: string): string {
  return relative(REPO_ROOT, file).split('\\').join('/');
}

const sourceFiles = SCAN_ROOTS.flatMap((root) => [...walk(join(REPO_ROOT, root))]);

describe('anti-god-object ratchet', () => {
  it('found the source tree (guards against a silently-empty scan)', () => {
    expect(sourceFiles.length).toBeGreaterThan(20);
  });

  it('every source file stays under its line budget', () => {
    const over = sourceFiles
      .map((file) => {
        const rel = relPosix(file);
        return { rel, lines: countLines(file), budget: EXCEPTIONS[rel] ?? DEFAULT_MAX_LINES };
      })
      .filter((f) => f.lines > f.budget)
      .map((f) => `${f.rel}: ${f.lines} lines > budget ${f.budget} — split it, don't raise the budget`);
    expect(over).toEqual([]);
  });

  it('exception budgets track their files (ratchet down, prune the dead)', () => {
    const stale = Object.entries(EXCEPTIONS).flatMap(([rel, budget]) => {
      const full = join(REPO_ROOT, rel);
      if (!existsSync(full)) {
        return [`${rel}: file no longer exists — remove its exception entry`];
      }
      const lines = countLines(full);
      if (budget > lines + RATCHET_SLACK) {
        return [`${rel}: budget ${budget} is ${budget - lines} above its ${lines} lines — ratchet the budget down`];
      }
      if (budget <= DEFAULT_MAX_LINES) {
        return [`${rel}: budget ${budget} <= default ${DEFAULT_MAX_LINES} — the entry is redundant, remove it`];
      }
      return [];
    });
    expect(stale).toEqual([]);
  });
});
