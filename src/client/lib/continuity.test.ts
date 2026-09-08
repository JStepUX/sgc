import { describe, expect, it } from 'vitest';
import {
  CHARACTER_RECORDS,
  SLOT_CHARS,
  applyContinuityDelta,
  characterKey,
  emptySheet,
  flattenSheetForPrompt,
  foldSheet,
  isDeltaEmpty,
  isSheetEmpty,
  type ContinuitySheet,
} from './continuity';
import type { ChatEntry } from './types';

// The merge table from spec 07 (verification.merge_table) — one `it` per row.
// The contract under test: the sheet ACCRETES, and nothing a model can emit
// (or fail to emit) blanks a fact that was established.

const tavern = (): ContinuitySheet => ({
  story: { genre: 'medieval fantasy', time: 'day 3, late evening' },
  location: { name: 'The Broken Anvil', type: 'tavern', environment: 'smoky, rain against the shutters' },
  characters: {
    duncan: { name: 'Duncan', present: true, apparel: 'red shirt, muddy boots', items: 'a tankard', immediate_location: 'at the bar' },
    mara: { name: 'Mara', present: true, stance: 'seated by the fire', disposition_to_user: 'wary' },
  },
});

describe('applyContinuityDelta — omission and absence', () => {
  it('an empty delta leaves every fact in place', () => {
    const prev = tavern();
    expect(applyContinuityDelta(prev, {})).toEqual(prev);
    expect(applyContinuityDelta(prev, { story: {}, location: {}, characters: {} })).toEqual(prev);
  });

  it('never mutates the previous sheet', () => {
    const prev = tavern();
    const frozen = JSON.stringify(prev);
    applyContinuityDelta(prev, { characters: { duncan: { apparel: 'blue shirt' } }, location: { name: 'Elsewhere' } });
    expect(JSON.stringify(prev)).toBe(frozen);
  });

  it('absence is not deletion: a departed character keeps their record and returns intact', () => {
    const gone = applyContinuityDelta(tavern(), {
      characters: { duncan: { present: false, absence_reason: 'left for the market' } },
    });
    expect(gone.characters.duncan).toMatchObject({
      present: false,
      absence_reason: 'left for the market',
      apparel: 'red shirt, muddy boots',
      items: 'a tankard',
    });
    const back = applyContinuityDelta(gone, { characters: { duncan: { present: true } } });
    expect(back.characters.duncan.present).toBe(true);
    expect(back.characters.duncan.apparel).toBe('red shirt, muddy boots');
    // Returning clears the stale reason — "present, reason: left" is a contradiction.
    expect(back.characters.duncan.absence_reason).toBeUndefined();
  });

  it('a change to one slot implies nothing about a neighbouring slot', () => {
    const next = applyContinuityDelta(tavern(), { characters: { duncan: { apparel: 'blue shirt' } } });
    expect(next.characters.duncan.apparel).toBe('blue shirt');
    expect(next.characters.duncan.items).toBe('a tankard');
    expect(next.characters.duncan.immediate_location).toBe('at the bar');
    expect(next.characters.mara).toEqual(tavern().characters.mara);
  });
});

describe('applyContinuityDelta — location', () => {
  it('a move replaces the location wholesale: the old environment does not survive the walk', () => {
    const next = applyContinuityDelta(tavern(), { location: { name: 'the forest road', type: 'outdoors' } });
    expect(next.location).toEqual({ name: 'the forest road', type: 'outdoors' });
  });

  it('a same-name delta merges (case-insensitively)', () => {
    const next = applyContinuityDelta(tavern(), { location: { name: 'the broken anvil', environment: 'quiet now' } });
    expect(next.location).toEqual({ name: 'the broken anvil', type: 'tavern', environment: 'quiet now' });
  });

  it('naming a previously unnamed place merges rather than replaces', () => {
    const prev: ContinuitySheet = { ...emptySheet(), location: { environment: 'dark' } };
    const next = applyContinuityDelta(prev, { location: { name: 'a cellar' } });
    expect(next.location).toEqual({ name: 'a cellar', environment: 'dark' });
  });

  it('story slots shallow-merge', () => {
    const next = applyContinuityDelta(tavern(), { story: { time: 'day 4, dawn' } });
    expect(next.story).toEqual({ genre: 'medieval fantasy', time: 'day 4, dawn' });
  });
});

