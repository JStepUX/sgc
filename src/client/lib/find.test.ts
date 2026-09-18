import { describe, it, expect } from 'vitest';
import { findMatches, resolveActive, stepMatch } from './find';

const thread = [
  { content: 'Steve has a Conference next week.' },
  { content: 'Jessica is annoyed.' },
  { content: 'The conference is in Denver; the **camping trip** goes ahead.' },
];

describe('findMatches', () => {
  it('finds every message containing the text, case-insensitively, in thread order', () => {
    expect(findMatches(thread, 'conference')).toEqual([0, 2]);
    expect(findMatches(thread, 'CAMPING trip')).toEqual([2]);
  });

  it('matches substrings, not words', () => {
    expect(findMatches(thread, 'annoy')).toEqual([1]);
  });

  it('returns nothing for a blank query or no hit', () => {
    expect(findMatches(thread, '   ')).toEqual([]);
    expect(findMatches(thread, 'zeppelin')).toEqual([]);
  });

  it('trims the query', () => {
    expect(findMatches(thread, '  denver ')).toEqual([2]);
  });
});

describe('resolveActive', () => {
  it('a fresh query (null cursor) lands on the newest match', () => {
    expect(resolveActive(null, 3)).toBe(2);
  });

  it('is -1 only when there are no matches', () => {
    expect(resolveActive(null, 0)).toBe(-1);
    expect(resolveActive(1, 0)).toBe(-1);
  });

  it('a cursor stranded at "no match" recovers when matches appear (never "0 of 1")', () => {
    expect(resolveActive(-1, 1)).toBe(0);
    expect(resolveActive(-1, 4)).toBe(3);
  });

  it('clamps a cursor left over from a longer result set', () => {
    expect(resolveActive(7, 2)).toBe(1);
    expect(resolveActive(1, 3)).toBe(1);
  });
});

describe('stepMatch', () => {
  it('wraps in both directions', () => {
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
    expect(stepMatch(1, 3, -1)).toBe(0);
  });

  it('is -1 with no matches', () => {
    expect(stepMatch(0, 0, 1)).toBe(-1);
  });
});
