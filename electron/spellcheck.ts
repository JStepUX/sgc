// Spellchecker wiring. Chromium's spellchecker is built into Electron and on
// by default, so misspellings already underline — but Electron ships NO default
// context menu, which means the squiggle has no fix attached to it. This module
// supplies the three missing pieces: the suggestion menu, the language choice,
// and loud logging of the dictionary download lifecycle.
//
// On the dictionary: Chromium fetches hunspell `.bdic` files from a Google CDN
// on first use and caches them in userData, so it's a one-time network hit, not
// a per-launch dependency. We deliberately do NOT self-host them
// (setSpellCheckerDictionaryDownloadURL REPLACES the CDN rather than falling
// back to it, and the filenames carry a Chromium-side format version that moves
// on Electron majors — a stale bundled file fails silently). The lifecycle
// logging below is the trade for that: if the fetch ever breaks, it says so
// instead of quietly dropping every squiggle. Core Value #5.
//
// Electron-free at runtime — types only, with Menu injected by the caller — so
// these tests run under plain Node like config.ts's.

import type {
  ContextMenuParams,
  Menu as MenuClass,
  MenuItemConstructorOptions,
  Session,
  WebContents,
} from 'electron';

// Most-wanted first. en-US is the deliberate choice (an early version shipped
// en-GB first without that ever being decided — flagging "favor" et al.); the
// fallback exists only for a machine with no en-US dictionary available at all.
//
// Note this resolves to exactly ONE language, not the whole list: Chromium
// accepts a word that is valid in ANY enabled language, so enabling en-GB and
// en-US together would pass both "colour" and "color" and make the choice
// meaningless.
export const PREFERRED_LANGUAGES = ['en-US', 'en-GB'];

export interface SpellcheckActions {
  replace(suggestion: string): void;
  addToDictionary(word: string): void;
}

/**
 * The first preferred language the session actually supports, as a
 * single-element list — or `[]` when none match, which the caller must treat as
 * "leave Chromium's default alone". Passing an empty list to
 * setSpellCheckerLanguages DISABLES spellchecking, which is not the fallback we
 * want.
 */
export function pickSpellcheckLanguages(
  available: readonly string[],
  preferred: readonly string[] = PREFERRED_LANGUAGES,
): string[] {
  const match = preferred.find((lang) => available.includes(lang));
  return match ? [match] : [];
}

/**
 * The context menu for a right-click, or `[]` when the click wasn't on a
 * misspelled word — in which case the caller shows no menu at all, leaving
 * non-misspelling right-clicks exactly as they were.
 */
export function spellcheckMenuTemplate(
  params: Pick<ContextMenuParams, 'misspelledWord' | 'dictionarySuggestions'>,
  actions: SpellcheckActions,
): MenuItemConstructorOptions[] {
  const word = params.misspelledWord;
  if (!word) return [];

  const suggestions = params.dictionarySuggestions ?? [];
  const items: MenuItemConstructorOptions[] =
    suggestions.length > 0
      ? suggestions.map((suggestion) => ({
          label: suggestion,
          click: () => actions.replace(suggestion),
        }))
      : [{ label: 'No suggestions', enabled: false }];

  items.push({ type: 'separator' });
  items.push({
    label: `Add “${word}” to dictionary`,
    click: () => actions.addToDictionary(word),
  });
  return items;
}

function applyLanguages(session: Session): void {
  const chosen = pickSpellcheckLanguages(session.availableSpellCheckerLanguages);
  if (chosen.length === 0) {
    console.warn('spellcheck: no preferred language available, keeping the Chromium default');
    return;
  }
  try {
    session.setSpellCheckerLanguages(chosen);
  } catch (err) {
    // Non-fatal: a failure here leaves the default language, not no
    // spellchecker. Never take the window down over it.
    console.error('spellcheck: setSpellCheckerLanguages failed:', err);
  }
}

// Sessions already wired, so a second window can't stack duplicate listeners.
const instrumented = new WeakSet<Session>();

function logDictionaryLifecycle(session: Session): void {
  if (instrumented.has(session)) return;
  instrumented.add(session);

  // These never fire on macOS, which uses the native OS spellchecker and skips
  // the download path entirely. SGC ships Windows-only, so this is the path.
  session.on('spellcheck-dictionary-download-begin', (_event, lang) => {
    console.log(`spellcheck: downloading the ${lang} dictionary`);
  });
  session.on('spellcheck-dictionary-download-success', (_event, lang) => {
    console.log(`spellcheck: ${lang} dictionary downloaded`);
  });
  session.on('spellcheck-dictionary-initialized', (_event, lang) => {
    console.log(`spellcheck: ${lang} dictionary ready`);
  });
  session.on('spellcheck-dictionary-download-failure', (_event, lang) => {
    // The one that matters. Without this line the symptom is "spellcheck just
    // stopped working" with nothing anywhere to explain it.
    console.error(
      `spellcheck: ${lang} dictionary download FAILED — no misspellings will be ` +
        'flagged until it succeeds (offline first run, or the CDN filename moved ' +
        'with a Chromium bump).',
    );
  });
}

/**
 * Wire spellchecking for a window: language, download logging, suggestion menu.
 * `menu` is Electron's Menu class, injected so this module stays testable.
 */
export function attachSpellcheck(webContents: WebContents, menu: typeof MenuClass): void {
  applyLanguages(webContents.session);
  logDictionaryLifecycle(webContents.session);

  webContents.on('context-menu', (_event, params) => {
    const template = spellcheckMenuTemplate(params, {
      replace: (suggestion) => webContents.replaceMisspelling(suggestion),
      addToDictionary: (word) => webContents.session.addWordToSpellCheckerDictionary(word),
    });
    if (template.length === 0) return;
    menu.buildFromTemplate(template).popup();
  });
}
