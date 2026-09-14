// Shared structural constants for the SGC memory tiers.

import type { ConceptEngine } from './bm25';

/**
 * Which concept scorer ranks the memory grep's turn corpus (lib/bm25.ts
 * conceptSearch). The ONE site that chooses; both production call sites
 * (turn-context.ts ambient grep, recall.ts deliberate recall) and the eval
 * harness read it, so retrieval and its ratchet always run the same engine.
 *
 * 'product' = cosine × squashed BM25 (spec 08 S1, 2026-09-13). Evidence from
 * the local replay lab over four labelled roleplay corpora (21–65 turns):
 * anchor recall equal to cosine on all four, junk-pull rate 0.62 → 0.24 on the
 * long-paragraph corpus, never worse. Each engine vetoes the other's failure
 * mode — cosine's "same scene, no anchor" and BM25's "one rare incidental
 * word". BM25 ORDERING was tried and withdrawn (won short queries, lost long
 * ones); only its veto is robust. Documented trades: below ~10 turns the
 * furniture veto is weak, a term present in every turn retrieves nothing, and
 * one rare word mentioned once in a long turn falls under the gate — pinned by
 * bm25.test.ts so nobody rediscovers them.
 *
 * conceptSearch's own default stays 'cosine' (a pure-function default the
 * engine tests rely on); this constant is what production passes.
 */
export const CONCEPT_ENGINE: ConceptEngine = 'product';

/**
 * Summary-corpus knobs (spec 08 S3, 2026-09-13). The memory grep runs a
 * SECOND corpus beside the raw turn text: the per-turn summaries the state
 * turn already writes (lib/tfidf.ts buildSummaryDocs). It exists for the
 * label the prose never restated — "the harbour trip", "the broken ribs" —
 * which a summary states in plain words. Fusion is raw-first: a summary hit
 * only fills a slot the raw corpus left empty, and never outranks a raw hit,
 * because the two corpora keep separate statistics (summary docs are ~40
 * tokens, raw ~300) and their scores are not comparable.
 *
 * SUMMARY_CONCEPT_THRESHOLD — the summary corpus's own gate (final AND
 * rescue). Its own knob because short docs score higher on cosine; start at
 * the raw corpus's 0.08 and tune in place via the inspector's source badge.
 *
 * SUMMARY_CORPUS_MIN_DOCS — below this many summaries the corpus is not
 * searched at all: in a handful of docs every term is rare and IDF says
 * nothing (the lesson of the withdrawn background prior, spec 08 evidence).
 */
export const SUMMARY_CONCEPT_THRESHOLD = 0.08;
export const SUMMARY_CORPUS_MIN_DOCS = 5;

/**
 * Retrieval-cue caps (spec 09 C1, 2026-09-14). The state turn may emit up
 * to CUE_MAX short strings per turn — OTHER words a person might later use
 * for the exchange — that the summary corpus indexes and no prompt renders.
 * The cap that matters for retrieval is CUE_TOKEN_BUDGET: the number of
 * NOVEL stems (not already in the summary lines or an earlier cue) a turn's
 * cues may add to its summary doc. Measured against the real scorer: one
 * unique stem in a ~40-token doc clears the 0.08 gate on its own (0.098),
 * and twenty unrelated stems drag a correct match from 0.100 to 0.073 — so
 * the budget bounds both a wrong cue's reach and the dilution of the lines
 * the cues ride with. lib/turn-parser.ts coerceCues enforces all three.
 */
export const CUE_MAX = 6;
export const CUE_MAX_CHARS = 40;
export const CUE_TOKEN_BUDGET = 12;

/**
 * The local-buffer window, in *messages* (not turns): the last 2 turns ×
 * (user + assistant) = 4 entries, passed verbatim every turn.
 *
 * This is load-bearing for the no-double-dip invariant. The buffer is the last
 * `LOCAL_BUFFER_SIZE` entries of the chat log; the cosine grep must exclude
 * exactly that same tail (`excludeLastN`) so a message lands in exactly one
 * tier — never both, never neither. Binding the buffer slice and the grep's
 * `excludeLastN` to this single constant is what keeps the two from drifting:
 * change the buffer size here and both sides move together.
 */
export const LOCAL_BUFFER_SIZE = 4;

/**
 * The summary-buffer window, in *messages* (same unit as LOCAL_BUFFER_SIZE): the
 * SUMMARY_BUFFER_SIZE entries sitting immediately BEHIND the verbatim local
 * buffer. Those turns have scrolled out of full-text recency, so rather than
 * dropping straight to the cosine grep they're carried forward DISTILLED — each
 * turn's own summary in place of its raw text. 4 entries = 2 turns.
 *
 * This window does NOT overlap the local buffer (it ends exactly where the buffer
 * begins), so the distilled tail extends the awareness horizon — raw recent →
 * distilled near-past → cosine grep — instead of duplicating the verbatim block.
 * An independent knob from LOCAL_BUFFER_SIZE: widen it for a longer distilled
 * tail at near-zero token cost (a summary is a few lines; a raw turn is not).
 */
export const SUMMARY_BUFFER_SIZE = 4;

/**
 * Knowledge-tier retrieval knobs (lib/brains.ts). Same default gate as the
 * memory grep (cosineSearch's topK/threshold) but deliberately independent
 * knobs — the knowledge axis tunes without touching the memory axis.
 */
export const BRAIN_TOP_K = 3;
export const BRAIN_SCORE_THRESHOLD = 0.08;

/**
 * Per-brain cap on the always-present digest line (characters), so a fat brain
 * cannot flood the PERSONA KNOWLEDGE tier with its own table of contents.
 */
export const BRAIN_DIGEST_CHAR_CAP = 600;
