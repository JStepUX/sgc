// Tests for the coercion contract the state turn's summary passes through
// (spec 09): the bounded `cues` list, the truncation mark, and the boundary
// normalisation hydrated rows get. The <turn-summary> scrubber's own tests
// live in prompt.test.ts.

import { coerceCues, coerceSummary, completeJson, dropTruncated, TRUNCATION_MARK } from './turn-parser';
import { CUE_MAX, CUE_MAX_CHARS, CUE_TOKEN_BUDGET } from './constants';
import { tokenize } from './tfidf';

describe('coerceCues', () => {
  it('keeps strings only, trimmed, cut to CUE_MAX_CHARS', () => {
    const long = 'x'.repeat(CUE_MAX_CHARS + 10);
    const out = coerceCues(['  fruit picking  ', 42, null, long], []);
    expect(out[0]).toBe('fruit picking');
    expect(out[1]).toHaveLength(CUE_MAX_CHARS);
  });

  it('drops a cue whose every stem is already in the summary lines (stem dedup)', () => {
    const lines = tokenize('said they ate at the harbour');
    // 'harbours' stems to 'harbour' — an inflection of a line word is not novel.
    expect(coerceCues(['harbour', 'the harbours'], lines)).toEqual([]);
  });

  it('drops a cue whose stems all appeared in an earlier cue', () => {
    expect(coerceCues(['fruit picking', 'picking fruit'], [])).toEqual(['fruit picking']);
  });

  it('stops at the novel-stem budget, keeping cues in order', () => {
    const cues = Array.from({ length: 10 }, (_, i) => `alpha${i} beta${i} gamma${i}`); // 3 novel stems each
    const out = coerceCues(cues, []);
    expect(out).toHaveLength(Math.floor(CUE_TOKEN_BUDGET / 3));
    expect(out[0]).toBe('alpha0 beta0 gamma0');
  });

  it('caps the list at CUE_MAX', () => {
    const cues = Array.from({ length: CUE_MAX + 3 }, (_, i) => `word${i}`);
    expect(coerceCues(cues, [])).toHaveLength(CUE_MAX);
  });

  it('yields [] for a non-array, a string, or an object', () => {
    expect(coerceCues('hero', [])).toEqual([]);
    expect(coerceCues({}, [])).toEqual([]);
    expect(coerceCues(undefined, [])).toEqual([]);
  });
});

describe('coerceSummary with cues', () => {
  it('carries cues only when the input had the key', () => {
    const legacy = coerceSummary({ persistent: ['a'], volatile: [], established_patterns: [] });
    expect(legacy).not.toBeNull();
    expect(legacy!.cues).toBeUndefined();
    expect('cues' in legacy!).toBe(false);
    const withCues = coerceSummary({ persistent: ['said they admire Harrow'], volatile: [], established_patterns: [], cues: ['hero', 'Harrow'] });
    expect(withCues!.cues).toEqual(['hero']); // 'Harrow' already in the lines → deduped away
  });

  it('a malformed cues field coerces to [] rather than throwing', () => {
    expect(coerceSummary({ persistent: [], cues: 'hero' })!.cues).toEqual([]);
    expect(coerceSummary({ persistent: [], cues: {} })!.cues).toEqual([]);
  });

  it('an oversized cues list is capped', () => {
    const many = Array.from({ length: 20 }, (_, i) => `cue${i}`);
    expect(coerceSummary({ persistent: [], cues: many })!.cues!.length).toBeLessThanOrEqual(CUE_MAX);
  });
});

describe('completeJson mark + dropTruncated (spec 09 D7)', () => {
  // Cut mid-string: the second item has no closing quote.
  const cut = '{"turn_summary": {"persistent": ["said they admire X", "said they work as a';

  it('completeJson without a mark behaves as before', () => {
    const parsed = JSON.parse(completeJson(cut)) as { turn_summary: { persistent: string[] } };
    expect(parsed.turn_summary.persistent).toEqual(['said they admire X', 'said they work as a']);
  });

  it('with a mark, the closed string carries it and dropTruncated removes that list item', () => {
    const parsed = JSON.parse(completeJson(cut, TRUNCATION_MARK)) as { turn_summary: { persistent: string[] } };
    expect(parsed.turn_summary.persistent[1].endsWith(TRUNCATION_MARK)).toBe(true);
    const cleaned = dropTruncated(parsed);
    expect(cleaned.turn_summary.persistent).toEqual(['said they admire X']);
  });

  it('a marked scalar keeps its partial text with the mark stripped', () => {
    const cut2 = '{"internal_state": {"goal": "keep the thread al';
    const cleaned = dropTruncated(JSON.parse(completeJson(cut2, TRUNCATION_MARK)) as { internal_state: { goal: string } });
    expect(cleaned.internal_state.goal).toBe('keep the thread al');
  });

  it('a complete response is untouched by the mark', () => {
    const whole = '{"turn_summary": {"persistent": ["a", "b"], "cues": ["c"]}}';
    expect(completeJson(whole, TRUNCATION_MARK)).toBe(whole);
    expect(dropTruncated(JSON.parse(whole))).toEqual({ turn_summary: { persistent: ['a', 'b'], cues: ['c'] } });
  });
});