describe('applyContinuityDelta — records and caps', () => {
  it('an unseen name opens a record that defaults to present', () => {
    const next = applyContinuityDelta(tavern(), { characters: { Tomas: { apparel: 'a grey cloak' } } });
    expect(next.characters.tomas).toEqual({ name: 'Tomas', present: true, apparel: 'a grey cloak' });
  });

  it('accepts an array of records carrying names (what models often emit)', () => {
    const next = applyContinuityDelta(null, { characters: [{ name: 'Ines', stance: 'standing' }, { stance: 'no name' }] });
    expect(Object.keys(next.characters)).toEqual(['ines']);
  });

  it('the 17th record is dropped; the first sixteen are intact', () => {
    let sheet: ContinuitySheet | null = null;
    for (let i = 0; i < CHARACTER_RECORDS; i++) {
      sheet = applyContinuityDelta(sheet, { characters: { [`c${i}`]: { stance: 'here' } } });
    }
    const full = applyContinuityDelta(sheet, { characters: { extra: { stance: 'late' }, c3: { stance: 'moved' } } });
    expect(Object.keys(full.characters)).toHaveLength(CHARACTER_RECORDS);
    expect(full.characters.extra).toBeUndefined();
    expect(full.characters.c3.stance).toBe('moved');
  });

  it('key normalisation: Duncan / duncan / DUNCAN are one record and the first casing is the display name', () => {
    const a = applyContinuityDelta(null, { characters: { Duncan: { apparel: 'red' } } });
    const b = applyContinuityDelta(a, { characters: { 'duncan ': { items: 'axe' } } });
    const c = applyContinuityDelta(b, { characters: { DUNCAN: { name: 'DUNCAN', stance: 'tall' } } });
    expect(Object.keys(c.characters)).toEqual(['duncan']);
    expect(c.characters.duncan).toEqual({ name: 'Duncan', present: true, apparel: 'red', items: 'axe', stance: 'tall' });
    expect(characterKey('  Two   Words ')).toBe('two words');
  });

  it('refuses prototype-reaching keys', () => {
    const next = applyContinuityDelta(null, { characters: { __proto__: { stance: 'x' }, constructor: { stance: 'y' } } });
    expect(Object.keys(next.characters)).toEqual([]);
  });
});

describe('applyContinuityDelta — values', () => {
  it('null clears one slot, blank clears, a non-string preserves', () => {
    const next = applyContinuityDelta(tavern(), {
      characters: { duncan: { apparel: null, items: '   ', immediate_location: 42 } },
    });
    expect(next.characters.duncan.apparel).toBeUndefined();
    expect(next.characters.duncan.items).toBeUndefined();
    expect(next.characters.duncan.immediate_location).toBe('at the bar');
  });

  it('collapses whitespace (no slot can fabricate a prompt line) and hard-cuts at SLOT_CHARS', () => {
    const long = 'a'.repeat(SLOT_CHARS + 40);
    const next = applyContinuityDelta(tavern(), {
      characters: { duncan: { apparel: 'a\ncloak\n\n  and   hood', physical_state: long } },
    });
    expect(next.characters.duncan.apparel).toBe('a cloak and hood');
    expect(next.characters.duncan.physical_state).toHaveLength(SLOT_CHARS);
  });

  it('present must be boolean; anything else leaves presence alone', () => {
    const next = applyContinuityDelta(tavern(), { characters: { duncan: { present: 'no' } } });
    expect(next.characters.duncan.present).toBe(true);
  });

  it('a field outside the schema changes nothing', () => {
    const prev = tavern();
    expect(applyContinuityDelta(prev, { characters: { duncan: { mood: 'furious' } }, weather: 'rain' })).toEqual(prev);
  });
});

describe('applyContinuityDelta — invalid deltas preserve the sheet', () => {
  it.each([null, undefined, 'garbage', 42, [], { story: 'x', location: [], characters: 'none' }])(
    'unusable delta %j → previous sheet unchanged',
    (delta) => {
      const prev = tavern();
      expect(applyContinuityDelta(prev, delta)).toEqual(prev);
    },
  );

  it('with no previous sheet, an unusable delta yields the empty sheet', () => {
    expect(applyContinuityDelta(null, 'garbage')).toEqual(emptySheet());
    expect(isSheetEmpty(applyContinuityDelta(null, null))).toBe(true);
  });
});

describe('flattenSheetForPrompt', () => {
  it('renders story, location, present characters in full and absent ones on one line', () => {
    const sheet = applyContinuityDelta(tavern(), {
      characters: {
        mara: { present: false, absence_reason: 'went to fetch the healer' },
        duncan: { disposition_to_user: 'grateful', unaware_of: 'that the letter was read' },
      },
    });
    const text = flattenSheetForPrompt(sheet);
    expect(text).toBe(
      [
        '  story: medieval fantasy; day 3, late evening',
        '  location: The Broken Anvil (tavern) — smoky, rain against the shutters',
        '  present:',
        '    Duncan — at: at the bar; wearing: red shirt, muddy boots; carrying: a tankard; toward you: grateful; unaware: that the letter was read',
        '  elsewhere:',
        '    Mara — went to fetch the healer',
      ].join('\n'),
    );
    expect(text).not.toContain('{');
  });

  it('omits empty slots and sections rather than labelling them empty', () => {
    const sheet: ContinuitySheet = {
      story: {},
      location: { type: 'forest' },
      characters: { ines: { name: 'Ines', present: true } },
    };
    expect(flattenSheetForPrompt(sheet)).toBe(['  location: forest', '  present:', '    Ines'].join('\n'));
  });

  it("returns '' for null or an empty sheet so the caller can skip the block", () => {
    expect(flattenSheetForPrompt(null)).toBe('');
    expect(flattenSheetForPrompt(emptySheet())).toBe('');
    expect(isSheetEmpty({ story: {}, location: {}, characters: {} })).toBe(true);
    expect(isSheetEmpty({ story: { time: 'noon' }, location: {}, characters: {} })).toBe(false);
  });
});

