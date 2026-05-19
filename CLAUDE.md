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
   user. Each carries a 0–100 confidence score. The user edits them in the UI;
   the model re-scores them every turn (max ±5 per turn, clamped 0–100).
2. **Local Buffer** — the last 2 turns (4 messages) passed verbatim. Immediate
   context, no retrieval.
3. **Cosine Grep ("Grepory")** — TF-IDF + cosine similarity search over *older*
   chat history (everything before the local buffer). **Pure math. No model. No
   API call. No drift surface.** This is the deliberate design choice of Phase
   1.5: retrieval must not be a reasoning component.

These feed **Sal**, an ephemeral reasoning instance that exists for exactly one
turn, then is retired — it has no memory of prior turns. Sal responds in natural
language, then emits a `<turn-meta>` block with updated confidence scores. **One
API call per turn**, total — streamed to the browser as Server-Sent Events. The
TF-IDF retrieval costs 0 ms and 0 tokens.

> **Naming:** the model's identity is **Sal** — used everywhere a user sees it
> (the persona prompt, the chat label). "Turn" is the codebase's neutral word
> for the mechanism — one user input → one model call → one response. ("Synth"
> was an early working title; it has been retired except inside the frozen
> `docs/phase-1-5-reference.jsx`.)

### Mission Brief — preserve the invariants

`docs/phase-1-5-reference.jsx` is both the original implementation *and* the
spec — its banner comments state the Phase 1.5 contract ("No model-based
retrieval. One reasoning component. One API call."). Preserve those invariants.
A change that adds a second API call, or makes retrieval model-based (embeddings,
a semantic-search model), is a **phase change, not a fix** — raise it with the
developer first. The cosine grep is the thesis of Phase 1.5, not a placeholder.

### Project Structure

```
src/client/
  main.tsx                    React entry point
  SalienceGatedCognition.tsx  the UI — main app + MemoryPanel / TurnInspector / TokenChart
  lib/
    types.ts                  shared domain types (ChatEntry, Memory)
    tfidf.ts                  the TF-IDF cosine engine ("Grepory") — pure, deterministic
    tfidf.test.ts             Vitest behavioral tests for the engine
    prompt.ts                 system-prompt builder + response parser
    api.ts                    runTurn() — POSTs to /api/turn
src/server/
  index.ts                    Express proxy — holds ANTHROPIC_API_KEY, one route
docs/
  phase-1-5-reference.jsx     frozen original single-file artifact
  changelogs/                 month-by-month change log
```

The reasoning split: **all three memory tiers are assembled in the browser**
(`SalienceGatedCognition.tsx` + `lib/`). The server (`src/server/index.ts`) is
deliberately dumb — it attaches the API key and forwards the request. No memory
logic lives server-side.

### Tech / Shape

- **Client:** React 19 + TypeScript, built with Vite 6. UI is hand-rolled
  inline styles + CSS custom properties — no component library, no Tailwind.
- **Server:** a thin Express proxy. `@anthropic-ai/sdk`, one route
  (`POST /api/turn`). Model defaults to `claude-opus-4-7`, overridable via the
  `ANTHROPIC_MODEL` env var.
- **Tests:** Vitest. The TF-IDF engine (`lib/tfidf.ts`) is pure logic and the
  prime test target — see `lib/tfidf.test.ts`.
- **Run it:** `npm install`, then `cp .env.example .env` and add an
  `ANTHROPIC_API_KEY`, then `npm run dev`. That runs the Vite client (`:5555`)
  and the Express proxy (`:3000`) together via `concurrently`; Vite proxies
  `/api` to the server. Open `http://localhost:5555`.
- **Key handling:** the API key lives *only* on the server. The browser calls
  `/api/turn` and never touches `api.anthropic.com`. See `AGENTS.md`.

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

`git commit` is gated. Run the `/pre-commit-qa` skill when work is ready; it
walks a checklist and, only if every item passes, writes the marker that
unlocks commits for the next 10 minutes. Use bare `git` commands (no `cd`
prefix) so the pre-approved `Bash(git:*)` permission matches.
