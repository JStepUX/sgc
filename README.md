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
| **Constitutional Memories** | Curated, durable facts about the user, each with a 0–100 confidence score the model re-scores each turn | in-prompt |
| **Local Buffer** | The last 2 turns, verbatim | in-prompt |
| **Cosine Grep ("Grepory")** | TF-IDF + cosine similarity over older history — pure math, no model | 0 ms, 0 tokens |

These feed **Sal**, an ephemeral reasoning instance that exists for exactly one
turn and is then retired. Sal replies in natural language and emits updated
confidence scores. One API call per turn, total.

Sal can also reach the live web when a turn needs it: **web search** for recent
or external facts, and a deterministic, SSRF-guarded **URL pre-fetch** that
extracts a linked page's text (Readability) before the call so it's read in one
pass. This is web/*knowledge* retrieval — a separate axis from the memory tiers
above, which stay model-free — and it keeps the one-call-per-turn shape (the
search loop runs server-side inside that single call). The "one API call" count
is a guardrail, not the thesis; the thesis is Sal's per-turn ephemerality and
the curated-tier context. See `CLAUDE.md` → Mission Brief.

## Running it

```bash
npm install
cp .env.example .env          # then add your ANTHROPIC_API_KEY
npm run dev
```

`npm run dev` starts the Vite client (`:5555`) and the Express proxy (`:3000`)
together. Open `http://localhost:5555`. The API key lives only on the server —
the browser never touches `api.anthropic.com`.

| Command | Does |
|---------|------|
| `npm run dev` | Client + server, hot-reloading |
| `npm test` | Vitest — covers the TF-IDF engine |
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
