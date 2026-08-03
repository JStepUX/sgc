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

1. **Constitutional Memories** — a single freeform per-chat document: 2–3
   paragraphs of durable prose about the user, edited in a modal textarea
   (`ConstitutionalEditorModal`, up to 20k chars) and rendered **verbatim**
   into the CONSTITUTIONAL MEMORIES prompt block — no chip list, no
   reformatting; **the model does not score or grade it** (the former 0–100
   per-turn confidence grading was retired — see the state-turn note below).
   It is **scoped per chat** — each conversation owns its own document, a new
   chat starts blank by default, and deleting a chat cascades its document
   away. "Begin again" offers an editable **carry-forward**: the outgoing
   chat's document, prefilled and toggled on by default when non-empty, so a
   new chat needn't start from a blank biography — an explicit copy made at
   chat birth, not shared state (a co-worker chat and a conversational partner
   legitimately need different "about me" text).
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
   On top of ambient retrieval sits **deliberate recall** (spec 01): Sal can
   pause mid-turn and re-query the SAME engine via a `recall` tool — a query it
   authors, or `around_turn` for a retrieved turn's N±1 neighbors — max 2 rounds
   per turn, Anthropic-only in v1, dedup-seeded so it widens context rather than
   duplicating it. The model proposes the query; the math disposes. The UI shows
   a quiet "Remembering…" line while a round-trip runs (diegetic naming — no
   grep jargon outside the inspector).

Alongside the memory tiers sits a separate **knowledge axis** — "plug-in
brains": JSON packs of document chunks compiled offline by the sibling
Atlantis repo (`C:/projects/Atlantis-SGC`, `python -m atlantis export`),
imported into SGC and mounted per chat. Each turn, the mounted packs' **union
TF-IDF index** (`lib/brains.ts` — same tokenizer/cosine primitives as
Grepory, one shared IDF per spec D3) is searched client-side and the top
chunks render as a PERSONA KNOWLEDGE prompt tier, behind an always-present
per-brain digest so Sal knows what it *could* be asked (D10). Knowledge is
**reference material about the world, not memory of the person**: packs are
read-only at runtime, carry no embeddings (lexical fields only — text,
summary, topics, and hand-editable `aliases`, the deterministic synonym
bridge), and never touch `searchScored` — an isolation regression pins the
memory grep byte-identical with and without mounts. Embedding retrieval for
brains is Phase 2b: a separate raise that must beat this lexical baseline on
the brain eval probes first.

These feed **Sal**, an ephemeral reasoning instance that exists for exactly one
turn, then is retired — it has no memory of prior turns. Sal's reply is **prose
only**: it carries no output format, no summary block. Once the reply has
streamed, a second small call — the **state turn** (`lib/dynamic-state.ts` +
`lib/state-turn.ts`) — reads that exchange back and returns two things:

- the **turn summary** — a fresh per-turn observation in three lists,
  `persistent` (true until explicitly changed), `volatile` (shifted this turn),
  `established_patterns` (behavioral rules demonstrated). Each summary is a
  fresh read of one turn and never consumes prior summaries, but the summaries
  of the **last couple of turns** are fed *back* into later prompts as a small
  **distilled summary buffer** sitting just behind the verbatim local buffer
  (offset, no overlap). So a turn that scrolls out of full-text recency
  survives as its summary instead of dropping straight to the cosine grep — a
  resolution falloff (raw recent → distilled near-past → grep), not a cliff.
- **Dynamic State** — Sal's bounded inner state (goal / feeling / association /
  passing thought / noticed / impulse), rendered into the NEXT prompt as a
  private, labeled-lines block just after the local buffer. Unlike the summary
  this is a **deliberate recurrence**: the state prompt consumes the previous
  state, so continuity accrues. Accepted 2026-08-02 with three bounds — schema
  caps, per-turn regeneration from live context (not an accreting document),
  and **user curation**: the rail's Dynamic State card shows it and edits it in
  place, so the drift surface is also a control surface.

