// ============================================================
// SPONTANEITY ENGINE — detector + deck → a directive to inject (or nothing)
//
// Ties the slack detector (slackDetector.ts) to the operator deck (flexDeck.ts):
// when the recent conversation is circling, draw a weighted operator and hand its
// directive back for the prompt-assembly step to inject. Avoids firing the same
// operator twice in a row.
//
// This module owns the DECISION only. The caller (processInput) runs it, then
// passes `directive` into assembleTurnContext → buildPrompt, which renders the
// prompt block (that format lives in prompt.ts, not here). Keeping the draw in
// the caller — not in the pure assembler — is what lets a re-spin reproduce a
// turn by replaying the snapshotted directive instead of redrawing. See README.md.
//
// PURITY / TESTABILITY:
//  - The RNG is injectable (`rng`, default Math.random) so the weighted draw is
//    deterministic under test. The rest of the engine is already pure.
//  - "Last fired" is NOT a module singleton — it is threaded through `state` by
//    the caller and returned anew. A singleton would leak across chats (SGC is
//    rigorously per-chat) and across reloads. The caller owns persistence; the
//    engine stays a pure function of (chatLog, state, opts).
//  - The return is richer than a bare string ON PURPOSE: the eventual wire-in
//    needs to persist WHICH operator fired (so a response re-spin reproduces the
//    turn faithfully — see turn-context.ts) and to surface it in the inspector.
//    `.directive` preserves the string-or-null contract; the rest is for that
//    future without forcing a second pass to add it.
// ============================================================

import type { ChatEntry } from '../types';
import { FLEX_DECK, type Operator } from './flexDeck';
import { detectSlack, type SlackOptions, type SlackReading } from './slackDetector';

/** Cross-turn state the engine threads to avoid consecutive repeats. */
export interface SpontaneityState {
  /** id of the operator that fired last turn, or null if none has yet. */
  lastFiredId: string | null;
}

/** The zero state — nothing has fired yet. */
export const INITIAL_SPONTANEITY_STATE: SpontaneityState = { lastFiredId: null };

/**
 * The spontaneity fields a turn's persisted inspector blob carries. Declared
 * here, in ONE place, so the writer (the component's TurnData, which `extends`
 * this) and the no-repeat restore reader (lastFiredOperatorId, below) can never
 * drift on field names — a rename breaks both at compile time. (Core Value #3:
 * the binding is the check; you don't have to remember to update the reader.)
 */
export interface SpontaneityInspector {
  /** Did an operator fire this turn? */
  spontaneityFired: boolean;
  /** The operator id that fired, or null when dormant. */
  spontaneityOperatorId: string | null;
  /** The directive injected this turn, or null when dormant. */
  spontaneityDirective: string | null;
  /** The average pairwise "slack" similarity reading — recorded every turn. */
  spontaneitySimilarity: number;
}

/**
 * Restore the no-repeat cursor from a chat's persisted inspector blobs (passed
 * oldest → newest). Returns the most recently FIRED operator id by scanning
 * BACKWARD — deliberately not just the last blob, because runSpontaneity leaves
 * state unchanged on dormant turns: a dormant latest turn persists
 * `spontaneityOperatorId: null` while an earlier turn fired, and that earlier
 * operator is still the one the next fire must avoid. Tolerant of null entries
 * (user rows have no inspector), parse failures, and pre-feature blobs — all
 * skipped. Returns null when nothing ever fired.
 */
export function lastFiredOperatorId(inspectorJsons: readonly (string | null)[]): string | null {
  for (let i = inspectorJsons.length - 1; i >= 0; i--) {
    const json = inspectorJsons[i];
    if (!json) continue;
    try {
      const blob = JSON.parse(json) as Partial<SpontaneityInspector>;
      if (blob.spontaneityFired && blob.spontaneityOperatorId) return blob.spontaneityOperatorId;
    } catch {
      // unparseable or pre-feature — keep scanning further back.
    }
  }
  return null;
}

export interface SpontaneityResult {
  /** The injectable directive, or null when nothing fired. THE integration
   * contract: prompt assembly reads this field. */
  directive: string | null;
  /** Which operator fired (null when none) — for persistence, the inspector, and
   * faithful re-spin reproduction. */
  operator: Operator | null;
  /** The detector reading that drove the decision — surfaced for diagnostics. */
  reading: SlackReading;
  /** The new last-fired state. Persist + thread this back next turn. Unchanged
   * from the input when nothing fired. */
  state: SpontaneityState;
}

export interface SpontaneityOptions {
  /** Slack-detector tuning (window size, threshold). */
  detector?: SlackOptions;
  /** Operator catalogue. Defaults to FLEX_DECK; overridable for tests/tuning. */
  deck?: Operator[];
  /** Injectable RNG in [0, 1). Default Math.random — stub it for deterministic
   * tests. */
  rng?: () => number;
}

/**
 * Run one spontaneity decision against the current chat log and prior state.
 *
 * Fires nothing (directive null, state unchanged) when the detector says the
 * conversation isn't circling. Otherwise draws a weighted operator — excluding
 * the last-fired one — and returns its directive plus the advanced state.
 */
export function runSpontaneity(
  chatLog: ChatEntry[],
  state: SpontaneityState = INITIAL_SPONTANEITY_STATE,
  opts: SpontaneityOptions = {},
): SpontaneityResult {
  const { detector, deck = FLEX_DECK, rng = Math.random } = opts;

  const reading = detectSlack(chatLog, detector);
  if (!reading.shouldFire) {
    return { directive: null, operator: null, reading, state };
  }

  const operator = drawOperator(deck, state.lastFiredId, rng);
  if (!operator) {
    // Empty deck (or every operator weighted 0) — fire nothing rather than throw.
    return { directive: null, operator: null, reading, state };
  }

  return {
    directive: operator.directive,
    operator,
    reading,
    state: { lastFiredId: operator.id },
  };
}

/**
 * Weighted random draw from `deck`, excluding `excludeId` to avoid a consecutive
 * repeat. Operators with weight ≤ 0 are never drawn.
 *
 * If excluding the last-fired operator empties the pool (e.g. a single-operator
 * deck), it falls back to the full positively-weighted deck — a repeat is
 * unavoidable there and firing it beats firing nothing. With the real
 * multi-operator FLEX_DECK this fallback never triggers. Returns null only when
 * no operator has positive weight.
 */
export function drawOperator(
  deck: Operator[],
  excludeId: string | null,
  rng: () => number,
): Operator | null {
  const eligible = deck.filter((op) => op.weight > 0);
  const pool = eligible.filter((op) => op.id !== excludeId);
  const candidates = pool.length > 0 ? pool : eligible;
  if (candidates.length === 0) return null;

  const total = candidates.reduce((sum, op) => sum + op.weight, 0);
  if (total <= 0) return null;

  let r = rng() * total;
  for (const op of candidates) {
    r -= op.weight;
    if (r < 0) return op;
  }
  // Floating-point fallthrough guard (rng() ≈ 1) — return the last candidate.
  return candidates[candidates.length - 1];
}
