// Behavioral tests for the recall executor — one tool call's worth of
// deterministic retrieval. No mocks: real searchScored over a hand-built log,
// same style as tfidf.test.ts. Window math assumes LOCAL_BUFFER_SIZE = 4 and
// SUMMARY_BUFFER_SIZE = 4 (see constants.ts): with 8 turns, turns 1–4 are
// retrievable, 5–6 sit in the summary window, 7–8 in the local buffer.

import { executeRecall } from './recall';
import type { ChatEntry } from './types';

const NOW = new Date(2026, 4, 23, 14, 30).getTime();
const HOUR = 60 * 60 * 1000;

const turn = (user: string, assist: string, ageHours: number, extra?: Partial<ChatEntry>): ChatEntry[] => [
  { role: 'user', content: user, createdAt: NOW - ageHours * HOUR, ...extra },
  { role: 'assistant', content: assist, createdAt: NOW - ageHours * HOUR, ...extra },
];

// 8 turns, oldest first. Distinctive vocabulary per turn so queries isolate.
const log: ChatEntry[] = [
  ...turn('my friend maren runs a glassblowing studio', 'maren and her glassblowing sounds lovely', 40),
  ...turn('explain quantum entanglement between particles', 'entangled particles share a quantum state', 35),
  ...turn('give me a carbonara pasta recipe', 'carbonara uses eggs pancetta and pasta', 30),
  ...turn('tell me about saturn rings astronomy', 'saturn rings are mostly water ice', 25),
  ...turn('how do pottery kilns reach temperature', 'pottery kilns fire slowly to cone ten', 20),
  ...turn('what is the weather forecast', 'rain is forecast tomorrow afternoon', 15),
  ...turn('hello there again', 'hi how can i help today', 10),
  ...turn('thanks for everything goodbye', 'goodbye see you soon', 5),
];

const none = new Set<number>();

describe('executeRecall — query mode', () => {
  it('surfaces an older turn with the shared fragment format and provenance', () => {
    const out = executeRecall({ query: 'quantum entanglement particles' }, log, NOW, none);
    expect(out.mode).toBe('query');
    expect(out.surfaced).toContain(2);
    expect(out.content).toContain('[Turn 2 ·');
    expect(out.content).toContain('via "');
    expect(out.content).toContain('entangled particles share a quantum state');
  });

  it('drops results already surfaced this turn and says everything matched is in context', () => {
    const out = executeRecall({ query: 'quantum entanglement particles' }, log, NOW, new Set([2]));
    expect(out.surfaced).toEqual([]);
    expect(out.content).toContain('already in front of you');
    expect(out.content).not.toContain('may not exist');
  });

  it('returns the honest-empty when nothing in older history matches', () => {
    const out = executeRecall({ query: 'xylophone zeppelin kumquat' }, log, NOW, none);
    expect(out.surfaced).toEqual([]);
    expect(out.content).toContain('may not exist in this conversation');
  });

  it('cannot reach a gated turn (chat memory editor rule holds for recall too)', () => {
    const gated = log.map((e, i) => (i === 2 || i === 3 ? { ...e, active: false } : e));
    const out = executeRecall({ query: 'quantum entanglement particles' }, gated, NOW, none);
    expect(out.surfaced).not.toContain(2);
  });

  it('takes query mode when both query and around_turn are provided', () => {
    const out = executeRecall({ query: 'carbonara pasta', around_turn: 2 }, log, NOW, none);
    expect(out.mode).toBe('query');
    expect(out.surfaced).toContain(3);
  });
});

describe('executeRecall — neighbors mode', () => {
  it('returns both neighbors of a retrievable turn, without provenance', () => {
    const out = executeRecall({ around_turn: 3 }, log, NOW, none);
    expect(out.mode).toBe('neighbors');
    expect(out.surfaced).toEqual([2, 4]);
    expect(out.content).toContain('[Turn 2 ·');
    expect(out.content).toContain('[Turn 4 ·');
    expect(out.content).toContain('saturn rings are mostly water ice');
    expect(out.content).not.toContain('via');
  });

  it('clamps below turn 1 (no turn zero)', () => {
    const out = executeRecall({ around_turn: 1 }, log, NOW, none);
    expect(out.surfaced).toEqual([2]);
  });

  it('notes a summary-window neighbor instead of duplicating distilled context', () => {
    // Turn 4's neighbors: 3 (retrievable) and 5 (summary window).
    const out = executeRecall({ around_turn: 4 }, log, NOW, none);
    expect(out.surfaced).toEqual([3]);
    expect(out.content).toContain('[Turn 3 ·');
    expect(out.content).toContain('Turn 5 is already in your recent context.');
  });

  it('notes a local-buffer neighbor and skips a nonexistent one', () => {
    // Turn 8's neighbors: 7 (local buffer) and 9 (doesn't exist).
    const out = executeRecall({ around_turn: 8 }, log, NOW, none);
    expect(out.surfaced).toEqual([]);
    expect(out.content).toContain('Turn 7 is already in your recent context.');
    expect(out.content).not.toContain('Turn 9');
  });

  it('silently skips a neighbor already surfaced this turn (D5)', () => {
    const out = executeRecall({ around_turn: 3 }, log, NOW, new Set([2]));
    expect(out.surfaced).toEqual([4]);
    expect(out.content).not.toContain('[Turn 2 ·');
  });

  it('skips a fully-gated neighbor and blanks a gated half', () => {
    // Gate all of turn 2 and the assistant half of turn 4.
    const gated = log.map((e, i) =>
      i === 2 || i === 3 || i === 7 ? { ...e, active: false } : e,
    );
    const out = executeRecall({ around_turn: 3 }, gated, NOW, none);
    expect(out.surfaced).toEqual([4]);
    expect(out.content).toContain('tell me about saturn rings');
    expect(out.content).not.toContain('mostly water ice');
  });

  it('tags a timeless (manual) neighbor timeless', () => {
    const withTimeless = log.map((e, i) => (i < 2 ? { ...e, timeless: true } : e));
    const out = executeRecall({ around_turn: 2 }, withTimeless, NOW, none);
    expect(out.content).toContain('[Turn 1 · timeless]');
  });

  it('returns the honest-empty when every neighbor is out of range', () => {
    const out = executeRecall({ around_turn: 40 }, log, NOW, none);
    expect(out.surfaced).toEqual([]);
    expect(out.content).toContain('may not exist in this conversation');
  });
});

describe('executeRecall — invalid input (never throws)', () => {
  it.each([
    [{}],
    [{ query: '' }],
    [{ query: '   ' }],
    [{ around_turn: 2.5 }],
    [{ query: '', around_turn: Number.NaN }],
  ])('returns the honest-empty for %j', (input) => {
    const out = executeRecall(input, log, NOW, none);
    expect(out.surfaced).toEqual([]);
    expect(out.content).toContain('may not exist in this conversation');
  });

  it('handles an empty chat log', () => {
    const out = executeRecall({ query: 'anything' }, [], NOW, none);
    expect(out.content).toContain('may not exist in this conversation');
  });
});
