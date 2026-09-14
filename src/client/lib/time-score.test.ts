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

  it('negates recency for a timeless turn: timeScore is forced to 1.0', () => {
    // A very old topical pair flagged timeless. Without the flag the recency
    // decay would crush its time score (~0.014 at 60 days); timeless pins it to
    // 1.0 so it ranks on concept alone — a manually-curated fact isn't stale.
    const veryOld = nowMs - 60 * DAY;
    const tl: ChatEntry[] = [
      { role: 'user', content: 'how do I make carbonara pasta sauce with eggs and pancetta', createdAt: veryOld, timeless: true },
      { role: 'assistant', content: 'carbonara needs eggs pancetta pasta starchy water', createdAt: veryOld, timeless: true },
      { role: 'user', content: 'unrelated topic about clouds and weather patterns', createdAt: veryOld + HOUR },
      { role: 'assistant', content: 'clouds form from condensation of water vapor', createdAt: veryOld + HOUR },
      // local buffer (excluded by excludeLastN=4)
      { role: 'user', content: 'buffer one', createdAt: nowMs - 2 * HOUR },
      { role: 'assistant', content: 'buffer one reply', createdAt: nowMs - 2 * HOUR },
      { role: 'user', content: 'buffer two', createdAt: nowMs - HOUR },
      { role: 'assistant', content: 'buffer two reply', createdAt: nowMs - HOUR },
    ];
    const results = searchScored('carbonara pasta sauce with eggs pancetta', tl, nowMs);
    expect(results.length).toBeGreaterThan(0);
    const hit = results.find((r) => r.turnIndex === 1);
    expect(hit).toBeDefined();
    expect(hit!.timeless).toBe(true);
    expect(hit!.timeScore).toBe(1);
    // Combined collapses to the concept score — recency contributes nothing.
    expect(hit!.combinedScore).toBeCloseTo(hit!.conceptScore, 8);
  });

  it('a timeless turn ignores time intent in the query', () => {
    // Even with an explicit "yesterday" anchor, a 60-day-old timeless turn keeps
    // timeScore = 1 (intent doesn't pull it down) — it's not anchored in time.
    const veryOld = nowMs - 60 * DAY;
    const tl: ChatEntry[] = [
      { role: 'user', content: 'remember my passport number conversation', createdAt: veryOld, timeless: true },
      { role: 'assistant', content: 'passport number stored as a standing fact', createdAt: veryOld, timeless: true },
      { role: 'user', content: 'filler about gardening tomatoes', createdAt: veryOld + HOUR },
      { role: 'assistant', content: 'tomatoes need sun and water', createdAt: veryOld + HOUR },
      { role: 'user', content: 'buffer one', createdAt: nowMs - 2 * HOUR },
      { role: 'assistant', content: 'buffer one reply', createdAt: nowMs - 2 * HOUR },
      { role: 'user', content: 'buffer two', createdAt: nowMs - HOUR },
      { role: 'assistant', content: 'buffer two reply', createdAt: nowMs - HOUR },
    ];
    const results = searchScored('what was my passport number from yesterday', tl, nowMs);
    const hit = results.find((r) => r.turnIndex === 1);
    expect(hit).toBeDefined();
    expect(hit!.timeScore).toBe(1);
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

describe('searchScored with the product engine (spec 08 S1)', () => {
  // A single continuous scene: every turn shares the same furniture words,
  // exactly one turn carries an anchor. Synthetic vocabulary — the fixture
  // illustrates a SHAPE (same scene, no anchor vs. one real anchor), nothing
  // in the engine knows these words.
  const nowMs = NOW.getTime();
  function scene(pairs: number, anchorAt: number): ChatEntry[] {
    const log: ChatEntry[] = [];
    for (let i = 0; i < pairs; i++) {
      const t = nowMs - (pairs + 2 - i) * HOUR;
      const anchor = i === anchorAt ? ' She mentioned Harrow and the ferry timetable.' : '';
      log.push(
        { role: 'user', content: `The lantern on the table threw light across the window.${anchor}`, createdAt: t },
        { role: 'assistant', content: 'Lantern, table, window; the room held still.', createdAt: t },
      );
    }
    // Two trailing pairs form the excluded local buffer.
    log.push(
      { role: 'user', content: 'buffer one', createdAt: nowMs - 2 * HOUR },
      { role: 'assistant', content: 'buffer one reply', createdAt: nowMs - 2 * HOUR },
      { role: 'user', content: 'buffer two', createdAt: nowMs - HOUR },
      { role: 'assistant', content: 'buffer two reply', createdAt: nowMs - HOUR },
    );
    return log;
  }
  const opts = { excludeLastN: 4, topK: 3, threshold: 0.08, engine: 'product' as const };
  const FURNITURE = 'the lantern on the table by the window';
  const ANCHOR = 'Harrow and the ferry timetable';

  it('carries both engine components on every result, and combined = concept × time', () => {
    const r = searchScored(ANCHOR, scene(12, 5), nowMs, opts);
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].cosineScore).toBeGreaterThan(0);
    expect(r[0].bm25Score).toBeGreaterThan(0);
    expect(r[0].conceptScore).toBeCloseTo(r[0].cosineScore * r[0].bm25Score, 8);
    expect(r[0].combinedScore).toBeCloseTo(r[0].conceptScore * r[0].timeScore, 8);
  });

  it('small corpus (4 retrievable turns): the furniture query scores under half the anchor query — a GAP, not silence', () => {
    // At N=4 a universal term's BM25 IDF is small but not ~0 (ln(1 + 0.5/4.5)),
    // so furniture still clears 0.08 here; the veto sharpens with N.
    const log = scene(4, 2);
    const furniture = searchScored(FURNITURE, log, nowMs, { ...opts, threshold: 0 });
    const anchor = searchScored(ANCHOR, log, nowMs, { ...opts, threshold: 0 });
    expect(anchor[0].turnIndex).toBe(3);
    expect(furniture[0].combinedScore).toBeLessThan(anchor[0].combinedScore / 2);
  });

  it('scene of 12 turns: the furniture query returns NOTHING at 0.08 while the anchor query returns its turn', () => {
    const log = scene(12, 5);
    expect(searchScored(FURNITURE, log, nowMs, opts)).toEqual([]);
    const anchor = searchScored(ANCHOR, log, nowMs, opts);
    expect(anchor.map((r) => r.turnIndex)).toEqual([6]);
  });

  it('cosine, by contrast, retrieves the furniture query on the same 12-turn scene (the failure S1 removes)', () => {
    const r = searchScored(FURNITURE, scene(12, 5), nowMs, { ...opts, engine: 'cosine' });
    expect(r.length).toBe(3);
  });
});

