import { describe, it, expect } from 'vitest';
import { summaryFromInspector, spontaneityFromInspector, type TurnData } from './turn-data';
import type { TurnSummary } from './types';

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
