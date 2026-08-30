import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { renderWithHighlights } from './highlight';
import { stem } from './stem';

/** Render the node array and hand back the container + its <mark> elements. */
function paint(text: string, stems: string[]) {
  const { container } = render(<div>{renderWithHighlights(text, stems)}</div>);
  return {
    container,
    marks: [...container.querySelectorAll('mark')].map((m) => m.textContent),
  };
}

describe('renderWithHighlights', () => {
  it('returns the text untouched when the stem set is empty', () => {
    const out = renderWithHighlights('maren runs a studio', []);
    expect(out).toEqual(['maren runs a studio']);
  });

  it('wraps a matching word in <mark> and leaves the rest plain', () => {
    const { container, marks } = paint('maren runs a studio', ['maren']);
    expect(marks).toEqual(['maren']);
    expect(container.textContent).toBe('maren runs a studio');
  });

  it('matches stemmed vocabulary against inflected surface forms', () => {
    // The engine reports stems — "glassblow" must light up "glassblowing".
    const { marks } = paint('her glassblowing studio', [stem('glassblowing')]);
    expect(marks).toEqual(['glassblowing']);
  });

  it('matches case-insensitively', () => {
    const { marks } = paint('Maren and MAREN and maren', ['maren']);
    expect(marks).toEqual(['Maren', 'MAREN', 'maren']);
  });

  it('does not light up a substring inside a longer word', () => {
    // "kiln" as a term must not mark "kilnworthy" unless they share a stem —
    // the word-boundary split guarantees whole-word tokenization.
    const { marks } = paint('the cat sat on concatenate', [stem('cat')]);
    expect(marks).toEqual(['cat']);
  });

  it('skips stopwords even when their stem collides with a term', () => {
    // tokenize() drops "make" (stopword) pre-stem, so it can never match —
    // even against the stem of the content word "makes".
    const { marks } = paint('make it so', [stem('makes')]);
    expect(marks).toEqual([]);
  });

  it('preserves punctuation and whitespace around highlights', () => {
    const { container, marks } = paint('maren, obviously — maren!', ['maren']);
    expect(marks).toEqual(['maren', 'maren']);
    expect(container.textContent).toBe('maren, obviously — maren!');
  });

  it('preserves newlines in the output', () => {
    const { container } = paint('line one\nline two', ['line']);
    expect(container.textContent).toBe('line one\nline two');
  });
});
