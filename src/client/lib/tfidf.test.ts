// Behavioral tests for the TF-IDF cosine engine. If any of these break, the
// retrieval tier of SGC is silently wrong — which is the whole point of the
// engine being pure, deterministic, and testable.

import {
  tokenize,
  buildTFVector,
  cosineSimilarity,
  computeIDF,
  applyIDF,
  cosineSearch,
} from './tfidf';
import type { ChatEntry } from './types';

describe('tokenize', () => {
  it('lowercases and strips punctuation', () => {
    expect(tokenize('Hello, WORLD!')).toEqual(['hello', 'world']);
  });

  it('drops words of 2 or fewer characters', () => {
    expect(tokenize('a an the elephant')).toEqual(['elephant']);
  });

  it('drops stop words', () => {
    // "about" and "would" are stop words; "rainfall" survives.
    expect(tokenize('about rainfall would')).toEqual(['rainfall']);
  });

  it('returns an empty array for content-free input', () => {
    expect(tokenize('the and but !!!')).toEqual([]);
  });
});

describe('buildTFVector', () => {
  it('counts terms and normalizes by document length', () => {
    const tf = buildTFVector(['cat', 'cat', 'dog', 'fish']);
    expect(tf.cat).toBeCloseTo(0.5);
    expect(tf.dog).toBeCloseTo(0.25);
    expect(tf.fish).toBeCloseTo(0.25);
  });

  it('weights sum to 1 for a non-empty document', () => {
    const tf = buildTFVector(['alpha', 'beta', 'beta', 'gamma']);
    const total = Object.values(tf).reduce((s, w) => s + w, 0);
    expect(total).toBeCloseTo(1);
  });

  it('does not divide by zero on empty input', () => {
    expect(buildTFVector([])).toEqual({});
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    const v = { quantum: 0.5, particle: 0.5 };
    expect(cosineSimilarity(v, v)).toBeCloseTo(1);
  });

  it('is 0 for vectors with no shared terms', () => {
    expect(cosineSimilarity({ cat: 1 }, { dog: 1 })).toBe(0);
  });

  it('is 0 when either vector is empty', () => {
    expect(cosineSimilarity({}, { dog: 1 })).toBe(0);
    expect(cosineSimilarity({ cat: 1 }, {})).toBe(0);
  });

  it('is direction-invariant to magnitude', () => {
    const a = { x: 1, y: 1 };
    const b = { x: 10, y: 10 };
    expect(cosineSimilarity(a, b)).toBeCloseTo(1);
  });
});

describe('computeIDF', () => {
  it('gives rare terms a higher weight than common ones', () => {
    const docs = ['common common rare', 'common again', 'common filler'].map(
      (text) => ({
        tokens: tokenize(text),
        tf: {},
        turnIndex: 0,
        userContent: '',
        assistContent: '',
      }),
    );
    const idf = computeIDF(docs);
    // "common" appears in every doc; "rare" in one. Wait — "rare" only
    // survives tokenize if >2 chars: it does (4 chars).
    expect(idf.rare).toBeGreaterThan(idf.common);
  });
});

describe('applyIDF', () => {
  it('scales term frequencies by their IDF weight', () => {
    const tf = { rare: 0.5 };
    const idf = { rare: 3 };
    expect(applyIDF(tf, idf).rare).toBeCloseTo(1.5);
  });

  it('defaults unknown terms to an IDF weight of 1', () => {
    expect(applyIDF({ mystery: 0.4 }, {}).mystery).toBeCloseTo(0.4);
  });
});

describe('cosineSearch', () => {
  // Four turns. With the default excludeLastN=4 (the local buffer's 2 turns),
  // only turns 1 and 2 are searchable. createdAt is required by the type but
  // not consumed by cosineSearch — pin it to a constant so the fixture stays
  // about content, not time.
  const T0 = new Date(2026, 0, 1).getTime();
  const log: ChatEntry[] = [
    { role: 'user', content: 'explain quantum entanglement between particles', createdAt: T0 },
    { role: 'assistant', content: 'entangled particles share a quantum state', createdAt: T0 },
    { role: 'user', content: 'give me a carbonara pasta recipe', createdAt: T0 },
    { role: 'assistant', content: 'carbonara uses eggs pancetta and pasta', createdAt: T0 },
    { role: 'user', content: 'what is the weather tomorrow', createdAt: T0 },
    { role: 'assistant', content: 'rain is forecast tomorrow afternoon', createdAt: T0 },
    { role: 'user', content: 'hello there', createdAt: T0 },
    { role: 'assistant', content: 'hi how can i help', createdAt: T0 },
  ];

  it('returns nothing when the log is shorter than the excluded window', () => {
    expect(cosineSearch('anything', log.slice(0, 4))).toEqual([]);
  });

  it('finds a semantically matching older turn', () => {
    const results = cosineSearch('quantum particles physics', log);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].turnIndex).toBe(1);
    expect(results[0].score).toBeGreaterThan(0.08);
  });

  it('does not retrieve turns inside the excluded recent window', () => {
    // Turn 4 ("hello there") is in the last 4 entries — never a candidate.
    const results = cosineSearch('hello there', log);
    expect(results.every((r) => r.turnIndex <= 2)).toBe(true);
  });

  it('returns nothing when no turn clears the similarity threshold', () => {
    expect(cosineSearch('xylophone zeppelin kumquat', log)).toEqual([]);
  });

  it('respects topK', () => {
    const results = cosineSearch('quantum pasta', log, 4, 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  // --- Gating: turns switched off in the chat memory editor are excluded ---
  describe('gating (active flag)', () => {
    it('excludes a turn whose both halves are gated off', () => {
      const gated: ChatEntry[] = log.map((e, i) =>
        i < 2 ? { ...e, active: false } : e,
      );
      // Turn 1 (the quantum pair) is gated off; the query that used to match it
      // now finds nothing in the searchable window.
      const results = cosineSearch('quantum particles physics', gated);
      expect(results.every((r) => r.turnIndex !== 1)).toBe(true);
    });

    it('treats undefined active as retrievable (ungated logs unchanged)', () => {
      const results = cosineSearch('quantum particles physics', log);
      expect(results[0]?.turnIndex).toBe(1);
    });

    it('drops a gated half from the matched document and its returned content', () => {
      // Gate only the assistant half of turn 1. The user half ("quantum
      // entanglement particles") still matches; the assistant text must not
      // leak into the result that feeds Sal's prompt.
      const gated: ChatEntry[] = log.map((e, i) =>
        i === 1 ? { ...e, active: false } : e,
      );
      const results = cosineSearch('quantum entanglement particles', gated);
      const turn1 = results.find((r) => r.turnIndex === 1);
      expect(turn1).toBeDefined();
      expect(turn1?.userContent).toContain('quantum');
      expect(turn1?.assistContent).toBe('');
    });
  });
});
