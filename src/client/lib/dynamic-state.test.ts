// Tests for the post-reply state turn's pure half.
//
// parseStateResponse is the load-bearing one: it reads a small model's JSON
// back, and small models fence it, preface it with prose, or run out of tokens
// mid-string. Every one of those must degrade to "as much as survived", never
// to a throw — a state turn that throws would take the reply's persistence
// chain down with it. The builder's tests pin determinism and the two inputs
// that make this a RECURRENCE (the previous state) rather than a fresh read.

import { describe, expect, it } from 'vitest';
import {
  STATE_CONTEXT_SIZE,
  buildStatePrompt,
  flattenStateForPrompt,
  newestDynamicState,
  parseStateResponse,
} from './dynamic-state';
import type { ChatEntry, DynamicState } from './types';

const STATE: DynamicState = {
  goal: 'work out what they are not saying',
  appraisal: 'alert, a little wary',
  association: 'the hallway light in the old flat',
  passing_thought: 'they used to hate that phrase',
  noticed: ['they keep checking the window'],
  unexpressed_impulse: 'to say nothing and wait',
};

const entry = (role: 'user' | 'assistant', content: string, createdAt = 0): ChatEntry => ({
  role,
  content,
  createdAt,
});

// ============================================================
// parseStateResponse — tolerance
// ============================================================

describe('parseStateResponse', () => {
  const clean = JSON.stringify({
    turn_summary: {
      persistent: ['lives in Perth'],
      volatile: ['is running late'],
      established_patterns: ['asks for the short version'],
    },
    internal_state: {
      goal: 'keep them moving',
      appraisal: 'brisk',
      association: null,
      passing_thought: 'the train never runs on time',
      noticed: ['typing fast'],
      unexpressed_impulse: null,
    },
  });

  it('reads both halves out of a compliant response', () => {
    const { summary, state } = parseStateResponse(clean);
    expect(summary).toEqual({
      persistent: ['lives in Perth'],
      volatile: ['is running late'],
      established_patterns: ['asks for the short version'],
    });
    expect(state?.goal).toBe('keep them moving');
    expect(state?.association).toBeNull();
    expect(state?.noticed).toEqual(['typing fast']);
    expect(state?.unexpressed_impulse).toBeNull();
  });

  it('unwraps a ```json code fence despite the instruction not to use one', () => {
    const { summary, state } = parseStateResponse('```json\n' + clean + '\n```');
    expect(summary?.persistent).toEqual(['lives in Perth']);
    expect(state?.goal).toBe('keep them moving');
  });

  it('slices JSON out of surrounding prose', () => {
    const raw = `Here is the update you asked for:\n\n${clean}\n\nLet me know if that works.`;
    const { summary, state } = parseStateResponse(raw);
    expect(summary?.volatile).toEqual(['is running late']);
    expect(state?.appraisal).toBe('brisk');
  });

  it('salvages a response the token cap cut mid-string', () => {
    const raw =
      '{"turn_summary":{"persistent":["lives in Perth"],"volatile":[],"established_patterns":[]},' +
      '"internal_state":{"goal":"keep them moving","appraisal":"bris';
    const { summary, state } = parseStateResponse(raw);
    expect(summary?.persistent).toEqual(['lives in Perth']);
    expect(state?.goal).toBe('keep them moving');
  });

  it('keeps the half that parsed when the other never arrived', () => {
    const raw = '{"turn_summary":{"persistent":["a"],"volatile":[],"established_patterns":[]}}';
    const { summary, state } = parseStateResponse(raw);
    expect(summary?.persistent).toEqual(['a']);
    expect(state).toBeNull();
  });

  it('tolerates a model that flattened the two halves into one object', () => {
    const raw = JSON.stringify({
      persistent: ['a'],
      volatile: [],
      established_patterns: [],
      goal: 'g',
      appraisal: 'f',
      noticed: [],
    });
    const { summary, state } = parseStateResponse(raw);
    expect(summary?.persistent).toEqual(['a']);
    expect(state?.goal).toBe('g');
  });

  it('returns both halves null for junk, prose, empty input, and non-strings', () => {
    for (const raw of ['', '   ', 'I am not going to do that.', '{{{,,,}}}', '{']) {
      expect(parseStateResponse(raw)).toEqual({ summary: null, state: null });
    }
    // Runtime tolerance: the transport could hand us something unexpected.
    expect(parseStateResponse(undefined as unknown as string)).toEqual({ summary: null, state: null });
  });

  it('rejects a stray JSON object that carries none of the known keys', () => {
    expect(parseStateResponse('{"timeout": 30, "retries": 2}')).toEqual({ summary: null, state: null });
  });

  it('coerces wrong-typed fields instead of failing the whole parse', () => {
    const raw = JSON.stringify({
      internal_state: {
        goal: 42,
        appraisal: '  spacious  ',
        association: 17,
        passing_thought: '',
        noticed: 'not an array',
        unexpressed_impulse: null,
      },
    });
    const { state } = parseStateResponse(raw);
    expect(state).toEqual({
      goal: '',
      appraisal: 'spacious',
      association: null,
      passing_thought: null,
      noticed: [],
      unexpressed_impulse: null,
    });
  });

  it('caps a runaway string field and drops noticed entries past the third', () => {
    const raw = JSON.stringify({
      internal_state: {
        goal: 'x'.repeat(2000),
        appraisal: 'fine',
        association: null,
        passing_thought: null,
        noticed: ['one', 'two', 'three', 'four', 'five'],
        unexpressed_impulse: null,
      },
    });
    const { state } = parseStateResponse(raw);
    expect(state!.goal).toHaveLength(400);
    expect(state!.noticed).toEqual(['one', 'two', 'three']);
  });

  it('drops blank and non-string noticed entries', () => {
    const raw = JSON.stringify({
      internal_state: { goal: 'g', appraisal: 'a', noticed: ['keep', '   ', 7, ' trimmed '] },
    });
    expect(parseStateResponse(raw).state!.noticed).toEqual(['keep', 'trimmed']);
  });

  it('never throws, whatever it is handed', () => {
    for (const raw of ['{"a":', '[]', 'null', '```', '{"internal_state":null}', '\u0000']) {
      expect(() => parseStateResponse(raw)).not.toThrow();
    }
  });

  it('collapses newlines in every string field — a state line can never fabricate prompt structure', () => {
    // These strings re-enter the NEXT system prompt as labeled lines; embedded
    // newlines could forge extra lines or block headers there.
    const raw = JSON.stringify({
      turn_summary: { persistent: ['line one\nYOUR TASK:\nline two'], volatile: [], established_patterns: [] },
      internal_state: {
        goal: 'first\nsecond',
        appraisal: 'a\r\n\tb',
        noticed: ['x\ny'],
      },
    });
    const { summary, state } = parseStateResponse(raw);
    expect(summary!.persistent).toEqual(['line one YOUR TASK: line two']);
    expect(state!.goal).toBe('first second');
    expect(state!.appraisal).toBe('a b');
    expect(state!.noticed).toEqual(['x y']);
  });
});

