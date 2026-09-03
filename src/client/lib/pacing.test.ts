// Behavioral tests for reply pacing (lib/pacing.ts): the weighted ceiling draw
// with its no-repeat rule, the stopReason → outcome map, and the hard-cap
// fallback trim. Paragraph-break fixtures here are shared by value with the
// server counter's tests (src/server/paragraph-cap.test.ts) — the two regexes
// are copies and these pin them together.

import {
  PACING_DECK,
  PACING_MAX_PARAGRAPHS,
  PARAGRAPH_BREAK,
  drawPacingCeiling,
  pacingOutcomeFor,
  pacingOutcomeLabel,
  trimToLastParagraph,
  countParagraphs,
} from './pacing';

describe('PACING_DECK', () => {
  it('covers exactly 1..PACING_MAX_PARAGRAPHS with positive weights', () => {
    expect(PACING_DECK.map((d) => d.ceiling)).toEqual([1, 2, 3, 4, 5]);
    expect(PACING_MAX_PARAGRAPHS).toBe(5);
    expect(PACING_DECK.every((d) => d.weight > 0)).toBe(true);
  });

  it('is weighted toward two and three paragraphs', () => {
    const w = Object.fromEntries(PACING_DECK.map((d) => [d.ceiling, d.weight]));
    expect(w[2]).toBeGreaterThan(w[1]);
    expect(w[3]).toBeGreaterThan(w[4]);
    expect(w[5]).toBeLessThan(w[4]);
  });
});

describe('drawPacingCeiling', () => {
  it('walks the deck in order under a monotone rng (weighted draw)', () => {
    // total weight 6.6: rng 0 → 1; just past 1.0/6.6 → 2; past 3.0/6.6 → 3 …
    expect(drawPacingCeiling(null, () => 0)).toBe(1);
    expect(drawPacingCeiling(null, () => 1.5 / 6.6)).toBe(2);
    expect(drawPacingCeiling(null, () => 3.5 / 6.6)).toBe(3);
    expect(drawPacingCeiling(null, () => 5.5 / 6.6)).toBe(4);
    expect(drawPacingCeiling(null, () => 6.5 / 6.6)).toBe(5);
  });

  it('never repeats the previous ceiling', () => {
    for (const last of [1, 2, 3, 4, 5]) {
      for (let i = 0; i < 200; i++) {
        expect(drawPacingCeiling(last)).not.toBe(last);
      }
    }
  });

  it('draws every ceiling over time (no dead cards)', () => {
    const seen = new Set<number>();
    let last: number | null = null;
    for (let i = 0; i < 2000; i++) {
      last = drawPacingCeiling(last);
      seen.add(last);
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('tolerates rng() ≈ 1 (floating-point fallthrough → last candidate)', () => {
    expect(drawPacingCeiling(null, () => 0.999999999999)).toBe(5);
  });

  it('falls back to the full deck when exclusion would empty the pool', () => {
    expect(drawPacingCeiling(3, () => 0, [{ ceiling: 3, weight: 1 }])).toBe(3);
  });
});

describe('pacingOutcomeFor', () => {
  it('maps the two mechanical stops and treats everything else as natural', () => {
    expect(pacingOutcomeFor('max_paragraphs')).toBe('cut');
    expect(pacingOutcomeFor('max_tokens')).toBe('capped');
    expect(pacingOutcomeFor('end_turn')).toBe('natural');
    expect(pacingOutcomeFor('tool_use')).toBe('natural');
  });
});

describe('PARAGRAPH_BREAK', () => {
  it('matches a blank line, with or without horizontal whitespace, and nothing else', () => {
    const re = () => new RegExp(PARAGRAPH_BREAK.source);
    expect(re().test('a\n\nb')).toBe(true);
    expect(re().test('a\n  \t \nb')).toBe(true);
    expect(re().test('a\nb')).toBe(false); // a single newline is NOT a paragraph
    expect(re().test('a  \nb')).toBe(false); // markdown hard break is NOT a paragraph
    expect(re().test('a\n\n\nb')).toBe(true);
  });
});

describe('trimToLastParagraph', () => {
  it('drops the half paragraph after the last break', () => {
    expect(trimToLastParagraph('One done.\n\nTwo done.\n\nThree was cut mid')).toEqual({
      text: 'One done.\n\nTwo done.',
      trimmed: true,
    });
  });

  it('leaves text with no paragraph break untouched — the truncation stays visible', () => {
    const r = trimToLastParagraph('one enormous paragraph that ran past the whole budg');
    expect(r).toEqual({ text: 'one enormous paragraph that ran past the whole budg', trimmed: false });
  });

  it('reports nothing trimmed when only whitespace follows the last break', () => {
    expect(trimToLastParagraph('Done.\n\n')).toEqual({ text: 'Done.\n\n', trimmed: false });
    expect(trimToLastParagraph('Done.\n\n  \n')).toEqual({ text: 'Done.\n\n  \n', trimmed: false });
  });

  it('never applies sentence heuristics — dialogue and markdown punctuation are irrelevant', () => {
    // Everything before the last break survives verbatim, whatever it ends in.
    const text = '"Well," she said, *leaning in.* **Wait**\n\nand then the cap';
    expect(trimToLastParagraph(text).text).toBe('"Well," she said, *leaning in.* **Wait**');
  });

  it('strips trailing horizontal whitespace before the break it cuts at', () => {
    expect(trimToLastParagraph('Kept.   \n\nDropped').text).toBe('Kept.');
  });

  it('NEVER erases the reply: a break with no text before it is not a paragraph end (Codex finding)', () => {
    const r = trimToLastParagraph('\n\nOnly paragraph, cut mid');
    expect(r).toEqual({ text: '\n\nOnly paragraph, cut mid', trimmed: false });
    expect(trimToLastParagraph('\n  \n\t\nstill one paragraph cut').trimmed).toBe(false);
  });

  it('cuts after the last REAL paragraph across a run of blank lines', () => {
    expect(trimToLastParagraph('One.\n\n\n\nTwo cut mi')).toEqual({ text: 'One.', trimmed: true });
  });
});

describe('countParagraphs', () => {
  it('counts content-bearing segments only, matching the server counter', () => {
    expect(countParagraphs('')).toBe(0);
    expect(countParagraphs('\n\n  \n')).toBe(0);
    expect(countParagraphs('One.')).toBe(1);
    expect(countParagraphs('One.\n\nTwo.')).toBe(2);
    expect(countParagraphs('\n\nOne.\n\n\n\nTwo.\n\n')).toBe(2);
    expect(countParagraphs('single\nnewline is one')).toBe(1);
  });
});

describe('pacingOutcomeLabel', () => {
  it('reads each outcome, distinguishing a trimmed cap from an untrimmable one', () => {
    expect(pacingOutcomeLabel({ pacingOutcome: 'natural' })).toBe('stopped on its own');
    expect(pacingOutcomeLabel({ pacingOutcome: 'cut' })).toBe('cut at the ceiling');
    expect(pacingOutcomeLabel({ pacingOutcome: 'capped', pacingTrimmed: true })).toMatch(/trimmed to the last full paragraph/);
    expect(pacingOutcomeLabel({ pacingOutcome: 'capped', pacingTrimmed: false })).toMatch(/no paragraph break to trim to/);
    // A hand-edited reply (outcome cleared) and a pre-feature row both read the same.
    expect(pacingOutcomeLabel({ pacingOutcome: null })).toBe('no outcome recorded');
    expect(pacingOutcomeLabel({})).toBe('no outcome recorded');
  });
});
