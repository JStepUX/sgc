// Behavioral tests for the paragraph cap (paragraph-cap.ts): counting across
// fragment boundaries, the held-back trailing newline, empty paragraphs not
// counting, and the exact text emitted at the cut. The fixtures for what IS
// and ISN'T a break mirror src/client/lib/pacing.test.ts — the regex is a
// copy on each side and these keep them equal.

import { PARAGRAPH_BREAK, createParagraphCap } from './paragraph-cap';

/** Run a whole stream through a cap, collecting what would reach the client. */
function run(max: number, fragments: string[]): { out: string; reached: boolean; count: number } {
  const cap = createParagraphCap(max);
  let out = '';
  for (const f of fragments) {
    const { emit, reached } = cap.feed(f);
    out += emit;
    if (reached) return { out, reached: true, count: cap.count };
  }
  out += cap.flush();
  return { out, reached: false, count: cap.count };
}

describe('PARAGRAPH_BREAK (server copy)', () => {
  it('is byte-identical to the client regex', () => {
    expect(PARAGRAPH_BREAK.source).toBe('\\n[ \\t]*\\n');
  });
  it('matches a blank line, with or without horizontal whitespace, and nothing else', () => {
    const re = () => new RegExp(PARAGRAPH_BREAK.source);
    expect(re().test('a\n\nb')).toBe(true);
    expect(re().test('a\n  \t \nb')).toBe(true);
    expect(re().test('a\nb')).toBe(false);
    expect(re().test('a  \nb')).toBe(false);
  });
});

describe('createParagraphCap', () => {
  it('passes an under-ceiling reply through byte-identical, trailing newline included', () => {
    expect(run(3, ['One.\n\n', 'Two.\n'])).toEqual({ out: 'One.\n\nTwo.\n', reached: false, count: 1 });
  });

  it('cuts at the Nth break and drops everything after it', () => {
    const r = run(2, ['One.\n\nTwo.\n\nThree starts here and keeps']);
    expect(r).toEqual({ out: 'One.\n\nTwo.', reached: true, count: 2 });
  });

  it('counts a break that straddles two fragments', () => {
    expect(run(1, ['One.\n', '\nTwo.'])).toEqual({ out: 'One.', reached: true, count: 1 });
    expect(run(1, ['One.\n  ', '\nTwo.'])).toEqual({ out: 'One.', reached: true, count: 1 });
  });

  it('holds back a trailing newline, then releases it once it proves not to be a break', () => {
    const cap = createParagraphCap(3);
    expect(cap.feed('Line one\n')).toEqual({ emit: 'Line one', reached: false });
    expect(cap.feed('line two')).toEqual({ emit: '\nline two', reached: false });
    expect(cap.flush()).toBe('');
  });

  it('releases held whitespace at a natural end of stream', () => {
    const cap = createParagraphCap(3);
    cap.feed('Done.\n');
    expect(cap.flush()).toBe('\n');
  });

  it('does not count empty paragraphs: leading blank lines or runs of newlines', () => {
    expect(run(1, ['\n\nOne.\n\n\n\nTwo.'])).toEqual({ out: '\n\nOne.', reached: true, count: 1 });
    // Three paragraphs separated by triple newlines are still three, not five.
    expect(run(3, ['A.\n\n\nB.\n\n\nC.\n\n\nD.'])).toEqual({ out: 'A.\n\n\nB.\n\n\nC.', reached: true, count: 3 });
  });

  it('is fed one character at a time without changing the result', () => {
    const text = 'One.\n\nTwo two.\n \nThree.\n\nFour is dropped';
    const whole = run(3, [text]);
    const chars = run(3, [...text]);
    expect(chars).toEqual(whole);
    expect(whole.out).toBe('One.\n\nTwo two.\n \nThree.');
  });

  it('returns nothing on every feed after the cut', () => {
    const cap = createParagraphCap(1);
    expect(cap.feed('A.\n\nB').reached).toBe(true);
    expect(cap.feed('more')).toEqual({ emit: '', reached: true });
    expect(cap.flush()).toBe('');
  });

  it('strips trailing horizontal whitespace from the paragraph it cuts on', () => {
    expect(run(1, ['Kept.   \n\nDropped']).out).toBe('Kept.');
  });

  it('rejects a non-positive or non-integer ceiling', () => {
    expect(() => createParagraphCap(0)).toThrow();
    expect(() => createParagraphCap(2.5)).toThrow();
  });
});
