# Releasing SGC — runbook

The full sequence for cutting a release, written for the agent doing it next
time. Everything here was exercised for v1.6.0 (2026-09-01) except the mac CI
leg, which first fires on the next tag.

## Naming facts (get these wrong and nothing lines up)

- Tags are **`sgc_vX.Y.Z`** (annotated), not `vX.Y.Z`.
- The installer/DMG name comes from `build.artifactName` in `package.json`:
  `sgc-v${version}.${ext}` — so `package.json`'s `version` MUST be bumped
  before packing or tagging. The mac workflow hard-fails a tag that doesn't
  match `package.json` (guard step in `.github/workflows/release-mac.yml`).
- `release/` is **gitignored** — installers never land in git, only on the
  GitHub release.
- **Tripwire**: `bash scripts/agent/health-check.sh` has a Release Drift
  section comparing `package.json` to the latest reachable `sgc_v*` tag. A
  warning outside the minutes between steps 5 and 6 below means a release
  stalled half-cut — bumped but never tagged/published (how 1.3–1.5 went
  unnoticed).

## Sequence

1. **Bump**: `npm version X.Y.Z --no-git-tag-version` (updates
   `package.json` + lock; never let npm tag — tag naming is ours).
2. **Changelog**: entry in `docs/changelogs/YYYY-MM.md` noting the release
   (house convention: every landing gets an entry; a release is a landing).
3. **Verify**: `npm run typecheck && npm run lint && npm test` — green before
   anything packs.
4. **Pack Windows locally**: `npm run dist:win` → `release/sgc-vX.Y.Z.exe`.
   The wrapper force-rebuilds better-sqlite3 to the Electron ABI and restores
   the Node ABI in a finally — do NOT run vitest concurrently with a pack
   (ABI conflict). If vitest ever breaks after a pack: `npm run rebuild:node`
   (see AGENTS.md, better-sqlite3 entry).
5. **Gate**: the developer runs `/pre-commit-qa` (developer-invoked ONLY —
   see CLAUDE.md). Commit is `chore: release SGC vX.Y.Z` — package files +
   changelog, same shape every time.
6. **Tag + push**: `git tag -a sgc_vX.Y.Z -m "SGC vX.Y.Z"`, push `main`,
   push the tag.
7. **Create the release** (this is the human-notes step — CI never writes
   the body):
   `gh release create sgc_vX.Y.Z release/sgc-vX.Y.Z.exe --title "SGC vX.Y.Z" --notes-file <notes>.md`
   Notes format: headline paragraph stating what the release is and that the
   Phase 1.5 thesis holds (say so explicitly, including the current call-count
   posture), one `##` section per feature distilled from the changelog
   entries, a Verified section with the test numbers. See the v1.2.0 and
   v1.6.0 release bodies for the register.
8. **The DMG arrives on its own**: the tag push (step 6) already started
   `.github/workflows/release-mac.yml` on an arm64 mac runner (~5 min build).
   Its upload step POLLS for the release to exist (up to 10 min), so step 7
   landing a few minutes after the tag is fine — then `sgc-vX.Y.Z.dmg`
   attaches beside the `.exe`. It uploads only; it never creates a release.

## Mac leg — status and recovery

- The DMG is **unsigned and untested on real mac hardware** (rulings in
  `docs/05_mac-packaging-spec.yaml` — the developer has no Mac). README's
  Desktop (macOS) section carries the Gatekeeper caveat; keep it there.
- Mac job failed? The release is still whole (`.exe` + notes). Fix, then
  re-run the failed job from the Actions tab — the upload `--clobber`s.
- Tag/version mismatch failure = you skipped step 1. Bump, land it, delete
  and re-push the tag (or tag the next patch — cheaper than history surgery).
- Build-only smoke without touching any release: Actions → release-mac →
  Run workflow (`workflow_dispatch` — no tag, so the upload step skips).
- The mac icon is the PRE-generated `resources/icon.icns` (from
  `public/sal_logo_1024.png` via `npx png2icons <src> resources/icon -icns`).
  Don't switch `mac.icon` to a PNG: electron-builder 26.15.2+ icns generation
  drops the non-retina 16/32 entries (upstream issue #9940). Regenerate the
  icns only if the logo itself changes, and re-verify the entry table carries
  `is32`/`il32`.

## History note

v1.3.0–v1.5.0 were never tagged or published — local builds only (deliberate,
ruled 2026-09-01: not backfilled). The GitHub release list jumping v1.2.0 →
v1.6.0 is expected; the v1.6.0 release body carries the intermediate notes.
