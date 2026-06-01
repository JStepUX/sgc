// ============================================================
// TF-IDF COSINE SIMILARITY ENGINE (Grepory)
// Pure math. No model. No reasoning. No drift surface.
//
// This is the thesis of Phase 1.5: retrieval over older conversation history
// is deterministic arithmetic, not a model call. Every function here is pure
// and side-effect-free — which is exactly why it is the prime test target
// (see tfidf.test.ts).
// ============================================================

import type { ChatEntry } from './types';
import { LOCAL_BUFFER_SIZE } from './constants';

/** A term-frequency (or TF-IDF) vector: term → weight. */
export type TFVector = Record<string, number>;

/** An inverse-document-frequency map: term → idf weight. */
export type IDFMap = Record<string, number>;

/** A turn-pair document: a user message + the assistant reply, tokenized. */
interface TurnDoc {
  tokens: string[];
  tf: TFVector;
  turnIndex: number;
  userContent: string;
  assistContent: string;
}

/** A cosine-similarity match returned by {@link cosineSearch}. */
export interface GrepResult extends TurnDoc {
  score: number;
}

const STOP_WORDS = new Set<string>([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'from',
  'they', 'will', 'with', 'this', 'that', 'what', 'when', 'where',
  'which', 'their', 'there', 'these', 'those', 'then', 'than', 'them',
  'were', 'would', 'could', 'should', 'about', 'into', 'just', 'also',
  'some', 'more', 'very', 'like', 'being', 'does', 'doing',
  'did', 'how', 'who', 'its', 'let', 'may', 'say', 'she', 'him',
  'his', 'here', 'way', 'each', 'make', 'well', 'back', 'only',
  'come', 'made', 'after', 'use', 'two', 'other', 'know', 'take',
  'because', 'good', 'give', 'most', 'think', 'over', 'such', 'much',
]);

/** Lowercase, strip punctuation, drop short words and stop words. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2)
    .filter((t) => !STOP_WORDS.has(t));
}

/** Build a length-normalized term-frequency vector from tokens. */
export function buildTFVector(tokens: string[]): TFVector {
  const tf: TFVector = {};
  for (const t of tokens) {
    tf[t] = (tf[t] || 0) + 1;
  }
  const len = tokens.length || 1;
  for (const t in tf) {
    tf[t] /= len;
  }
  return tf;
}

/** Cosine similarity of two sparse vectors. Returns 0 if either is empty. */
export function cosineSimilarity(vecA: TFVector, vecB: TFVector): number {
  const allTerms = new Set<string>([...Object.keys(vecA), ...Object.keys(vecB)]);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const term of allTerms) {
    const a = vecA[term] || 0;
    const b = vecB[term] || 0;
    dot += a * b;
    magA += a * a;
    magB += b * b;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/** IDF computed across all turn-documents in the searchable log. */
export function computeIDF(turnDocs: TurnDoc[]): IDFMap {
  const df: Record<string, number> = {};
  const N = turnDocs.length || 1;
  for (const doc of turnDocs) {
    const seen = new Set(doc.tokens);
    for (const term of seen) {
      df[term] = (df[term] || 0) + 1;
    }
  }
  const idf: IDFMap = {};
  for (const term in df) {
    idf[term] = Math.log(N / df[term]) + 1;
  }
  return idf;
}

/** Weight a term-frequency vector by IDF. Unknown terms default to weight 1. */
export function applyIDF(tf: TFVector, idf: IDFMap): TFVector {
  const tfidf: TFVector = {};
  for (const term in tf) {
    tfidf[term] = tf[term] * (idf[term] || 1);
  }
  return tfidf;
}

/**
 * Search the chat log for turns similar to `query`, returning the top matches
 * above `threshold`.
 *
 * @param excludeLastN  Skip the last N entries — the local buffer already
 *                      carries those verbatim, so retrieving them is wasteful.
 */
export function cosineSearch(
  query: string,
  chatLog: ChatEntry[],
  excludeLastN = LOCAL_BUFFER_SIZE,
  topK = 3,
  threshold = 0.08,
): GrepResult[] {
  if (chatLog.length <= excludeLastN) return [];

  const searchable = chatLog.slice(0, chatLog.length - excludeLastN);
  if (searchable.length === 0) return [];

  // Build turn-pair documents (user + assistant grouped).
  //
  // Per-message gating: a turn the user switched off in the chat memory editor
  // is excluded from retrieval. `active !== false` treats undefined (the common
  // case — entries with no flag) as active, so this is a no-op for ungated
  // logs. A gated half contributes nothing to the document text, the IDF
  // statistics, or the returned `userContent`/`assistContent` (so its words
  // never reach Sal's prompt). This is deterministic curation of the memory
  // tier — no model decides what's retrievable, the person does.
  const turnDocs: TurnDoc[] = [];
  for (let i = 0; i < searchable.length; i += 2) {
    const userEntry = searchable[i];
    const assistEntry = searchable[i + 1];
    const userMsg = userEntry && userEntry.active !== false ? userEntry.content : '';
    const assistMsg = assistEntry && assistEntry.active !== false ? assistEntry.content : '';
    const tokens = tokenize(`${userMsg} ${assistMsg}`);
    // Both halves gated off (or genuinely content-free) → the turn drops out of
    // the corpus entirely. turnIndex stays position-based (`i / 2`), so the
    // diagnostics panel's "Turn N" labels are unaffected by what's gated.
    if (tokens.length === 0) continue;
    turnDocs.push({
      tokens,
      tf: buildTFVector(tokens),
      turnIndex: Math.floor(i / 2) + 1,
      userContent: userMsg,
      assistContent: assistMsg,
    });
  }

  if (turnDocs.length === 0) return [];

  const idf = computeIDF(turnDocs);
  const queryVec = applyIDF(buildTFVector(tokenize(query)), idf);

  return turnDocs
    .map((doc): GrepResult => ({
      ...doc,
      score: cosineSimilarity(queryVec, applyIDF(doc.tf, idf)),
    }))
    .filter((d) => d.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
