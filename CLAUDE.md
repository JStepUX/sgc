If you ever encounter something in the project that surprises you, please alert the developer working with you and note it in the `AGENTS.md` file to help prevent future agents from having the same issue.

## Project Overview

**SGC — Salience-Gated Cognition** is a research prototype for a conversational
memory architecture. It is not a product; it is an experiment about *how a
reasoning agent should remember*.

The current iteration is **Phase 1.5**. `docs/phase-1-5-reference.jsx` is the
frozen original single-file artifact; the live implementation is the TypeScript
React app under `src/`.

### The Architecture

Every turn, three memory tiers are assembled (client-side) into a single prompt
and handed to one ephemeral reasoning instance:

1. **Constitutional Memories** — a small, curated set of durable facts about the
   user. Plain text the user edits/adds/deletes in the UI; **the model does not
   score or grade them** (the former 0–100 per-turn confidence grading was
   retired — see the turn-summary note below). They are **scoped per chat** —
   each conversation owns its own set, a new chat starts empty (no seeded
   defaults), and deleting a chat cascades its memories away.
2. **Local Buffer** — the last 2 turns (4 messages) passed verbatim. Immediate
   context, no retrieval.
3. **Cosine Grep ("Grepory")** — TF-IDF + cosine similarity search over *older*
   chat history (everything before the local buffer). **Pure math. No model. No
   API call. No drift surface.** This is the deliberate design choice of Phase
   1.5: retrieval must not be a reasoning component. The user can gate individual
   turns *out* of this corpus in the **chat memory editor** (a turn switched off
   dims and stops being retrievable) — deterministic curation of the memory tier,
   still no model in the loop. It strengthens the thesis rather than touching it.
   The same editor also supports **manual memories** ("brain surgery"): the user
   inserts a full user+assistant turn that lands as the *oldest* turn in the
   chat, flagged **timeless** — greppable like any other turn, but immune to the
   recency scorer (its time score is pinned to 1.0). Still pure curation, no
   model: timeless cards have no gate toggle, only a delete control.

These feed **Sal**, an ephemeral reasoning instance that exists for exactly one
turn, then is retired — it has no memory of prior turns. Sal responds in natural
language, then emits a `<turn-summary>` block: a fresh per-turn observation in
three lists — `persistent` (true until explicitly changed), `volatile` (shifted
this turn), `established_patterns` (behavioral rules demonstrated). Each summary
is produced fresh (Sal stays ephemeral — it carries no state of its own), but the
summaries of the **last couple of turns** are then fed *back* into later prompts
as a small **distilled summary buffer** sitting just behind the verbatim local
buffer (offset, no overlap). So a turn that scrolls out of full-text recency
survives as its summary instead of dropping straight to the cosine grep — a
resolution falloff (raw recent → distilled near-past → grep), not a cliff. This
is bounded curated context, **not accumulated model state**. The UI renders the
current turn's summary flattened to one dimmed line beneath the reply (and
structured in the inspector). In the base
loop that's **one API call per turn**, total — streamed to the browser as
Server-Sent Events; the TF-IDF retrieval costs 0 ms and 0 tokens. (That
single-call count is a guardrail, not the thesis — see Mission Brief.)

> **Naming:** the model's identity is **Sal** (used everywhere a user sees it).
> "Turn" is the codebase's neutral word for the mechanism — one user input → one
> model call → one response. ("Synth" was an early working title, retired except
> in the frozen reference.)

### Mission Brief — preserve the invariants

The Phase 1.5 contract on `docs/phase-1-5-reference.jsx` reads "No model-based
retrieval. One reasoning component. One API call." The real invariant is the
**architecture, not the count**: Sal stays ephemeral — every turn a fresh
instance gets a context rebuilt from the curated tiers, then is retired (no
growing transcript, no model carrying its own state). Two rules protect that:

- **No model in the memory/retrieval path.** Retrieval over the user's *own
  history* stays deterministic math (the cosine grep), never a reasoning
  component. Phase 1 tried a model as the grepper — slow, drifty; cosine
  replaced it. Re-introducing a model into *memory* retrieval (embeddings,
  semantic search) is a **phase change, not a fix — raise it first.**
- **"One API call per turn" is a guardrail, not the law.** A cheap tripwire:
  historically a model creeping back into retrieval showed up as an extra call.
  So treat a *new* model call as a smell worth investigating, not a forbidden
  act — work that adds a call within a single turn (e.g. a tool loop) while
  keeping Sal ephemeral and memory retrieval deterministic does **not** breach
  the thesis. (Web/knowledge retrieval is a separate axis from memory: server-
  side `web_search`/`web_fetch` tools were tried and then removed for cost — Sal
  now reaches the world only via the deterministic URL pre-fetch. See
  `AGENTS.md`.)

### Project Structure

