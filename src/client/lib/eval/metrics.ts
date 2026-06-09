// ============================================================
// RETRIEVAL EVAL — METRIC HELPERS
//
// Pure, side-effect-free functions over probe outcomes.
// Exported so the aggregate test can compose them and so
// the implementations are independently verifiable.
//
// Both functions operate on 1-based turnIndex values (matching
// searchScored / cosineSearch convention).
// ============================================================

/**
 * Recall@K — fraction of expected turnIndexes that appear in
 * the retrieved set.  Returns a value in [0, 1].
 *
 * @param expected  turnIndexes the probe declares should surface.
 * @param got       turnIndexes returned by searchScored (order irrelevant).
 */
export function recallAtK(expected: number[], got: number[]): number {
  if (expected.length === 0) return 1; // vacuously correct
  const gotSet = new Set(got);
  const hits = expected.filter((t) => gotSet.has(t)).length;
  return hits / expected.length;
}

/**
 * Mean Reciprocal Rank — 1/rank of the first expected hit in
 * `got`, where rank is 1-based position.  Returns 0 when no
 * expected turnIndex appears in `got`.
 *
 * `got` is ordered by the engine's combined score (best first).
 *
 * @param expected  turnIndexes the probe declares should surface.
 * @param got       ordered turnIndexes returned by searchScored.
 */
export function mrr(expected: number[], got: number[]): number {
  if (expected.length === 0) return 1; // vacuously correct
  const expectedSet = new Set(expected);
  for (let i = 0; i < got.length; i++) {
    if (expectedSet.has(got[i])) {
      return 1 / (i + 1);
    }
  }
  return 0;
}
