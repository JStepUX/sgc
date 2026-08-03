// Turn-edit persistence — the two ways an EXISTING assistant reply's row gets
// rewritten after the fact: the response editor replacing its content, and the
// post-reply state turn attaching its inspector blob. The turns table itself is
// declared in db.ts (schema is db.ts's job); these helpers own the rewrites.
// Split from db.ts by the anti-god-object ratchet — same connection, one
// concern per module (the db-brains.ts pattern).

import { db } from './db.js';

// Replace a turn's content in place (assistant-response editor). created_at and
// ordinal are intentionally left UNCHANGED: editing a reply is curation of an
// existing turn, not new activity — the cosine corpus re-reads the new text
// automatically (tfidf is recomputed fresh every search, no cache) while the
// time scorer's recency anchor stays put. Scoped by chat_id as well as id so a
// turn-id from another chat can't be rewritten through this chat's route. Does
// NOT bump updated_at — same reasoning as setTurnsActive. Returns false when no
// row matched.
//
// inspectorJson === undefined leaves the existing blob untouched; a string/null
// overwrites it. A manual edit clears the turn-summary by overwriting with a
// blob whose `summary` is null (the only field loadChat rehydrates); a re-spin
// overwrites with fresh TurnData.
//
// `AND role = 'assistant' AND timeless = 0` scopes this to ordinary streamed
// replies at the mutation itself — the editor only ever targets those. A user
// row must never be rewritten through this route, and a timeless manual memory
// is curated through the chat memory editor's insert/delete path (it has no
// Sal-emitted summary and no original prompt to re-spin). Defense-in-depth,
// mirroring setTurnsActive / deleteManualTurnPair: build the check, don't
// trust the caller — a UI bug or an API client can't reach past the intent.
const updateTurnContentOnlyStmt = db.prepare(
  `UPDATE turns SET content = ? WHERE id = ? AND chat_id = ? AND role = 'assistant' AND timeless = 0`,
);
const updateTurnContentAndInspectorStmt = db.prepare(
  `UPDATE turns SET content = ?, inspector_json = ? WHERE id = ? AND chat_id = ? AND role = 'assistant' AND timeless = 0`,
);

export function updateTurnContent(
  chatId: string,
  turnId: number,
  content: string,
  inspectorJson?: string | null,
): boolean {
  if (inspectorJson === undefined) {
    return updateTurnContentOnlyStmt.run(content, turnId, chatId).changes > 0;
  }
  return updateTurnContentAndInspectorStmt.run(content, inspectorJson, turnId, chatId).changes > 0;
}

// The post-reply state turn's write: attach a fresh inspector blob WITHOUT
// touching content — and only if the content is still the text the state call
// reflected on. The `AND content = ?` makes the check-and-write one atomic
// statement (better-sqlite3 is synchronous on one connection), which is what
// closes the client's check-then-PATCH race for good: a state call that lands
// after an edit finds the content moved, matches zero rows, and the caller
// abandons. Same assistant/timeless scoping as updateTurnContent, same
// no-updated_at-bump reasoning. Returns false when nothing matched — the
// caller cannot distinguish "row gone" from "content moved", and doesn't need
// to: both mean the state result describes a reply that no longer exists.
//
// KNOWN BOUNDARY: the condition is on content only, so two same-content
// inspector writes (a machine state vs a hand-curated one) are last-writer-
// wins. Within one window the client's write-epoch map orders them; across
// windows nothing does — accepted, because the whole client session (in-memory
// logs, epoch map, reflecting registry) is single-window by design, and a
// second window desyncs far more than this row. If multi-window ever becomes
// real, the fix is an inspector revision column CAS, not a cleverer condition.
const updateTurnInspectorIfContentStmt = db.prepare(
  `UPDATE turns SET inspector_json = ? WHERE id = ? AND chat_id = ? AND role = 'assistant' AND timeless = 0 AND content = ?`,
);

export function updateTurnInspector(
  chatId: string,
  turnId: number,
  inspectorJson: string | null,
  expectedContent: string,
): boolean {
  return updateTurnInspectorIfContentStmt.run(inspectorJson, turnId, chatId, expectedContent).changes > 0;
}
