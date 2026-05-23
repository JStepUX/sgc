// Behavioral tests for the time-aware retrieval scorer. Pure functions over
// (timestamp, intent, now); every test pins `now` so chrono-node + the decay
// math are fully deterministic. Mirrors the style of tfidf.test.ts.

import {
  parseTimeIntent,
  timeScore,
  combineScores,
  searchScored,
  DEFAULT_DECAY_TAU_MS,
  INTENT_DECAY_TAU_MS,
} from './time-score';
import type { ChatEntry } from './types';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Pin "now" to a known weekday. 2026-05-23 is a Saturday.
const NOW = new Date(2026, 4, 23, 14, 30);

describe('parseTimeIntent', () => {
  it('returns no anchor for a query with no time phrase', () => {
    const intent = parseTimeIntent('explain quantum entanglement', NOW);
    expect(intent.anchor).toBeNull();
    expect(intent.phrase).toBeNull();
  });

  it('parses "yesterday" to within a day of (now - 1d)', () => {
    const intent = parseTimeIntent('what did I say yesterday', NOW);
    expect(intent.anchor).not.toBeNull();
    const expected = NOW.getTime() - DAY;
    // chrono resolves to noon or midnight depending on the locale/component
    // resolution — allow a 24h window.
    expect(Math.abs((intent.anchor as number) - expected)).toBeLessThan(DAY);
    expect(intent.phrase?.toLowerCase()).toContain('yesterday');
  });

  it('parses "last Monday" to a Monday at or before now', () => {
    const intent = parseTimeIntent('the carbonara conversation last Monday', NOW);
    expect(intent.anchor).not.toBeNull();
    const d = new Date(intent.anchor as number);
    expect(d.getDay()).toBe(1); // Monday
    expect(d.getTime()).toBeLessThanOrEqual(NOW.getTime());
  });

  it('parses an absolute date like "May 1"', () => {
    const intent = parseTimeIntent('that piece on May 1', NOW);
    expect(intent.anchor).not.toBeNull();
    const d = new Date(intent.anchor as number);
    expect(d.getMonth()).toBe(4); // May (0-indexed)
    expect(d.getDate()).toBe(1);
  });

  it('echoes the matched phrase for inspector telemetry', () => {
    const intent = parseTimeIntent('what did we discuss last week', NOW);
    expect(intent.phrase?.toLowerCase()).toContain('last week');
  });
});

