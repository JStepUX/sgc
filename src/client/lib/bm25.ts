// ============================================================
// BM25 CONCEPT ENGINE + ENGINE DISPATCH
//
// A sibling of the TF-IDF cosine grep (tfidf.ts), scoring the SAME turn-pair
// corpus (buildTurnDocs) with the Okapi BM25 ranking function instead of
// cosine similarity. Pure math, no model — the Phase 1.5 invariant holds
// exactly as it does for cosine.
//
// Why a second engine exists: cosine measures distributional RESEMBLANCE, so
// two turns set in the same scene ("bed", "sheet", "eyes") look alike whatever
// happens in them. BM25 accumulates rarity-weighted EVIDENCE per query term:
//   - its IDF, ln((N - df + 0.5) / (df + 0.5) + 1), goes to ~0 for a term in
//     every turn (cosine's log(N/df) + 1 floors at 1, so scene furniture never
//     dies);
//   - term frequency saturates (k1), so six mentions ≈ one-and-a-bit, not six;
//   - document length is normalised (b), so a long turn can't win by volume.
//
// Score normalisation: raw BM25 is unbounded and corpus-size dependent, while
// everything downstream (time-score's multiplicative combinator, the rescue
// threshold, the inspector) assumes [0, 1]. The raw score is squashed as
//   norm = 1 - exp(-raw / idfMax)
// where idfMax is the IDF of a term seen in exactly one turn — i.e. the score
// is "evidence found, in units of one unique word". Monotone in raw (pure BM25
// ranking preserved), query-length independent (an 80-word narrative paragraph
// matching two rare words scores the same as a two-word query matching both),
// and a furniture-only query stays near 0 because its raw evidence is tiny.
// The alternative, dividing by the query's own IDF mass, cancels IDF for
// single-term queries ("bed" would score 1.0 on every bedroom turn).
//
// `conceptSearch` is the dispatcher: 'cosine' reproduces cosineSearch exactly,
// 'bm25' is this engine, 'product' multiplies the two normalised scores so
// each vetoes the other's failure mode (same-scene-no-anchor vs one-rare-
// incidental-word). Production runs 'product' (CONCEPT_ENGINE, lib/constants.ts
// — the one site that chooses; spec 08 S1, 2026-09-13); conceptSearch's own
// default stays 'cosine' so the pure-function tests pin the dispatch. The
// evidence came from a local, untracked replay lab over real chats
// (gitignored under scripts/eval/ — it holds people's chat content).
// ============================================================

import type { ChatEntry } from './types';
import { LOCAL_BUFFER_SIZE } from './constants';
import {
  applyIDF,
  buildTFVector,
  buildTurnDocs,
  computeIDF,
  cosineSimilarity,
  tokenize,
  topSharedTerms,
  MATCHED_TERMS_CAP,
  type GrepResult,
  type IDFMap,
  type TurnDoc,
} from './tfidf';

/** Which concept scorer ranks the turn corpus. */
export type ConceptEngine = 'cosine' | 'bm25' | 'product';

export interface BM25Params {
  /** Term-frequency saturation. 1.2 is the textbook default. */
  k1: number;
  /** Document-length normalisation strength in [0, 1]. 0.75 is the default. */
  b: number;
}

export const BM25_DEFAULTS: BM25Params = { k1: 1.2, b: 0.75 };

/** BM25's IDF: ln((N - df + 0.5) / (df + 0.5) + 1). Non-negative (the +1
 * inside the log is Lucene's variant), ~0 for a term in every document. */
export function computeBM25IDF(docs: { tokens: string[] }[]): IDFMap {
  const df: Record<string, number> = {};
  const N = docs.length || 1;
  for (const doc of docs) {
    for (const term of new Set(doc.tokens)) df[term] = (df[term] || 0) + 1;
  }
  const idf: IDFMap = {};
  for (const term in df) idf[term] = Math.log((N - df[term] + 0.5) / (df[term] + 0.5) + 1);
  return idf;
}

/** IDF of a term seen in exactly one of N documents — the normalisation unit. */
export function bm25IdfMax(N: number): number {
  return Math.log((N - 1 + 0.5) / 1.5 + 1);
}

