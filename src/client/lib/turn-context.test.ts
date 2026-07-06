// Behavioral tests for assembleTurnContext — the deterministic context-assembly
// shared by the live turn and the response editor's re-spin. The load-bearing
// guarantees: it is pure (no hidden Date.now()), it caps the verbatim buffer,
// and — critically — it reads ONLY `priorLog`, so a re-spin that slices the log
// to before a target turn cannot let later-turn content leak into the
// reconstruction.

import { describe, expect, it } from 'vitest';
import { assembleTurnContext } from './turn-context';
import { buildBrainIndex } from './brains';
import { LOCAL_BUFFER_SIZE } from './constants';
import type { BrainPack, ChatEntry } from './types';

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

const constitutional = 'The user is named Ada.';

describe('assembleTurnContext', () => {
  it('is deterministic for identical inputs (no hidden Date.now())', () => {
    const log = [...turnPair('first question about cats', 'cats answer', 40), ...turnPair('second about dogs', 'dogs answer', 30)];
    const args = { query: 'cats', priorLog: log, constitutional, persona: 'P', now: NOW, fetchedDocs: [], failedUrls: [] };
    expect(assembleTurnContext(args).systemPrompt).toBe(assembleTurnContext(args).systemPrompt);
  });

  it('caps the verbatim buffer at LOCAL_BUFFER_SIZE and renders the constitutional memory', () => {
    const log = [
      ...turnPair('q1', 'a1', 40),
      ...turnPair('q2', 'a2', 30),
      ...turnPair('q3', 'a3', 20),
    ];
    const { systemPrompt, localBufferSize } = assembleTurnContext({
      query: 'q3', priorLog: log, constitutional, persona: 'P', now: NOW, fetchedDocs: [], failedUrls: [],
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
      query: 'xylophone', priorLog: full, constitutional, persona: 'P', now: NOW, fetchedDocs: [], failedUrls: [],
    });
    expect(withFuture.systemPrompt).toContain(SENTINEL);

    // Re-spin reconstruction: slice to BEFORE the future turn (turns 1–4, 8
    // entries). The helper reads only this slice, so the sentinel must vanish.
    const reconstructed = assembleTurnContext({
      query: 'xylophone', priorLog: full.slice(0, 8), constitutional, persona: 'P', now: NOW, fetchedDocs: [], failedUrls: [],
    });
    expect(reconstructed.systemPrompt).not.toContain(SENTINEL);
  });

  it('threads a spontaneity directive into the prompt — and omits it when none', () => {
    const log = [...turnPair('q1', 'a1', 20), ...turnPair('q2', 'a2', 10)];
    const base = { query: 'q', priorLog: log, constitutional, persona: 'P', now: NOW, fetchedDocs: [], failedUrls: [] };

    const fired = assembleTurnContext({ ...base, spontaneityDirective: '@!OPERATOR: Zed!@ — a deliberate nudge' });
    expect(fired.systemPrompt).toContain('SPONTANEITY OPERATOR');
    expect(fired.systemPrompt).toContain('a deliberate nudge');

    // No directive → no block. (Re-spin passes the snapshotted directive here to
    // reproduce a turn; a fresh turn passes its draw. Either way it's caller-supplied.)
    expect(assembleTurnContext(base).systemPrompt).not.toContain('SPONTANEITY OPERATOR');
  });
});

describe('assembleTurnContext — knowledge axis (mounted brains)', () => {
  const pack: BrainPack = {
    schema: 'sgc-brain/1',
    id: 'glassblowing',
    name: 'Glassblowing Notes',
    description: 'Studio notes on working hot glass.',
    version: '1.0',
    built_at: '2026-07-04T00:00:00Z',
    source: { tool: 'atlantis', schema: 'atlantis-salience-v1', stub: true },
    chunks: [
      {
        id: 'glass_000',
        title: 'Gathering from the Furnace',
        text: 'Gathering molten glass onto the blowpipe requires steady rotation at the furnace mouth.',
        summary: 'How to gather molten glass.',
        topics: ['gathering'],
        aliases: ['parison'],
        source: { file: 'raw/glass.md', doc: 'glass-notes', position: 0 },
        tokens: 20,
      },
    ],
  };

  const log = [
    ...turnPair('an old exchange about travel plans', 'a travel reply', 40),
    ...turnPair('filler one', 'filler reply one', 30),
    ...turnPair('filler two', 'filler reply two', 20),
  ];
  const base = { query: 'molten glass on the blowpipe', priorLog: log, constitutional, persona: 'P', now: NOW, fetchedDocs: [], failedUrls: [] };

  it('populates the knowledge block from the brain index (digest + matched fragment)', () => {
    const { knowledge, systemPrompt } = assembleTurnContext({ ...base, brainIndex: buildBrainIndex([pack]) });
    expect(knowledge).not.toBeNull();
    expect(knowledge!.digests).toHaveLength(1);
    expect(knowledge!.results.length).toBeGreaterThan(0);
    expect(knowledge!.results[0].chunkId).toBe('glass_000');
    expect(systemPrompt).toContain('PERSONA KNOWLEDGE');
    expect(systemPrompt).toContain('Gathering from the Furnace');
  });

  it('returns knowledge: null (and no prompt tier) when nothing is mounted', () => {
    for (const brainIndex of [undefined, null, buildBrainIndex([])]) {
      const { knowledge, systemPrompt } = assembleTurnContext({ ...base, brainIndex });
      expect(knowledge).toBeNull();
      expect(systemPrompt).not.toContain('PERSONA KNOWLEDGE');
    }
  });

  it('ISOLATION REGRESSION: grepResults are byte-identical with and without a mounted brain', () => {
    // The knowledge axis must never touch the memory axis. Same query, same
    // log, same instant — the memory grep's output must not move by one byte
    // when a brain is mounted.
    const without = assembleTurnContext(base);
    const withBrain = assembleTurnContext({ ...base, brainIndex: buildBrainIndex([pack]) });
    expect(JSON.stringify(withBrain.grepResults)).toBe(JSON.stringify(without.grepResults));
    expect(withBrain.localBufferSize).toBe(without.localBufferSize);
  });
});
