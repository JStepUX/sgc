import { describe, it, expect, vi } from 'vitest';
import { PREFERRED_LANGUAGES, pickSpellcheckLanguages, spellcheckMenuTemplate } from './spellcheck';

describe('pickSpellcheckLanguages', () => {
  it('picks the most-preferred available language', () => {
    expect(pickSpellcheckLanguages(['en-US', 'en-GB', 'fr'])).toEqual(['en-GB']);
  });

  it('falls back to the next preference when the first is unavailable', () => {
    expect(pickSpellcheckLanguages(['en-US', 'de'])).toEqual(['en-US']);
  });

  it('resolves to exactly one language — enabling several accepts words from any of them', () => {
    expect(pickSpellcheckLanguages(['en-GB', 'en-US'])).toHaveLength(1);
  });

  it('returns empty rather than a list when nothing matches (empty DISABLES the checker, so the caller must skip the call)', () => {
    expect(pickSpellcheckLanguages(['de', 'fr'])).toEqual([]);
    expect(pickSpellcheckLanguages([])).toEqual([]);
  });

  it('defaults to the exported preference order', () => {
    expect(pickSpellcheckLanguages(PREFERRED_LANGUAGES)).toEqual([PREFERRED_LANGUAGES[0]]);
  });
});

describe('spellcheckMenuTemplate', () => {
  const actions = () => ({ replace: vi.fn(), addToDictionary: vi.fn() });

  // Electron hands click() a (menuItem, window, event) triple that these
  // handlers ignore; calling it bare is enough to assert what it wired to.
  const click = (item: { click?: unknown }): void => (item.click as () => void)();

  it('is empty when the click was not on a misspelling, so no menu appears at all', () => {
    expect(
      spellcheckMenuTemplate({ misspelledWord: '', dictionarySuggestions: [] }, actions()),
    ).toEqual([]);
  });

  it('offers one item per suggestion, then a separator, then add-to-dictionary', () => {
    const template = spellcheckMenuTemplate(
      { misspelledWord: 'garantee', dictionarySuggestions: ['guarantee', 'guarantees'] },
      actions(),
    );
    expect(template.map((i) => i.label ?? i.type)).toEqual([
      'guarantee',
      'guarantees',
      'separator',
      'Add “garantee” to dictionary',
    ]);
  });

  it('clicking a suggestion replaces the misspelling with THAT suggestion', () => {
    const a = actions();
    const template = spellcheckMenuTemplate(
      { misspelledWord: 'garantee', dictionarySuggestions: ['guarantee', 'guarantees'] },
      a,
    );
    click(template[1]);
    expect(a.replace).toHaveBeenCalledWith('guarantees');
    expect(a.addToDictionary).not.toHaveBeenCalled();
  });

  it('still offers add-to-dictionary when Chromium has no suggestions', () => {
    const a = actions();
    const template = spellcheckMenuTemplate(
      { misspelledWord: 'Grepory', dictionarySuggestions: [] },
      a,
    );
    expect(template.map((i) => i.label ?? i.type)).toEqual([
      'No suggestions',
      'separator',
      'Add “Grepory” to dictionary',
    ]);
    expect(template[0].enabled).toBe(false);

    click(template[2]);
    expect(a.addToDictionary).toHaveBeenCalledWith('Grepory');
  });

  it('tolerates a params object with no suggestions array', () => {
    const template = spellcheckMenuTemplate(
      { misspelledWord: 'garantee' } as Parameters<typeof spellcheckMenuTemplate>[0],
      actions(),
    );
    expect(template.map((i) => i.label ?? i.type)).toEqual([
      'No suggestions',
      'separator',
      'Add “garantee” to dictionary',
    ]);
  });
});