/** Raw BM25 of one document against a set of UNIQUE query terms, plus each
 * term's contribution (for provenance). Query term frequency is ignored, as
 * in classic BM25 — a narrative query saying "thing" twice is not twice as
 * interested in things. */
export function bm25Raw(
  queryTerms: Iterable<string>,
  doc: { counts: Record<string, number>; tokens: string[] },
  idf: IDFMap,
  avgLen: number,
  params: BM25Params = BM25_DEFAULTS,
): { raw: number; contributions: Record<string, number> } {
  const { k1, b } = params;
  const lenNorm = 1 - b + b * (doc.tokens.length / (avgLen || 1));
  let raw = 0;
  const contributions: Record<string, number> = {};
  for (const t of queryTerms) {
    const tf = doc.counts[t] || 0;
    if (tf === 0) continue;
    const w = (idf[t] || 0) * ((tf * (k1 + 1)) / (tf + k1 * lenNorm));
    contributions[t] = w;
    raw += w;
  }
  return { raw, contributions };
}

/** Squash a raw BM25 score into [0, 1) — see the header for the rationale. */
export function bm25Normalise(raw: number, idfMax: number): number {
  return 1 - Math.exp(-raw / (idfMax || 1));
}

/** A concept-engine hit: GrepResult plus both component scores, so the
 * replay harness and the inspector can show which engine said what. */
export interface ConceptResult extends GrepResult {
  cosineScore: number;
  bm25Score: number;
}

export interface ConceptSearchOpts {
  engine?: ConceptEngine;
  excludeLastN?: number;
  topK?: number;
  threshold?: number;
  bm25?: BM25Params;
  /** A caller-built corpus (e.g. tfidf.ts buildSummaryDocs). When given,
   * buildTurnDocs is skipped and IDF/length statistics are computed over
   * THESE docs only — corpora never share statistics. */
  docs?: TurnDoc[];
}

/**
 * Score the turn corpus with the chosen engine. `engine: 'cosine'` is
 * bit-for-bit cosineSearch (same IDF, same vectors, same provenance) — the
 * dispatcher exists so time-score.ts has one call site whichever engine is
 * live. Returns the top `topK` results at or above `threshold`, sorted by
 * the engine's score, each carrying BOTH component scores.
 */
export function conceptSearch(
  query: string,
  chatLog: ChatEntry[],
  opts: ConceptSearchOpts = {},
): ConceptResult[] {
  const engine = opts.engine ?? 'cosine';
  const excludeLastN = opts.excludeLastN ?? LOCAL_BUFFER_SIZE;
  const topK = opts.topK ?? 3;
  const threshold = opts.threshold ?? 0.08;
  const params = opts.bm25 ?? BM25_DEFAULTS;

  const docs: TurnDoc[] = opts.docs ?? buildTurnDocs(chatLog, excludeLastN);
  if (docs.length === 0) return [];

  const queryTokens = tokenize(query);
  const queryTerms = new Set(queryTokens);

  // Cosine side (always computed — it's cheap and the harness wants both).
  const idf = computeIDF(docs);
  const queryVec = applyIDF(buildTFVector(queryTokens), idf);

  // BM25 side.
  const bmIdf = computeBM25IDF(docs);
  const idfMax = bm25IdfMax(docs.length);
  const avgLen = docs.reduce((s, d) => s + d.tokens.length, 0) / docs.length;

  return docs
    .map((doc): ConceptResult => {
      const docVec = applyIDF(doc.tf, idf);
      const cosineScore = cosineSimilarity(queryVec, docVec);
      const { raw, contributions } = bm25Raw(queryTerms, doc, bmIdf, avgLen, params);
      const bm25Score = bm25Normalise(raw, idfMax);
      const score =
        engine === 'cosine' ? cosineScore : engine === 'bm25' ? bm25Score : cosineScore * bm25Score;
      const matchedTerms =
        engine === 'cosine'
          ? topSharedTerms(queryVec, docVec, MATCHED_TERMS_CAP)
          : Object.keys(contributions)
              .sort((a, b) => contributions[b] - contributions[a])
              .slice(0, MATCHED_TERMS_CAP);
      return { ...doc, score, matchedTerms, cosineScore, bm25Score };
    })
    .filter((d) => d.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
