The role of this file is to describe common mistakes and confusion points that agents might encounter as they work in this project. If you ever encounter something in the project that surprises you, please alert the developer working with you and indicate that this is the case in this file to help prevent future agents from having the same issue.

## How to add entries

Each entry documents a real gotcha encountered during a session. The format:

```
## <Short, scannable title> (<source task or context>, <date>)

<Two to four sentences describing the surprise, why it happens, and what the
correct behavior looks like. Point at the relevant file paths so the next
agent can verify.>
```

Keep entries tight. If a section would be longer than a screenful, it probably
belongs in a dedicated doc under `docs/` or as a comment at the source. This
file is for **confusion pointers**, not long-form documentation.

Before adding an entry, ask whether the surprise can be invalidated instead of
documented:

- **Push to source.** A pattern with a clear home (a function, a hook) belongs
  in a comment at that site. Agents reading the code find it when they need it.
- **Build a structural check.** Diligence traps ("remember to update X when you
  change Y") should become tests or derived assertions that remove the trap.
  Core Value #3.
- **Write the entry only when neither works** — when the surprise is
  cross-cutting, environmental, or a one-shot heads-up with no natural home.

---

## A just-added manual memory doesn't show in the live thread until reload (brain surgery, 2026-06-01)

Adding a manual ("timeless") memory to the *currently-loaded* chat updates
`chatLog` (the grep corpus) but NOT `messages` (the visible thread) — so the
inserted turn is retrievable immediately but only *appears* in the thread on the
next load of that chat (where it shows as the oldest messages). This is
intentional, not a bug: the editor mutation path (`resyncLiveChatLog` in
`SalienceGatedCognition.tsx`) rebuilds only `chatLog`, deliberately leaving the
ongoing visual conversation untouched so a memory isn't retroactively injected
mid-scroll. SGC keeps `messages` (display) and `chatLog` (retrieval) as separate
state; don't assume mutating one mirrors the other.

## Known-gap synonymy probes need pure-synonym queries — no overlapping terms (retrieval eval harness, 2026-06-09)

When authoring 'known-gap' probes for synonym coverage, the probe query must contain ONLY
the synonym word with no terms that also appear in the planted fact. For example, a fact
containing "boss approved budget proposal" will match a query of "manager approved budget
proposal" on TF-IDF shared terms ('approved', 'budget', 'proposal') — that is NOT a synonym
gap, it is an ordinary exact-term match. Redesign synonym queries to share zero vocabulary
with the planted fact text; test against the fixture before declaring a gap.

## Apostrophes in single-quoted TS string literals cause esbuild parse errors (retrieval eval harness, 2026-06-09)

TypeScript fixture strings written as single-quoted literals must not contain apostrophes
(e.g. `'Saturn's rings'`). esbuild terminates the string at the first `'` and fails with
"Expected ')' but found 's'". Use double-quoted strings or remove the possessive form.
The affected lines were in `src/client/lib/eval/fixtures.ts` — two instances fixed by
dropping the possessive suffix. This does not affect retrieval behaviour because the
apostrophised words were not the probe target terms.

## better-sqlite3 + Electron: prebuild-or-MSVC — pin Electron to an ABI with a prebuild (electron release, 2026-06-12)

This machine has NO Visual Studio toolchain, so `electron-builder`'s pack-time
`npmRebuild` can only succeed when better-sqlite3 ships a prebuilt binary for
the target Electron ABI. Electron 42 (ABI 146) had none → node-gyp → "Could not
find any Visual Studio installation". Electron is pinned to `^41` (ABI 145,
prebuild exists) for exactly this reason — before bumping the Electron major,
check the better-sqlite3 release assets for `electron-v<abi>-win32-x64`
(`node -e "require('node-abi').getAbi('<ver>','electron')"` gives the ABI).
Separately: `npm run dist:win` MUTATES node_modules to the Electron ABI; the
wrapper (`scripts/dist-win.mjs`) restores the Node ABI in a `finally`, so
vitest/dev work even after a failed pack. If you ever see
"NODE_MODULE_VERSION" / "not a valid Win32 application" from vitest, run
`npm run rebuild:node`.

Second-order trap (hit on the SECOND pack of a session): @electron/rebuild
writes an "already built" marker — `build/Release/.forge-meta` ("x64--145") —
next to the binary. The post-pack restore swaps the binary back to the Node
ABI but the marker survives, so a marker-trusting rebuild (electron-builder's
`npmRebuild`, or `electron-rebuild` without `-f`) SKIPS and silently packages
the NODE binary → the installed app crashes at boot with ERR_DLOPEN_FAILED.
That's why `npmRebuild` is `false` and `scripts/dist-win.mjs` force-rebuilds
(`electron-rebuild -f`) before the pack and deletes the stale marker after the
restore. Don't "simplify" either of those away.

## The ESM server runs under utilityProcess.fork from inside asar — primary path shipped (electron release, 2026-06-12)

The packaged app forks `dist/server/index.js` (ESM) with
`utilityProcess.fork` and it loads cleanly from inside the asar because the
asar root `package.json` (with `"type": "module"`) is in `build.files`. The
spawn+`ELECTRON_RUN_AS_NODE` fallback in `electron/serverManager.ts` was NOT
needed — it stays behind the single `launch` assignment; if you ever swap to
it, also add `"dist/server/**"` to `asarUnpack`. The SPA static assets serve
fine from inside the asar too; only the better-sqlite3 `.node` needs
`asarUnpack`.

## SGC_DB_PATH is mandatory in the packaged app; userData is %APPDATA%\sgc, not the productName (electron release, 2026-06-12)

Without `SGC_DB_PATH` the server's `db.ts` falls back to `process.cwd()` —
non-writable under Program Files — and crashes at import-time `mkdirSync`.
`electron/serverManager.ts` always sets it to `<userData>/data/sgc.db`. Note
the real path: Electron derives userData from package.json `name`, so it is
`%APPDATA%\sgc\…`, NOT `%APPDATA%\Salience-Gated Cognition\…` as the spec's
verification section assumed. sgc-config.json and logs/server.log live there
too.

## Electron main + preload ship as .cjs BY DESIGN (electron release, 2026-06-12)

The root package.json is `"type": "module"`, so a `.js` emit from esbuild
would load as ESM and CJS-in-.js deterministically fails. `build:electron`
emits `dist/electron/{main,preload}.cjs` via `--out-extension:.js=.cjs`.
"require is not defined" (main) or "contextBridge is not defined" (preload)
means a `.js` emit slipped back in — check that flag is still on the script.

## `npm audit` reports a pre-existing "critical" — don't `audit fix --force` it (mermaid add, 2026-06-02)

After `npm install`, `npm audit` shows ~4 moderate + 1 critical. They all live in
the **dev toolchain** (`vitest` → `vite` → `esbuild`, the Vitest-UI advisory
chain), not in any runtime dependency, and they predate recent feature work.
`npm audit fix --force` "resolves" them by bumping `vitest` a major version (a
breaking change) — don't run it. Adding `mermaid` (2026-06-02) pulled ~110
transitive packages but introduced none of these. If a fresh `npm install` shows
the same count, it's this, not something you broke.
