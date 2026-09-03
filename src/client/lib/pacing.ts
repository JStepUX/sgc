// ============================================================
// PACING — how much of the scene one reply is allowed to cover.
//
// The reply's LENGTH is not a token problem and never was: max_tokens is a
// ceiling shared with the model's thinking (openai-provider.ts strips the
// <think> block out of the same budget), and a small local model treats any
// cap as a target — 512 tokens of flavour for a two-line beat, every turn.
// The decision "how much progress to make this turn" is a judgement call.
// Frontier models can make it from a sentence of guidance; the local models
// SGC actually runs cannot, and this module is what stands in for them.
//
// Mechanism, in three parts:
//
//   1. THE DRAW (here). Each reply gets a paragraph CEILING drawn from a
//      weighted deck — one to PACING_MAX_PARAGRAPHS, weighted toward two and
//      three, never the same twice running. Deliberately blind to the
//      person's input: a ceiling derived from how much they typed would read
//      as mirroring, and a flat ceiling is what 512 already was. The model is
//      told the ceiling (lib/prompt.ts) and may stop anywhere under it — the
//      draw bounds the turn, the model still paces within the bound.
//   2. THE CUT (server: src/server/paragraph-cap.ts). A model that ignores
//      the ceiling is stopped at the Nth paragraph break anyway — pure
//      counting, no punctuation heuristics, no model. Everything before the
//      break is a paragraph the model itself finished, so the cut never
//      leaves a half sentence.
//   3. THE FALLBACK (trimToLastParagraph, here). If the HARD cap fires
//      instead (the reply hit max_tokens before the Nth break), the client
//      trims back to the last complete paragraph — client-side because the
//      half paragraph is already on the wire and the delta stream can't
//      retract. No paragraph break at all → nothing trimmed, the truncation
//      stays visible and the inspector marks the turn capped: one paragraph
//      that outran the whole budget is a broken generation, not a pacing
//      problem, and tidying its tail would hide that.
//
// Same shape as the spontaneity engine (lib/spontaneity/engine.ts): injectable
// RNG, no module state — the "last ceiling" for the no-repeat rule is read by
// the caller from the latest turn's persisted inspector blob (TurnData), so
// nothing here leaks across chats or reloads. The ceiling is snapshotted onto
// TurnData so a re-spin replays it instead of redrawing.
//
// NOT a paragraph detector with opinions: a break is a blank line —
// PARAGRAPH_BREAK — and nothing else. The server carries an identical copy
// (it can't import client code); both are pinned by tests against the same
// fixtures so they cannot drift.
// ============================================================

/** The largest ceiling the deck can draw. */
export const PACING_MAX_PARAGRAPHS = 5;

/** One paragraph break: a newline, optional horizontal whitespace, newline.
 *  Mirrored verbatim in src/server/paragraph-cap.ts. */
export const PARAGRAPH_BREAK = /\n[ \t]*\n/g;

/** The weighted deck. Weights are relative: ≈15 / 30 / 30 / 15 / 9 percent. */
export const PACING_DECK: readonly { ceiling: number; weight: number }[] = [
  { ceiling: 1, weight: 1.0 },
  { ceiling: 2, weight: 2.0 },
  { ceiling: 3, weight: 2.0 },
  { ceiling: 4, weight: 1.0 },
  { ceiling: 5, weight: 0.6 },
];

/**
 * Draw this reply's paragraph ceiling, excluding `lastCeiling` so two
 * consecutive replies never share one (the flat-512 feel this replaces). The
 * RNG is injectable for deterministic tests. With the full deck the exclusion
 * can never empty the pool; if a trimmed deck ever does, the full deck is
 * used rather than drawing nothing.
 */
