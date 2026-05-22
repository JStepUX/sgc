---
name: pre-commit-qa
description: >
  A mandatory quality gate that enforces verification, documentation, spec
  archival, and commit hygiene after any implementation work. Use this skill
  whenever code changes are complete and about to be committed — trigger on
  phrases like "I'm done", "ready to commit", "finished implementing", "task
  complete", "wrap up", "ship it", "PR ready", or any signal that implementation
  is finished and the work is moving toward version control. Also trigger when
  reviewing someone else's completed work before merge. This skill should fire
  even if the user doesn't explicitly ask for a quality check — if implementation
  just finished, this gate applies. Do NOT skip steps. Do NOT self-certify.
  Every item requires evidence.
---

# Pre-Commit Quality Assurance Gate

You just finished implementation work. Before anything gets committed, you must
walk through every item below and either demonstrate compliance or flag the gap.
No item is optional. No item is self-certifying — each requires you to show your
work (file paths, command output, diff snippets).

If you cannot satisfy an item, say so explicitly and explain why. Do not silently
skip items or claim compliance without evidence.

This gate enforces itself: the PreToolUse hook at `.claude/hooks/pre-commit-gate.mjs`
blocks every `git commit` until this skill writes its approval marker (final step).

---

## 1. Verification

The change must be shown to work — not assumed to.

**Rules:**
- **Pure logic** (the TF-IDF engine: `tokenize`, `buildTFVector`, `cosineSimilarity`,
  `computeIDF`, `applyIDF`, `cosineSearch`, and similar side-effect-free
  functions): if a test harness exists, add or update tests that would fail if
  the change were reverted. If no harness exists yet, verify by exercising the
  function directly (e.g. a throwaway `node -e` snippet with real inputs) and
  paste the output. Then flag that SGC still lacks a test harness — that gap is
  itself worth surfacing.
- **UI / behavioral changes**: covered by item 6 (Visual Verification).
- "It compiles" / "it renders" is not verification. Show the behavior.

**Evidence required:** State what you ran and what you observed. If the change
is documentation- or config-only, say so and mark this N/A.

---

## 2. Spec Archival (if applicable)

If this work was driven by a spec document in `docs/` (the `*-spec.yaml` files),
move it to `docs/ignored/` once the work is fully complete. This keeps the active spec
directory clean and preserves the spec as a historical artifact.

**Rules:**
- Only move the spec if the work it describes is fully complete — not partial.
- Use `git mv` so history is preserved (if the spec was tracked).
- If only partially complete, leave it in place and note which sections remain.

**Evidence required:** State the spec filename and confirm the move, or confirm
that no spec was driving this work.

---

## 3. Documentation Updates

Each document below must be *reviewed* for necessary updates. "Reviewed" means
you opened the file and checked whether your change requires an update — not
that you assumed it doesn't.

| Document | Path | Update when... |
|---|---|---|
| Changelog | `docs/changelogs/YYYY-MM.md` (current month) | Any user- or developer-facing change (always) |
| Agent Guide | `CLAUDE.md` | Project structure, architecture, or conventions changed |
| Confusion Pointers | `AGENTS.md` | You hit a surprise a future agent would also hit |
| README | `README.md` | Setup, how-to-run, or project description changed |
| Agent Scripts | `scripts/agent/` | Files moved/renamed, or what a script greps for changed |

**Rules:**
- The changelog should always get an entry. Make it specific enough that a
  developer reading it in six months understands what changed — no boilerplate.
- For agent utility scripts, "reviewed" means *executed* — run any script your
  change could affect and confirm it still produces plausible, non-empty output.
- For the others, if no update is needed, state why.

**Evidence required:** For each document, state whether it was updated or why
it was skipped.

---

## 4. Commit Hygiene

Work must be broken into logical, well-written, digestible commits. One giant
"implemented feature X" commit is not acceptable.

**Rules:**
- Each commit is one logical unit of change. If you'd struggle to write a clear,
  specific commit message, the commit is probably too broad.
- Refactors, new features, and documentation updates should generally be
  separate commits unless splitting them would make a commit non-functional.
- Commit messages reference the relevant spec or ticket when one exists.

