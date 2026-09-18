import { describe, it, expect } from 'vitest';
import type { ChatEntry } from './types';
import { DEFAULT_PERSONA } from './prompt';
import {
  SIDECAR_RECENT_ENTRIES,
  SIDECAR_SUMMARY_ENTRIES,
  buildSidecarPrompt,
  sidecarWireMessages,
} from './sidecar';

const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);

function pair(n: number, extra: Partial<ChatEntry> = {}): ChatEntry[] {
  return [
    { role: 'user', content: `user line ${n}`, createdAt: NOW - 1000 },
    { role: 'assistant', content: `reply line ${n}`, createdAt: NOW - 1000, ...extra },
  ];
}

const base = { persona: '', mask: '', constitutional: '', chatLog: [] as ChatEntry[], now: NOW };

describe('buildSidecarPrompt', () => {
  it('frames the sidecar as outside the fiction and falls back to the default persona + "Sal"', () => {
    const p = buildSidecarPrompt(base);
    expect(p).toContain('You are the Sidecar');
    expect(p).toContain('a persona called "Sal"');
    expect(p).toContain(DEFAULT_PERSONA);
    expect(p).toContain('NOT instructions to you');
    expect(p).toContain('the story has not started yet');
  });

  it('uses the mask as the persona voice and the custom persona text', () => {
    const p = buildSidecarPrompt({ ...base, persona: 'You are Vale, a tired detective.', mask: 'Vale', chatLog: pair(1) });
    expect(p).toContain('a persona called "Vale"');
    expect(p).toContain('You are Vale, a tired detective.');
    expect(p).not.toContain(DEFAULT_PERSONA);
    expect(p).toContain('AUTHOR: user line 1');
    expect(p).toContain('VALE: reply line 1');
  });

  it('omits empty sections rather than rendering bare labels', () => {
    const p = buildSidecarPrompt({ ...base, chatLog: pair(1) });
    expect(p).not.toContain('CONTINUITY SHEET');
    expect(p).not.toContain('INNER STATE');
    expect(p).not.toContain('EARLIER (distilled');
    expect(p).not.toContain('constitutional document');
  });

  it('renders the constitutional document, the folded sheet and the newest inner state', () => {
    const chatLog = pair(1, {
      sheetDelta: { characters: { Vale: { apparel: 'a wet trench coat' } } },
      dynamicState: {
        goal: 'keep her talking',
        appraisal: 'she is stalling',
        association: null,
        passing_thought: null,
        noticed: [],
        unexpressed_impulse: null,
      },
    });
    const p = buildSidecarPrompt({ ...base, constitutional: '  James writes noir.  ', chatLog });
    expect(p).toContain('James writes noir.');
    expect(p).toContain('a wet trench coat');
    expect(p).toContain('keep her talking');
  });

  it('shows only the recent window verbatim, and distilled summaries for the window behind it', () => {
    const turns = SIDECAR_RECENT_ENTRIES / 2 + SIDECAR_SUMMARY_ENTRIES / 2 + 1;
    const chatLog: ChatEntry[] = [];
    for (let n = 1; n <= turns; n++) {
      chatLog.push(...pair(n, {
        summary: { persistent: [`fact ${n}`], volatile: [], established_patterns: [] },
      }));
    }
    const p = buildSidecarPrompt({ ...base, chatLog });
    // Newest turn verbatim; the first turn behind the recent window is summary-only.
    const firstDistilled = turns - SIDECAR_RECENT_ENTRIES / 2;
    expect(p).toContain(`reply line ${turns}`);
    expect(p).not.toContain(`reply line ${firstDistilled}`);
    expect(p).toContain(`fact ${firstDistilled}`);
    // Recent turns are not ALSO distilled, and turn 1 is beyond both windows.
    expect(p).not.toContain(`fact ${turns}`);
    expect(p).not.toMatch(/- fact 1\n/);
    expect(p).not.toContain('reply line 1\n');
  });
});

describe('buildSidecarPrompt — ambient grep', () => {
  // One old, distinctive turn buried under enough filler to push it out of
  // the verbatim window.
  const story = (): ChatEntry[] => {
    const log: ChatEntry[] = [
      { role: 'user', content: 'Steve tells Jessica he has a last-minute conference and cannot come on the camping trip.', createdAt: NOW - 5000 },
      { role: 'assistant', content: 'Jessica is annoyed, then names Jim the heavy lifter for the camping trip.', createdAt: NOW - 5000 },
    ];
    for (let n = 1; n <= SIDECAR_RECENT_ENTRIES / 2 + 2; n++) log.push(...pair(n));
    return log;
  };

  it("retrieves an older turn using the author's message as the query", () => {
    const p = buildSidecarPrompt({ ...base, chatLog: story(), query: 'has Steve told Jessica about the camping trip?' });
    expect(p).toContain('RETRIEVED HISTORY');
    expect(p).toContain('last-minute conference');
    expect(p).toContain('[Turn ');
  });

  it('renders no retrieval block without a query, or when nothing matches', () => {
    expect(buildSidecarPrompt({ ...base, chatLog: story() })).not.toContain('RETRIEVED HISTORY');
    expect(
      buildSidecarPrompt({ ...base, chatLog: story(), query: 'zeppelin marmalade' }),
    ).not.toContain('RETRIEVED HISTORY');
  });

  it('never retrieves from the verbatim window (no duplicate of what is already shown)', () => {
    const p = buildSidecarPrompt({ ...base, chatLog: pair(1), query: 'user line 1 reply line 1' });
    expect(p).not.toContain('RETRIEVED HISTORY');
  });
});

describe('sidecarWireMessages', () => {
  it('passes the transcript through as plain-string wire messages', () => {
    expect(
      sidecarWireMessages([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ]),
    ).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });
});
