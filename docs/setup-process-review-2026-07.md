# Setup & Process Review — 2026-07-02

Findings from a four-agent sweep: the `.claude/` surface, all 26 session
transcripts (~24 MB, 2026-06-01 → 2026-07-02), full git history + docs
conventions, and a codebase health scan. This is a findings report, not a spec —
items picked up for implementation should get their own YAML spec per the
docs/ convention.

## Ranked: highest-leverage setup & process improvements

### 1. Restore the deleted AGENTS.md knowledge; guard against recurrence
Commit `2b368d6` ("Wrap \"quotes\" in orange.", 2026-05-22) silently deleted
**8 of 10 AGENTS.md entries (138 lines)** — unmentioned in the commit message,
never restored. Recover with `git show 2b368d6~1:AGENTS.md`. Durable entries to
re-add: API-key-is-server-only; "Sal is the identity / turn is the mechanism";
web fonts via `<link>` not `@import`; `npm run dev` is two processes + needs
`.env`; "no model-based retrieval" means MEMORY retrieval; local-provider
thesis-compatibility. Skip: "memories are global" (reversed by design
2026-06-01) and any entry re-documented since.
**Guard:** add a pre-commit-qa gate item — if the staged diff deletes lines from
`AGENTS.md`/`CLAUDE.md`, require explicit confirmation in the QA walk. This is
Core Value #3: the failure mode was a scope-narrow message hiding a broad diff.

### 2. Close the PowerShell bypass on the commit gate
`.claude/settings.json` hook matcher is `"Bash"` only — a `git commit` issued
through the PowerShell tool never reaches `pre-commit-gate.mjs`. On Windows,
PowerShell is the default shell tool. Fix: matcher `"Bash|PowerShell"` (the gate
script already filters on the command string, so it handles both). Also: the
`"if": "Bash(git commit*)"` field is not part of the documented hooks schema —
harmless (the script self-filters) but should be removed or verified.
Transcript evidence says the gate has had **0 observed blocks** and the
developer-invoked-only rule stuck after 2026-06-09 — the gate works; this just
closes the one hole cheaply.

### 3. De-stale the agent definitions and bash scripts (Phase 1.0 ghosts)
Two of three agent defs and two scripts still describe the retired single-file
prototype. A fresh agent reading them gets wrong priors every session:
- `.claude/agents/scout.md:63-65` — "single-file React prototype (`sgc-phase-1-5.jsx`)"
- `.claude/agents/task-executor.md:35-37,62-65` — "no build tooling yet"; references a
  nonexistent `callClaude` and wrong key-handling doc location
- `scripts/agent/health-check.sh:5-6,47-48` — "no lint/test/build pipeline to run"
  (it now runs lint + tests; the *comments* lie)
- `scripts/agent/codebase-snapshot.sh:41,45` — same, plus a Key Files check for
  the old jsx filename

### 4. New bash helpers targeting the real transcript friction
Friction leaderboard from 26 sessions (41 total tool errors — low, but clustered):
- **`scripts/agent/dev-restart.sh`** — kill listeners on 3000/5555, optionally
  relaunch `npm run dev`, curl health. Five sessions hand-rolled this
  (14 kill/inspect commands); already covered by the `Bash(bash scripts/agent/*)`
  allowlist, so zero new prompts.
- **ABI doctor in `health-check.sh`** — `node -e "require('better-sqlite3')"`;
  on failure print `npm run rebuild:node`. Three sessions rediscovered this fix.
- **Disk canary in `health-check.sh`** — timed read of `data/sgc.db` + small
  fsync write; warn when slow/erroring. D:-drive failures consumed one full
  session (Jun 10) and derailed another (Jun 29). Also consider `SGC_DB_PATH`
  on C: as a supported mitigation.
- **Commit-message rule** (AGENTS.md line or tiny helper): multi-line commits in
  Bash use a heredoc (`git commit -F- <<'EOF'`), never PowerShell `@'...'@`
  here-strings — two mangled-commit incidents, same confusion both times.

### 5. Codify the Codex review loop as a skill
"critically interrogate" appears **29 times across 5 sessions** — it is the
project's core review ritual and is re-improvised each time. A
`/interrogate` skill taking pasted findings with a fixed structure —
restate finding → verify against code with file:line evidence → verdict
(confirmed / refuted / partial) → fix if confirmed → summary table — makes the
most-repeated human loop deterministic.

### 6. Playwright verification discipline
Biggest single error source: stale element refs after page mutations, timeouts,
and 7× "screenshot file does not exist" (agents guess the wrong path in
`.playwright-mcp/`). Two AGENTS.md lines fix most of it: (a) always pass an
explicit `filename` to `browser_take_screenshot` and Read that exact path;
(b) re-snapshot before any post-mutation click.

### 7. Permissions hygiene
- `.claude/settings.local.json`: `Read(//d//**)` grants the **entire D: drive** —
  narrow to the project; remove the dead `Read(//d/Bolt-On/Miles-Chat/**)`.
- 77 PowerShell calls vs 333 Bash in transcripts, and only Bash patterns are
  allowlisted — read-only PowerShell (`Get-*`) prompts every time. Allowlist
  `PowerShell(Get-*)` or run `/fewer-permission-prompts`.
