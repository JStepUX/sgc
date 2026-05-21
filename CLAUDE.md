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
language, then emits a `<turn-meta>` block with updated confidence scores. In the
base loop that's **one API call per turn**, total — streamed to the browser as
Server-Sent Events; the TF-IDF retrieval costs 0 ms and 0 tokens. (That
single-call count is a *guardrail*, not the thesis — the thesis is Sal's
ephemerality + the curated-tier context. See Mission Brief.)

> **Naming:** the model's identity is **Sal** — used everywhere a user sees it
> (the persona prompt, the chat label). "Turn" is the codebase's neutral word
> for the mechanism — one user input → one model call → one response. ("Synth"
> was an early working title; it has been retired except inside the frozen
> `docs/phase-1-5-reference.jsx`.)

### Mission Brief — preserve the invariants

`docs/phase-1-5-reference.jsx` is both the original implementation *and* the
spec — its banner comments state the Phase 1.5 contract ("No model-based
retrieval. One reasoning component. One API call."). But be precise about what
those words are *protecting*. The real invariant is the **architecture, not a
count**:

- **Sal is ephemeral and never accumulates.** Every turn, a fresh reasoning
  instance is handed a context *rebuilt from the curated tiers* (memories +
  4-message buffer + cosine grep) and then retired. No growing transcript, no
  context rot, no model carrying its own state forward. That separation of
  chat-log from model — with the context reconstructed each turn rather than
  accreting — is the thesis.
- **No model in the memory/retrieval path.** Retrieval over the user's *own
  history* must stay deterministic math (the cosine grep), never a reasoning
  component. Phase 1 tried a model as the grepper ("Grepory") — slow, drifty;
  cosine replaced it. Re-introducing a model into *memory* retrieval (embeddings,
  a semantic-search model) is a **phase change, not a fix** — raise it first.

"One API call per turn" is a **guardrail, not the law.** It's a cheap, checkable
tripwire: historically the way you'd violate the real thesis (a model creeping
back into the retrieval path) showed up as an extra model call. So treat a *new*
model call as a smell worth investigating — not a forbidden act. Work that adds a
call *within a single turn* while keeping Sal ephemeral and leaving memory
retrieval deterministic — a tool loop, or external web/knowledge retrieval — does
**not** breach the thesis (cost and latency are still real and worth weighing).
The cosine grep is the thesis of Phase 1.5, not a placeholder; web/knowledge
retrieval is a separate axis from memory — see `AGENTS.md`.

### Project Structure

```
src/client/
  main.tsx                    React entry point — imports index.css
  index.css                   Tailwind v4 entry — design tokens (@theme), shadcn theme, aurora CSS
  SalienceGatedCognition.tsx  the UI — main app + MemoryPanel / TurnInspector / TokenChart
  components/ui/               shadcn/ui primitives (button, card)
  lib/
    types.ts                  shared domain types (ChatEntry, Memory)
    utils.ts                  cn() — Tailwind-aware class-name merge
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

- **Client:** React 19 + TypeScript, built with Vite 6. UI is **Tailwind v4**
  (the `@tailwindcss/vite` plugin; design tokens in an `@theme` block) +
  **shadcn/ui** primitives. Tokens, the shadcn theme, and the aurora CSS all
  live in `src/client/index.css`; `components.json` configures shadcn. The
  visual language is the "Sal" design system — a warm near-black field.
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

**Solo repo — commit on `main` directly.** The harness default is to branch
when commits would land on a project's default branch; for SGC, override that
and commit straight to `main`. There's no review workflow here that benefits
from feature branches, and the publish/sync IDE workflow turns every stray
branch into a "compare & pull request" banner on GitHub. Single linear
history on `main` is the convention.

`git commit` is gated. Run the `/pre-commit-qa` skill when work is ready; it
walks a checklist and, only if every item passes, writes the marker that
unlocks commits for the next 10 minutes. Use bare `git` commands (no `cd`
prefix) so the pre-approved `Bash(git:*)` permission matches.
