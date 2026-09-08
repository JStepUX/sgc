// ============================================================
// CONTINUITY SHEET — the pure half (spec 07).
//
// A per-chat sheet of durable, low-salience scene facts: story, location, and
// one record per named character (presence, apparel, items, position,
// physical state, disposition toward the person, what they don't yet know).
// It exists for the facts salience gating structurally drops — a shirt is
// never the topic, so the grep never scores it, and it's rarely restated, so
// the buffers lose it after four entries. The selection criterion for a SLOT
// (never a category list in the prompt): a fact holds until an event changes
// it, later replies must stay consistent with it, and neither buffer nor a
// topical search could reconstruct it.
//
// STORAGE IS DELTAS, THE SHEET IS A FOLD. Each assistant entry carries only
// the delta its state turn produced (ChatEntry.sheetDelta); the sheet any
// reader sees is foldSheet(log) — every delta applied in LOG order, from the
// first entry to the last. This is the concurrency fix from review
// (2026-09-07): with no composer gate, turn N+1's state call can land before
// or after turn N's, and a design that stored each turn's whole sheet let
// whichever landed later silently drop the other's delta. Folding by log
// position makes landing order irrelevant, makes an edited turn's old
// contribution vanish the moment its delta is cleared, and validates every
// persisted delta on the way in (an unusable one applies nothing). Cost: one
// pass over the log per prompt build — a few object spreads per entry.
//
// Produced as DELTAS by the existing post-reply state turn (lib/state-turn.ts)
// and merged here by code. The recurrence bound is different from Dynamic
// State's and must be read as such: inner state is regenerated every turn;
// the sheet ACCRETES by design. Its bounds are the fixed schema (the slot
// count is the cap), the per-slot char cap, the character-record cap,
// deltas-only merging (omission never deletes, so a lazy or truncated model
// output cannot blank it), and diegetic correction (the person's explicit
// correction outranks narration — a prompt rule, not code).
//
// Re-spin, tangent rollback and edit get correct rollback for free: they slice
// or delete entries, and the fold only sees what remains. Pure — no React, no
// network, no model. Rendered into the main prompt by lib/prompt.ts as
// labeled lines, never JSON (spec 03 D4).
// ============================================================

import type { ChatEntry } from './types';

/** Hard cap on any one slot, in characters — a model that ignores the
 *  "concise" instruction still cannot flood the next prompt. */
export const SLOT_CHARS = 160;

/** Hard cap on character records. A 17th named character is dropped (that
 *  record only); the existing sixteen are untouched. */
export const CHARACTER_RECORDS = 16;

export interface StorySlots {
  genre?: string;
  /** One line: time of day and/or elapsed narrative time — "day 3, late evening". */
  time?: string;
}

export interface LocationSlots {
  name?: string;
  type?: string;
  /** ONE established line (rain, dark, smoke) — never decoration. */
  environment?: string;
}

export interface CharacterRecord {
  /** Display name — the first sighting's casing, never overwritten. */
  name: string;
  present: boolean;
  absence_reason?: string;
  immediate_location?: string;
  stance?: string;
  apparel?: string;
  items?: string;
  physical_state?: string;
  /** A standing attitude toward the person (trust, fear, debt) — not this moment's mood. */
  disposition_to_user?: string;
  /** Only a SHOWN gap — what the story showed them miss or be misled about. */
  unaware_of?: string;
}

export interface ContinuitySheet {
  story: StorySlots;
  location: LocationSlots;
  /** Keyed by characterKey(name). */
  characters: Record<string, CharacterRecord>;
}

/**
 * A model-emitted delta, stored as received (whitespace and caps are applied
 * at fold time, not at store time, so the stored blob is exactly what the
 * model said). Deliberately opaque: applyContinuityDelta validates every
 * field it reads and ignores the rest, so a persisted delta of any shape —
 * including a corrupted one — can never crash a fold.
 */
export type ContinuityDelta = Record<string, unknown>;

const STORY_SLOTS = ['genre', 'time'] as const;
const LOCATION_SLOTS = ['name', 'type', 'environment'] as const;
const CHARACTER_SLOTS = [
  'absence_reason',
  'immediate_location',
  'stance',
  'apparel',
  'items',
  'physical_state',
  'disposition_to_user',
  'unaware_of',
] as const;

/** Keys that would reach Object.prototype through a plain-object record map. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** The schema example in the state prompt uses "<only if it changed>"-style
 *  placeholders. A small model that echoes the template back would otherwise
 *  write those onto the sheet (review finding, 2026-09-07) — so a value or a
 *  name that IS a placeholder is a no-op, never a fact. */
const PLACEHOLDER = /^<[^<>]*>$/;

