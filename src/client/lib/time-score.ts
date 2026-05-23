// ============================================================
// TIME-AWARE TURN SCORING
//
// A second deterministic dimension alongside the TF-IDF cosine grep (Grepory).
// Parses time intent out of the query with chrono-node — a deterministic JS
// date parser, no model, no network — then scores each candidate turn by
// distance from the intent anchor (or a soft default recency decay when the
// query carries no temporal phrase). The concept score and time score combine
// MULTIPLICATIVELY so a strong time match cannot resurrect a content-irrelevant
// turn: the "no concept match → no retrieval" cliff is preserved.
//
// Phase 1.5 invariant intact: no model in the memory retrieval path. chrono-node
// is pure JS arithmetic over the query string. The cosine engine (tfidf.ts)
// stays untouched and pure — this module is a sibling, not an extension.
// ============================================================

import * as chrono from 'chrono-node';
import type { ChatEntry } from './types';
import { cosineSearch } from './tfidf';

// ---- Tunable defaults (named so tuning happens at a single site) ----

/** Decay time constant (τ, the 1/e crossing — NOT a half-life) when the query
 * carries NO temporal intent. Softer — gentle "recent matters slightly more".
 * 14 days → a 2-week-old turn scores 1/e (~0.37). For a true half-life, scale
 * by ln(2): half-life ≈ 0.693 × τ. */
export const DEFAULT_DECAY_TAU_MS = 14 * 24 * 60 * 60 * 1000;

/** Decay time constant (τ, the 1/e crossing — NOT a half-life) when chrono
 * finds a temporal anchor in the query. Sharper — a turn 7 days off the anchor
 * scores 1/e. */
export const INTENT_DECAY_TAU_MS = 7 * 24 * 60 * 60 * 1000;

/** Reserved for future weighting. v1 stays at 1.0 — the combinator is plain
 * multiplication. Exported so a later tuning pass has a single knob. */
export const INTENT_WEIGHT_ALPHA = 1.0;

/** Final threshold applied to the COMBINED score in searchScored. */
const DEFAULT_FINAL_THRESHOLD = 0.08;

/** A strong concept score survives the final filter regardless of age. Without
 * this rescue, multiplying by the no-intent recency decay silently drops a
 * perfect 60-day-old topical match below DEFAULT_FINAL_THRESHOLD — the user
 * loses the ability to retrieve older content without attaching a time phrase.
 * Same numeric value as the combined threshold so "strong by either path" is
 * the consistent gate; ranking still happens on combined score. */
const CONCEPT_RESCUE_THRESHOLD = 0.08;

/** When orchestrating, ask cosineSearch for more candidates than we'll return
 * so the time scorer can promote turns that cosine alone ranked just under
 * the topK cut. Multiplier kept modest — too wide and ancient junk creeps in. */
const CANDIDATE_POOL_MULTIPLIER = 3;
const CANDIDATE_POOL_MIN = 9;

/** Lower concept-only threshold when pooling — final threshold gates the result. */
const CANDIDATE_CONCEPT_THRESHOLD = 0.02;

// ============================================================
// TYPES
// ============================================================

/** Result of parsing time intent out of a query string. */
export interface TimeIntent {
  /** Anchor instant the query points at (epoch ms). null = no intent detected. */
  anchor: number | null;
  /** The raw matched phrase ("yesterday", "last week"), for telemetry/inspector. */
  phrase: string | null;
}

/**
 * A grep hit with its combined score and the two components, ready for prompt
 * assembly + the inspector tile. Superset of the fields prompt.ts reads.
 */
export interface ScoredResult {
  turnIndex: number;
  userContent: string;
  assistContent: string;
  conceptScore: number;
  timeScore: number;
  combinedScore: number;
  /** Epoch ms — forwarded from the matched ChatEntry so prompt.ts can render
   * a relative-time prefix without a second lookup. */
  createdAt: number;
}

// ============================================================
// PARSE
// ============================================================

/**
 * Parse time intent from a query. Returns the first chrono match's resolved
 * instant (multi-intent queries take the first; documented as a v1 trade-off).
 *
 * `now` is injectable so tests pin the reference instant; production calls
 * default to the real wall clock. `forwardDate: false` keeps "Monday" reading
 * as the most recent past Monday — chats are about what was said, not planned.
 */
export function parseTimeIntent(query: string, now: Date = new Date()): TimeIntent {
  // chrono.parse returns ParsedResult[]; we take the first (earliest position).
  // Resolved Dates are in the runtime's local TZ — use .getTime() for arithmetic;
  // .toISOString() prints UTC and can look "off by N hours" when debugging.
  const results = chrono.parse(query, now, { forwardDate: false });
  if (results.length === 0) return { anchor: null, phrase: null };
  const first = results[0];
  // start.date() resolves the components into a concrete Date relative to `now`.
  const anchor = first.start?.date()?.getTime();
  if (anchor === undefined || Number.isNaN(anchor)) {
    return { anchor: null, phrase: first.text ?? null };
  }
  return { anchor, phrase: first.text ?? null };
}