```
src/client/
  main.tsx                    React entry point — imports index.css
  index.css                   Tailwind v4 entry — design tokens (@theme), shadcn theme, aurora CSS
  SalienceGatedCognition.tsx  the UI — main app + MemoryPanel / TurnInspector / TokenChart
  components/
    ChatHistoryModal.tsx      history list + (editor mode) the rail
    ChatMemoryEditor.tsx      per-turn cosine-grep gating editor (4-col card grid)
    ConfirmPersonaModal.tsx   per-chat persona (system prompt) + optional mask, set at "Begin again"
    PromptEditorModal.tsx     edit THIS chat's persona mid-chat, forward-only version history
    EditResponseModal.tsx     edit the latest assistant reply — manual rewrite or "re-spin"
                              (re-run the model with this turn's history; current memories/persona)
    ProviderConfigModal.tsx   configure either provider from the chip (desktop saves via the
                              Electron bridge → server restart; web mode shows .env guidance)
    MermaidBlock.tsx          lazy-loaded mermaid code blocks → themed SVG; streaming-gated, code-block fallback
    ui/                       shadcn/ui primitives (button, card)
  lib/
    types.ts                  shared domain types (ChatEntry, Memory)
    utils.ts                  cn() — Tailwind-aware class-name merge
    tfidf.ts                  the TF-IDF cosine engine ("Grepory") — pure, deterministic
    tfidf.test.ts             Vitest behavioral tests for the engine
    time-score.ts             time scorer + searchScored orchestrator (concept × time)
    turn-context.ts           assembleTurnContext() — deterministic per-turn tier assembly,
                              shared by the live turn and the response editor's re-spin
    prompt.ts                 system-prompt builder + response parser
    api.ts                    runTurn() — POSTs to /api/turn
    desktop.ts                typed guard for window.sgcDesktop (Electron bridge; web → absent)
    eval/                     retrieval eval harness — planted-fact fixtures + probes
                              replayed through searchScored, ratcheted recall@3 / MRR
src/server/
  index.ts                    Express server — holds the provider keys/URLs; /api/health,
                              /api/turn (SSE), chat/turn/memory persistence routes; serves
                              dist/client when built. Reads ALL config from env once at boot.
  db.ts                       SQLite persistence (better-sqlite3) — chats/turns/memories,
                              schema + pure helpers; SGC_DB_PATH overrides the ./data default
  providers.ts                per-turn provider registry/resolver (anthropic | openai "LOCAL")
electron/                     Windows desktop shell — supervises, never thinks
  main.ts                     window + IPC; packaged: fork server, load ITS origin; dev: load :5555
  serverManager.ts            fork (utilityProcess) + health poll + restart-on-config-change;
                              persists serverPort so the origin/localStorage survive relaunches
  config.ts                   sgc-config.json read/merge/atomic-write + env mapping (+ tests)
  preload.ts                  contextBridge → window.sgcDesktop (redacted state, whitelisted patches)
scripts/dist-win.mjs          electron-builder wrapper — restores the Node ABI in a finally
docs/
  phase-1-5-reference.jsx     frozen original single-file artifact
  *-spec.yaml                 implementation specs (YAML — see "Spec format" below)
  changelogs/                 month-by-month change log
```

### Spec format — YAML, not prose

Specs in `docs/` are **machine-legible YAML for an executing agent, not reports
for stakeholders.** A spec exists to drive a code task: it carries the *facts*
an implementer acts on — file paths, line numbers, type/signature deltas,
ordered build steps, and the load-bearing constraints — not the argument for
those facts. Do **not** write narrative justification, "why this matters"
prose, history, or blog-post framing. Keep `goal` to a sentence; compress the
thesis/invariant check to a short key/value block (`invariant_check:`); make
everything else actionable. (Earlier `.md` specs were prose-heavy; that style is
retired.)

### Tech / Shape

- **Client:** React 19 + TypeScript, built with Vite 6. UI is **Tailwind v4**
  (the `@tailwindcss/vite` plugin; design tokens in an `@theme` block) +
  **shadcn/ui** primitives. Tokens, the shadcn theme, and the aurora CSS all
  live in `src/client/index.css`; `components.json` configures shadcn. The
  visual language is the "Sal" design system — a warm near-black field.
- **Server:** a thin Express proxy, **deliberately dumb** — it attaches the API
  key and forwards the request, with no memory logic server-side (all three
  tiers are assembled in the browser, `SalienceGatedCognition.tsx` + `lib/`).
  `@anthropic-ai/sdk`, one route (`POST /api/turn`); model defaults to
  `claude-opus-4-7`, overridable via the `ANTHROPIC_MODEL` env var.
- **Tests:** Vitest. The TF-IDF engine (`lib/tfidf.ts`) is pure logic and the
  prime test target — see `lib/tfidf.test.ts`. Retrieval *quality* has its own
  instrument: `lib/eval/` replays planted-fact fixtures through `searchScored`
  and ratchets recall@3 / MRR; `known-gap` probes document the synonymy limits
  and fail loudly if a change closes one (promote them to `pass` when that
  happens). Turn-score changes must keep this suite green.