export function drawPacingCeiling(
  lastCeiling: number | null,
  rng: () => number = Math.random,
  deck: readonly { ceiling: number; weight: number }[] = PACING_DECK,
): number {
  const eligible = deck.filter((d) => d.weight > 0);
  const pool = eligible.filter((d) => d.ceiling !== lastCeiling);
  const candidates = pool.length > 0 ? pool : eligible;
  const total = candidates.reduce((sum, d) => sum + d.weight, 0);
  let r = rng() * total;
  for (const d of candidates) {
    r -= d.weight;
    if (r < 0) return d.ceiling;
  }
  return candidates[candidates.length - 1].ceiling;
}

/** How a paced reply ended, relative to its ceiling. */
export type PacingOutcome =
  /** The model stopped on its own, under the ceiling. */
  | 'natural'
  /** The server cut it at the Nth paragraph break (stopReason max_paragraphs). */
  | 'cut'
  /** The hard token cap fired first (stopReason max_tokens). */
  | 'capped';

/** Map a round's stopReason to the pacing outcome recorded on the turn. */
export function pacingOutcomeFor(stopReason: string): PacingOutcome {
  if (stopReason === 'max_paragraphs') return 'cut';
  if (stopReason === 'max_tokens') return 'capped';
  return 'natural';
}

/**
 * The pacing fields a turn's persisted inspector blob carries. Declared here,
 * in ONE place, so the writer (TurnData `extends` this) and the readers (the
 * no-repeat draw, the inspector card, the re-spin replay) can never drift on
 * field names. All optional: turns persisted before pacing existed lack them.
 */
export interface PacingInspector {
  /** The paragraph ceiling this reply was given, or null when none was
   *  (pre-feature rows; an un-paced call). */
  pacingCeiling?: number | null;
  /** How the reply ended relative to that ceiling. */
  pacingOutcome?: PacingOutcome | null;
  /** 'capped' only: the client trimmed the reply back to its last complete
   *  paragraph (false = no break to trim to; truncation left visible). */
  pacingTrimmed?: boolean;
}

/** The inspector's one-line reading of how a paced reply ended. */
export function pacingOutcomeLabel(td: PacingInspector): string {
  switch (td.pacingOutcome) {
    case 'cut':
      return 'cut at the ceiling';
    case 'capped':
      return td.pacingTrimmed
        ? 'hit the token cap — trimmed to the last full paragraph'
        : 'hit the token cap — no paragraph break to trim to';
    case 'natural':
      return 'stopped on its own';
    default:
      return 'no outcome recorded';
  }
}

/**
 * Content-bearing paragraphs in `text` — segments between blank lines that
 * hold any non-whitespace. Same rule as the server counter (an empty
 * paragraph never counts). The recall loop uses it to spend a ceiling ACROSS
 * rounds: paragraphs already committed from earlier rounds come off the
 * ceiling the next round is given, so a recall turn is bounded as one reply.
 */
export function countParagraphs(text: string): number {
  return text.split(new RegExp(PARAGRAPH_BREAK.source)).filter((seg) => /\S/.test(seg)).length;
}

/**
 * The hard-cap fallback: drop everything after the last paragraph break, so
 * the reply ends on a paragraph the model finished. Pure; returns the text
 * unchanged (trimmed: false) when there is no break, or when nothing but
 * whitespace follows the last one (nothing lost, nothing to report).
 *
 * A break only counts if REAL TEXT precedes it (Codex review, 2026-09-03):
 * a reply that opens with blank lines has a break at offset 0, and cutting
 * there would persist an empty turn. Same rule as the server counter.
 */
export function trimToLastParagraph(text: string): { text: string; trimmed: boolean } {
  let lastBreakAt = -1;
  const re = new RegExp(PARAGRAPH_BREAK.source, 'g');
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (/\S/.test(text.slice(0, m.index))) lastBreakAt = m.index;
  }
  if (lastBreakAt === -1) return { text, trimmed: false };
  const kept = text.slice(0, lastBreakAt).replace(/\s+$/, '');
  const dropped = text.slice(lastBreakAt);
  if (dropped.trim().length === 0) return { text, trimmed: false };
  return { text: kept, trimmed: true };
}