export function emptySheet(): ContinuitySheet {
  return { story: {}, location: {}, characters: {} };
}

/** Collapse ALL whitespace runs (incl. newlines) to single spaces and trim —
 *  structural sanitization, not tidiness: every slot re-enters a system prompt
 *  as part of a labeled line, and a value carrying newlines could fabricate
 *  lines that prompt never wrote (same rule as dynamic-state.ts coerceField). */
function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** The record key for a character name: trimmed, whitespace-collapsed,
 *  lower-cased — so "Duncan", "duncan " and "DUNCAN" are one record. */
export function characterKey(name: string): string {
  return clean(name).toLowerCase();
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function usableName(v: unknown): string {
  if (typeof v !== 'string') return '';
  const t = clean(v);
  return PLACEHOLDER.test(t) ? '' : t;
}

/**
 * Apply one delta object's slots onto a target: a string sets (cleaned,
 * hard-cut), null or blank clears, a placeholder or anything else leaves the
 * slot as it was. Only the listed slots are read — a model that invents a
 * field changes nothing.
 */
function applySlots<K extends string>(
  target: Partial<Record<K, string>>,
  delta: Record<string, unknown>,
  slots: readonly K[],
): void {
  for (const slot of slots) {
    if (!(slot in delta)) continue;
    const v = delta[slot];
    if (v === null) {
      delete target[slot];
    } else if (typeof v === 'string') {
      const t = clean(v);
      if (t.length === 0) delete target[slot];
      else if (!PLACEHOLDER.test(t)) target[slot] = t.slice(0, SLOT_CHARS);
    }
    // any other type: preserved
  }
}

/**
 * A character delta may arrive keyed by name (the schema) or as an array of
 * records each carrying a `name` (what models often produce anyway). Both
 * normalise to [displayName, delta] pairs; entries without a usable name —
 * blank, or a template placeholder like "<name>" — are dropped.
 */
function characterDeltas(raw: unknown): [string, Record<string, unknown>][] {
  const out: [string, Record<string, unknown>][] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isPlainObject(item)) continue;
      const display = usableName(item.name);
      if (display) out.push([display, item]);
    }
  } else if (isPlainObject(raw)) {
    for (const [key, item] of Object.entries(raw)) {
      if (!isPlainObject(item)) continue;
      const display = usableName(item.name) || usableName(key);
      if (display) out.push([display, item]);
    }
  }
  return out;
}

/**
 * Merge a model-authored delta into the previous sheet. Pure, never throws,
 * never blanks: an unusable delta returns the previous sheet unchanged (or
 * the empty sheet when there was none). Rules (spec 07 D2):
 *
 *  - story: shallow merge of its slots.
 *  - location: shallow merge — EXCEPT when both sides carry a name and the
 *    names differ, in which case the delta REPLACES the location wholesale.
 *    A move is a new place, not an edit to the old one; the old environment
 *    must not survive the walk. Naming a place that had no name yet is not a
 *    move, so it merges (the spec's one documented exception).
 *  - characters: per-record shallow merge. An unseen name opens a record
 *    (present defaults true). Records are never deleted — absence is
 *    present:false plus a reason. A delta that sets present:true clears a
 *    stale absence_reason unless it supplies a new one (the spec's other
 *    documented exception: "present, reason: left for the market" is a
 *    contradiction, not a fact, and the state prompt would carry it forward
 *    as one).
 *  - over cap: a record that would be the 17th is dropped; nothing else is.
 *  - values: whitespace-collapsed, hard-cut at SLOT_CHARS; null or blank
 *    clears; a template placeholder or a non-string leaves the slot alone;
 *    `present` must be boolean.
 */
export function applyContinuityDelta(prev: ContinuitySheet | null, delta: unknown): ContinuitySheet {
  const base: ContinuitySheet = prev
    ? {
        story: { ...prev.story },
        location: { ...prev.location },
        characters: Object.fromEntries(Object.entries(prev.characters).map(([k, r]) => [k, { ...r }])),
      }
    : emptySheet();
  if (!isPlainObject(delta)) return base;

  if (isPlainObject(delta.story)) applySlots(base.story, delta.story, STORY_SLOTS);

  if (isPlainObject(delta.location)) {
    const incoming = usableName(delta.location.name);
    const current = base.location.name ?? '';
    const moved = incoming.length > 0 && current.length > 0 && incoming.toLowerCase() !== current.toLowerCase();
    if (moved) base.location = {};
    applySlots(base.location, delta.location, LOCATION_SLOTS);
  }

  for (const [display, d] of characterDeltas(delta.characters)) {
    const key = characterKey(display);
    if (!key || FORBIDDEN_KEYS.has(key)) continue;
    let record = base.characters[key];
    if (!record) {
      if (Object.keys(base.characters).length >= CHARACTER_RECORDS) continue;
      record = { name: display.slice(0, SLOT_CHARS), present: true };
      base.characters[key] = record;
    }
    if (typeof d.present === 'boolean') {
      if (d.present && !record.present && !('absence_reason' in d)) delete record.absence_reason;
      record.present = d.present;
    }
    applySlots(record, d, CHARACTER_SLOTS);
  }

  return base;
}

