// Behavioral tests for the BM25 concept engine and the engine dispatcher. The
// load-bearing contracts: (1) `engine: 'cosine'` is bit-for-bit cosineSearch,
// so wiring the dispatcher into time-score.ts changed nothing in production;
// (2) BM25's IDF actually kills scene furniture where cosine's floor keeps it;
// (3) the normalised score stays in [0, 1) and monotone so the time
// combinator and thresholds keep their meaning.

import {
  bm25IdfMax,
  bm25Normalise,
  bm25Raw,
  computeBM25IDF,
  conceptSearch,
} from './bm25';
import { computeIDF, cosineSearch, tokenize } from './tfidf';
import type { ChatEntry } from './types';

const T0 = 1_700_000_000_000;
function pair(user: string, assistant: string, i: number): ChatEntry[] {
  return [
    { role: 'user', content: user, createdAt: T0 + i * 60_000 },
    { role: 'assistant', content: assistant, createdAt: T0 + i * 60_000 },
  ];
}

// A bedroom scene: every turn shares the furniture, one turn carries an anchor.
const scene: ChatEntry[] = [
  ...pair('Jim rolled over in bed, the sheet tangled at his feet.', 'She watched his eyes open in the grey light of the bedroom.', 0),
  ...pair('Bed, sheet, eyes — he blinked at the ceiling.', 'Her eyes stayed on the sheet, on the bed, on him.', 1),
  ...pair('He sat up in bed and told her about Maren and the glassblowing studio in Tacoma.', 'Her eyes widened under the sheet. "Maren? The one with the kiln?"', 2),
  ...pair('The sheet slid; his eyes found hers across the bed.', 'The bed creaked. Eyes, sheet, silence.', 3),
  // Two trailing pairs form the excluded local buffer.
  ...pair('Morning again. Bed, sheet, eyes.', 'The bedroom brightened.', 4),
  ...pair('He stretched under the sheet.', 'Her eyes followed.', 5),
];

describe('computeBM25IDF', () => {
  it('drives a term found in every document to ~0 while cosine IDF floors at 1', () => {
    const docs = [
      { tokens: tokenize('bed sheet eyes maren') },
      { tokens: tokenize('bed sheet eyes kiln') },
      { tokens: tokenize('bed sheet eyes studio') },
      { tokens: tokenize('bed sheet eyes tacoma') },
    ];
    const bm = computeBM25IDF(docs);
    const cos = computeIDF(docs);
    expect(bm.bed).toBeLessThan(0.15);
    expect(cos.bed).toBe(1);
    expect(bm.maren).toBeGreaterThan(1);
    // Rarity ordering agrees with cosine's; only the curve differs.
    expect(bm.maren).toBeGreaterThan(bm.bed);
  });
});

describe('bm25Raw', () => {
  const idf = { bed: 0.1, maren: 1.5 };
  it('saturates on term frequency instead of scaling linearly', () => {
    const once = bm25Raw(['maren'], { counts: { maren: 1 }, tokens: ['maren'] }, idf, 1);
    const six = bm25Raw(['maren'], { counts: { maren: 6 }, tokens: Array(6).fill('maren') }, idf, 6);
    expect(six.raw).toBeGreaterThan(once.raw);
    expect(six.raw).toBeLessThan(once.raw * 2); // not 6×
  });
  it('ignores query term repetition (unique terms only)', () => {
    const doc = { counts: { maren: 1 }, tokens: ['maren'] };
    const a = bm25Raw(['maren'], doc, idf, 1);
    const b = bm25Raw(new Set(['maren']), doc, idf, 1);
    expect(a.raw).toBe(b.raw);
  });
  it('reports per-term contributions for provenance', () => {
    const r = bm25Raw(['bed', 'maren', 'absent'], { counts: { bed: 1, maren: 1 }, tokens: ['bed', 'maren'] }, idf, 2);
    expect(Object.keys(r.contributions).sort()).toEqual(['bed', 'maren']);
    expect(r.contributions.maren).toBeGreaterThan(r.contributions.bed);
  });
});

describe('bm25Normalise', () => {
  it('maps raw 0 to 0, stays below 1, and is monotone', () => {
    const m = bm25IdfMax(100);
    expect(bm25Normalise(0, m)).toBe(0);
    expect(bm25Normalise(m, m)).toBeCloseTo(1 - Math.exp(-1), 6);
    expect(bm25Normalise(50, m)).toBeLessThan(1);
    expect(bm25Normalise(2, m)).toBeGreaterThan(bm25Normalise(1, m));
  });
});