**Git command hygiene:** use bare `git` commands (no `cd` prefix). The working
directory is already correct and `Bash(git:*)` is pre-approved in
`.claude/settings.json` — prefixing with `cd` breaks pattern matching and forces
unnecessary approval prompts.

**Evidence required:** List the planned commits with their messages before
executing them. The developer should approve the commit plan.

---

## 5. Git Tracking

Before committing, verify the actual state of the working tree. Do not rely on
memory of what you changed.

**Rules:**
- Run `git status` and `git diff --stat` (or `bash scripts/agent/git-context.sh`)
  to enumerate every modified, added, and deleted file. Compare against your
  mental model. Investigate anything unexpected before committing.
- Check for untracked files that *should* be staged (new source/test files) and
  files that should NOT be (`.env`, API keys, build artifacts, editor temp files,
  `.claude/settings.local.json`, `.claude/state/`).
- No partial changes left in mixed staged/unstaged state.
- Run `git log --oneline -3` to confirm you're building on the expected base.

**Evidence required:** Paste or summarize the `git status` output. Flag any
surprises.

---

## 6. Visual Verification (UI changes only)

SGC *is* a UI — the live React + TypeScript app under `src/client/`
(`SalienceGatedCognition.tsx` + `components/`; the frozen original artifact is
`docs/phase-1-5-reference.jsx`). If the work touched components, styles, layout,
or user flows, visual verification is required.
Automated checks catch logic; they do not catch layout shift, color rendering,
or interaction feel.

**Rules:**
- If a browser MCP is available (Playwright at `mcp__playwright__*`), render the
  component, drive the affected interaction, and capture a screenshot. Confirm
  the change visually — exercise the changed flow, not just "it renders."
- Note that a turn (`runTurn` in `lib/api.ts` → `POST /api/turn`) will not return
  a real response without the server running with a configured provider (see
  `AGENTS.md`). Verify layout, state transitions, and the TF-IDF diagnostics
  panel, which do not depend on a live API response.
- If no browser MCP is available, say so explicitly in the completion report and
  ask the user to eyeball it. Do not claim the UI works from code inspection.
- N/A only when the change touches zero user-visible surface (pure-logic or
  docs-only change).

**Evidence required:** Either (a) a screenshot + short description of what was
verified, or (b) an explicit disclosure that visual verification was skipped,
with the reason.

---

## Output Format

After walking through all six items, produce a summary table:

```
| # | Check                | Status      | Notes                          |
|---|----------------------|-------------|--------------------------------|
| 1 | Verification         | OK / FAIL   | [what was run/observed]        |
| 2 | Spec Archived        | OK / N/A    | [N/A = no spec]                |
| 3 | Docs Updated         | OK / FAIL   | [which docs touched]           |
| 4 | Commit Plan Approved | OK / FAIL   | [number of planned commits]    |
| 5 | Git Tracking         | OK / FAIL   | [unexpected files? clean tree?]|
| 6 | Visual Verification  | OK / N/A / WARN | [WARN = UI changed, not verified] |
```

If any item is FAIL, do not proceed to commit. Resolve the gap first.

---

## Final Step: Write the Approval Marker

If — and only if — every item above is OK (or a non-blocking N/A), write the
approval marker. This unlocks `git commit`: the PreToolUse hook at
`.claude/hooks/pre-commit-gate.mjs` blocks every commit until this marker exists,
matches the current branch, and is < 10 minutes old. The marker is **time-
bounded, not single-use** — one QA pass covers every commit in the planned batch
as long as they all land within the 10-minute window. Switch branches, let the
marker expire, or come back later and you'll need to re-run this skill — that's
by design.

Do NOT write this marker if any item is FAIL. Do NOT write it speculatively
before walking the list. The marker is the artifact of the QA pass, not a way
around it.

```bash
mkdir -p .claude/state
node -e "
  const { execSync } = require('node:child_process');
  const fs = require('node:fs');
  fs.writeFileSync('.claude/state/pre-commit-qa-passed.json', JSON.stringify({
    branch: execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim(),
    headSha: execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(),
    timestamp: new Date().toISOString(),
  }, null, 2));
"
```

After writing, proceed with the planned commits. If you cross the 10-minute
window mid-batch, the gate blocks the next commit with a "stale" message —
re-run /pre-commit-qa, then continue.
