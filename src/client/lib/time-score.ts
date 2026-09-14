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
import { LOCAL_BUFFER_SIZE, SUMMARY_CONCEPT_THRESHOLD, SUMMARY_CORPUS_MIN_DOCS } from './constants';
import { conceptSearch, type ConceptEngine, type ConceptResult } from './bm25';
import { buildSummaryDocs } from './tfidf';

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
  /** The first chrono match the narrative filters (parseTimeIntent R1–R3)
   * saw and DROPPED — "April", "tonight", "4 years ago". Set whether or not a
   * later match survived, so tests and the replay lab can count what the
   * filters are catching. Not rendered anywhere yet (TurnData carries no
   * intent field). */
  rejected?: string;
}

/** Which corpus a retrieval hit came from (spec 08 S3): the raw turn text,
 * the turn's state-turn summary, or both. Drives what the prompt renders —
 * a 'summary' hit is a POINTER (the summary lines, never the raw text); a
 * 'both' hit is the raw pair with the summary lines beneath it. */
export type RetrievalSource = 'turn' | 'summary' | 'both';

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
  /** Manually-inserted memory (recency negated — timeScore forced to 1.0).
   * Forwarded so prompt.ts can tag it "timeless" instead of a relative time. */
  timeless: boolean;
  /** Provenance forwarded from the concept engine: the top terms behind this
   * match, for the prompt's `via "…"` prefix. Stemmed vocabulary. */
  matchedTerms: string[];
  /** The two engine components behind conceptScore (lib/bm25.ts) — always
   * both, whichever engine ranked, so the inspector can show what each said. */
  cosineScore: number;
  bm25Score: number;
  /** Corpus provenance (spec 08 S3). */
  source: RetrievalSource;
  /** The matched summary's lines — present on 'summary' and 'both' hits. */
  summaryLines?: string[];
}

// ============================================================
// PARSE
// ============================================================

/** Present-tense phrases chrono resolves to a day-certain anchor AT now.
 * Rejected (R3) because they carry no retrieval cue — and rejecting costs
 * nothing in ORDER: an anchor at now (τ 7 d) and the default decay from now
 * (τ 14 d) are both monotone in age, so "what did I say today" ranks the
 * same either way. Generic English, deliberately tiny: the R1 predicate
 * already drops the hour-only/nothing-certain forms ("this morning",
 * "evening", "night"); these four are the day-certain leftovers. */
const PRESENT_TENSE_PHRASES: ReadonlySet<string> = new Set(['now', 'right now', 'today', 'tonight']);

/**
 * Parse time intent from a query. Returns the first chrono match that
 * survives the narrative filters, resolved to an instant (multi-intent
 * queries take the first survivor; documented as a v1 trade-off).
 *
 * `now` is injectable so tests pin the reference instant; production calls
 * default to the real wall clock. `forwardDate: false` means "not forced
 * forward", NOT "past": bare "Monday" on a Sunday resolves to tomorrow, and
 * "May 1" asked in January resolves to the coming May. `span.oldest` is the
 * oldest eligible turn's createdAt (searchScored computes it); without it R2
 * is skipped.
 *
 * Why filters exist (spec 08 S2, 2026-09-13): chrono is eager on narrative
 * text. In a replay over a ~65-turn roleplay, 38 of 65 user turns carried an
 * "intent" — a character whose name is a month ("April" → the 1st of April),
 * a duration ("4 years ago" → −1461 d), present-tense scene words ("night",
 * "evening"). Each one anchored the time score years or months from every
 * candidate, driving combined ≈ 0 for all of them; results survived only via
 * the concept rescue and ranked by pool order. The filters accept a match
 * only when it can plausibly be a RETRIEVAL cue, on chrono's own certainty
 * flags (time-score.test.ts pins the real output — don't reason about them
 * from memory, run chrono):
 *
 *   R1 precision — keep iff day or weekday is certain, or year AND month are.
 *      Keeps yesterday / last Monday / 3 days ago / May 1 / a month ago;
 *      drops "April" ({month}), "4 years ago" ({year}), "this morning" ({}).
 *      Accepted loss: "in April" — a month-wide intent under a 7-day τ from
 *      the 1st was a poor anchor anyway.
 *   R3 present tense — drop the four phrases above.
 *   R2 span — roll a year-uncertain anchor that lands beyond now + τ back a
 *      year (chrono's implied year is the current one), then reject an anchor
 *      outside [oldest eligible turn − τ, now + τ]: an intent can only select
 *      among turns that exist.
 *
 * Inherent limit, accepted: no lexical rule separates narrative "yesterday"
 * or "we leave tomorrow" from a recall cue with the same words; those anchor
 * within a week of now, so they mis-steer by days, not years. The sanctioned
 * next step if that bites is a recall-context gate (fire only when the query
 * also carries a recall cue) — spec 08 `decisions.recall_context_gate`.
 */
