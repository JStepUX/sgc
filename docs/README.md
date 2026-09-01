# docs/

- `phase-1-5-reference.jsx` — the frozen original single-file artifact; the
  Phase 1.5 contract the Mission Brief (`CLAUDE.md`) protects. Never edit it.
- `*-spec.yaml` — implementation specs (format below).
- `releasing.md` — the release runbook: bump → gate → pack → tag → GitHub
  release → CI mac DMG. Read it before cutting a release.
- `changelogs/` — month-by-month change log; the QA gate requires an entry for
  every landing.
- `ignored/` — **gitignored.** Anything moved here silently leaves version
  control; the pre-commit-qa skill's Git Tracking section exists because of
  this trap. Archive specs here only when you mean them to be untracked.

## Spec format — YAML, not prose

Specs are **machine-legible YAML for an executing agent, not reports for
stakeholders.** A spec exists to drive a code task: it carries the *facts* an
implementer acts on — file paths, line numbers, type/signature deltas, ordered
build steps, and the load-bearing constraints — not the argument for those
facts. Do **not** write narrative justification, "why this matters" prose,
history, or blog-post framing. Keep `goal` to a sentence; compress the
thesis/invariant check to a short key/value block (`invariant_check:`); make
everything else actionable. (Earlier `.md` specs were prose-heavy; that style
is retired.)