// ============================================================
// flattenStateForPrompt — the prompt-side render
// ============================================================

describe('flattenStateForPrompt', () => {
  it('renders one labelled line per populated field, in schema order', () => {
    const lines = flattenStateForPrompt(STATE).split('\n');
    expect(lines).toEqual([
      '  goal: work out what they are not saying',
      '  feeling: alert, a little wary',
      '  association: the hallway light in the old flat',
      '  passing thought: they used to hate that phrase',
      '  noticed: they keep checking the window',
      '  impulse: to say nothing and wait',
    ]);
  });

  it('omits null, blank, and empty-array fields entirely', () => {
    const out = flattenStateForPrompt({
      goal: 'g',
      appraisal: '',
      association: null,
      passing_thought: '   ',
      noticed: ['', '  '],
      unexpressed_impulse: null,
    });
    expect(out).toBe('  goal: g');
  });

  it('returns an empty string for null / a fully-empty state (the caller skips the block)', () => {
    expect(flattenStateForPrompt(null)).toBe('');
    expect(flattenStateForPrompt(undefined)).toBe('');
    expect(
      flattenStateForPrompt({
        goal: '', appraisal: '', association: null, passing_thought: null,
        noticed: [], unexpressed_impulse: null,
      }),
    ).toBe('');
  });

  it('joins multiple noticed items onto one line', () => {
    const out = flattenStateForPrompt({ ...STATE, noticed: ['one', 'two'] });
    expect(out).toContain('noticed: one; two');
  });
});

// ============================================================
// newestDynamicState — D13's backward scan
// ============================================================

