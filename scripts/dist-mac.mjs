// dist:mac wrapper — force the Electron-ABI rebuild, run electron-builder,
// and restore the Node ABI in a FINALLY. Sibling of dist-win.mjs; runs on a
// mac (or the release-mac.yml CI runner) ONLY — electron-builder cannot build
// mac targets from Windows.
//
// The FORCE (-f) is load-bearing on mac too: @electron/rebuild's "already
// built" marker (build/Release/.forge-meta, e.g. "arm64--145") survives the
// post-pack restore, so a marker-trusting rebuild would silently package the
// Node-ABI binary → ERR_DLOPEN_FAILED at app launch (see AGENTS.md,
// better-sqlite3 entry — the trap is platform-general). CI's node_modules is
// ephemeral, but this script must also be safe on a physical mac, so the
// finally-restore + marker scrub stay.

import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

function run(command, args) {
  // shell:true keeps parity with dist-win.mjs (harmless on POSIX).
  const result = spawnSync(command, args, { stdio: 'inherit', shell: true });
  return result.status ?? 1;
}

let exitCode = 1;
try {
  // --arch arm64 is load-bearing (Codex review 2026-09-01): electron-rebuild
  // defaults to the HOST arch, so on an Intel mac it would build an x64 module
  // that electron-builder then packages into the arm64 app → ERR_DLOPEN_FAILED.
  exitCode = run('npx', ['electron-rebuild', '-f', '-w', 'better-sqlite3', '--arch', 'arm64']);
  if (exitCode !== 0) {
    console.error('\n[dist-mac] electron-rebuild failed — skipping electron-builder.');
  } else {
    // --publish never is load-bearing (first CI firing, 2026-09-01):
    // electron-builder 26 IMPLICITLY publishes when it detects a git tag and
    // then dies without GH_TOKEN in the build step. The workflow's upload
    // step is the only publisher; the builder must never be.
    exitCode = run('npx', ['electron-builder', '--mac', '--arm64', '--publish', 'never']);
  }
} finally {
  const restoreExit = run('npm', ['rebuild', 'better-sqlite3']);
  // The restore puts the Node binary back but @electron/rebuild's marker
  // still claims the Electron ABI — delete it so nothing later trusts it.
  rmSync('node_modules/better-sqlite3/build/Release/.forge-meta', { force: true });
  if (restoreExit !== 0) {
    console.error(
      '\n[dist-mac] WARNING: `npm rebuild better-sqlite3` failed — node_modules may still hold ' +
        'the Electron ABI. vitest/dev:server will fail with NODE_MODULE_VERSION errors until ' +
        '`npm run rebuild:node` succeeds.',
    );
  }
}
process.exit(exitCode);