describe('parseTimeIntent narrative filters (spec 08 S2)', () => {
  // Every assertion here runs against the REAL chrono output — the rules key
  // on its certainty flags, and those are not what intuition says (a bare
  // "April" is month-certain only; "this morning" has nothing certain;
  // "4 years ago" is year-certain only). Change chrono, re-run, re-read.
  const JUNE_15 = new Date(2026, 5, 15, 12, 0);
  const JAN_1 = new Date(2026, 0, 1, 12, 0);
  const SUNDAY_SEP_13 = new Date(2026, 8, 13, 12, 0);

  it('R1: a character whose name is a month is not a date', () => {
    const intent = parseTimeIntent('April: *she waves at him from the doorway*', JUNE_15);
    expect(intent.anchor).toBeNull();
    expect(intent.phrase).toBeNull();
    expect(intent.rejected).toBe('April');
  });

  it('R1: a duration in years is not a date ("4 years ago", "in 4 years")', () => {
    for (const q of ['we met 4 years ago', 'in 4 years this will be over']) {
      const intent = parseTimeIntent(q, JUNE_15);
      expect(intent.anchor, q).toBeNull();
      expect(intent.rejected, q).toMatch(/4 years/);
    }
  });

  it('documents that "we have at least 4 years" and "on the 9th" do not parse at all — they exercise nothing', () => {
    for (const q of ['we have at least 4 years', 'on the 9th']) {
      const intent = parseTimeIntent(q, JUNE_15);
      expect(intent.anchor, q).toBeNull();
      expect(intent.rejected, q).toBeUndefined();
    }
  });

  it('R1: nothing-certain scene words are not dates ("this afternoon", "evening", "night")', () => {
    for (const q of ['this afternoon she left', 'in the evening she left', 'night fell over the harbour']) {
      const intent = parseTimeIntent(q, JUNE_15);
      expect(intent.anchor, q).toBeNull();
      expect(intent.rejected, q).toBeDefined();
    }
  });

  it('R3: present-tense phrases at now are dropped ("right now", "tonight", "today")', () => {
    for (const q of ['what is happening right now', 'tonight we rest', 'what did I say today']) {
      const intent = parseTimeIntent(q, JUNE_15);
      expect(intent.anchor, q).toBeNull();
      expect(intent.rejected, q).toBeDefined();
    }
  });

  it('R1 keeps "a month ago" (year + month certain, day implied)', () => {
    const intent = parseTimeIntent('the argument we had a month ago', JUNE_15);
    expect(intent.anchor).not.toBeNull();
    const days = ((intent.anchor as number) - JUNE_15.getTime()) / DAY;
    expect(days).toBeGreaterThan(-32);
    expect(days).toBeLessThan(-28);
    expect(intent.rejected).toBeUndefined();
  });

  it('R2: "May 1" with a log that starts in early May → anchored', () => {
    const oldest = new Date(2026, 4, 5).getTime();
    const intent = parseTimeIntent('that piece on May 1', JUNE_15, { oldest });
    expect(intent.anchor).not.toBeNull();
    expect(new Date(intent.anchor as number).getMonth()).toBe(4);
  });

  it('R2: "May 1" with a log that starts in June → rejected (no such turn exists)', () => {
    const oldest = new Date(2026, 5, 1).getTime();
    const intent = parseTimeIntent('that piece on May 1', JUNE_15, { oldest });
    expect(intent.anchor).toBeNull();
    expect(intent.rejected).toBe('May 1');
  });

  it('R2: year roll-back — "May 1" asked on Jan 1 means LAST May, not the coming one', () => {
    // chrono with forwardDate:false still resolves this to May of the current
    // year (+120 d). A year-uncertain anchor beyond next week rolls back.
    const oldest = new Date(2025, 3, 1).getTime();
    const intent = parseTimeIntent('that piece on May 1', JAN_1, { oldest });
    expect(intent.anchor).not.toBeNull();
    const d = new Date(intent.anchor as number);
    expect(d.getFullYear()).toBe(2025);
    expect(d.getMonth()).toBe(4);
  });

  it('documented pass-through: a bare weekday on a Sunday resolves to tomorrow and is kept (inside the +τ allowance)', () => {
    const intent = parseTimeIntent('Monday', SUNDAY_SEP_13);
    expect(intent.anchor).not.toBeNull();
    const days = ((intent.anchor as number) - SUNDAY_SEP_13.getTime()) / DAY;
    expect(days).toBeGreaterThan(0);
    expect(days).toBeLessThan(2);
  });

  it('first SURVIVOR wins: a rejected phrase before a real cue does not block the cue, and is reported', () => {
    const intent = parseTimeIntent('April asked what we said yesterday', JUNE_15);
    expect(intent.anchor).not.toBeNull();
    expect(intent.phrase?.toLowerCase()).toContain('yesterday');
    expect(intent.rejected).toBe('April');
  });

  it('keeps: yesterday, last night, last Monday, 3 days ago, last week', () => {
    for (const q of ['yesterday', 'last night', 'last Monday', '3 days ago', 'last week']) {
      const intent = parseTimeIntent(`what did we say ${q}`, JUNE_15);
      expect(intent.anchor, q).not.toBeNull();
      expect(intent.rejected, q).toBeUndefined();
    }
  });
});

