// Behavioral tests for assembleTurnContext — the deterministic context-assembly
// shared by the live turn and the response editor's re-spin. The load-bearing
// guarantees: it is pure (no hidden Date.now()), it caps the verbatim buffer,
// and — critically — it reads ONLY `priorLog`, so a re-spin that slices the log
// to before a target turn cannot let later-turn content leak into the
// reconstruction.

import { describe, expect, it } from 'vitest';
import { assembleTurnContext } from './turn-context';
import { LOCAL_BUFFER_SIZE } from './constants';
import type { ChatEntry, Memory } from './types';

const HOUR = 3_600_000;
const NOW = 1_700_000_000_000;

// One user+assistant pair, both halves sharing an instant (matches the corpus).
function turnPair(userText: string, assistantText: string, ageHours: number): ChatEntry[] {
  const t = NOW - ageHours * HOUR;
  return [
    { role: 'user', content: userText, createdAt: t },
    { role: 'assistant', content: assistantText, createdAt: t },
  ];
}

const memories: Memory[] = [{ id: 'm1', text: 'The user is named Ada.' }];

describe('assembleTurnContext', () => {
  it('is deterministic for identical inputs (no hidden Date.now())', () => {
    const log = [...turnPair('first question about cats', 'cats answer', 40), ...turnPair('second about dogs', 'dogs answer', 30)];
    const args = { query: 'cats', priorLog: log, memories, persona: 'P', now: NOW, fetchedDocs: [], failedUrls: [] };
    expect(assembleTurnContext(args).systemPrompt).toBe(assembleTurnContext(args).systemPrompt);
  });

  it('caps the verbatim buffer at LOCAL_BUFFER_SIZE and renders the constitutional memory', () => {
    const log = [
      ...turnPair('q1', 'a1', 40),
      ...turnPair('q2', 'a2', 30),
      ...turnPair('q3', 'a3', 20),
    ];
    const { systemPrompt, localBufferSize } = assembleTurnContext({
      query: 'q3', priorLog: log, memories, persona: 'P', now: NOW, fetchedDocs: [], failedUrls: [],
    });
    expect(localBufferSize).toBe(LOCAL_BUFFER_SIZE);
    expect(systemPrompt).toContain('Ada'); // constitutional tier rendered
    expect(systemPrompt).toContain('a3'); // most-recent assistant sits in the verbatim buffer
  });

  it('leak guard: only priorLog is read — a later turn cannot surface in a re-spin', () => {
    const SENTINEL = 'ZQXLEAK';
    const full = [
      ...turnPair('apples oranges fruit basket', 'a fruit reply', 60),
      ...turnPair('filler one', 'filler reply one', 50),
      ...turnPair('filler two', 'filler reply two', 45),
      ...turnPair('filler three', 'filler reply three', 40),
      // A FUTURE turn (the most recent) carrying the sentinel.
      ...turnPair(`xylophone ${SENTINEL}`, `xylophone reply ${SENTINEL}`, 5),
    ];

    // Positive control: with the full log the future turn sits in the verbatim
    // buffer, so its content (sentinel and all) reaches the prompt.
    const withFuture = assembleTurnContext({
      query: 'xylophone', priorLog: full, memories, persona: 'P', now: NOW, fetchedDocs: [], failedUrls: [],
    });
    expect(withFuture.systemPrompt).toContain(SENTINEL);

    // Re-spin reconstruction: slice to BEFORE the future turn (turns 1–4, 8
    // entries). The helper reads only this slice, so the sentinel must vanish.
    const reconstructed = assembleTurnContext({
      query: 'xylophone', priorLog: full.slice(0, 8), memories, persona: 'P', now: NOW, fetchedDocs: [], failedUrls: [],
    });
    expect(reconstructed.systemPrompt).not.toContain(SENTINEL);
  });

  it('threads a spontaneity directive into the prompt — and omits it when none', () => {
    const log = [...turnPair('q1', 'a1', 20), ...turnPair('q2', 'a2', 10)];
    const base = { query: 'q', priorLog: log, memories, persona: 'P', now: NOW, fetchedDocs: [], failedUrls: [] };

    const fired = assembleTurnContext({ ...base, spontaneityDirective: '@!OPERATOR: Zed!@ — a deliberate nudge' });
    expect(fired.systemPrompt).toContain('SPONTANEITY OPERATOR');
    expect(fired.systemPrompt).toContain('a deliberate nudge');

    // No directive → no block. (Re-spin passes the snapshotted directive here to
    // reproduce a turn; a fresh turn passes its draw. Either way it's caller-supplied.)
    expect(assembleTurnContext(base).systemPrompt).not.toContain('SPONTANEITY OPERATOR');
  });
});
