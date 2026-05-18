If you ever encounter something in the project that surprises you, please alert the developer working with you and note it in the `AGENTS.md` file to help prevent future agents from having the same issue.

## Project Overview

**SGC — Salience-Gated Cognition** is a research prototype for a conversational
memory architecture. It is not a product; it is an experiment about *how a
reasoning agent should remember*.

The current artifact is **Phase 1.5**, a single React component in
`sgc-phase-1-5.jsx` (default export `SalienceGatedCognition`). One file, one
reasoning component, one API call per turn.

### The Architecture

Every turn, three memory tiers are assembled into a single prompt and handed to
one ephemeral reasoning instance:

1. **Constitutional Memories** — a small, curated set of durable facts about the
   user. Each carries a 0–100 confidence score. The user edits them in the UI;
   the model re-scores them every turn (max ±5 per turn, clamped 0–100).
2. **Local Buffer** — the last 2 turns (4 messages) passed verbatim. Immediate
   context, no retrieval.
3. **Cosine Grep ("Grepory")** — TF-IDF + cosine similarity search over *older*
   chat history (everything before the local buffer). **Pure math. No model. No
   API call. No drift surface.** This is the deliberate design choice of Phase
   1.5: retrieval must not be a reasoning component.

These feed **Sal**, an ephemeral "Synth" that exists for exactly one turn, then
is retired — it has no memory of prior turns. Sal responds in natural language,
then emits a fenced JSON block with updated confidence scores. **One API call
per turn**, total. The TF-IDF retrieval costs 0 ms and 0 tokens.

### Mission Brief

`sgc-phase-1-5.jsx` is both the implementation *and* the spec — its banner
comments state the Phase 1.5 contract ("No model-based retrieval. One reasoning
component. One API call."). Preserve those invariants. A change that adds a
second API call, or makes retrieval model-based, is a phase change, not a fix —
raise it with the developer first.

### Tech / Shape

- React (function component + hooks: `useState`, `useRef`, `useEffect`,
  `useCallback`).
- Browser `fetch` to `https://api.anthropic.com/v1/messages`; model id
  `claude-sonnet-4-20250514` is hardcoded in `callClaude` (~line 204).
- **No build tooling yet.** There is no `package.json`, bundler, or test
  harness. `sgc-phase-1-5.jsx` is a standalone reference artifact; running it
  requires a host (Vite/CRA) or the Claude artifact runtime. Standing up that
  tooling is a future-phase task — do not assume `npm`/`vite`/`vitest` work.

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
| `health-check.sh` | Build tooling, tests, git state, code/secret markers | `health-check.sh` |

Shared utilities (project-root detection, colors, exclude patterns,
`SOURCE_GLOBS`) live in `_common.sh`. The script set is intentionally small —
SGC is a single-file project; it will grow as the project does.

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
