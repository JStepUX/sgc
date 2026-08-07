# Spontaneity engine

A deterministic trigger + a curated operator deck that, when the recent
conversation is **circling**, hands a single short **directive** to the
prompt-assembly step for injection into Sal's context. The intent is *controlled
unpredictability* — nudging Sal off a rut without a model in the loop.

```
slackDetector.ts   "is the conversation circling?"   →  { shouldFire, similarity }
flexDeck.ts        the operator catalogue (data only)
engine.ts          detector + deck → { directive: string | null, ... }
```

## ⚠️ Read this first — why this is here and why it's surprising

The rest of SGC is an experiment in **deterministic, faithful, model-free
context assembly** ("no drift surface"; the default persona tells Sal to *"Reach
for the truer word… Be direct. Be precise."*). This module is a **different
research axis: deliberate, randomized behavioral perturbation.** It does not
contradict the two hard invariants — but it is genuinely surprising next to
everything the top-level `CLAUDE.md` documents, so it is flagged here, at the
point recon is most likely to find it.

**The hard invariants still hold:**

- **No model in the memory/retrieval path.** The slack detector is pure TF-IDF
  cosine arithmetic, reusing `../tfidf.ts`. No API call, no reasoning component.
- **Sal stays ephemeral.** Injecting a directive does not make the model carry
  state. The only cross-turn state is `lastFiredId`, deterministic harness state
  threaded by the caller (not a module singleton) — like the chat log itself.
- **Still one API call per turn.** The decision and the draw are local
  computation.

**The tension to keep your eyes open about:** some operators (`passive_refusal`
— "Sidestep the question"; `withheld_information`; `misread_intention`) cut
directly against the persona's "say plainly… don't guess." Firing these on an
ordinary task turn can degrade Sal's usefulness/trustworthiness. (The 2026-08-07
subtlety rewording softened *how hard* they cut, not *whether* they cut.)

> **Decision (reviewed, accepted):** these stay in the default deck at weight
> 1.0 *by deliberate choice*. This is a research prototype the author runs
> themselves; every fire is visible via the transparency surfaces (in-message
> marker + inspector), and the slack threshold gates how often anything fires.
> A cross-model review flagged this; the call was to keep it. If you're tempted
> to downweight, remove, or mode-gate these — that's a fresh product decision,
> not a bug fix. Raise it; don't silently "harden" it. (Off-ramps: see
> "Turning it off" below.)

## Status: WIRED IN (live)

`runSpontaneity` is called each live turn in
`hooks/useTurnRunner.ts::processInput`, **before** `assembleTurnContext`.
The flow and where each concern lives:

- **Decision + draw** happen in the caller (`processInput`), not in the pure
  assembler. The directive is then passed in via
  `TurnContextInput.spontaneityDirective` → `buildPrompt`'s last param, which
  renders the `⟐ SPONTANEITY OPERATOR ⟐ … ⟐ END OPERATOR ⟐` block (the block
  format lives ONLY in `../prompt.ts` now).
- **No-repeat state** lives in `spontaneityStateRef` (per-chat: reset in
  `startNewChat`, restored on load by scanning turns backward for the most recent
  *fired* operator — not the latest turn's, which may be dormant over an earlier
  fire). It is committed only after a reply is delivered, so a failed model call
  never records an operator it never produced.
- **Re-spin drops or replays, never redraws.** By default a re-spin runs
  WITHOUT the turn's fired operator (undoing the perturbation is the usual
  reason to re-spin) and, on save, clears the turn's fired fields + ⟐ marker so
  the record matches the regenerated text. Clearing follows *provenance*, not
  verbatim-ness: a hand edit on top of a clean re-spin still descends from
  unperturbed text, so it clears too. Clearing also re-pulls the no-repeat
  cursor from the DB (same scan load/undo use) — the cleared fire no longer
  counts as "last fired". The modal's replay toggle opts back into a faithful
  reproduction: the *snapshotted* `spontaneityDirective` (from the persisted
  `TurnData`) is re-injected to the byte. Neither path rolls a fresh operator.
  (Default flipped from always-replay, 2026-07-24.)

The three earlier wire-in cautions, now satisfied:

1. **Out of the naive baseline.** ✅ `estimateNaiveContextTokens` calls
   `buildPrompt` without the directive, so it never inflates the Context-Savings
   tile (guarded by a test in `../prompt.test.ts`).
2. **Persisted operator.** ✅ `TurnData.spontaneityOperatorId` /
   `spontaneityDirective` ride along in `inspector_json`; the re-spin reads them.
3. **Block format.** ✅ Single source in `../prompt.ts`.

### Transparency

Two recessive surfaces, mirroring the cosine-grep diagnostics:

- **In-message marker** — a dimmed `⟐ <Operator Name>` line beneath a perturbed
  reply (rehydrated on reload via `spontaneityFromInspector`).
- **Inspector card** — `TurnInspector` shows the **slack reading every turn**
  (`slack X / fire ≥ threshold — fired|dormant`), the calibration signal, plus
  the full injected directive on a fire.

Transparency shows the **input** (what was injected + why). Whether Sal *obeyed*
it is your read of the reply — auto-grading that would require a model in the
loop, which the thesis forbids.

### Turning it off

There's no UI toggle. To silence it without removing code, raise
`DEFAULT_SLACK_THRESHOLD` toward 1.0 (never fires) or remove the
`runSpontaneity` call in `processInput`.

## Calibration history

`DEFAULT_SLACK_THRESHOLD` started at 0.3 — reasoned, not measured, and flagged
provisional from day one.

Measured 2026-07-03, when Porter stemming landed in the shared tokenizer
(stemming-spec D4): replaying the 9 dev chats in `data/sgc.db` (290 detector
windows), mean window similarity rose 0.294 → 0.338 and firings at 0.3 went
135 → 200. The dev chats are repetitive by design, so the absolute rates are
inflated — but the threshold clearly sat in the fat of the distribution, where
the stemming lift flips many windows.

Retuned 2026-08-07, first dogfooding pass: real sessions confirmed the engine
fired too often *and* too loud — characters visibly derailed by ambient events,
weather always arriving as a house-shaking thunderstorm. Two paired changes:
the deck was reworded into a light-touch register (plus a global "color, don't
commandeer" clause in the `⟐` prompt block — see flexDeck.ts's REGISTER note),
and the threshold went 0.3 → 0.35, just above the measured dev-chat mean.
Wording was deliberately the bigger lever; the threshold raise is the "slightly
less often" half. Further retuning should be measured against post-stemming
similarity as real transcripts accumulate.