/**
 * Would this delta change anything? Structural only (does it carry any slot
 * at all), not semantic (a delta that restates a fact still counts). Used by
 * the rail to say "no changes this turn"; a null/absent delta is empty.
 */
export function isDeltaEmpty(delta: ContinuityDelta | null | undefined): boolean {
  if (!isPlainObject(delta)) return true;
  const story = isPlainObject(delta.story) ? Object.keys(delta.story).length : 0;
  const location = isPlainObject(delta.location) ? Object.keys(delta.location).length : 0;
  const characters = Array.isArray(delta.characters)
    ? delta.characters.length
    : isPlainObject(delta.characters)
      ? Object.keys(delta.characters).length
      : 0;
  return story + location + characters === 0;
}

/**
 * THE fold: every delta in the log, applied in log order. Null when no entry
 * carries a delta, so callers can skip the block. This is what the next
 * prompt reads (turn-context.ts), what the rail shows, and what the state
 * prompt feeds back as the previous sheet — always derived, never stored, so
 * there is exactly one truth and it survives out-of-order commits, edits and
 * rollback by construction (see header).
 */
export function foldSheet(log: readonly ChatEntry[]): ContinuitySheet | null {
  let sheet: ContinuitySheet | null = null;
  for (const entry of log) {
    if (entry.sheetDelta === undefined || entry.sheetDelta === null) continue;
    sheet = applyContinuityDelta(sheet, entry.sheetDelta);
  }
  return sheet;
}

/** True when nothing on the sheet would render — the caller skips the block. */
export function isSheetEmpty(sheet: ContinuitySheet | null | undefined): boolean {
  if (!sheet) return true;
  return (
    STORY_SLOTS.every((k) => !sheet.story[k]) &&
    LOCATION_SLOTS.every((k) => !sheet.location[k]) &&
    Object.keys(sheet.characters).length === 0
  );
}

/** Slot → the label Sal reads. Diegetic wording, not schema keys. */
const CHARACTER_LABELS: { key: (typeof CHARACTER_SLOTS)[number]; label: string }[] = [
  { key: 'immediate_location', label: 'at' },
  { key: 'stance', label: 'stance' },
  { key: 'apparel', label: 'wearing' },
  { key: 'items', label: 'carrying' },
  { key: 'physical_state', label: 'state' },
  { key: 'disposition_to_user', label: 'toward you' },
  { key: 'unaware_of', label: 'unaware' },
];

/**
 * Flatten a sheet into the labeled lines the main prompt renders — never JSON.
 * Present characters get one full line each; absent ones a single line with
 * the reason. Empty slots are OMITTED rather than rendered as an empty label
 * (an empty label invites the model to fill it). Returns '' when the sheet is
 * empty, so the caller can skip the block. The block header lives in
 * lib/prompt.ts; this is the body.
 */
export function flattenSheetForPrompt(sheet: ContinuitySheet | null | undefined): string {
  if (!sheet || isSheetEmpty(sheet)) return '';
  const lines: string[] = [];

  const story = [sheet.story.genre, sheet.story.time].filter((s): s is string => !!s);
  if (story.length > 0) lines.push(`  story: ${story.join('; ')}`);

  const { name, type, environment } = sheet.location;
  if (name || type || environment) {
    const head = name ? (type ? `${name} (${type})` : name) : (type ?? '');
    lines.push(`  location: ${[head, environment].filter(Boolean).join(' — ')}`);
  }

  const present: string[] = [];
  const elsewhere: string[] = [];
  for (const r of Object.values(sheet.characters)) {
    if (r.present) {
      const parts = CHARACTER_LABELS.filter(({ key }) => r[key]).map(({ key, label }) => `${label}: ${r[key]}`);
      present.push(parts.length > 0 ? `    ${r.name} — ${parts.join('; ')}` : `    ${r.name}`);
    } else {
      elsewhere.push(r.absence_reason ? `    ${r.name} — ${r.absence_reason}` : `    ${r.name}`);
    }
  }
  if (present.length > 0) lines.push('  present:', ...present);
  if (elsewhere.length > 0) lines.push('  elsewhere:', ...elsewhere);

  return lines.join('\n');
}
