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

## "No model-based retrieval" means MEMORY retrieval — web search/fetch is a different axis (web tools, 2026-05-20)

The Phase 1.5 invariant "no model-based retrieval / no drift surface" is about
how Sal recalls **the person** — chat history and memories. Phase 1 used a model
as the grepper ("Grepory"); it was slow and unhelpful, so cosine TF-IDF replaced
it (`lib/tfidf.ts`). That story is the whole point of the invariant: *memory*
retrieval must be deterministic math, not a reasoning component. It was never
about whether Sal can reach the outside world. So the server-side `web_search` /
`web_fetch` tools added to `/api/turn` (`src/server/index.ts`) do **not** violate
it — they're web/knowledge retrieval, an orthogonal axis. The cosine grep remains
the sole memory mechanism. Don't "fix" the web tools by routing them through a
model-retrieval objection that doesn't apply; and equally, don't let web access
creep into the *memory* path — that line is still load-bearing. The prompt
(`lib/prompt.ts`) tells Sal explicitly: web is for the world, memories are for the
person.

These are Anthropic server-side tools: the search/fetch loop runs inside the one
`messages.stream()` request, so "one API call per turn" still holds. But note
(per CLAUDE.md → Mission Brief) that the call count is a **guardrail, not the
law** — the thesis is Sal's per-turn ephemerality + curated-tier context, not the
integer 1. A call added *within* a turn that keeps Sal ephemeral and leaves
*memory* retrieval deterministic doesn't breach the thesis. The single caveat
here is `stop_reason: 'pause_turn'` (server loop hit its iteration cap) — we log
it and deliberately do **not** resume, because resuming costs a second call for
no thesis benefit. See the comment at the stream/`finalMessage` site in
`src/server/index.ts`.

For the explicit-URL case ("read this page"), retrieval is even cleaner: a
deterministic server-side **pre-fetch** (`POST /api/fetch-url`, Readability
extraction — no model) pulls clean article text *before* the single model call,
and the browser folds it into the prompt as a `LINKED PAGE` block. One call, page
counted once, no loop, no model in the loop. `web_search` (and `web_fetch` as a
discovery-read fallback) stay server-side for the case where Sal must decide what
to read. The pre-fetch is the web-knowledge analogue of cosine-replacing-Grepory:
mechanical retrieval, no drift.

## Swapping Sal's model to a local OpenAI-compatible server is thesis-compatible; web tools are a provider-dependent axis, dark on LOCAL (local provider, 2026-05-21)

The header provider chip can point Sal's single reasoning call at a local
OpenAI-compatible server (KoboldCPP/Ollama, `OPENAI_BASE_URL`) instead of
Anthropic. This is **not** a Phase change: a local model is just a different
*Sal* — still ephemeral (one fresh instance per turn, rebuilt from the curated
tiers, then retired), and the memory/retrieval path is untouched (cosine grep in
`lib/tfidf.ts` + the `/api/fetch-url` pre-fetch stay deterministic, no model in
the loop, on either provider). Switching mid-chat is harmless because no state is
carried between turns; a single chat may mix anthropic and local turns. The
client sends only a provider TOKEN (`'anthropic'|'openai'`) — never a URL or key;
the server (`src/server/providers.ts` + `index.ts`) owns those. Both providers
emit the **same** `delta`/`done`/`error` SSE frames, so the browser parser
(`lib/api.ts`) is provider-agnostic.

Two things to know. (1) `web_search` / `web_fetch` are **Anthropic server-side
tools** — they're a *different axis* from memory (see the entry above) and they
go **dark on the local path** (`openaiProvider` doesn't offer them; the `done`
frame carries 0 for both counts). That's an accepted trade-off, not a bug:
deterministic retrieval (cosine grep + `/api/fetch-url` pre-fetch) still works on
both paths, so Sal can still read a pasted URL locally. (2) KoboldCPP may report
no token usage; the local `done` frame then carries 0 input/output tokens — the
Context-Savings tile still renders (its baseline is computed client-side) but
local *input*-token counts aren't authoritative. The default persona's
web-access paragraph is technically false on LOCAL; it's harmless/unused, so it
stays in `DEFAULT_PERSONA` — flagged here so a future agent isn't surprised the
prompt mentions web access the local model can't use. (As of the per-chat
persona work, 2026-05-21, `buildPrompt` *does* take an optional `persona`, so a
custom persona on a local chat can drop that paragraph — but `DEFAULT_PERSONA`
deliberately keeps it.)

## Web fonts must load via `<link>` in `index.html`, not `@import` in `index.css` (Sal re-skin, 2026-05-19)

A web-font `@import url("https://fonts.googleapis.com/…")` placed in
`src/client/index.css` after `@import "tailwindcss"` triggers a Lightning CSS
warning — `"@import rules must precede all rules aside from @charset and @layer
statements"` — and may be dropped from the output, silently breaking the font.
Tailwind v4 inlines `@import "tailwindcss"` into many rules during processing,
so any later `@import` lands mid-stylesheet. Load web fonts via
`<link rel="stylesheet">` in `index.html` instead — see the Geist + Geist Mono
links in `<head>`. New fonts go there too.

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

## Persistence is keyed by chat-id; memories are global by design (chat history, 2026-05-19)

`src/server/db.ts` deliberately scopes turns to a `chat_id` but keeps `memories`
+ `memory_history` at the top level — there is no `chat_id` column on either.
Memories are the user's constitutional state across the lifetime of the system;
a chat doesn't own them. This is *enforced* by the route shapes:
`PUT /api/memories` has no chat-id, and "Begin again" in
`SalienceGatedCognition.tsx` creates a new chat but only clears the visible
session, never the memory set. If a future agent adds per-chat memory scoping,
it's a Phase change (the constitution would no longer be constitutional), not a
fix — raise it first.

The mount-time hydration in `SalienceGatedCognition.tsx` returns the in-memory
`DEFAULT_MEMORIES` *only* when the server returns `[]` (i.e. fresh install). A
real saved set always overrides the defaults. Don't be surprised if you see
three seed memories on first run that vanish once the user edits — they're
placeholders, not authoritative.

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
