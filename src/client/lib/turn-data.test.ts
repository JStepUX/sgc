import { describe, it, expect } from 'vitest';
import {
  canonEntryCount,
  dynamicStateFromInspector,
  replayEntry,
  summaryFromInspector,
  spontaneityFromInspector,
  type TurnData,
} from './turn-data';
import type { ChatTurn } from './persistence';
import type { DynamicState, TurnSummary } from './types';

// Behavioral contract of the inspector_json rehydration parsers: tolerant of
// null blobs, garbage, and pre-feature turns — a reload must never throw over
// an old row, it just renders nothing.

const summary: TurnSummary = {
  persistent: ['prefers dark mode'],
  volatile: ['debugging the composer'],
  established_patterns: [],
};

function blob(partial: Partial<TurnData>): string {
  return JSON.stringify(partial);
}

describe('summaryFromInspector', () => {
  it('returns undefined for a null blob', () => {
    expect(summaryFromInspector(null)).toBeUndefined();
  });

  it('returns undefined for malformed JSON', () => {
    expect(summaryFromInspector('{not json')).toBeUndefined();
  });

  it('returns undefined for a pre-summary turn (no summary field)', () => {
    expect(summaryFromInspector(blob({ turnNumber: 3 }))).toBeUndefined();
  });

  it('returns undefined when summary was persisted as null', () => {
    expect(summaryFromInspector(blob({ summary: null }))).toBeUndefined();
  });

  it('round-trips a persisted summary', () => {
    expect(summaryFromInspector(blob({ summary }))).toEqual(summary);
  });
});

describe('dynamicStateFromInspector', () => {
  const dynamicState: DynamicState = {
    goal: 'find the thread again',
    appraisal: 'patient',
    association: null,
    passing_thought: null,
    noticed: ['they went quiet'],
    unexpressed_impulse: null,
  };

  it('returns undefined for a null blob, malformed JSON, and a pre-feature turn', () => {
    expect(dynamicStateFromInspector(null)).toBeUndefined();
    expect(dynamicStateFromInspector('{not json')).toBeUndefined();
    expect(dynamicStateFromInspector(blob({ turnNumber: 3 }))).toBeUndefined();
  });

  it('returns undefined when the state call failed and null was persisted', () => {
    expect(dynamicStateFromInspector(blob({ dynamicState: null }))).toBeUndefined();
  });

  it('round-trips a persisted state', () => {
    expect(dynamicStateFromInspector(blob({ dynamicState }))).toEqual(dynamicState);
  });

  it('replayEntry rehydrates the state onto the entry — the next prompt reads it after a reload', () => {
    const row: ChatTurn = {
      id: 7,
      ordinal: 3,
      role: 'assistant',
      content: 'a reply',
      createdAt: 1_700_000_000_000,
      inspectorJson: blob({ summary, dynamicState }),
      active: true,
      timeless: false,
    };
    const entry = replayEntry(row);
    expect(entry.dynamicState).toEqual(dynamicState);
    expect(entry.summary).toEqual(summary);
  });
});

describe('spontaneityFromInspector', () => {
  const directive = '@!OPERATOR: Inversion!@ Argue the opposite for one turn.';

  it('returns undefined for a null blob', () => {
    expect(spontaneityFromInspector(null)).toBeUndefined();
  });

  it('returns undefined for malformed JSON', () => {
    expect(spontaneityFromInspector('{not json')).toBeUndefined();
  });

  it('returns undefined for a pre-feature turn (no spontaneity fields)', () => {
    expect(spontaneityFromInspector(blob({ turnNumber: 3 }))).toBeUndefined();
  });

  it('returns undefined for a dormant turn (fired=false)', () => {
    expect(
      spontaneityFromInspector(blob({ spontaneityFired: false, spontaneityDirective: directive })),
    ).toBeUndefined();
  });

  it('returns undefined for a fire with no snapshotted directive', () => {
    expect(
      spontaneityFromInspector(blob({ spontaneityFired: true, spontaneityDirective: null })),
    ).toBeUndefined();
  });

  it('derives the label from the snapshotted directive on a fire', () => {
    expect(
      spontaneityFromInspector(blob({ spontaneityFired: true, spontaneityDirective: directive })),
    ).toEqual({ label: 'Inversion' });
  });
});

describe('canonEntryCount (ephemeral tangent, spec 04)', () => {
  const ord = (ordinals: number[]) => ordinals.map((ordinal) => ({ ordinal }));

  it('returns null when no tangent is open', () => {
    expect(canonEntryCount(ord([1, 2, 3, 4]), null)).toBeNull();
  });

  it('counts entries at or below the boundary (a mid-history boundary)', () => {
    // Boundary 2 = one canon pair; ordinals 3,4 are the tangent tail.
    expect(canonEntryCount(ord([1, 2, 3, 4]), 2)).toBe(2);
  });

  it('counts timeless prepends (negative ordinals) as canon — they sit below any boundary', () => {
    // A manual memory prepended during the tangent: ordinals -1,0 join the
    // canon side, matching what replayEntry renders after a reload.
    expect(canonEntryCount(ord([-1, 0, 1, 2, 3, 4]), 2)).toBe(4);
  });

  it('a boundary at the tail means zero tangent entries (fresh tangent, nothing streamed yet)', () => {
    expect(canonEntryCount(ord([1, 2, 3, 4]), 4)).toBe(4);
  });
});