describe('searchScored under the narrative filters (spec 08 S2)', () => {
  const nowMs = NOW.getTime();
  const longAgo = nowMs - 30 * DAY;
  const yesterday = nowMs - 1 * DAY;
  const log: ChatEntry[] = [
    { role: 'user', content: 'how do I make carbonara pasta sauce', createdAt: longAgo },
    { role: 'assistant', content: 'carbonara needs eggs pancetta pasta', createdAt: longAgo },
    { role: 'user', content: 'remind me about the carbonara recipe', createdAt: yesterday },
    { role: 'assistant', content: 'eggs pancetta pasta still the answer', createdAt: yesterday },
    { role: 'user', content: 'buffer one', createdAt: nowMs - 2 * HOUR },
    { role: 'assistant', content: 'buffer one reply', createdAt: nowMs - 2 * HOUR },
    { role: 'user', content: 'buffer two', createdAt: nowMs - HOUR },
    { role: 'assistant', content: 'buffer two reply', createdAt: nowMs - HOUR },
  ];

  it('a narrative month name in the query scores exactly as a query with no time phrase', () => {
    const plain = searchScored('carbonara', log, nowMs);
    const narrative = searchScored('carbonara, April said', log, nowMs);
    expect(narrative.map((r) => r.turnIndex)).toEqual(plain.map((r) => r.turnIndex));
    expect(narrative.map((r) => r.timeScore)).toEqual(plain.map((r) => r.timeScore));
  });

  it('a real cue still steers: "yesterday" puts the yesterday turn first', () => {
    const r = searchScored('carbonara yesterday', log, nowMs);
    expect(r[0].turnIndex).toBe(2);
    expect(r[0].timeScore).toBeCloseTo(1, 1);
  });

  it('R2 uses the eligible span: an absolute date before the log started does not anchor', () => {
    // The log starts 30 days before now (2026-05-23). "May 1" is 22 days back,
    // inside the span, so it anchors and re-ranks; "March 1" is before the
    // oldest turn, so it is rejected and the ranking equals the plain query's.
    const plain = searchScored('carbonara', log, nowMs);
    const inside = searchScored('carbonara on May 1', log, nowMs);
    expect(inside.map((r) => r.timeScore)).not.toEqual(plain.map((r) => r.timeScore));
    const early = searchScored('carbonara on March 1', log, nowMs);
    expect(early.map((r) => r.timeScore)).toEqual(plain.map((r) => r.timeScore));
  });
});

