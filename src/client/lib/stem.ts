// ============================================================
// PORTER STEMMER — the shared tokenizer's suffix-collapse step
//
// Thin local wrapper around the npm `stemmer` package (Porter, 1980 — a
// fixed, data-free suffix-rewriting rule set; deterministic string
// arithmetic, same dependency class as chrono-node). tokenize() imports
// ONLY from this file, so swapping the engine later (vendored reference
// implementation, Porter2) is a one-file change.
// ============================================================

import { stemmer } from 'stemmer';

/** Porter-stem a single word. Pure suffix arithmetic — no model, no data. */
export function stem(word: string): string {
  return stemmer(word);
}
