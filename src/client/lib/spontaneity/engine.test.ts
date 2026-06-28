// Behavioral tests for the spontaneity engine. The RNG is injected so the
// weighted draw and the no-consecutive-repeat rule are deterministic.

import {
  runSpontaneity,
  drawOperator,
  lastFiredOperatorId,
  INITIAL_SPONTANEITY_STATE,
  type SpontaneityInspector,
} from './engine';
import { FLEX_DECK, type Operator } from './flexDeck';
import type { ChatEntry } from '../types';

function turn(user: string, assistant: string): ChatEntry[] {
  return [
    { role: 'user', content: user, createdAt: 0 },
    { role: 'assistant', content: assistant, createdAt: 0 },
  ];
}

/** A circling log that drives detectSlack above any sane threshold. */
const CIRCLING_LOG = [
  ...turn('rainfall patterns discussion', 'rainfall patterns response'),
  ...turn('rainfall patterns discussion', 'rainfall patterns response'),
  ...turn('rainfall patterns discussion', 'rainfall patterns response'),
];

/** A vocabulary-disjoint log that keeps the detector silent. */
const VARIED_LOG = [
  ...turn('quantum chromodynamics lecture', 'gluons confine quarks'),
  ...turn('sourdough baking schedule', 'autolyse before kneading'),
];

describe('runSpontaneity', () => {
  it('fires nothing and leaves state untouched when the detector is silent', () => {
    const state = { lastFiredId: 'reincorporation' };
    const result = runSpontaneity(VARIED_LOG, state, { rng: () => 0 });
    expect(result.directive).toBeNull();
    expect(result.operator).toBeNull();
    expect(result.reading.shouldFire).toBe(false);
    expect(result.state).toBe(state); // unchanged reference
  });

  it('fires an operator and advances state when the conversation is circling', () => {
    const result = runSpontaneity(CIRCLING_LOG, INITIAL_SPONTANEITY_STATE, {
      rng: () => 0, // → first eligible operator
    });
    expect(result.reading.shouldFire).toBe(true);
    expect(result.operator).toEqual(FLEX_DECK[0]);
    expect(result.directive).toBe(FLEX_DECK[0].directive);
    expect(result.state.lastFiredId).toBe(FLEX_DECK[0].id);
  });

  it('never repeats the last-fired operator on consecutive fires', () => {
    // rng → 0 would normally land on FLEX_DECK[0]; excluding it shifts the draw
    // to the next eligible operator, FLEX_DECK[1].
    const result = runSpontaneity(
      CIRCLING_LOG,
      { lastFiredId: FLEX_DECK[0].id },
      { rng: () => 0 },
    );
    expect(result.operator?.id).toBe(FLEX_DECK[1].id);
    expect(result.operator?.id).not.toBe(FLEX_DECK[0].id);
  });

  it('respects detector options (threshold override suppresses a fire)', () => {
    const result = runSpontaneity(CIRCLING_LOG, INITIAL_SPONTANEITY_STATE, {
      rng: () => 0,
      detector: { threshold: 1.01 }, // unreachable → never fires
    });
    expect(result.directive).toBeNull();
  });
});

describe('drawOperator', () => {
  const deck: Operator[] = [
    { id: 'a', directive: 'A', weight: 1 },
    { id: 'b', directive: 'B', weight: 3 },
  ];

  it('selects by cumulative weight', () => {
    // total = 4. r = rng()*4. r in [0,1) → 'a'; r in [1,4) → 'b'.
    expect(drawOperator(deck, null, () => 0)?.id).toBe('a'); // r = 0
    expect(drawOperator(deck, null, () => 0.2)?.id).toBe('a'); // r = 0.8
    expect(drawOperator(deck, null, () => 0.3)?.id).toBe('b'); // r = 1.2
    expect(drawOperator(deck, null, () => 0.99)?.id).toBe('b'); // r ≈ 3.96
  });

  it('excludes the last-fired operator', () => {
    // 'a' excluded → only 'b' remains regardless of rng.
    expect(drawOperator(deck, 'a', () => 0)?.id).toBe('b');
  });

  it('skips zero-weight operators', () => {
    const withDead: Operator[] = [
      { id: 'dead', directive: 'X', weight: 0 },
      { id: 'live', directive: 'Y', weight: 1 },
    ];
    expect(drawOperator(withDead, null, () => 0)?.id).toBe('live');
  });

  it('falls back to a repeat only when exclusion empties the pool', () => {
    const single: Operator[] = [{ id: 'only', directive: 'Z', weight: 1 }];
    // Excluding the sole operator would leave nothing — a repeat beats a no-op.
    expect(drawOperator(single, 'only', () => 0)?.id).toBe('only');
  });

  it('returns null when no operator has positive weight', () => {
    const dead: Operator[] = [{ id: 'x', directive: 'X', weight: 0 }];
    expect(drawOperator(dead, null, () => 0)).toBeNull();
    expect(drawOperator([], null, () => 0)).toBeNull();
  });
});

describe('lastFiredOperatorId', () => {
  // A persisted inspector blob, as the component's TurnData serializes it.
  const blob = (fired: boolean, operatorId: string | null): string => {
    const b: SpontaneityInspector = {
      spontaneityFired: fired,
      spontaneityOperatorId: operatorId,
      spontaneityDirective: operatorId ? `@!OPERATOR: ${operatorId}!@ — x` : null,
      spontaneitySimilarity: fired ? 0.5 : 0.1,
    };
    return JSON.stringify(b);
  };
  const FIRE = (id: string) => blob(true, id);
  const DORMANT = blob(false, null);

  it('returns null when nothing fired', () => {
    expect(lastFiredOperatorId([])).toBeNull();
    expect(lastFiredOperatorId([DORMANT, DORMANT])).toBeNull();
  });

  it('returns the operator id of the only fired turn', () => {
    expect(lastFiredOperatorId([FIRE('offscreen_life')])).toBe('offscreen_life');
  });

  it('REGRESSION: returns the earlier fire when the latest turn is dormant', () => {
    // The exact bug the reviewer caught: A fires, the next turn is dormant
    // (persists operatorId: null). Reading only the latest blob yields null and
    // the next fire could repeat A. The backward scan must still surface A.
    expect(lastFiredOperatorId([FIRE('offscreen_life'), DORMANT])).toBe('offscreen_life');
    // Several dormant turns deep — still found.
    expect(lastFiredOperatorId([FIRE('competing_want'), DORMANT, DORMANT, DORMANT]))
      .toBe('competing_want');
  });

  it('returns the MOST RECENT fire when several turns fired', () => {
    expect(lastFiredOperatorId([FIRE('a'), FIRE('b'), DORMANT])).toBe('b');
    expect(lastFiredOperatorId([FIRE('a'), FIRE('b'), FIRE('c')])).toBe('c');
  });

  it('skips null entries (user rows have no inspector) and unparseable blobs', () => {
    expect(lastFiredOperatorId([FIRE('a'), null, DORMANT, null])).toBe('a');
    expect(lastFiredOperatorId([FIRE('a'), 'not json {{{', DORMANT])).toBe('a');
    expect(lastFiredOperatorId([null, 'garbage'])).toBeNull();
  });

  it('skips pre-feature blobs that lack the spontaneity fields', () => {
    const preFeature = JSON.stringify({ turnNumber: 3, inputTokens: 100 });
    expect(lastFiredOperatorId([FIRE('a'), preFeature])).toBe('a');
    expect(lastFiredOperatorId([preFeature])).toBeNull();
  });
});
