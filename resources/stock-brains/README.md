# Stock brains

Committed `sgc-brain/1` knowledge packs that ship inside the Windows installer
(stock-brains spec — see `docs/stock-brains-spec.yaml` until it is archived).

- **What belongs here:** the pack **JSONs only** (D3). Each pack's Atlantis
  archive bundle (sources + chunks + provenance, from `export --archive`) stays
  with the developer OUTSIDE this repo.
- **Content rules (D4):** 3–5 fun, broadly shareable topics; public-domain or
  self-authored content only — never the internal BOPD KB. Prefer
  Gemma-enriched builds (richer aliases); keep each pack under ~500 KB.
- **How they ship (D1):** electron-builder `extraResources` copies `*.json`
  here → `<resourcesPath>/stock-brains/` beside the packaged app. On boot,
  the Electron main process seeds them into `<userData>/data/brains/` gated by
  the `seededBrains` ledger in `sgc-config.json` (D2) — so a user-deleted pack
  stays deleted, and bumping a pack's `version` re-seeds it on upgrade.
- **Dev (D5):** `npm run dev` never auto-seeds; run `npm run seed:dev` to copy
  the packs into `./data/brains/`.

This README is not packaged (the `extraResources` filter is `*.json`) and the
seeder ignores non-JSON files.
