// dist:win wrapper — force the Electron-ABI rebuild, run electron-builder,
// and restore the Node ABI in a FINALLY (Core Value 3: even a failed pack
// leaves vitest/dev:server working).
//
// The FORCE (-f) is load-bearing: @electron/rebuild writes an "already built"
// marker (build/Release/.forge-meta, e.g. "x64--145") next to the binary.
// After a successful pack, the finally below restores the NODE-ABI binary but
// the marker survives — so a marker-trusting rebuild (electron-builder's
// npmRebuild, or electron-rebuild without -f) SKIPS the work and silently
// packages the Node binary → ERR_DLOPEN_FAILED (NODE_MODULE_VERSION mismatch)
// at app launch. npmRebuild is false in package.json "build"; this wrapper
// owns the flip in both directions and scrubs the stale marker after restore.

import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

function run(command, args) {
  // shell:true so npm/npx resolve to their .cmd shims on Windows.
  const result = spawnSync(command, args, { stdio: 'inherit', shell: true });
  return result.status ?? 1;
}

let exitCode = 1;
try {
  exitCode = run('npx', ['electron-rebuild', '-f', '-w', 'better-sqlite3']);
  if (exitCode !== 0) {
    console.error('\n[dist-win] electron-rebuild failed — skipping electron-builder.');
  } else {
    exitCode = run('npx', ['electron-builder', '--win', '--x64']);
  }
} finally {
  const restoreExit = run('npm', ['rebuild', 'better-sqlite3']);
  // The restore puts the Node binary back but @electron/rebuild's marker
  // still claims the Electron ABI — delete it so nothing later trusts it.
  rmSync('node_modules/better-sqlite3/build/Release/.forge-meta', { force: true });
  if (restoreExit !== 0) {
    console.error(
      '\n[dist-win] WARNING: `npm rebuild better-sqlite3` failed — node_modules may still hold ' +
        'the Electron ABI. vitest/dev:server will fail with NODE_MODULE_VERSION errors until ' +
        '`npm run rebuild:node` succeeds.',
    );
  }
}
process.exit(exitCode);
