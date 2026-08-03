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

An entry that gets its check built or its comment pushed to source is DELETED,
not kept "for the record" — this file was audited to that standard 2026-08-02
and entries here have survived it.

---

## Stopping a background `npm run dev` can orphan the Vite/tsx children on :5555/:3000 (package spinup, 2026-05-18)

Killing the background task stops the `concurrently` parent but can leave the
Vite client and tsx server processes alive, still holding their ports — the
next `npm run dev` then dies with "Port 5555 is already in use". Don't trust
the task-stop to free the ports; verify and, if needed, kill by port before
relaunching (PowerShell):
`Get-NetTCPConnection -LocalPort 5555,3000 -State Listen | %{ Stop-Process -Id $_.OwningProcess -Force }`.

## Model web tools were removed for their per-turn token tax — the URL pre-fetch is the world axis (web tools removed, 2026-05-21)

Anthropic's server-side `web_search`/`web_fetch` tools once rode on
`/api/turn`. Removed 2026-05-21: attached tools inject ~4–5k tokens of
definitions and scaffolding into EVERY turn's `input_tokens` whether or not
Sal browses (a turn-1 "capital of France?" question billed ~5.2k input). The
deterministic `/api/fetch-url` pre-fetch (Readability extraction, no model)
already covers "read this page", and with the tools gone the Anthropic input
count ≈ the actual prompt again, so the Context-Savings tile compares
honestly. If you're tempted to re-add model web tools, weigh that per-turn
tax first — and note it's a world-axis change, not a memory-path one (the
Phase 1.5 invariant is about how Sal recalls the PERSON; see CLAUDE.md).

## `npm audit` reports a pre-existing "critical" — don't `audit fix --force` it (mermaid add, 2026-06-02)

After `npm install`, `npm audit` shows ~4 moderate + 1 critical. They all live in
the **dev toolchain** (`vitest` → `vite` → `esbuild`, the Vitest-UI advisory
chain), not in any runtime dependency, and they predate recent feature work.
`npm audit fix --force` "resolves" them by bumping `vitest` a major version (a
breaking change) — don't run it. Adding `mermaid` (2026-06-02) pulled ~110
transitive packages but introduced none of these. If a fresh `npm install` shows
the same count, it's this, not something you broke.

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

## A raw control byte in a source file silently breaks every grep over it (dynamic-state review, 2026-08-03)

A junk-input test fixture written as a literal NUL byte (instead of the
`'\u0000'` escape) made ripgrep classify the whole file as binary — every
Grep over `dynamic-state.test.ts` returned "binary file matches" with no
lines, while Vitest/tsc ran it happily. If a text search over a source file
returns a binary-file result, suspect an embedded control character and
re-encode it as an escape; don't trust "no matches" from a file grep can't
actually read.

## Always-on prompt copy is a behavioral change — and small local models take it harder (v1.3.0 plot-loss regression, 2026-07-10)

The v1.3.0 absence marker ("nothing from older history surfaced") shipped
unconditional and measurably degraded LOCAL-provider narrative consistency:
a 7-13B model reads that line — rendered on most mid-plot turns, since the
plot lives in the buffers, not the grep — as "you don't remember this" and
starts dropping threads Opus carries fine. Two standing rules fell out of it:
(1) any copy added to every turn's prompt is a behavioral change to BOTH
providers and needs a LOCAL-path sanity pass, not just an Anthropic one;
(2) prompt block ORDER is load-bearing — late-prompt position gets the most
attention weight, so history tiers must render chronologically (stale grep
first, live exchange last). Both are pinned in `prompt.test.ts` (the gating
and ordering tests) and explained at the source (`lib/prompt.ts`); this entry
is the cross-cutting heads-up.
