// Tests for the prompt builder and — critically — the turn-response parser.
// parseTurnResponse must anchor on the LAST <turn-meta> block: Sal's answer can
// legitimately mention the tag, and parsing that mention as metadata silently
// corrupts the visible response. stripStreamingMeta is the mid-stream sibling:
// it must hide the metadata block (and partial opening tags split across SSE
// chunks) so the block never flickers into the chat bubble.

import { buildPrompt, parseTurnResponse, stripStreamingMeta } from './prompt';
import type { Memory, ChatEntry } from './types';

describe('parseTurnResponse', () => {
  it('extracts the trailing metadata block and the prose before it', () => {
    const raw = 'Here is my answer.\n\n<turn-meta>\n{"confidence_scores":{"M1":55}}\n</turn-meta>';
    const { displayText, metadata } = parseTurnResponse(raw);
    expect(displayText).toBe('Here is my answer.');
    expect(metadata?.confidence_scores.M1).toBe(55);
  });

  it('uses the LAST turn-meta block when the answer mentions the tag earlier (P1 regression)', () => {
    // Sal explains the metadata protocol in prose — mentioning the tag — THEN
    // appends its real block. The explanation must survive; metadata is last.
    const raw = [
      'You asked how scoring works: I emit a <turn-meta> block at the end.',
      'That block carries the confidence scores.',
      '',
      '<turn-meta>',
      '{"confidence_scores":{"M1":50,"M2":48}}',
      '</turn-meta>',
    ].join('\n');
    const { displayText, metadata } = parseTurnResponse(raw);
    expect(displayText).toContain('how scoring works');
    expect(displayText).toContain('carries the confidence scores');
    expect(metadata?.confidence_scores).toEqual({ M1: 50, M2: 48 });
  });

  it('returns no metadata when there is no turn-meta block', () => {
    const raw = 'Just a plain answer, no metadata anywhere.';
    const { displayText, metadata } = parseTurnResponse(raw);
    expect(displayText).toBe(raw);
    expect(metadata).toBeNull();
  });

  it('does not treat a trailing non-metadata turn-meta block as metadata', () => {
    // The block ends the response but carries no confidence_scores — it must
    // not be swallowed or mistaken for metadata.
    const raw = 'Here is the shape:\n<turn-meta>\n{"timeout": 30}\n</turn-meta>';
    const { displayText, metadata } = parseTurnResponse(raw);
    expect(metadata).toBeNull();
    expect(displayText).toBe(raw);
  });

  it('returns no metadata when the trailing block is malformed JSON', () => {
    const raw = 'Answer.\n<turn-meta>\n{not valid json,,,}\n</turn-meta>';
    const { displayText, metadata } = parseTurnResponse(raw);
    expect(metadata).toBeNull();
    expect(displayText).toBe(raw);
  });

  it('returns no metadata when the opening tag is never closed', () => {
    const raw = 'Answer.\n<turn-meta>\n{"confidence_scores":{"M1":50}}';
    const { displayText, metadata } = parseTurnResponse(raw);
    expect(metadata).toBeNull();
    expect(displayText).toBe(raw);
  });
});

describe('stripStreamingMeta', () => {
  it('returns the text unchanged when no metadata tag is present', () => {
    expect(stripStreamingMeta('A partial answer so far')).toBe('A partial answer so far');
  });

  it('drops everything from the opening tag onward', () => {
    const raw = 'The finished prose.\n\n<turn-meta>\n{"confidence_scores":{"M1":50}}';
    expect(stripStreamingMeta(raw)).toBe('The finished prose.');
  });

  it('holds back a partial opening tag split across SSE chunks', () => {
    // The opening tag arrives one character at a time; none of it should leak.
    const prose = 'My answer.';
    for (const partial of ['<', '<tu', '<turn-', '<turn-meta']) {
      expect(stripStreamingMeta(prose + partial)).toBe(prose);
    }
  });

  it('keeps an interior < and releases a trailing one once the next chunk lands', () => {
    // A lone trailing '<' looks like the start of <turn-meta>, so it is held
    // back for the frame it arrives in...
    expect(stripStreamingMeta('Compare a <')).toBe('Compare a ');
    // ...then released once the next chunk proves it was just prose.
    expect(stripStreamingMeta('Compare a < b here')).toBe('Compare a < b here');
  });

  it('keeps a prose mention of the tag visible, hiding only the JSON-bearing block', () => {
    // Sal explains the metadata protocol in prose — a bare mention of the tag,
    // followed by words rather than `{`. It must NOT truncate the bubble.
    const proseMention = 'I emit a <turn-meta> block at the end of every turn.';
    expect(stripStreamingMeta(proseMention)).toBe(proseMention);

    // Once the real block streams in, that — and only that — is hidden, even
    // though an earlier mention of the tag appears first in the text.
    const withBlock = proseMention + '\n\n<turn-meta>\n{"confidence_scores":{"M1":50}}';
    expect(stripStreamingMeta(withBlock)).toBe(proseMention);
  });

  it('hides the real block the instant its opening tag arrives, before the JSON', () => {
    // The block has just opened — only whitespace has streamed after the tag.
    // It is hidden proactively so the literal <turn-meta> tag never flashes.
    expect(stripStreamingMeta('Done.\n\n<turn-meta>')).toBe('Done.');
    expect(stripStreamingMeta('Done.\n\n<turn-meta>\n')).toBe('Done.');
  });
});

describe('buildPrompt', () => {
  const memories: Memory[] = [
    { id: 'a', text: 'User likes brevity.', confidence: 50, history: [] },
  ];

  it('includes every memory with its confidence score', () => {
    const prompt = buildPrompt(memories, [], null);
    expect(prompt).toContain('[M1] (confidence: 50%) User likes brevity.');
  });

  it('omits the recent-context and retrieved-history sections when empty', () => {
    const prompt = buildPrompt(memories, [], null);
    expect(prompt).not.toContain('RECENT CONTEXT');
    expect(prompt).not.toContain('RETRIEVED HISTORY');
  });

  it('includes the local buffer when present', () => {
    const buffer: ChatEntry[] = [{ role: 'user', content: 'hello there' }];
    const prompt = buildPrompt(memories, buffer, null);
    expect(prompt).toContain('RECENT CONTEXT');
    expect(prompt).toContain('user: hello there');
  });
});
