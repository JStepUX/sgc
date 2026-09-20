If you ever encounter something in the project that surprises you, please alert the developer working with you and note it in the `AGENTS.md` file to help prevent future agents from having the same issue.

## Project Brief

**SGC — Salience-Gated Cognition** is a research prototype for a conversational
memory architecture. It is not a product; it is an experiment about *how a
reasoning agent should remember*. It began as one question of James's — *"Can I
create an indefinite chat with an agent that resolves the worst excesses and
sins of long context windows: drift, sycophancy, prompt abandonment?"* — which
Sal answered to his satisfaction long ago. What is being built now is a small
narrative runtime, a roleplay engine he uses for fun, with no product launch or
publication behind it. Work in that register: novel, careful, enjoyable, and
honest about scope. The current iteration is **Phase 1.5**: a React +
TypeScript client (Vite, Tailwind v4 + shadcn/ui), an Express proxy that holds
the API key and — since reply pacing — makes the one editorial cut on the
server (ending a reply at its drawn paragraph ceiling), SQLite persistence, and
a Windows Electron shell.

Every turn, client-assembled context tiers — a per-chat **constitutional
document**, a 2-turn verbatim **local buffer** (a distilled summary buffer just
behind it), a deterministic lexical grep over older history — TF-IDF cosine × a squashed
BM25 veto, over the raw turns and the state turn's own summaries (**"Grepory"**
— pure math, no model; Sal can also re-query it mid-turn via the `recall` tool), and mounted **knowledge packs** — feed **Sal**, an ephemeral
reasoning instance built fresh for the turn and retired after it. A small
post-reply **state turn** distils the finished exchange into a turn summary +
Sal's bounded, user-editable Dynamic State. Base loop: 2 API calls/turn; the
retrieval costs 0 ms and 0 tokens. Beside the story, the rail's **Sidecar** tab
is a co-author chat that is deliberately NOT Sal: an ordinary in-memory
transcript (never persisted) that reads a snapshot of the session and writes
nothing back — see `lib/sidecar.ts` before "fixing" it into the turn pipeline.
("Sal" is the model's identity everywhere a
user sees it; "turn" is the codebase's neutral word for one user input → one
model call → one response.)

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
  act — a call added within a single turn while Sal stays ephemeral and memory
  retrieval stays deterministic does **not** breach the thesis. Two raises are
  sanctioned so far: **deliberate recall** (spec 01, approved 2026-06-09) —
  Sal re-queries the deterministic engine with a query it authors, worst case
  3 calls/turn, ranking still 100% `searchScored` — and the **state turn**
  (spec 03, approved 2026-08-02) — one small post-reply distillation call,
  base loop 2 calls/turn, worst case 4 with recall; it retrieves nothing.
  Since spec 07 (2026-09-07) that same call also returns **continuity sheet**
  deltas — a fixed-schema, accreting scene record merged by code — still no
  new call, still nothing retrieved.
  Since specs 08 and 09 (2026-09-13/14) the grep also INDEXES that call's
  output — each turn's summary lines plus a few retrieval cues — as a second
  corpus beside the raw turns. That is model-distilled text used as index
  material, recorded as a raise on the corpus side: ranking over it stays pure
  math, still no model in the retrieval path, still no new call.
  (Web/knowledge retrieval is a separate axis from memory — see the web-tools
  entry in `AGENTS.md`.)

### Where the detail lives

Detail lives in the path of alteration, not here:

- **`README.md`** — the public front page: pitch, turn loop, how to run it (web,
  desktop, local-model).
- **`docs/architecture.md`** — the full present-tense architecture narrative:
  tiers, grep, state turn, curation, invariants.
- **File header comments** — the per-file truth. There is no structure map to
  keep in sync; orient with `bash scripts/agent/codebase-snapshot.sh` and read
  the headers of the files you touch.
- **`AGENTS.md`** — confusion pointers: real gotchas, kept to their own audit
  rubric (push to source or build the check before writing an entry).
- **`docs/README.md`** — what lives in `docs/`, the YAML spec format, and the
  `docs/ignored/` gitignore trap.

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
| `health-check.sh` | Build tooling, lint, tests, git state, release drift, code/secret markers | `health-check.sh` |

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

**Cutting a release** (version bump → tag → GitHub release → CI DMG) has its
own runbook: `docs/releasing.md`. Follow it — the naming facts alone
(`sgc_vX.Y.Z` tags, artifact names bound to `package.json` version) are easy
to get wrong from memory.