describe('template placeholders are never facts (review finding)', () => {
  it('a placeholder value is a no-op, a placeholder location name is not a move, a placeholder name opens nothing', () => {
    const next = applyContinuityDelta(tavern(), {
      story: { time: '<only if it moved>' },
      location: { name: '<only on a move>', type: '<only if established>', environment: '<only if it changed>' },
      characters: {
        '<name>': { present: true, apparel: '<only if it changed>' },
        duncan: { apparel: '<only if it changed>', items: 'a lantern' },
      },
    });
    expect(next.story).toEqual(tavern().story);
    expect(next.location).toEqual(tavern().location);
    expect(Object.keys(next.characters)).toEqual(['duncan', 'mara']);
    expect(next.characters.duncan.apparel).toBe('red shirt, muddy boots');
    expect(next.characters.duncan.items).toBe('a lantern');
  });

  it('an echoed schema example applied to an empty sheet records nothing', () => {
    const echoed = applyContinuityDelta(null, {
      story: { time: '<only if it moved>' },
      location: { name: '<only on a move>', type: '<only if established>', environment: '<only if it changed>' },
      characters: { '<name>': { present: true, apparel: '<only if it changed>', items: '<only if it changed>' } },
    });
    expect(isSheetEmpty(echoed)).toBe(true);
  });
});

describe('isDeltaEmpty', () => {
  it('is true for null, non-objects, and the no-change shape; false when any slot is carried', () => {
    expect(isDeltaEmpty(null)).toBe(true);
    expect(isDeltaEmpty(undefined)).toBe(true);
    expect(isDeltaEmpty({})).toBe(true);
    expect(isDeltaEmpty({ story: {}, location: {}, characters: {} })).toBe(true);
    expect(isDeltaEmpty({ story: { time: 'dusk' } })).toBe(false);
    expect(isDeltaEmpty({ characters: [{ name: 'x' }] })).toBe(false);
  });
});

describe('foldSheet — the sheet is a fold of every delta in log order', () => {
  const entry = (i: number, sheetDelta?: Record<string, unknown>): ChatEntry => ({
    role: 'assistant',
    content: `reply ${i}`,
    createdAt: i,
    sheetDelta,
  });
  const red = { characters: { Duncan: { apparel: 'red shirt' } } };
  const rain = { location: { environment: 'raining' } };

  it('folds every delta, skipping entries that carry none; null when nothing carries one', () => {
    const log = [entry(0, red), entry(1), entry(2, rain), entry(3)];
    const sheet = foldSheet(log);
    expect(sheet?.characters.duncan.apparel).toBe('red shirt');
    expect(sheet?.location.environment).toBe('raining');
    expect(foldSheet([entry(0), entry(1)])).toBeNull();
  });

  it('commit order is irrelevant: turn N and N+1 landing in either order fold to the same sheet', () => {
    // The review scenario: N establishes the shirt, N+1 records only the rain.
    // Each turn stamps only its own delta, so whichever state call lands
    // later cannot drop the other's fact — the fold reads log position.
    const landedNFirst = [entry(0, red), entry(1, rain)];
    const landedN1First = [entry(0), entry(1, rain)];
    landedN1First[0] = entry(0, red); // N lands afterwards, onto its own entry
    expect(foldSheet(landedNFirst)).toEqual(foldSheet(landedN1First));
    expect(foldSheet(landedN1First)?.characters.duncan.apparel).toBe('red shirt');
  });

  it('a sliced log (re-spin / tangent rollback) folds only what remains', () => {
    const log = [entry(0, red), entry(1, rain), entry(2, { characters: { Duncan: { present: false, absence_reason: 'left' } } })];
    expect(foldSheet(log)?.characters.duncan.present).toBe(false);
    expect(foldSheet(log.slice(0, 2))?.characters.duncan.present).toBe(true);
    expect(foldSheet(log.slice(0, 1))?.location.environment).toBeUndefined();
  });

  it('a corrupted persisted delta applies nothing and cannot break the fold', () => {
    const log = [entry(0, red), entry(1, 'oops' as unknown as Record<string, unknown>), entry(2, rain)];
    expect(foldSheet(log)?.characters.duncan.apparel).toBe('red shirt');
    expect(foldSheet(log)?.location.environment).toBe('raining');
  });
});
