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
— "Do not answer the question"; `withheld_information`; `misread_intention`) cut
directly against the persona's "say plainly… don't guess." Firing these on an
ordinary task turn can degrade Sal's usefulness/trustworthiness.

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
`SalienceGatedCognition.tsx::processInput`, **before** `assembleTurnContext`.
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
- **Re-spin replays, never redraws.** `handleRespin` passes the turn's
  *snapshotted* `spontaneityDirective` (from its persisted `TurnData`) so a
  re-spin reproduces the original perturbation to the byte.

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

## Calibration caveat

`DEFAULT_SLACK_THRESHOLD` (0.3) is **provisional** — reasoned, not measured. Raw
TF cosine between turns runs low; the right firing line needs real transcripts.
Retune before trusting the default firing rate.
