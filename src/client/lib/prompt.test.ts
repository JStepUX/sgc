// Tests for the prompt builder and — critically — the turn-response parser.
// parseTurnResponse must anchor on the LAST fenced json block: Sal's answer can
// legitimately contain an earlier JSON example, and parsing that as metadata
// silently corrupts the visible response.

import { buildPrompt, parseTurnResponse } from './prompt';
import type { Memory, ChatEntry } from './types';

describe('parseTurnResponse', () => {
  it('extracts the trailing metadata block and the prose before it', () => {
    const raw = 'Here is my answer.\n\n```json\n{"confidence_scores":{"M1":55}}\n```';
    const { displayText, metadata } = parseTurnResponse(raw);
    expect(displayText).toBe('Here is my answer.');
    expect(metadata?.confidence_scores.M1).toBe(55);
  });

  it('uses the LAST json block when the answer contains an earlier one (P1 regression)', () => {
    // Sal answers a JSON-shaped question with an example block, THEN appends
    // its required metadata. The example must survive; metadata is the final block.
    const raw = [
      'Sure — here is a sample config:',
      '```json',
      '{"timeout": 30, "retries": 3}',
      '```',
      'That sets a 30s timeout.',
      '',
      '```json',
      '{"confidence_scores":{"M1":50,"M2":48}}',
      '```',
    ].join('\n');
    const { displayText, metadata } = parseTurnResponse(raw);
    expect(displayText).toContain('sample config');
    expect(displayText).toContain('"timeout": 30');
    expect(displayText).toContain('That sets a 30s timeout.');
    expect(metadata?.confidence_scores).toEqual({ M1: 50, M2: 48 });
  });

  it('returns no metadata when there is no fenced json block', () => {
    const raw = 'Just a plain answer, no JSON anywhere.';
    const { displayText, metadata } = parseTurnResponse(raw);
    expect(displayText).toBe(raw);
    expect(metadata).toBeNull();
  });

  it('does not treat a trailing non-metadata json block as metadata', () => {
    // The answer ends with a JSON example that carries no confidence_scores —
    // it must not be swallowed or mistaken for metadata.
    const raw = 'Here is the shape:\n```json\n{"timeout": 30}\n```';
    const { displayText, metadata } = parseTurnResponse(raw);
    expect(metadata).toBeNull();
    expect(displayText).toBe(raw);
  });

  it('returns no metadata when the trailing block is malformed JSON', () => {
    const raw = 'Answer.\n```json\n{not valid json,,,}\n```';
    const { displayText, metadata } = parseTurnResponse(raw);
    expect(metadata).toBeNull();
    expect(displayText).toBe(raw);
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