- Global `~/.claude/CLAUDE.md` is empty and there is no user-level allowlist —
  cross-project constants (git/npm allows, Bash-over-PowerShell preference,
  commit-message heredoc rule) could live once at user level.

### 8. Spec lifecycle: one decision + one triage
- `docs/ignored/` is gitignored ("kept locally, out of version control") but
  `electron-release-spec.yaml` stayed tracked through its rename while its five
  siblings are local-only — **a fresh clone gets 1 of 6 archived specs**.
  Decide: track `docs/ignored/` (history preserved; back up the 5 orphans) or
  `git rm --cached` the one. The current split is the worst of both.
- `docs/deliberate-recall-spec.yaml` (proposed 2026-06-09, never implemented):
  five feature commits have since moved its cited line anchors. Archive it or
  refresh `current_state` before anyone executes against it.

### 9. Small mechanical hygiene
- Changelog rule slipped twice recently: `519d7cd` (darkmode CSS) and `9da99d0`
  (Volta) have no changelog entries. ~21% of history is non-conventional
  messages; recent examples show the convention hasn't fully stuck.
- Tag `sgc_v1.0.1` was never pushed to origin (`git push origin --tags`).
- Volta pin exists but no `engines.node` — non-Volta users/CI get no signal.
- Optional: `git gc` (1522 loose objects; 9.7 MiB — not urgent).

## Codebase robustness findings (record, fix when touched)

Overall hygiene is excellent: zero TODO/FIXME, zero `any`, zero silent catches,
pure-logic core fully tested. Remaining risks:

1. **Truncated SSE stream reads as success** — `api.ts:180-206`: stream ending
   without the `done` frame returns partial text with 0 tokens and no error.
   Track "saw done" and throw.
2. **`src/server/index.ts` has zero tests** — the SSRF guards
   (`isPrivateIp`/`assertPublicHost`/`safeFetch`/`readCapped`, index.ts:265-441)
   are security-critical and unit-testable in isolation.
3. **Stale default model** — `index.ts:49` falls back to `claude-opus-4-7` when
   `ANTHROPIC_MODEL` is unset; consider failing loudly or updating.
4. **`serverManager.ts:63`** — the primary launch path's `kill()` ignores the
   `force` flag, so the graceful→forced escalation sends the identical call
   twice; a wedged utility process never gets a harder kill.
5. **No `PRAGMA user_version` in db.ts** — migrations are ad-hoc introspection
   probes with one deliberate destructive DROP; fine for a prototype, add a
   version counter before non-additive changes.
6. ~~**`SalienceGatedCognition.tsx` is 2,244 lines**~~ — **RESOLVED 2026-07-03**
   (the client split): the root is now a ~270-line composition root over
   `hooks/` (six per-axis hooks; `processInput` lives in `useTurnRunner.ts`)
   and `components/` (nine extracted files), and `src/architecture.test.ts`
   ratchets per-file line budgets so nothing regrows. Kept here as pre-split
   historical context only.

## Product ideas (ranked, thesis-compatible)

All deterministic, no model in the memory path:

1. **Retrieval score transparency** — `ScoredResult` already computes
   `conceptScore`/`timeScore`/`timeless` but `processInput` discards all but
   `combinedScore` (hooks/useTurnRunner.ts:152-160 post-split). Surface the
   split in the inspector (components/TurnInspector.tsx). *Small; data already
   exists.*
2. **Porter stemmer in the tokenizer** — `tokenize` (tfidf.ts:48-55) has no
   stemming, so "needle"≠"needles"; pure arithmetic, could promote documented
   known-gap eval probes to pass. *Medium.*
3. **Dry-run query box in ChatMemoryEditor** — `searchScored` is pure and
   client-side; show what a query *would* retrieve after gating. Makes curation
   tangible. *Small.*
4. **Savings + spontaneity trends in TokenChart** — `naiveTokens` is persisted
   every turn but never plotted; add sent-vs-naive savings line and a
   spontaneity firing sparkline. *Small.*
5. **Corpus export/import** — "download this chat's baton" (turns + memories +
   persona versions as JSON) and re-import. *Medium.*
6. **Tuning-knob panel** — decay taus, buffer sizes, slack threshold are all
   deliberately centralized single knobs; expose them without recompiling.
   *Small–medium.*
7. **Calibration harness for the constants** — the eval covers outcomes, not
   parameter choice; a fixture-driven sweep over taus/threshold turns
   "reasoned, not measured" into measured. *Medium.*
8. **Opt-in cross-chat retrieval** — still TF-IDF, grep across all chats;
   thesis-compatible. *Medium/large.*

## Explicitly healthy — don't spend effort here

- The pre-commit gate: 0 blocks in 26 sessions; the Jun-9 process fix stuck.
- Context management: 0 compactions in 26 sessions.
- Permission denials: 4 total, all healthy plan-mode redirects.
- Tracked-file hygiene: no binaries/DBs/secrets tracked; `.gitattributes` solid.
- Subagent usage is appropriately reserved for design/recon sessions.
  (`project-coordinator` has never been invoked — keep or cut, nothing broken.)