describe('timeScore', () => {
  const nowMs = NOW.getTime();

  it('scores ≈ 1.0 for a turn at the intent anchor', () => {
    const anchor = nowMs - 3 * DAY;
    const score = timeScore(anchor, { anchor, phrase: 'three days ago' }, nowMs);
    expect(score).toBeCloseTo(1, 5);
  });

  it('scores ≈ 1/e for a turn one INTENT_DECAY_TAU_MS off the anchor', () => {
    const anchor = nowMs - 30 * DAY;
    const ts = anchor - INTENT_DECAY_TAU_MS;
    const score = timeScore(ts, { anchor, phrase: 'a month ago' }, nowMs);
    expect(score).toBeCloseTo(Math.exp(-1), 5);
  });

  it('without intent, more recent scores higher than less recent', () => {
    const recent = timeScore(nowMs - 1 * DAY, { anchor: null, phrase: null }, nowMs);
    const older = timeScore(nowMs - 10 * DAY, { anchor: null, phrase: null }, nowMs);
    expect(recent).toBeGreaterThan(older);
  });

  it('without intent, a turn one DEFAULT_DECAY_TAU_MS old scores ≈ 1/e', () => {
    const ts = nowMs - DEFAULT_DECAY_TAU_MS;
    const score = timeScore(ts, { anchor: null, phrase: null }, nowMs);
    expect(score).toBeCloseTo(Math.exp(-1), 5);
  });

  it('result is always in (0, 1]', () => {
    const cases = [
      { ts: nowMs, intent: { anchor: null, phrase: null }, now: nowMs },
      { ts: nowMs - 100 * DAY, intent: { anchor: null, phrase: null }, now: nowMs },
      { ts: nowMs - 100 * DAY, intent: { anchor: nowMs - 50 * DAY, phrase: 'x' }, now: nowMs },
      { ts: nowMs + 100 * DAY, intent: { anchor: null, phrase: null }, now: nowMs }, // future
    ];
    for (const c of cases) {
      const s = timeScore(c.ts, c.intent, c.now);
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it('decay is symmetric: |Δ| from the anchor, not signed', () => {
    const anchor = nowMs;
    const before = timeScore(nowMs - 2 * DAY, { anchor, phrase: 'p' }, nowMs);
    const after = timeScore(nowMs + 2 * DAY, { anchor, phrase: 'p' }, nowMs);
    expect(before).toBeCloseTo(after, 5);
  });
});

describe('combineScores', () => {
  it('is 0 when the concept score is 0 (cliff preserved)', () => {
    expect(combineScores(0, 1)).toBe(0);
  });

  it('is 0 when the time score is 0', () => {
    expect(combineScores(1, 0)).toBe(0);
  });

  it('multiplies the two components', () => {
    expect(combineScores(0.5, 0.5)).toBeCloseTo(0.25, 5);
  });

  it('returns the concept score when time is 1.0', () => {
    expect(combineScores(0.42, 1)).toBeCloseTo(0.42, 5);
  });
});

describe('searchScored', () => {
  // Build a chat where the same topic appears in two different turns at
  // different ages, plus filler. With excludeLastN=4 the last 2 turn-pairs are
  // off-limits — so we put 4 retrievable pairs at the start and 2 filler pairs
  // at the end.
  const nowMs = NOW.getTime();
  const longAgo = nowMs - 30 * DAY;
  const yesterday = nowMs - 1 * DAY;

  const log: ChatEntry[] = [
    // Pair 1: pasta, long ago
    { role: 'user', content: 'how do I make carbonara pasta sauce', createdAt: longAgo },
    { role: 'assistant', content: 'carbonara needs eggs pancetta pasta', createdAt: longAgo },
    // Pair 2: filler, long ago
    { role: 'user', content: 'tell me about birdsong recordings', createdAt: longAgo + HOUR },
    { role: 'assistant', content: 'birdsong is studied by ornithologists', createdAt: longAgo + HOUR },
    // Pair 3: pasta, yesterday — same topic, much newer
    { role: 'user', content: 'remind me about the carbonara recipe', createdAt: yesterday },
    { role: 'assistant', content: 'eggs pancetta pasta still the answer', createdAt: yesterday },
    // Pair 4: filler, today
    { role: 'user', content: 'what time is it', createdAt: nowMs - 4 * HOUR },
    { role: 'assistant', content: 'time is a flat circle', createdAt: nowMs - 4 * HOUR },
    // Pairs 5+6: the local-buffer window — excluded by excludeLastN=4
    { role: 'user', content: 'buffer one', createdAt: nowMs - 2 * HOUR },
    { role: 'assistant', content: 'buffer one reply', createdAt: nowMs - 2 * HOUR },
    { role: 'user', content: 'buffer two', createdAt: nowMs - HOUR },
    { role: 'assistant', content: 'buffer two reply', createdAt: nowMs - HOUR },
  ];

  it('returns empty when the log is shorter than the excluded window', () => {
    expect(searchScored('anything', log.slice(0, 4), nowMs)).toEqual([]);
  });

  it('without time intent: the more recent topical turn ranks above the older one', () => {
    const results = searchScored('carbonara recipe', log, nowMs);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].turnIndex).toBe(3); // yesterday's pasta beats the month-old one
  });

  it('with intent "yesterday": the matching-day topical turn is the top hit', () => {
    const results = searchScored('carbonara from yesterday', log, nowMs);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].turnIndex).toBe(3);
    // It should have a higher score than the long-ago version, even though both
    // contain the same keywords.
    const oldHit = results.find((r) => r.turnIndex === 1);
    if (oldHit) expect(results[0].combinedScore).toBeGreaterThan(oldHit.combinedScore);
  });

  it('respects topK', () => {
    const results = searchScored('carbonara', log, nowMs, { topK: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('attaches createdAt to each result so the prompt can render a relative tag', () => {
    const results = searchScored('carbonara', log, nowMs);
    for (const r of results) {
      expect(typeof r.createdAt).toBe('number');
      expect(r.createdAt).toBeGreaterThan(0);
    }
  });

  it('exposes both component scores so the inspector can show them', () => {
    const results = searchScored('carbonara', log, nowMs);
    expect(results.length).toBeGreaterThan(0);
    const r = results[0];
    expect(r.conceptScore).toBeGreaterThan(0);
    expect(r.timeScore).toBeGreaterThan(0);
    expect(r.combinedScore).toBeCloseTo(r.conceptScore * r.timeScore, 8);
  });

  it('preserves the cosine cliff: a query with zero concept overlap returns nothing', () => {
    // No topical match against any turn → no retrieval, regardless of how
    // recent the turns are.
    expect(searchScored('xylophone zeppelin kumquat', log, nowMs)).toEqual([]);
  });

  it('rescues strong concept matches from the age-cliff (no time intent)', () => {
    // A strong topical match 60 days old: time = exp(-60/14) ≈ 0.014, so
    // combinedScore < 0.08. Without CONCEPT_RESCUE_THRESHOLD the turn would
    // be filtered out and the user couldn't retrieve it without attaching a
    // time phrase — the regression P1 caught.
    const veryOld = nowMs - 60 * DAY;
    const ageyLog: ChatEntry[] = [
      { role: 'user', content: 'how do I make carbonara pasta sauce with eggs and pancetta', createdAt: veryOld },
      { role: 'assistant', content: 'carbonara needs eggs pancetta pasta starchy water', createdAt: veryOld },
      { role: 'user', content: 'unrelated topic about clouds and weather patterns', createdAt: veryOld + HOUR },
      { role: 'assistant', content: 'clouds form from condensation of water vapor', createdAt: veryOld + HOUR },
      // local buffer (excluded by excludeLastN=4)
      { role: 'user', content: 'buffer one', createdAt: nowMs - 2 * HOUR },
      { role: 'assistant', content: 'buffer one reply', createdAt: nowMs - 2 * HOUR },
      { role: 'user', content: 'buffer two', createdAt: nowMs - HOUR },
      { role: 'assistant', content: 'buffer two reply', createdAt: nowMs - HOUR },
    ];
    const results = searchScored('carbonara pasta sauce with eggs pancetta', ageyLog, nowMs);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].turnIndex).toBe(1);
    // The rescue is doing real work: combined is below the normal threshold,
    // concept alone is above it.
    expect(results[0].timeScore).toBeLessThan(0.05);
    expect(results[0].combinedScore).toBeLessThan(0.08);
    expect(results[0].conceptScore).toBeGreaterThanOrEqual(0.08);
  });

  it('honors gated turns (active=false) via the underlying cosineSearch', () => {
    // Gate off pair 3 (yesterday's pasta) — both halves. The pasta query should
    // now only find pair 1 (the long-ago version).
    const gated: ChatEntry[] = log.map((e, i) =>
      i === 4 || i === 5 ? { ...e, active: false } : e,
    );
    const results = searchScored('carbonara recipe', gated, nowMs);
    expect(results.every((r) => r.turnIndex !== 3)).toBe(true);
  });
});
