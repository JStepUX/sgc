// Behavioral tests for the dialogue-quote splitter. The walker itself is
// trivial recursion; the regex + boundary handling is where the real risk
// lives, so we test it directly.

import { describe, it, expect } from 'vitest';
import { splitDialogue } from './rehype-quotes';

describe('splitDialogue', () => {
  it('returns a single text node when no quotes are present', () => {
    expect(splitDialogue('plain prose with no dialogue')).toEqual([
      { type: 'text', value: 'plain prose with no dialogue' },
    ]);
  });

  it('wraps straight-double-quoted dialogue in a text-ember span', () => {
    const result = splitDialogue('George said "What the heck?" and walked off.');
    expect(result).toEqual([
      { type: 'text', value: 'George said ' },
      {
        type: 'element',
        tagName: 'span',
        properties: { className: ['text-ember-bright'] },
        children: [{ type: 'text', value: '"What the heck?"' }],
      },
      { type: 'text', value: ' and walked off.' },
    ]);
  });

  it('wraps curly-double-quoted dialogue', () => {
    const result = splitDialogue('She whispered “hush” softly.');
    expect(result).toHaveLength(3);
    expect(result[1]).toMatchObject({
      type: 'element',
      tagName: 'span',
      properties: { className: ['text-ember-bright'] },
    });
    expect((result[1] as { children: { value: string }[] }).children[0].value).toBe(
      '“hush”',
    );
  });

  it('wraps multiple dialogue runs in one string', () => {
    const result = splitDialogue('"Hi," he said, "are you ok?"');
    const spans = result.filter((n) => n.type === 'element');
    expect(spans).toHaveLength(2);
  });

  it('does not match an empty pair of quotes', () => {
    expect(splitDialogue('he said "" and left')).toEqual([
      { type: 'text', value: 'he said "" and left' },
    ]);
  });

  it('does not cross a newline within a quote', () => {
    // The opening " has no matching " on the same logical line, so nothing
    // should be wrapped.
    const result = splitDialogue('he said "hello\nworld" later');
    expect(result.every((n) => n.type === 'text')).toBe(true);
  });
});
