// ============================================================
// SLACK DETECTOR — "is the conversation circling?"
//
// A deterministic trigger for the spontaneity engine. It reuses the SAME TF-IDF
// primitives as the cosine grep (tfidf.ts) to measure how lexically alike the
// last N turns are to each other: the average pairwise cosine similarity across
// the recent window. High average similarity ⇒ the conversation is treading the
// same ground ("slack") ⇒ a spontaneity operator may fire to inject novelty.
//
// Pure math. No model, no API call, no drift surface — same contract as Grepory.
// This is the part of the spontaneity subsystem that is fully in keeping with the
// SGC thesis: the *decision to perturb* is deterministic arithmetic; only the
// injected directive (engine.ts) introduces controlled unpredictability.
//
// Design notes:
//  - Similarity is measured on RAW term-frequency vectors (buildTFVector), NOT
//    IDF-weighted. IDF computed over a 3-document window is degenerate (every
//    term's df is 1–3), so it would add noise, not signal. We want the honest
//    "how much vocabulary do these turns share" measure, which is plain TF
//    cosine with the shared tokenizer and stop-word list.
//  - A "turn" is a user+assistant pair, grouped exactly as cosineSearch groups
//    them (by index, stepping 2), so the unit matches the rest of the pipeline.
//  - The recency window is NOT gated by ChatEntry.active. Per-turn gating curates
//    the cosine-grep CORPUS (older history); this detector measures the RECENT
//    conversation as-spoken, overlapping the verbatim local buffer — which itself
//    ignores gating (see types.ts ChatEntry.active). Consistent treatment.
// ============================================================

import type { ChatEntry } from '../types';
import { tokenize, buildTFVector, cosineSimilarity } from '../tfidf';

/** How many recent turn-pairs to compare by default. */
export const DEFAULT_SLACK_WINDOW = 3;

/**
 * Default firing threshold on the average pairwise cosine similarity.
 *
 * PROVISIONAL — pending calibration against real conversation logs. Raw TF
 * cosine between varied turns runs low; between turns that recycle vocabulary it
 * climbs. 0.3 is a conservative "notably alike" line picked by reasoning, not
 * data — expect to retune once there are real transcripts to measure against
 * ("let friction drive the architecture, not speculation"). Callers can override.
 */
export const DEFAULT_SLACK_THRESHOLD = 0.3;

export interface SlackOptions {
  /** Number of most-recent turn-pairs to compare. Default DEFAULT_SLACK_WINDOW. */
  windowTurns?: number;
  /** Fire when average pairwise similarity ≥ this. Default DEFAULT_SLACK_THRESHOLD. */
  threshold?: number;
}

export interface SlackReading {
  /** True when avgPairwiseSimilarity ≥ threshold. */
  shouldFire: boolean;
  /** Average pairwise cosine similarity across the comparable recent turns.
   * 0 when fewer than two comparable (non-empty) turns exist. */
  similarity: number;
}

/**
 * Measure conversational slack over the last N turns of `chatLog`.
 *
 * Groups the log into user+assistant turn-pairs, takes the last `windowTurns`,
 * tokenizes each, drops content-free turns, and averages the cosine similarity
 * over every distinct pair. Returns `shouldFire` against the threshold.
 *
 * Needs at least two comparable turns to produce a non-zero reading; otherwise
 * it reports `{ shouldFire: false, similarity: 0 }`.
 */
export function detectSlack(chatLog: ChatEntry[], opts?: SlackOptions): SlackReading {
  const windowTurns = opts?.windowTurns ?? DEFAULT_SLACK_WINDOW;
  const threshold = opts?.threshold ?? DEFAULT_SLACK_THRESHOLD;

  // Group into turn-pairs by position (mirrors cosineSearch's i / i+1 pairing).
  // A dangling trailing user message (turn in progress) pairs with ''.
  const turnTexts: string[] = [];
  for (let i = 0; i < chatLog.length; i += 2) {
    const user = chatLog[i]?.content ?? '';
    const assistant = chatLog[i + 1]?.content ?? '';
    turnTexts.push(`${user} ${assistant}`);
  }

  // The last `windowTurns` turns, vectorized; content-free turns drop out so they
  // neither inflate nor deflate the average.
  const vectors = turnTexts
    .slice(-windowTurns)
    .map((t) => buildTFVector(tokenize(t)))
    .filter((v) => Object.keys(v).length > 0);

  if (vectors.length < 2) {
    return { shouldFire: false, similarity: 0 };
  }

  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      sum += cosineSimilarity(vectors[i], vectors[j]);
      pairs++;
    }
  }
  const similarity = pairs > 0 ? sum / pairs : 0;

  return { shouldFire: similarity >= threshold, similarity };
}