describe('searchScored fusion over the summary corpus (spec 08 S3)', () => {
  // Six retrievable pairs, every one with a summary (≥ SUMMARY_CORPUS_MIN_DOCS),
  // plus the 4-entry buffer. Synthetic vocabulary throughout — the fixture
  // illustrates the SHAPE S3 exists for: a label ("the harbour trip") that
  // the raw prose never states and the summary does.
  const nowMs = NOW.getTime();
  const sum = (persistent: string[], volatile: string[] = []) => ({ persistent, volatile, established_patterns: [] });
  const pairAt = (i: number, user: string, assistant: string, summary?: ReturnType<typeof sum>): ChatEntry[] => {
    const t = nowMs - (10 - i) * DAY;
    return [
      { role: 'user', content: user, createdAt: t },
      { role: 'assistant', content: assistant, createdAt: t, ...(summary ? { summary } : {}) },
    ];
  };
  const log: ChatEntry[] = [
    ...pairAt(1, 'the kiln ran hot all afternoon', 'the glaze crazed on the second shelf', sum(['kiln overheated, glaze crazed'])),
    ...pairAt(2, 'we ate sandwiches on the bench by the water and watched the boats come in', 'the gulls took the crusts', sum(['harbour trip: bench by the water, sandwiches, watched the boats'])),
    ...pairAt(3, 'the telescope mount kept slipping', 'tighten the azimuth clutch', sum(['telescope mount slipping; azimuth clutch'])),
    ...pairAt(4, 'she taught the knitting class again', 'cables this time, not lace', sum(['knitting class: cables'])),
    ...pairAt(5, 'the sourdough starter died', 'too cold on the sill', sum(['sourdough starter died on the cold sill'])),
    ...pairAt(6, 'the harbour ferry was cancelled by the storm', 'we drove the long way round', sum(['harbour ferry cancelled by storm; drove round'])),
    { role: 'user', content: 'buffer one', createdAt: nowMs - 2 * HOUR },
    { role: 'assistant', content: 'buffer one reply', createdAt: nowMs - 2 * HOUR },
    { role: 'user', content: 'buffer two', createdAt: nowMs - HOUR },
    { role: 'assistant', content: 'buffer two reply', createdAt: nowMs - HOUR },
  ];
  const opts = { excludeLastN: 4, topK: 3, threshold: 0.08, engine: 'product' as const };

  it('the label case: a query the raw prose never states retrieves the turn via its summary', () => {
    const r = searchScored('our harbour trip', log, nowMs, opts);
    const hit = r.find((x) => x.turnIndex === 2);
    expect(hit).toBeDefined();
    expect(hit!.source).toBe('summary');
    expect(hit!.summaryLines).toEqual(['harbour trip: bench by the water, sandwiches, watched the boats']);
    // A pointer serves no raw text.
    expect(hit!.userContent).toBe('');
    expect(hit!.assistContent).toBe('');
    // Nothing on turn 2 matched by raw: with the summary corpus removed the turn is absent.
    const stripped = log.map((e) => ({ ...e, summary: undefined }));
    expect(searchScored('our harbour trip', stripped, nowMs, opts).some((x) => x.turnIndex === 2)).toBe(false);
  });

  it('a turn matched in both corpora is ONE result: raw rank, raw body, source both, summary lines attached', () => {
    const r = searchScored('the sourdough starter', log, nowMs, opts);
    const hits = r.filter((x) => x.turnIndex === 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe('both');
    expect(hits[0].userContent).toContain('sourdough');
    expect(hits[0].summaryLines).toEqual(['sourdough starter died on the cold sill']);
  });

  it('raw fills first; summary hits only take the slots raw left empty; total ≤ topK', () => {
    // 'harbour' is raw-only on turn 6, summary-only on turn 2. Raw wins the
    // first slot regardless of score; the summary pointer fills the next.
    const r = searchScored('harbour', log, nowMs, opts);
    expect(r.length).toBeLessThanOrEqual(3);
    expect(r[0].turnIndex).toBe(6);
    expect(r[0].source).not.toBe('summary');
    expect(r.find((x) => x.turnIndex === 2)?.source).toBe('summary');
    // Every raw hit precedes every summary-only hit.
    const firstSummary = r.findIndex((x) => x.source === 'summary');
    const lastRaw = r.map((x) => x.source).lastIndexOf('turn');
    if (firstSummary !== -1 && lastRaw !== -1) expect(lastRaw).toBeLessThan(firstSummary);
  });

  it('a summary hit never displaces a raw hit when raw already fills topK', () => {
    // Turn 6 matches 'harbour' by raw (and its own summary, so it reads
    // 'both'); turn 2 matches only by summary. With one slot, raw keeps it.
    const r = searchScored('harbour trip', log, nowMs, { ...opts, topK: 1 });
    expect(r).toHaveLength(1);
    expect(r[0].turnIndex).toBe(6);
    expect(r[0].source).not.toBe('summary');
    expect(r[0].userContent).toContain('harbour ferry');
  });

  it('the summary corpus is not searched below SUMMARY_CORPUS_MIN_DOCS', () => {
    // Keep only two summaries (turn 2's among them): the label case then
    // finds nothing via summary — only the raw 'harbour' hit on turn 6.
    const sparse = log.map((e, i) => (i === 3 || i === 5 ? e : { ...e, summary: undefined }));
    const r = searchScored('our harbour trip', sparse, nowMs, opts);
    expect(r.some((x) => x.turnIndex === 2)).toBe(false);
    expect(r.every((x) => x.source === 'turn')).toBe(true);
  });

  it('a gated user half hides the pair from the summary corpus too', () => {
    const gated = log.map((e, i) => (i === 2 ? { ...e, active: false } : e));
    expect(searchScored('our harbour trip', gated, nowMs, opts).some((x) => x.turnIndex === 2)).toBe(false);
  });

  it('summary hits carry both engine components and time, like raw hits', () => {
    const r = searchScored('our harbour trip', log, nowMs, opts);
    const hit = r.find((x) => x.turnIndex === 2)!;
    expect(hit.cosineScore).toBeGreaterThan(0);
    expect(hit.bm25Score).toBeGreaterThan(0);
    expect(hit.combinedScore).toBeCloseTo(hit.conceptScore * hit.timeScore, 8);
    expect(hit.matchedTerms).toContain('harbour');
  });
});
