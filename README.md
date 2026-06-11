# SGC — Salience-Gated Cognition

A research prototype for a conversational memory architecture. SGC explores
*how a reasoning agent should remember*: not one big context window, but tiered,
salience-gated memory feeding a single ephemeral reasoning call.

> **Phase 1.5** — Ephemeral Sal + TF-IDF Cosine Grep + 2-turn local buffer.
> No model-based *memory* retrieval. One reasoning component. One API call per turn.

## The idea

Every turn, three memory tiers are assembled and handed to one short-lived
reasoning instance:

| Tier | What it is | Cost |
|------|-----------|------|
| **Constitutional Memories** | Curated, durable facts about the user — plain text the user edits; not model-scored | in-prompt |
| **Local Buffer** | The last 2 turns, verbatim | in-prompt |
| **Cosine Grep ("Grepory")** | TF-IDF + cosine similarity over older history — pure math, no model; individual turns can be gated out of retrieval in the chat memory editor | 0 ms, 0 tokens |

These feed **Sal**, an ephemeral reasoning instance that exists for exactly one
turn and is then retired. Sal replies in natural language and emits a per-turn
`<turn-summary>` (persistent / volatile / established_patterns) — a fresh
observation produced each turn (Sal carries no state of its own). The last couple
of turns' summaries are fed back as a small **distilled buffer** just behind the
verbatim local buffer, so a turn that scrolls out of full-text recency survives
as its summary rather than dropping straight to grep — bounded context, not
accumulated memory. One API call per turn, total.

Sal has no live web access of its own. The one way a page reaches a turn is a
deterministic, SSRF-guarded **URL pre-fetch**: when the person pastes a link,
the server extracts its text (Readability) *before* the call and folds it into
the prompt as a LINKED PAGE, read in one pass. No model, no search loop — the
web-knowledge analogue of the cosine grep. (Anthropic's server-side
`web_search`/`web_fetch` tools were tried and removed: they injected ~4–5k
tokens of scaffolding into every turn's input whether or not Sal browsed, which
wasn't worth it next to the free pre-fetch.) The "one API call" count is a
guardrail, not the thesis; the thesis is Sal's per-turn ephemerality and the
curated-tier context. See `CLAUDE.md` → Mission Brief.

Sal's persona — the head of the per-turn system prompt — is editable **per
chat**: "Begin again" opens a Confirm Persona step where you can rewrite it and
set an optional display-only name (a "mask") for the assistant's turns. It's
also editable **mid-chat** from the **System Prompt** button in the right rail,
which keeps a forward-only edit history (each save mints a new live version; old
versions stay frozen and can be reloaded into the editor). This lets several
personas be tested against the same architecture without editing source. It
changes only *what* the system prompt says, not how memory works: the mask is
cosmetic and never reaches the model, and editing a persona involves no model —
the memory tiers stay exactly as above.

## Running it

```bash
npm install
cp .env.example .env          # then add your ANTHROPIC_API_KEY
npm run dev
```

`npm run dev` starts the Vite client (`:5555`) and the Express proxy (`:3000`)
together. Open `http://localhost:5555`. The API key lives only on the server —
the browser never touches `api.anthropic.com`.

**Optional — run Sal on a local model.** Sal's single reasoning call can target
a local OpenAI-compatible server (KoboldCPP/Ollama) instead of Anthropic,
switchable at runtime from the header provider chip. It's opt-in: uncomment
`OPENAI_BASE_URL` in `.env` (see the LOCAL block in `.env.example`). The
deterministic memory tiers work identically; Anthropic-only web tools are dark
on the local path.

| Command | Does |
|---------|------|
| `npm run dev` | Client + server, hot-reloading |
| `npm test` | Vitest — TF-IDF engine, time scorer, retrieval eval probes |
| `npm run typecheck` | `tsc` on client and server |
| `npm run lint` | ESLint |
| `npm run build` | Production build into `dist/` |

## Repository layout

```
src/client/    React + TypeScript UI; lib/ holds the memory-architecture logic
src/server/    Express proxy — holds ANTHROPIC_API_KEY, one route
docs/          phase-1-5-reference.jsx (frozen original artifact) + changelogs
scripts/agent/ Bash utilities for codebase recon and checks
.claude/       Agents, skills, and the pre-commit QA gate
CLAUDE.md      Architecture + conventions for AI agents
AGENTS.md      Confusion pointers — gotchas worth knowing
```

## Working in this repo

`git commit` is gated by a pre-commit QA checklist (`.claude/skills/pre-commit-qa`).
Run `/pre-commit-qa` when work is ready to commit; it walks the checklist and
unlocks commits only if every item passes.