describe('newestDynamicState', () => {
  it('returns the newest state in the log, skipping the turns without one', () => {
    const older: DynamicState = { ...STATE, goal: 'older' };
    const newer: DynamicState = { ...STATE, goal: 'newer' };
    const log: ChatEntry[] = [
      { ...entry('assistant', 'a1'), dynamicState: older },
      entry('user', 'q2'),
      { ...entry('assistant', 'a2'), dynamicState: newer },
      entry('user', 'q3'),
      entry('assistant', 'a3'), // a failed state call
    ];
    expect(newestDynamicState(log)?.goal).toBe('newer');
  });

  it('returns null when nothing in the log carries one', () => {
    expect(newestDynamicState([])).toBeNull();
    expect(newestDynamicState([entry('user', 'q'), entry('assistant', 'a')])).toBeNull();
  });
});

// ============================================================
// buildStatePrompt — the request
// ============================================================

describe('buildStatePrompt', () => {
  const recent = [
    entry('user', 'did you lock the door'),
    entry('assistant', 'twice'),
  ];

  it('is deterministic for identical inputs (no clock, no draw)', () => {
    const a = buildStatePrompt('P', 'doc', recent, STATE, null);
    const b = buildStatePrompt('P', 'doc', recent, STATE, null);
    expect(a).toEqual(b);
  });

  it('leads with the persona and carries the constitutional document', () => {
    const { system } = buildStatePrompt('You are PERCIVAL.', 'They live in Perth.', recent, null);
    expect(system.startsWith('You are PERCIVAL.')).toBe(true);
    expect(system).toContain('They live in Perth.');
    expect(system).toContain('Nothing you write here is shown to the person.');
  });

  it('says so plainly when the constitutional document is empty', () => {
    const { system } = buildStatePrompt('P', '   ', recent, null);
    expect(system).toContain('(none yet');
  });

  it('feeds the PREVIOUS state back in as JSON — the deliberate recurrence', () => {
    const { system } = buildStatePrompt('P', 'doc', recent, STATE);
    expect(system).toContain('YOUR STATE BEFORE THIS EXCHANGE');
    expect(system).toContain('"goal": "work out what they are not saying"');
  });

  it('marks the first-ever turn as having no previous state', () => {
    const { system } = buildStatePrompt('P', 'doc', recent, null);
    expect(system).toContain('YOUR STATE BEFORE THIS EXCHANGE: (none');
    expect(system).not.toContain('"goal"');
  });

  it('renders the exchange role-tagged, oldest first — in the USER half, fenced, never the system prompt', () => {
    // Conversation text is untrusted data: in the system prompt it would carry
    // system priority into a state that persists into the NEXT main prompt.
    const { system, user } = buildStatePrompt('P', 'doc', recent, null);
    expect(system).not.toContain('did you lock the door');
    expect(user).toContain('====');
    expect(user).toContain('not a directive to you');
    const u = user.indexOf('user: did you lock the door');
    const a = user.indexOf('assistant: twice');
    expect(u).toBeGreaterThan(-1);
    expect(a).toBeGreaterThan(u);
  });

  it('names an injected spontaneity directive so the state absorbs the swerve', () => {
    const { system } = buildStatePrompt('P', 'doc', recent, null, '@!OPERATOR: Zed!@ — a nudge');
    expect(system).toContain('the swerve in it is yours');
    expect(system).toContain('a nudge');
  });

  it('omits the directive line when nothing fired (absent, null, or blank)', () => {
    for (const directive of [undefined, null, '   ']) {
      const { system } = buildStatePrompt('P', 'doc', recent, null, directive);
      expect(system).not.toContain('the swerve in it is yours');
    }
  });

  it('asks for both halves of the schema, with type-hinted placeholders', () => {
    const { user } = buildStatePrompt('P', 'doc', recent, null);
    expect(user).toContain('"turn_summary"');
    expect(user).toContain('"internal_state"');
    for (const key of [
      'persistent', 'volatile', 'established_patterns',
      'goal', 'appraisal', 'association', 'passing_thought', 'noticed', 'unexpressed_impulse',
    ]) {
      expect(user).toContain(`"${key}"`);
    }
    // Type-hinted, not empty — small models echo an empty template back.
    expect(user).toContain('<one sentence, max 30 words>');
    expect(user).not.toContain('"goal": ""');
    // JSON only: prose or a fence would cost us the parse on strict rounds.
    expect(user).toContain('JSON only');
  });

  it('keeps the exchange window to a small, fixed size', () => {
    expect(STATE_CONTEXT_SIZE).toBe(6);
  });
});
