import type { ReactNode } from 'react';
import { tokenize } from './tfidf';

// ============================================================
// HIGHLIGHT — wrap the words that tipped a cosine match in <mark>.
//
// Render-side half of the engine's matchedTerms provenance: the terms are
// STEMS (post-tokenization vocabulary), so membership can't be a plain string
// compare. Each visible word runs through the SAME tokenize() pipeline that
// built the corpus (lowercase → stopword filter → Porter stem), so a word
// lights up only if it contributed to the score. Not the converse: the engine
// reports the TOP contributors (MATCHED_TERMS_CAP, tfidf.ts), so a long-tail
// shared term past the cap stays unmarked. Pure function; no state, no model.
// ============================================================

/**
 * Split `text` into alternating word / non-word runs and wrap every word
 * whose tokenized form is one of `stems` in a `<mark>`. Case and punctuation
 * are preserved in the visible text; the membership check is normalized.
 * Empty `stems` (legacy rows, neighbor fetches) returns the text untouched.
 */
export function renderWithHighlights(text: string, stems: string[]): ReactNode[] {
  if (stems.length === 0) return [text];
  const stemSet = new Set(stems);
  const parts = text.match(/\w+|\W+/g) ?? [];
  return parts.map((part, i) => {
    // Non-word runs (whitespace, punctuation) pass through verbatim.
    if (!/^\w/.test(part)) return part;
    // tokenize() yields [] for stopwords and ≤2-char words — they can never
    // be in matchedTerms, so they auto-skip without a separate filter.
    const toks = tokenize(part);
    return toks.length === 1 && stemSet.has(toks[0]) ? (
      <mark key={i} className="rounded-[2px] bg-ember/20 px-[1px] text-fg-1">
        {part}
      </mark>
    ) : (
      part
    );
  });
}