describe('conceptSearch', () => {
  it("engine 'cosine' reproduces cosineSearch exactly (scores, order, provenance)", () => {
    const viaDispatch = conceptSearch('Maren and the bed', scene, { engine: 'cosine', excludeLastN: 4, topK: 3, threshold: 0.02 });
    const direct = cosineSearch('Maren and the bed', scene, 4, 3, 0.02);
    expect(viaDispatch.map((r) => [r.turnIndex, r.score, r.matchedTerms])).toEqual(
      direct.map((r) => [r.turnIndex, r.score, r.matchedTerms]),
    );
  });

  it('defaults to the cosine engine', () => {
    const a = conceptSearch('Maren', scene, { excludeLastN: 4, threshold: 0.02 });
    const b = conceptSearch('Maren', scene, { engine: 'cosine', excludeLastN: 4, threshold: 0.02 });
    expect(a.map((r) => r.score)).toEqual(b.map((r) => r.score));
  });

  it('bm25 ranks the anchor turn first on a furniture-heavy narrative query', () => {
    const query = 'He lay back in the bed, the sheet drooping, his eyes on Maren.';
    const r = conceptSearch(query, scene, { engine: 'bm25', excludeLastN: 4, topK: 3, threshold: 0 });
    expect(r[0].turnIndex).toBe(3);
    expect(r[0].matchedTerms[0]).toBe('maren');
    // The furniture-only turns score far below the anchor turn.
    const anchor = r[0].bm25Score;
    for (const other of r.slice(1)) expect(other.bm25Score).toBeLessThan(anchor / 2);
  });

  it('bm25 scores a furniture-only query far below an anchor query on the same corpus', () => {
    const furniture = conceptSearch('bed sheet eyes', scene, { engine: 'bm25', excludeLastN: 4, topK: 1, threshold: 0 });
    const anchor = conceptSearch('Maren', scene, { engine: 'bm25', excludeLastN: 4, topK: 1, threshold: 0 });
    // Four-document corpus, so the furniture IDF is small but not zero; the
    // contract is the gap, not an absolute. (Cosine ranks the furniture query
    // HIGHER than the anchor query here — that's the failure being fixed.)
    expect(furniture[0].bm25Score).toBeLessThan(anchor[0].bm25Score / 2);
    expect(furniture[0].cosineScore).toBeGreaterThan(anchor[0].cosineScore);
  });

  it('product never exceeds either component and carries both', () => {
    const r = conceptSearch('Maren in the bed', scene, { engine: 'product', excludeLastN: 4, topK: 3, threshold: 0 });
    expect(r.length).toBeGreaterThan(0);
    for (const hit of r) {
      expect(hit.score).toBeCloseTo(hit.cosineScore * hit.bm25Score, 12);
      expect(hit.score).toBeLessThanOrEqual(hit.cosineScore);
      expect(hit.score).toBeLessThanOrEqual(hit.bm25Score);
    }
  });

  it('returns nothing when the log is inside the excluded window', () => {
    expect(conceptSearch('Maren', scene.slice(0, 4), { engine: 'bm25', excludeLastN: 4 })).toEqual([]);
  });
});

describe('documented trades of the product engine (spec 08 S1)', () => {
  // Pinned with their numbers so nobody rediscovers them as bugs. Each is an
  // ACCEPTED consequence of multiplying cosine by squashed BM25; the lab's
  // 21–65-turn corpora showed anchor recall unaffected by them.

  it('a term present in EVERY retrievable turn retrieves nothing — it is furniture by definition', () => {
    // Cosine cannot tell these turns apart (all 1.0 — it would return an
    // arbitrary tie); BM25's IDF for a universal term is ~0, so the product
    // sits far under the 0.08 gate. N=10 → 0.023.
    const log: ChatEntry[] = [];
    for (let i = 0; i < 10; i++) log.push(...pair('lantern', '', i));
    log.push(...pair('buffer', 'buffer', 10), ...pair('buffer', 'buffer', 11));
    const r = conceptSearch('lantern', log, { engine: 'product', excludeLastN: 4, topK: 3, threshold: 0 });
    expect(r).toHaveLength(3);
    for (const hit of r) {
      expect(hit.cosineScore).toBeCloseTo(1, 6);
      expect(hit.score).toBeLessThan(0.08);
    }
  });

  it('one rare word mentioned once inside a long turn falls under the 0.08 gate', () => {
    // 1 anchor token among 99 unique filler tokens: cosine puts the turn at
    // exactly 1/√100 = 0.10 (marginal already); BM25's length normalisation
    // drags the product to ~0.017. Two anchor mentions, or a second query
    // term, lift it back over the gate — the shape that fails is precisely
    // "one word, once, buried".
    const filler = Array.from({ length: 99 }, (_, i) => `word${i}`).join(' ');
    const log: ChatEntry[] = [];
    for (let i = 0; i < 19; i++) log.push(...pair(`topic${i} thing${i}`, `reply${i}`, i));
    log.push(...pair(`lantern ${filler}`, '', 19));
    log.push(...pair('buffer', 'buffer', 20), ...pair('buffer', 'buffer', 21));
    const r = conceptSearch('lantern', log, { engine: 'product', excludeLastN: 4, topK: 1, threshold: 0 });
    expect(r[0].turnIndex).toBe(20);
    expect(r[0].cosineScore).toBeCloseTo(0.1, 2);
    expect(r[0].score).toBeLessThan(0.08);
  });
});