// ============================================================
// SCORE
// ============================================================

/**
 * Score one candidate turn under a time intent (or the default decay when
 * intent is null). Always returns a number in (0, 1].
 *
 * - With intent: score = exp(-|now - turnCreatedAt| / INTENT_DECAY_TAU_MS_or_override)
 *   measured from the anchor, not from now. A turn AT the anchor scores 1.0.
 * - Without intent: score = exp(-|now - turnCreatedAt| / DEFAULT_DECAY_TAU_MS)
 *   measured from now. A turn AT now scores 1.0; older drops gently.
 */
export function timeScore(
  turnCreatedAt: number,
  intent: TimeIntent,
  now: number,
  opts?: { decayTauMs?: number; intentDecayTauMs?: number; alpha?: number },
): number {
  const tauDefault = opts?.decayTauMs ?? DEFAULT_DECAY_TAU_MS;
  const tauIntent = opts?.intentDecayTauMs ?? INTENT_DECAY_TAU_MS;
  const alpha = opts?.alpha ?? INTENT_WEIGHT_ALPHA;
  if (intent.anchor !== null) {
    const delta = Math.abs(intent.anchor - turnCreatedAt);
    return alpha * Math.exp(-delta / tauIntent);
  }
  const delta = Math.abs(now - turnCreatedAt);
  return Math.exp(-delta / tauDefault);
}

/**
 * Combine a concept score and a time score multiplicatively. Both inputs are
 * expected to be in [0, 1]; the result is too. Preserves the cosine engine's
 * "concept score 0 → no retrieval" cliff, which matters: a flag that says
 * "this turn was yesterday" should not let an unrelated topic surface.
 */
export function combineScores(concept: number, time: number): number {
  return concept * time;
}

// ============================================================
// ORCHESTRATOR
// ============================================================

/**
 * Run cosineSearch → time-score → combine → threshold → sort → topK.
 *
 * The single function call sites use (replaces direct cosineSearch
 * invocations). Two gates a turn can pass: (1) combined score ≥ threshold
 * lets a marginally-topical turn survive when it's highly relevant in time;
 * (2) concept score ≥ CONCEPT_RESCUE_THRESHOLD rescues a strong topical
 * match regardless of age, so the user can still retrieve old relevant
 * content without needing to attach a time phrase. Ranking is by combined
 * score either way — recent topical hits still rank above old ones.
 *
 * Pools wider than topK (CANDIDATE_POOL_MULTIPLIER) and uses a looser concept
 * threshold (CANDIDATE_CONCEPT_THRESHOLD) so the time scorer can promote
 * turns cosine alone would have ranked just under the cut — without that the
 * second dimension would be a re-ranker over an already-cosine-decided set.
 */
export function searchScored(
  query: string,
  chatLog: ChatEntry[],
  now: number,
  opts?: { excludeLastN?: number; topK?: number; threshold?: number },
): ScoredResult[] {
  const excludeLastN = opts?.excludeLastN ?? 4;
  const topK = opts?.topK ?? 3;
  const threshold = opts?.threshold ?? DEFAULT_FINAL_THRESHOLD;

  const poolK = Math.max(CANDIDATE_POOL_MIN, topK * CANDIDATE_POOL_MULTIPLIER);
  const candidates = cosineSearch(
    query,
    chatLog,
    excludeLastN,
    poolK,
    CANDIDATE_CONCEPT_THRESHOLD,
  );
  if (candidates.length === 0) return [];

  const intent = parseTimeIntent(query, new Date(now));

  // Each cosine candidate's `turnIndex` is 1-based (see cosineSearch); map back
  // to ChatEntry indices i = (turnIndex - 1) * 2 (user) / +1 (assistant) to
  // pull the createdAt. Both halves of a turn pair share createdAt (see
  // saveTurnPair in db.ts and the in-session append site), so either is fine —
  // user-half is the conventional choice.
  return candidates
    .map((c): ScoredResult => {
      const userIdx = (c.turnIndex - 1) * 2;
      const entry = chatLog[userIdx];
      const createdAt = entry?.createdAt ?? now; // fallback only on malformed input
      const t = timeScore(createdAt, intent, now);
      const combined = combineScores(c.score, t);
      return {
        turnIndex: c.turnIndex,
        userContent: c.userContent,
        assistContent: c.assistContent,
        conceptScore: c.score,
        timeScore: t,
        combinedScore: combined,
        createdAt,
      };
    })
    .filter((r) => r.combinedScore >= threshold || r.conceptScore >= CONCEPT_RESCUE_THRESHOLD)
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, topK);
}
