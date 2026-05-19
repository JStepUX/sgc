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

## The API key is server-only — never call api.anthropic.com from the client (package spinup, 2026-05-18)

The browser never talks to `api.anthropic.com`. The React client builds the
system prompt and POSTs it to `/api/turn` via `src/client/lib/api.ts`; the
Express server (`src/server/index.ts`) holds `ANTHROPIC_API_KEY` and makes the
real call. The Phase 1.5 artifact (`docs/phase-1-5-reference.jsx`) *did* fetch
`api.anthropic.com` directly with no auth header — that only worked inside the
Claude Artifact runtime, which injected credentials. If you add a client feature
that needs the model, route it through the proxy. **Never hardcode an
`sk-ant-...` key into client code** — `scripts/agent/health-check.sh` scans
source for exactly that.

## `npm run dev` is two processes, and the turn route needs a `.env` (package spinup, 2026-05-18)

`npm run dev` uses `concurrently` to run the Vite client (`:5555`) and the
Express proxy (`:3000`) together — Vite proxies `/api` to the server. If you
only see the UI but every turn fails, the server process probably isn't up, or
`.env` is missing. Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`.
Without it the server still starts (and prints a warning on boot), but it never
constructs the Anthropic client, and `/api/turn` returns a 500 with a clear
"ANTHROPIC_API_KEY is not set" message. `.env` is gitignored — never committed.

## "Sal" is the identity; "turn" is the mechanism (naming pass, 2026-05-18)

The model has one name — **Sal** — used wherever a user sees it (the persona
prompt in `lib/prompt.ts`, the chat label). The codebase's neutral word for the
mechanism is **turn**: `runTurn`, `/api/turn`, `TurnData`, `TurnMetadata`,
`turnCount`. "Synth" was an early working title and has been retired — if you
see it anywhere outside the frozen `docs/phase-1-5-reference.jsx`, that's a
leftover worth fixing. Don't reintroduce it, and don't spread "Sal" onto
plumbing (routes, interfaces) — keep the name reserved for the identity.

## Agent bash scripts run under git-bash; `node_modules` is platform-specific (review, 2026-05-18)

`scripts/agent/*.sh` are bash scripts. The project's standard environment is
Windows, where they run under **git-bash** (which uses the Windows Node build) —
that is what they are written and tested against. `node_modules` contains
platform-native binaries (Rollup, esbuild); a tree installed by Windows `npm`
will NOT load under WSL/Linux Node, and vice versa — `npm test` / `vitest` then
fails with `Cannot find module @rollup/rollup-<platform>`. That is an
environment mismatch, not a real test failure. If you work in WSL, run your own
`npm install` there; never share one `node_modules` across shells of different
OS. `scripts/agent/health-check.sh` detects this signature and reports it as an
environment mismatch rather than a failure — but `npm test` run directly will
still fail, so reinstall in the shell you intend to use.
