// ============================================================
// PLUG-IN BRAINS — the knowledge axis ("persona knowledge packs")
//
// A separate axis from memory: the three memory tiers are untouched and
// searchScored/cosineSearch are never called from here. This module composes
// the SAME pure tfidf.ts primitives over chunks of mounted knowledge packs —
// deterministic lexical retrieval, 0 ms, 0 tokens, no model, no drift surface.
// Packs are read-only at runtime: conversation never writes back into them.
//
// Union index (spec D3): all mounted brains share ONE index and ONE IDF, so
// "distinctive" is measured against everything the persona currently knows.
// Accepted trade-off: a brain's scores shift slightly with the mount set —
// deterministic and inspector-visible.
//
// Indexing surface vs. render surface (spec D2): a chunk is indexed over
// text + summary + topics + aliases (the lexical bridge across the author
// gap), but only title + text ever reach the prompt.
// ============================================================

import type { BrainChunk, BrainPack } from './types';
import type { IDFMap, TFVector } from './tfidf';
import { applyIDF, buildTFVector, computeIDF, cosineSimilarity, tokenize } from './tfidf';
import { BRAIN_DIGEST_CHAR_CAP, BRAIN_SCORE_THRESHOLD, BRAIN_TOP_K } from './constants';

/**
 * The always-present compact summary of one mounted brain (spec D10): with no
 * retrieval hit a mounted brain would otherwise be invisible, and Sal could
 * never say "I have material on that — ask me". Also a vocabulary bridge:
 * once the corpus's own terms are on screen, later queries align with them,
 * which directly improves lexical retrieval.
 */
export interface BrainDigest {
  brainId: string;
  brainName: string;
  text: string;
}

/** One indexed chunk in the union index, with its mount provenance. */
export interface BrainIndexDoc {
  chunk: BrainChunk;
  brainId: string;
  brainName: string;
  tokens: string[];
  tf: TFVector;
}

/**
 * ONE union index over all mounted brains' chunks (single IDF — spec D3).
 * Rebuilt deterministically whenever the mount set changes; same packs in the
 * same order always produce the identical index.
 */
export interface BrainIndex {
  digests: BrainDigest[];
  docs: BrainIndexDoc[];
  idf: IDFMap;
}

/** A retrieved knowledge fragment. Concept score only — knowledge is
 * timeless by nature, so there is no time dimension at all (spec D4). */
export interface KnowledgeResult {
  brainId: string;
  brainName: string;
  chunkId: string;
  title: string;
  text: string;
  score: number;
  source: BrainChunk['source'];
}

/** What the PERSONA KNOWLEDGE prompt tier consumes. */
export interface KnowledgeBlock {
  digests: BrainDigest[];
  results: KnowledgeResult[];
}

/** Dedupe while preserving first-seen order. */
function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * Derive one brain's digest from its pack — name, description, document
 * titles, and each chunk's primary topic (the pack's flat topics list keeps
 * frontmatter order, where the first entry is the depth-0/primary one).
 * Deterministic, capped at BRAIN_DIGEST_CHAR_CAP so a fat brain cannot flood
 * the tier.
 */
export function buildBrainDigest(pack: BrainPack): BrainDigest {
  const titles = uniqueInOrder(pack.chunks.map((c) => c.title));
  const topics = uniqueInOrder(pack.chunks.map((c) => c.topics[0] ?? ''));
  let text = `${pack.name} — ${pack.description}`;
  if (titles.length > 0) text += ` Documents: ${titles.join('; ')}.`;
  if (topics.length > 0) text += ` Topics: ${topics.join(', ')}.`;
  if (text.length > BRAIN_DIGEST_CHAR_CAP) {
    text = `${text.slice(0, BRAIN_DIGEST_CHAR_CAP - 1).trimEnd()}…`;
  }
  return { brainId: pack.id, brainName: pack.name, text };
}

/**
 * Build the union index over the given packs. Caller rebuilds whenever the
 * mount set changes. Chunks whose combined lexical surface tokenizes to
 * nothing are dropped (they could never retrieve).
 */
export function buildBrainIndex(packs: BrainPack[]): BrainIndex {
  const docs: BrainIndexDoc[] = [];
  for (const pack of packs) {
    for (const chunk of pack.chunks) {
      const tokens = tokenize(
        `${chunk.text} ${chunk.summary} ${chunk.topics.join(' ')} ${chunk.aliases.join(' ')}`,
      );
      if (tokens.length === 0) continue;
      docs.push({
        chunk,
        brainId: pack.id,
        brainName: pack.name,
        tokens,
        tf: buildTFVector(tokens),
      });
    }
  }
  return {
    digests: packs.map(buildBrainDigest),
    docs,
    idf: computeIDF(docs),
  };
}

/**
 * Search the union index. Pure math — the model never decides what a query
 * matches. Ties break on (brainId, chunkId) so results are independent of
 * mount order, not just of runtime.
 */
export function searchBrains(
  query: string,
  index: BrainIndex,
  topK = BRAIN_TOP_K,
  threshold = BRAIN_SCORE_THRESHOLD,
): KnowledgeResult[] {
  if (index.docs.length === 0) return [];

  const queryVec = applyIDF(buildTFVector(tokenize(query)), index.idf);

  return index.docs
    .map((doc) => ({ doc, score: cosineSimilarity(queryVec, applyIDF(doc.tf, index.idf)) }))
    .filter((d) => d.score >= threshold)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.doc.brainId.localeCompare(b.doc.brainId) ||
        a.doc.chunk.id.localeCompare(b.doc.chunk.id),
    )
    .slice(0, topK)
    .map(
      ({ doc, score }): KnowledgeResult => ({
        brainId: doc.brainId,
        brainName: doc.brainName,
        chunkId: doc.chunk.id,
        title: doc.chunk.title,
        text: doc.chunk.text,
        score,
        source: doc.chunk.source,
      }),
    );
}