- **Run it (web/dev):** `npm install`, then `cp .env.example .env` and add an
  `ANTHROPIC_API_KEY`, then `npm run dev`. That runs the Vite client (`:5555`)
  and the Express proxy (`:3000`) together via `concurrently`; Vite proxies
  `/api` to the server. Open `http://localhost:5555`.
- **Run it (desktop):** `npm run electron:dev` adds an Electron window over the
  same dev stack (no embedded server in dev). `npm run dist:win` builds the
  NSIS installer into `release/` — it rebuilds better-sqlite3 to the Electron
  ABI at pack time and flips it back to the Node ABI in a `finally` (see
  `AGENTS.md`). Packaged, the app forks the built server, loads its origin
  (`http://127.0.0.1:<persisted port>`), and applies provider-config changes
  (the chip's ProviderConfigModal → `%APPDATA%\sgc\sgc-config.json`) by
  restarting that fork — the server still reads env once at boot, unchanged.
- **Key handling:** the API key lives *only* on the server (web: `.env`;
  desktop: `sgc-config.json` in userData, plaintext by decision D2, handed to
  the fork as env). The browser/renderer calls `/api/turn` and never touches
  `api.anthropic.com`; the renderer sees only redacted presence booleans. See
  `AGENTS.md`.

## Core Values

1. I don't want to be right; I want to do right.
2. Be kind to future you.
3. Don't build systems that require diligence. Build systems that catch you when you're not diligent.
4. Half-measures are confusing to future agents — commit fully.
5. The agent doesn't know what it doesn't know. Build the check, don't trust the self-report.
6. Let friction drive the architecture, not speculation.
7. Ship what you'd sign.

## Agent Utility Scripts (`scripts/agent/`) — CHECK THESE BEFORE MULTI-STEP TOOL CALLS

Bash scripts that collapse common multi-tool-call patterns into single
invocations. **Before chaining 3+ tool calls for grepping, orientation, or
git/health checks, see if one of these already does it.** Run via
`bash scripts/agent/<script>.sh`. Run `/bash-tools` to refresh the live index.

| Script | Purpose | Usage |
|--------|---------|-------|
| `codebase-snapshot.sh` | Project tree, git log, file counts, Claude surface | `codebase-snapshot.sh` |
| `git-context.sh` | Status, diffs, branch info for commits/PRs | `git-context.sh [base-branch]` |
| `related-files.sh` | Grep for a term + match context, grouped by file | `related-files.sh <term> [dir]` |
| `health-check.sh` | Build tooling, lint, tests, git state, code/secret markers | `health-check.sh` |

Shared utilities (project-root detection, colors, exclude patterns,
`SOURCE_GLOBS`) live in `_common.sh`. `health-check.sh` runs `npm run lint` and
`npm test` when those scripts exist — which they now do.

## Claude Code Surface (`.claude/`)

- **agents/** — `project-coordinator` (Opus, decomposes), `task-executor`
  (Sonnet, implements), `scout` (Haiku, recon).
- **skills/** — `pre-commit-qa` (mandatory QA gate before commits),
  `bash-tools` (re-indexes `scripts/agent/`).
- **hooks/** — `pre-commit-gate.mjs`: a PreToolUse hook that blocks `git commit`
  until `pre-commit-qa` writes a fresh branch-scoped approval marker. This is
  Core Value #3 made literal — the gate catches you, you don't have to remember.

## Committing

**Solo repo — commit on `main` directly.** The harness default is to branch when
commits would land on the default branch; override that for SGC. There's no
review workflow that benefits from feature branches, and stray branches turn into
"compare & pull request" banners on GitHub. Single linear history on `main` is
the convention.

`git commit` is gated, and the gate is **developer-invoked only** — never run
`/pre-commit-qa` proactively, even when implementation is plainly finished. The
developer usually interposes a cross-model peer review (Codex) between
"implementation done" and "ready to land"; an early gate commits unreviewed
work and forces a second landing pass (QA ceremony, changelog amendments,
re-walked gates) once review findings come back. The loop:

1. implement → verify (tests / typecheck / lint — **no gate**) → present
2. developer reviews (often Codex; findings return as "critically interrogate")
3. interrogate → harden → verify again → present, leaving the tree dirty
4. developer runs `/pre-commit-qa` — that invocation IS the commit order
5. walk the gates with evidence; if all pass, commit **without further
   approval pauses** (the developer doesn't review commit structure; a
   reasonable logical split beats a perfect one)

The skill writes a marker that unlocks commits for 10 minutes. Use bare `git`
commands (no `cd` prefix) so the pre-approved `Bash(git:*)` permission matches.
