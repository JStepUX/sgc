// The packaged Electron main + preload MUST emit as .cjs: the root
// package.json is `"type": "module"`, so a `.js` emit from esbuild would load
// as ESM, and CJS-in-.js deterministically fails at boot — "require is not
// defined" (main) or "contextBridge is not defined" (preload). This pins the
// esbuild flag that guarantees the extension, so the failure mode is a named
// test instead of a dead packaged app.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('electron build contract', () => {
  it('build:electron still emits .cjs via --out-extension:.js=.cjs', () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      type?: string;
      scripts?: Record<string, string>;
    };
    // The flag only matters while the package is ESM — if `type` ever changes,
    // this contract should be re-thought, not silently satisfied.
    expect(pkg.type, 'root package.json is no longer "type": "module" — revisit the .cjs emit contract').toBe('module');
    const script = pkg.scripts?.['build:electron'] ?? '';
    expect(
      script,
      'build:electron lost --out-extension:.js=.cjs — a .js emit loads as ESM and the packaged app dies at boot ("require is not defined")',
    ).toContain('--out-extension:.js=.cjs');
  });
});