Both persist inside the turn's `inspector_json` and rehydrate on load; the
state turn is fired after the reply is promoted and **never blocks** — a
failure leaves the turn summary-less and the previous state standing. This is
bounded curated context, **not accumulated model state**: Sal is still rebuilt
fresh every turn and retired. The UI renders the current turn's summary
flattened to one dimmed line beneath the reply (and both, structured, in the
inspector). In the base loop that's **two API calls per turn** — the reply
(streamed to the browser as Server-Sent Events) and the state turn; the TF-IDF
retrieval costs 0 ms and 0 tokens. (The call count is a guardrail, not the
thesis — see Mission Brief.)

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
  the thesis. Deliberate recall (spec 01) is the sanctioned tool-loop case:
  Sal may pause mid-turn to re-query the deterministic engine with a query it
  authors — worst case 3 calls/turn, ranking still 100% `searchScored`; raised
  and approved 2026-06-09. The **state turn** (spec 03) is the second sanctioned
  case: one small post-reply call that distils the finished exchange into the
  turn summary + Dynamic State — base loop 2 calls/turn, worst case 4 with
  recall. It retrieves nothing, so the memory path stays pure math; raised and
  approved 2026-08-02. (Web/knowledge retrieval is a separate axis from memory: server-
  side `web_search`/`web_fetch` tools were tried and then removed for cost — Sal
  now reaches the world only via the deterministic URL pre-fetch. See
  `AGENTS.md`.)

### Project Structure

