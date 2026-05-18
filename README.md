# SGC — Salience-Gated Cognition

A research prototype for a conversational memory architecture. SGC explores
*how a reasoning agent should remember*: not one big context window, but tiered,
salience-gated memory feeding a single ephemeral reasoning call.

> **Phase 1.5** — Ephemeral Synth + TF-IDF Cosine Grep + 2-turn local buffer.
> No model-based retrieval. One reasoning component. One API call per turn.

## The idea

Every turn, three memory tiers are assembled and handed to one short-lived
reasoning instance:

| Tier | What it is | Cost |
|------|-----------|------|
| **Constitutional Memories** | Curated, durable facts about the user, each with a 0–100 confidence score the model re-scores each turn | in-prompt |
| **Local Buffer** | The last 2 turns, verbatim | in-prompt |
| **Cosine Grep ("Grepory")** | TF-IDF + cosine similarity over older history — pure math, no model | 0 ms, 0 tokens |

These feed **Sal**, a "Synth" that exists for exactly one turn and is then
retired. Sal replies in natural language and emits updated confidence scores.
One API call per turn, total.

## Repository layout

```
sgc-phase-1-5.jsx     The Phase 1.5 implementation (and de facto spec)
CLAUDE.md             Architecture + conventions for AI agents
AGENTS.md             Confusion pointers — gotchas worth knowing
scripts/agent/        Bash utilities for codebase recon and checks
.claude/              Agents, skills, and the pre-commit QA gate
docs/changelogs/      Month-by-month change log
```

## Status

Early prototype. There is **no build tooling yet** — `sgc-phase-1-5.jsx` is a
standalone React artifact. Running it requires a host (Vite/CRA) or the Claude
artifact runtime. See `CLAUDE.md` for details and `AGENTS.md` for known sharp
edges.

## Working in this repo

`git commit` is gated by a pre-commit QA checklist (`.claude/skills/pre-commit-qa`).
Run `/pre-commit-qa` when work is ready to commit; it walks the checklist and
unlocks commits only if every item passes.