export function parseTimeIntent(
  query: string,
  now: Date = new Date(),
  span?: { oldest: number },
): TimeIntent {
  // Resolved Dates are in the runtime's local TZ — use .getTime() for arithmetic;
  // .toISOString() prints UTC and can look "off by N hours" when debugging.
  const results = chrono.parse(query, now, { forwardDate: false });
  if (results.length === 0) return { anchor: null, phrase: null };

  const upper = now.getTime() + INTENT_DECAY_TAU_MS;
  let rejected: string | undefined;
  const drop = (text: string) => {
    if (rejected === undefined) rejected = text;
  };

  for (const r of results) {
    const start = r.start;
    const text = r.text ?? '';
    // R1 — precision: a bare month, a bare year, or nothing certain is a name,
    // a duration, or scene furniture, not a date someone is pointing at.
    const precise =
      start.isCertain('day') ||
      start.isCertain('weekday') ||
      (start.isCertain('year') && start.isCertain('month'));
    if (!precise) {
      drop(text);
      continue;
    }
    // R3 — present tense.
    if (PRESENT_TENSE_PHRASES.has(text.trim().toLowerCase())) {
      drop(text);
      continue;
    }
    let anchor = start.date().getTime();
    if (Number.isNaN(anchor)) {
      drop(text);
      continue;
    }
    // R2 — year roll-back, then the span. The roll-back applies with or
    // without a span: a year-uncertain anchor in the future is never what a
    // chat about the past means.
    if (!start.isCertain('year') && anchor > upper) {
      const d = new Date(anchor);
      d.setFullYear(d.getFullYear() - 1);
      anchor = d.getTime();
    }
    if (span && (anchor < span.oldest - INTENT_DECAY_TAU_MS || anchor > upper)) {
      drop(text);
      continue;
    }
    return rejected === undefined ? { anchor, phrase: text } : { anchor, phrase: text, rejected };
  }
  return { anchor: null, phrase: null, rejected };
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
 * Run conceptSearch → time-score → combine → threshold → sort → topK.
 *
 * The single function call sites use. Two gates are written: (1) combined
 * score ≥ threshold, (2) concept score ≥ the rescue threshold (a strong
 * topical match survives regardless of age, so old relevant content is
 * retrievable without a time phrase). Be honest about what they do under
 * production defaults: INTENT_WEIGHT_ALPHA is 1.0 and timeScore ≤ 1, so
 * combined ≤ concept, and with both thresholds at 0.08 gate (1) can never
 * pass where gate (2) fails — the filter reduces to concept ≥ 0.08 and time
 * RE-RANKS within the survivors (recent topical hits above old ones). A
 * candidate in the 0.02–0.08 pool band cannot be promoted by time alone;
 * that would need alpha > 1 or a final threshold below the rescue one.
 * (Observed 2026-09-13, spec 08 — pre-existing, documented rather than
 * changed.)
 *
 * Pools wider than topK (CANDIDATE_POOL_MULTIPLIER) at a looser concept
 * threshold (CANDIDATE_CONCEPT_THRESHOLD) so the band exists for a caller
 * that does set those knobs; under the defaults the pool is a re-rank set.
 */
export function searchScored(
  query: string,
  chatLog: ChatEntry[],
  now: number,
  opts?: { excludeLastN?: number; topK?: number; threshold?: number; engine?: ConceptEngine },
): ScoredResult[] {
  const excludeLastN = opts?.excludeLastN ?? LOCAL_BUFFER_SIZE;
  const topK = opts?.topK ?? 3;
  const threshold = opts?.threshold ?? DEFAULT_FINAL_THRESHOLD;

  const poolK = Math.max(CANDIDATE_POOL_MIN, topK * CANDIDATE_POOL_MULTIPLIER);
  const engine = opts?.engine;
  // `engine` defaults to 'cosine' inside conceptSearch (pure-function default);
  // production call sites pass CONCEPT_ENGINE from lib/constants.ts.
  const rawCandidates = conceptSearch(query, chatLog, {
    engine,
    excludeLastN,
    topK: poolK,
    threshold: CANDIDATE_CONCEPT_THRESHOLD,
  });

  // SUMMARY CORPUS (spec 08 S3): the state turn's per-turn summaries as a
  // second corpus with its own statistics — short docs, own IDF, so its
  // scores are NOT comparable with the raw corpus's and the fusion below
  // never compares them. Searched only once enough summaries exist: in a
  // handful of docs every term is rare and IDF says nothing.
  const summaryDocs = buildSummaryDocs(chatLog, excludeLastN);
  const summaryCandidates =
    summaryDocs.length >= SUMMARY_CORPUS_MIN_DOCS
      ? conceptSearch(query, chatLog, {
          engine,
          docs: summaryDocs,
          excludeLastN,
          topK: poolK,
          threshold: CANDIDATE_CONCEPT_THRESHOLD,
        })
      : [];
  if (rawCandidates.length === 0 && summaryCandidates.length === 0) return [];

  // The span for parseTimeIntent's R2: the oldest ELIGIBLE entry — outside
  // the excluded buffer, not gated off, not timeless (those carry synthetic
  // dates). Candidates exist, so at least one eligible entry does too; the
  // guard is for malformed input.
  let oldest = Infinity;
  for (const e of chatLog.slice(0, Math.max(0, chatLog.length - excludeLastN))) {
    if (e.active === false || e.timeless === true) continue;
    if (typeof e.createdAt === 'number' && e.createdAt < oldest) oldest = e.createdAt;
  }
  const intent = parseTimeIntent(query, new Date(now), Number.isFinite(oldest) ? { oldest } : undefined);

  // Each candidate's `turnIndex` is 1-based (see buildTurnDocs); map back to
  // ChatEntry indices i = (turnIndex - 1) * 2 (user) / +1 (assistant) to pull
  // the createdAt. Both halves of a turn pair share createdAt (see
  // saveTurnPair in db.ts and the in-session append site), so either is fine —
  // user-half is the conventional choice.
  const score = (c: ConceptResult, source: RetrievalSource): ScoredResult => {
    const userIdx = (c.turnIndex - 1) * 2;
    const entry = chatLog[userIdx];
    const createdAt = entry?.createdAt ?? now; // fallback only on malformed input
    // A timeless (manually-inserted) memory negates recency: its time score is
    // pinned to 1.0 regardless of age or any time intent in the query, so it
    // ranks on concept alone. The concept cliff still applies — concept 0 → no
    // retrieval — so a timeless flag can't surface an off-topic memory.
    const timeless = entry?.timeless === true;
    const t = timeless ? 1 : timeScore(createdAt, intent, now);
    const combined = combineScores(c.score, t);
    const r: ScoredResult = {
      turnIndex: c.turnIndex,
      userContent: c.userContent,
      assistContent: c.assistContent,
      conceptScore: c.score,
      timeScore: t,
      combinedScore: combined,
      createdAt,
      timeless,
      matchedTerms: c.matchedTerms,
      cosineScore: c.cosineScore,
      bm25Score: c.bm25Score,
      source,
    };
    if (c.summaryLines) r.summaryLines = c.summaryLines;
    return r;
  };
  const byCombined = (a: ScoredResult, b: ScoredResult) => b.combinedScore - a.combinedScore;

  // Rescue keys on the caller's threshold when one is given: the engines'
  // normalised scales differ (a BM25 hit sits far higher than a cosine one),
  // so a fixed 0.08 would rescue every BM25 candidate regardless of age.
  // Production passes 0.08 explicitly, so the default path is unchanged.
  const rescue = opts?.threshold ?? CONCEPT_RESCUE_THRESHOLD;
  const raw = rawCandidates
    .map((c) => score(c, 'turn'))
    .filter((r) => r.combinedScore >= threshold || r.conceptScore >= rescue)
    .sort(byCombined)
    .slice(0, topK);
  const summaryHits = summaryCandidates
    .map((c) => score(c, 'summary'))
    .filter((r) => r.combinedScore >= SUMMARY_CONCEPT_THRESHOLD || r.conceptScore >= SUMMARY_CONCEPT_THRESHOLD)
    .sort(byCombined);

  // FUSION — raw first, summary fills (spec 08 `decisions.fusion_policy`).
  // The raw hits keep their rank and body; a raw hit whose turn also matched
  // by summary becomes 'both' and carries the summary lines beneath it (the
  // meat is in the turn, the summary is the pointer). Summary-only hits fill
  // whatever slots remain, best first. A summary hit never displaces a raw
  // hit and never outranks one — no cross-corpus score comparison happens.
  const bySummary = new Map(summaryHits.map((h) => [h.turnIndex, h] as const));
  const fused: ScoredResult[] = raw.map((r) => {
    const h = bySummary.get(r.turnIndex);
    if (!h) return r;
    const both: ScoredResult = { ...r, source: 'both', summaryLines: h.summaryLines };
    return both;
  });
  const have = new Set(fused.map((r) => r.turnIndex));
  for (const h of summaryHits) {
    if (fused.length >= topK) break;
    if (have.has(h.turnIndex)) continue;
    fused.push(h);
    have.add(h.turnIndex);
  }
  return fused;
}
