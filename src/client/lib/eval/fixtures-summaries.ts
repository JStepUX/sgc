// ============================================================
// RETRIEVAL EVAL — SUMMARIES FIXTURE (spec 08 S3)
//
// Its own file because fixtures.ts sits at the anti-god-object line
// budget (src/architecture.test.ts) — split, don't raise. Same design
// constraints as the fixtures there: planted turns older than the
// buffer, vocabulary that survives tokenize(), stems disjoint across
// turns, both halves of a pair sharing createdAt.
// ============================================================

import type { ChatEntry } from '../types';
import { daysAgo, hoursAgo } from './fixture-time';

// ============================================================
// FIXTURE 7: summaries (spec 08 S3 — the summary corpus)
//
// Six pairs, every assistant half carrying a state-turn summary
// (≥ SUMMARY_CORPUS_MIN_DOCS, so the corpus is searched). Planted
// at turn 2: an outing the raw prose describes WITHOUT its label
// ("we climbed the ladders and filled two baskets before the rain
// came") while the summary states the label ("orchard visit").
// 'orchard' appears nowhere in any raw text — a hit on it can only
// come through the summary corpus. Buffer tail: turns 7 + 8.
// ============================================================

/** A pair whose assistant half carries a summary (assistant rows only —
 * production stamps summaries there, buildSummaryDocs reads them there). */
function spair(userContent: string, assistContent: string, createdAt: number, persistent: string[]): ChatEntry[] {
  return [
    { role: 'user', content: userContent, createdAt },
    { role: 'assistant', content: assistContent, createdAt, summary: { persistent, volatile: [], established_patterns: [] } },
  ];
}

export const summariesLog: ChatEntry[] = [
  // turn 1 – filler (disjoint: violin practice)
  ...spair(
    'My violin bowing keeps squeaking on the E string.',
    'Squeaks usually mean too little bow pressure or old rosin.',
    daysAgo(12),
    ['violin bowing squeaks; rosin and pressure'],
  ),
  // turn 2 – PLANTED: the label lives only in the summary
  ...spair(
    'We climbed the ladders and filled two baskets before the rain came.',
    'Two baskets in an hour is quick work; the rain would have ended it anyway.',
    daysAgo(10),
    ['orchard visit: ladders, two baskets, rain cut it short'],
  ),
  // turn 3 – filler (disjoint: bicycle brakes)
  ...spair(
    'The rear brake lever on my bicycle feels spongy.',
    'Spongy hydraulic brakes usually want bleeding.',
    daysAgo(8),
    ['bicycle rear brake spongy; needs bleeding'],
  ),
  // turn 4 – filler (disjoint: watercolour)
  ...spair(
    'How do I keep watercolour washes from blooming?',
    'Blooms come from adding wet paint to a drying wash — wait or go wetter.',
    daysAgo(6),
    ['watercolour blooms: timing of the wash'],
  ),
  // turn 5 – filler (disjoint: chess endgame)
  ...spair(
    'Is a rook endgame with an extra pawn always winning?',
    'Not always — the Philidor position holds the draw.',
    daysAgo(4),
    ['rook endgame, extra pawn, Philidor draw'],
  ),
  // turn 6 – filler (disjoint: coffee)
  ...spair(
    'My pour-over coffee tastes sour lately.',
    'Sour points to under-extraction — grind finer or pour slower.',
    daysAgo(2),
    ['pour-over sour: under-extraction'],
  ),
  // Buffer tail (2 filler turns — excluded by searchScored)
  ...spair('What is the dew point?', 'The temperature at which air saturates.', hoursAgo(3), ['dew point definition']),
  ...spair('Is fog the same as low cloud?', 'Essentially, yes.', hoursAgo(1), ['fog is low cloud']),
];
