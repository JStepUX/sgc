// Behavioral tests for stock-brain seeding (electron/stock-brains.ts).
// The module is electron-free by design — both directories are injected —
// so these run under plain vitest/Node, like config.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedStockBrains, type SeededBrainsLedger } from './stock-brains';

let dir: string;
let stockDir: string;
let brainsDir: string;

function makePack(id: string, version: string): string {
  return JSON.stringify({
    schema: 'sgc-brain/1',
    id,
    version,
    name: `Pack ${id}`,
    description: 'test pack',
    built_at: '2026-07-04T00:00:00Z',
    source: { tool: 'atlantis', schema: 'atlantis-salience-v1', stub: true },
    chunks: [
      {
        id: `${id}_000`,
        title: 'Chunk',
        text: 'Some text.',
        summary: 'Some text.',
        topics: [],
        aliases: [],
        source: { file: 'x.md', doc: id, position: 0 },
        tokens: 3,
      },
    ],
  });
}

function writeStock(file: string, content: string): void {
  writeFileSync(join(stockDir, file), content, 'utf8');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sgc-stock-brains-test-'));
  stockDir = join(dir, 'stock-brains');
  brainsDir = join(dir, 'data', 'brains');
  mkdirSync(stockDir, { recursive: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('seedStockBrains', () => {
  it('seeds every pack on a fresh install (empty ledger) and creates brainsDir', () => {
    writeStock('alpha.json', makePack('alpha', '1.0'));
    writeStock('beta.json', makePack('beta', '2.1'));
    const result = seedStockBrains(stockDir, brainsDir, {});
    expect(result.seeded).toEqual(['alpha', 'beta']);
    expect(result.ledger).toEqual({ alpha: '1.0', beta: '2.1' });
    expect(existsSync(join(brainsDir, 'alpha.json'))).toBe(true);
    expect(existsSync(join(brainsDir, 'beta.json'))).toBe(true);
  });

  it('copies raw bytes and names the file by pack id, not source filename', () => {
    const raw = makePack('renamed-pack', '1.0');
    writeStock('999-some-build-name.json', raw);
    seedStockBrains(stockDir, brainsDir, {});
    expect(readFileSync(join(brainsDir, 'renamed-pack.json'), 'utf8')).toBe(raw);
  });

  it('skips a pack whose version the ledger already records (deleted stays deleted)', () => {
    writeStock('alpha.json', makePack('alpha', '1.0'));
    const first = seedStockBrains(stockDir, brainsDir, {});
    // User deletes the brain via the UI (file gone, ledger intact) …
    unlinkSync(join(brainsDir, 'alpha.json'));
    // … next launch must NOT resurrect it.
    const second = seedStockBrains(stockDir, brainsDir, first.ledger);
    expect(second.seeded).toEqual([]);
    expect(second.skipped).toEqual(['alpha']);
    expect(existsSync(join(brainsDir, 'alpha.json'))).toBe(false);
  });

  it('re-seeds (overwrites) when the stock pack version differs from the ledger', () => {
    writeStock('alpha.json', makePack('alpha', '1.0'));
    const first = seedStockBrains(stockDir, brainsDir, {});
    const upgraded = makePack('alpha', '1.1');
    writeStock('alpha.json', upgraded);
    const second = seedStockBrains(stockDir, brainsDir, first.ledger);
    expect(second.seeded).toEqual(['alpha']);
    expect(second.ledger).toEqual({ alpha: '1.1' });
    expect(readFileSync(join(brainsDir, 'alpha.json'), 'utf8')).toBe(upgraded);
  });

  it('is a no-op when the stock directory does not exist', () => {
    const ledger: SeededBrainsLedger = { alpha: '1.0' };
    const result = seedStockBrains(join(dir, 'nope'), brainsDir, ledger);
    expect(result).toEqual({ ledger: { alpha: '1.0' }, seeded: [], skipped: [], failed: [] });
    expect(existsSync(brainsDir)).toBe(false);
  });

  it('does not mutate the ledger it was given', () => {
    writeStock('alpha.json', makePack('alpha', '1.0'));
    const ledger: SeededBrainsLedger = {};
    seedStockBrains(stockDir, brainsDir, ledger);
    expect(ledger).toEqual({});
  });

  it('fails corrupt/invalid packs without ledgering them, and still seeds the rest', () => {
    writeStock('corrupt.json', '{not json');
    writeStock('wrong-schema.json', JSON.stringify({ schema: 'sgc-brain/2', id: 'x', version: '1' }));
    writeStock('bad-id.json', JSON.stringify({ schema: 'sgc-brain/1', id: 'Bad_ID!', version: '1' }));
    writeStock('good.json', makePack('good', '1.0'));
    const result = seedStockBrains(stockDir, brainsDir, {});
    expect(result.failed).toEqual(['bad-id.json', 'corrupt.json', 'wrong-schema.json']);
    expect(result.seeded).toEqual(['good']);
    expect(result.ledger).toEqual({ good: '1.0' });
  });

  it('ignores non-.json files (e.g. a README) in the stock directory', () => {
    writeStock('README.md', 'about these packs');
    const result = seedStockBrains(stockDir, brainsDir, {});
    expect(result).toEqual({ ledger: {}, seeded: [], skipped: [], failed: [] });
  });

  it('leaves no tmp file behind (atomic rename)', () => {
    writeStock('alpha.json', makePack('alpha', '1.0'));
    seedStockBrains(stockDir, brainsDir, {});
    expect(readdirSync(brainsDir)).toEqual(['alpha.json']);
  });
});