```
src/
  architecture.test.ts        ANTI-GOD-OBJECT RATCHET — per-file line budgets over src/ +
                              electron/; a failure means "split the file", never "raise the budget"
src/client/
  main.tsx                    React entry point — imports index.css
  index.css                   Tailwind v4 entry — design tokens (@theme), shadcn theme, aurora CSS
  SalienceGatedCognition.tsx  COMPOSITION ROOT only (~270 lines) — wires the hooks into the
                              components + owns modal open/close flags; no domain logic
  hooks/                      per-axis state hooks — namespaces over ONE shared session,
                              not isolated stores (useChatSession exposes its setters)
    useChatSession.ts         persistence axis: hydration, chat create/load/delete, persona
                              versions, the in-memory logs; composes the two per-axis hooks
                              below and restores the outgoing chat if a create fails mid-swap
    useBrainMounts.ts         knowledge axis: the active chat's mounted packs + the ONE union
                              index (composed by useChatSession; adopt/clear/bind at load sites)
    useConstitutionalDoc.ts   memory tier 1's state: the per-chat document + user-edit dirty
                              flag + 250ms debounced save + swap-safety flush (composed by
                              useChatSession, same pattern as useBrainMounts)
    useStateCalls.ts          the shared per-chat "reflecting" registry — both state-turn
                              producers report into it; the rail reads the active chat only
    useTurnRunner.ts          the live turn: tier assembly → streamed model call → promote
                              reply → persist pair ‖ fire the state turn (joined, non-blocking)
    useResponseEditor.ts      edit/re-spin the latest reply (editTarget, respin, saveEdit —
                              which re-fires the state turn) + the Dynamic State editor's save
    useTurnUndo.ts            undo the latest turn: delete the pair (server-verified latest,
                              persist-first) + hand the user text back for the composer seed
    useProvider.ts            /api/health reconcile, provider token, config-modal state
    useAuroraPulse.ts         throttled aurora gate/typing/pulse signals
    useRailCollapse.ts        context-rail collapse, persisted to localStorage
  components/
    AuroraBackground.tsx      the warm field behind the glass (memoized; pulse re-key)
    PhaseBar.tsx              title, provider chip, run-mode metadata, begin-again
    ProviderChip.tsx          anchored popover to switch/configure the model backing Sal
    MemoryPanel.tsx           the IDENTITY section: read-only document preview + [ Human ]
                              (opens ConstitutionalEditorModal) and [ Agent ] (opens the prompt
                              editor) buttons, plus a compact MOUNTED BRAINS summary (right
                              rail) whose "Manage" button opens BrainManagerModal
    TurnInspector.tsx         per-turn diagnostics: trace, grep matches, spontaneity, savings,
                              and the DYNAMIC STATE card (state fields + [ Edit ] + summary)
    TokenChart.tsx            payload-size-per-turn SVG bars (right rail)
    AssistantMessage.tsx      Sal's reply — ReactMarkdown + summary line + spontaneity marker
    UserPill.tsx              the user's centred pill
    Composer.tsx              input row — owns its own keystroke-frequency state
    rail-styles.ts            shared rail section-header class strings
    ChatHistoryModal.tsx      history list + (editor mode) the rail
    ChatMemoryEditor.tsx      per-turn cosine-grep gating editor (4-col card grid)
    BrainManagerModal.tsx     knowledge-pack lifecycle: import/mount-toggle/delete-with-confirm,
                              opened from MemoryPanel's mounted-brains summary
    ConfirmPersonaModal.tsx   per-chat persona (system prompt) + optional mask + brain mount
                              picker (incl. pack import) + constitutional-memory carry-forward
                              (editable, default-on when non-empty), set at "Begin again" — a
                              separate flow from BrainManagerModal (binds before a chat id exists)
    ConstitutionalEditorModal.tsx  edit THIS chat's constitutional document: one freeform
                              textarea (up to 20k chars), no version history; opened from
                              MemoryPanel's [ Human ] button
    DynamicStateModal.tsx     edit the latest turn's inner state by hand (one field per schema
                              key, noticed = 3 inputs) — the curation half of the recurrence;
                              opened from the inspector's Dynamic State card
    PromptEditorModal.tsx     edit THIS chat's persona mid-chat, forward-only version history
    EditResponseModal.tsx     edit the latest assistant reply — manual rewrite or "re-spin"
                              (re-run the model with this turn's history; current memories/
                              persona; a fired spontaneity operator is dropped by default,
                              with a toggle to replay it verbatim)
    ProviderConfigModal.tsx   configure either provider from the chip (desktop saves via the
                              Electron bridge → server restart; web mode shows .env guidance)
    MermaidBlock.tsx          lazy-loaded mermaid code blocks → themed SVG; streaming-gated, code-block fallback
    ui/                       shadcn/ui primitives (button, card) + toggle-switch.tsx (the
                              shared ToggleSwitch, extracted from ChatMemoryEditor's turn gate)
  lib/
    types.ts                  shared domain types (ChatEntry, TurnSummary, DynamicState,
                              BrainPack)
    turn-data.ts              TurnData (the per-turn inspector blob) + the tolerant
                              inspector_json rehydration parsers (tested)
    provider.ts               provider types/labels/order shared by chip + hook
    utils.ts                  cn() — Tailwind-aware class-name merge
    stem.ts                   Porter-stemmer wrapper (npm `stemmer`, pinned) — the only file
                              that imports the package; tokenize() imports only from here
    tfidf.ts                  the TF-IDF cosine engine ("Grepory") — pure, deterministic;
                              tokenize() = lowercase → stopwords → Porter stemming
    tfidf.test.ts             Vitest behavioral tests for the engine
    brains.ts                 the knowledge axis: union index over mounted packs + digests +
                              searchBrains (composes tfidf.ts primitives; never touches the
                              memory grep — see the isolation regression in turn-context.test.ts)
    time-score.ts             time scorer + searchScored orchestrator (concept × time)
    turn-context.ts           assembleTurnContext() — deterministic per-turn tier assembly,
                              shared by the live turn and the response editor's re-spin
    recall.ts                 deliberate recall: RECALL_TOOL definition + executeRecall()
                              (query mode = same searchScored params as ambient; neighbors
                              mode = around_turn±1) — pure, honest-empty, never throws
    recall-loop.ts            runTurnWithRecall() — the per-turn tool loop (≤ 2 recall
                              rounds, final round sent tool-less; injected callTurn/
                              executeTool so it unit-tests without a server)
    dynamic-state.ts          the state turn's PURE half: buildStatePrompt, parseStateResponse
                              (tolerant, never throws), flattenStateForPrompt (labeled lines,
                              never JSON), newestDynamicState, STATE_CONTEXT_SIZE
    dynamic-state.test.ts     parser tolerance (fenced/prose-wrapped/truncated/junk), caps,
                              builder determinism + recurrence, flattener null-omission
    state-turn.ts             the state turn's IMPURE half: callStateTurn (plain call, no
                              tools — LOCAL-safe) + commitStateTurn (PATCH → stamp → rail),
                              split so the live turn can run it PARALLEL with saveTurn; also
                              saveDynamicState for the hand-edit path. Never blocks, never
                              retries, never surfaces
    prompt.ts                 system-prompt builder (memory tiers + PERSONA KNOWLEDGE + YOUR
                              INNER STATE + recall framing/absence marker; exports
                              formatGrepFragment, shared by the grep block and the recall tool)
    turn-parser.ts            <turn-summary> SCRUBBER (the contract left the main prompt —
                              this keeps legacy rows + habitual models from leaking a block)
                              + streaming strip; re-exported from prompt.ts. Also exports
                              coerceSummary/completeJson, reused by dynamic-state.ts
    api.ts                    runTurn() — POSTs to /api/turn (messages + optional tools;
                              mirrors the server's wire types — the builds don't share modules)
    desktop.ts                typed guard for window.sgcDesktop (Electron bridge; web → absent)
    eval/                     retrieval eval harness — planted-fact fixtures + probes
                              replayed through searchScored, ratcheted recall@3 / MRR;
                              brain-eval.test.ts runs the same ledger over searchBrains +
                              the committed Atlantis fixture pack (fixtures/brain-fixture.json)
    spontaneity/              SEPARATE AXIS, not memory: a deterministic slack detector
                              (TF-IDF reuse) + operator deck that injects a one-turn
                              creative directive when the conversation circles. Wired into
                              the prompt path; off-thesis by design — read its README.md
                              first (the why + the accepted refusal-operator trade-off)
src/server/
  index.ts                    Express server — holds the provider keys/URLs; /api/health,
                              chat/turn/constitutional persistence routes; serves dist/client
                              when built. Reads ALL config from env once at boot.
  turn-route.ts               POST /api/turn (SSE) — message|messages normalization, tools
                              passthrough (forwarded verbatim; the server never interprets
                              them), delta/tool_use/done/error frames
  wire-types.ts               ContentBlock/WireMessage/WireTool — the wire shape (mirrored
                              client-side in lib/api.ts; the two builds don't share modules)
  provider-types.ts           TurnChunk/TurnProvider/ProviderId — shared by both providers
  db.ts                       SQLite persistence (better-sqlite3) — chats (incl. the
                              constitutional document column) + turns + the chat_brains DDL,
                              schema + pure helpers; SGC_DB_PATH overrides the ./data default
  db-brains.ts                the (chat_id, brain_id) mount-binding helpers
  db-turn-edits.ts            rewrites of an existing assistant row: the editor's content
                              replace + the state turn's conditional inspector-only write
                              (`AND content = ?` — the atomic check that closes the
                              edit-vs-state-write race)
  brains-routes.ts            knowledge-pack routes — import/list/get/delete pack FILES in
                              <dirname(DB_PATH)>/brains (SGC_BRAINS_DIR overrides) + the
                              per-chat mount PUT; validates sgc-brain/1, never searches
  providers.ts                the anthropic provider (streams text; tool_use blocks read from
                              finalMessage()) + resolveTurnProvider; re-exports the LOCAL provider
  openai-provider.ts          the OpenAI-compatible "LOCAL" provider — ignores tools entirely
                              (recall is Anthropic-only, spec 01 D2); flattens messages to its
                              single-prompt shape; always reports stopReason 'end_turn'
electron/                     Windows desktop shell — supervises, never thinks
  main.ts                     window + IPC; packaged: fork server, load ITS origin; dev: load :5555
  serverManager.ts            fork (utilityProcess) + health poll + restart-on-config-change;
                              persists serverPort so the origin/localStorage survive relaunches
  config.ts                   sgc-config.json read/merge/atomic-write + env mapping (+ tests);
                              holds the seededBrains ledger (stock-brain tombstones)
  stock-brains.ts             pre-fork stock-brain seeding — copies bundled packs into the
                              brains dir iff ledger[id] != pack.version (electron-free, + tests)
  spellcheck.ts               the right-click suggestion menu Electron doesn't ship + en-GB
                              language pick + dictionary-download logging (electron-free, + tests)
  build-contract.test.ts      pins the .cjs emit flag on build:electron (ESM package — a .js
                              emit ships a packaged app dead at boot)
  preload.ts                  contextBridge → window.sgcDesktop (redacted state, whitelisted patches)
resources/stock-brains/       committed sgc-brain/1 packs shipped in the installer via
                              electron-builder extraResources (content rules in its README)
scripts/dist-win.mjs          electron-builder wrapper — restores the Node ABI in a finally
scripts/seed-dev-brains.mjs   `npm run seed:dev` — copies stock packs into ./data/brains
                              (dev never auto-seeds; ledgerless dumb copy)
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
  tiers are assembled in the browser — `hooks/useTurnRunner.ts` + `lib/`).
  `@anthropic-ai/sdk`, one route (`POST /api/turn`); model defaults to
  `claude-opus-4-7`, overridable via the `ANTHROPIC_MODEL` env var.
- **Tests:** Vitest. The TF-IDF engine (`lib/tfidf.ts`) is pure logic and the
  prime test target — see `lib/tfidf.test.ts`. Retrieval *quality* has its own
  instrument: `lib/eval/` replays planted-fact fixtures through `searchScored`
  and ratchets recall@3 / MRR; `known-gap` probes document the synonymy limits
  and fail loudly if a change closes one (promote them to `pass` when that
  happens). Turn-score changes must keep this suite green. Structure has one
  too: `src/architecture.test.ts` ratchets per-file line budgets (the
  anti-god-object gate) — a failure means split the file, never raise its budget.
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
  Before the fork, main seeds the bundled **stock brains**
  (`resources/stock-brains/*.json`, shipped beside the app via extraResources)
  into `<userData>/data/brains`, gated by the `seededBrains` ledger in
  sgc-config.json — copy iff `ledger[id] != pack.version`, so a user-deleted
  stock brain stays deleted and a version bump re-seeds on upgrade. Dev never
  auto-seeds; `npm run seed:dev` is the explicit equivalent.
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
