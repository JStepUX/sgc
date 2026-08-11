// Ephemeral-tangent boundary persistence (docs/04_ephemeral-tangent-spec.yaml)
// — the two lifecycle moves of chats.tangent_start: begin (stamp the boundary)
// and resolve (clear it, wiping the tail on discard). The column itself is
// declared in db.ts (schema is db.ts's job); these helpers own its lifecycle.
// Split from db.ts by the anti-god-object ratchet — same connection, one
// concern per module (the db-turn-edits.ts pattern).
//
// Phase 1.5 invariant: pure row curation, same family as deleteLatestTurnPair
// — no model anywhere, and Sal is never told a tangent is open (the boundary
// is harness state, never prompt-visible — spec D5). A tangent turn is an
// ordinary turn to every context tier until a discard removes its row.

import { db } from './db.js';

const getTangentStmt = db.prepare(
  `SELECT tangent_start FROM chats WHERE id = ?`,
);
const chatMaxOrdinalStmt = db.prepare(
  `SELECT COALESCE(MAX(ordinal), 0) AS max_ord, COUNT(*) AS n FROM turns WHERE chat_id = ?`,
);
const setTangentStmt = db.prepare(
  `UPDATE chats SET tangent_start = ? WHERE id = ?`,
);
// `AND timeless = 0` is defense-in-depth (build the check, don't trust the
// caller): the boundary being MAX(ordinal) at entry already means a manual
// memory can't land past it (prepends go BELOW the current minimum — see
// prependManualTurnPair), but an API caller must still be unable to wipe a
// curated memory through this route.
const deleteTailStmt = db.prepare(
  `DELETE FROM turns WHERE chat_id = ? AND ordinal > ? AND timeless = 0`,
);

// Open a tangent: stamp the boundary (the chat's current MAX ordinal) into
// tangent_start. Returns the boundary on success; null when a tangent is
// already open OR the chat has no turns yet (a tangent on an empty chat is
// meaningless and would let its first turn derive the chat title, then leave
// a ghost title after a wipe — spec D3; the route 409s both). Throws for an
// unknown chat, mirroring saveTurnPair. Does NOT bump updated_at — opening a
// tangent is curation-adjacent bookkeeping, not new activity.
export function beginTangent(chatId: string): number | null {
  const row = getTangentStmt.get(chatId) as { tangent_start: number | null } | undefined;
  if (!row) throw new Error(`chat not found: ${chatId}`);
  if (row.tangent_start !== null) return null;
  const { max_ord, n } = chatMaxOrdinalStmt.get(chatId) as { max_ord: number; n: number };
  if (n === 0) return null;
  setTangentStmt.run(max_ord, chatId);
  return max_ord;
}

// Resolve the open tangent. 'canon' clears the boundary and touches nothing
// else — tangent turns were stored canon-shaped all along, so canonization is
// a no-op on the turns table. 'discard' deletes every non-timeless turn past
// the boundary and clears the column in one transaction, so a crash can never
// leave a half-wiped tangent that still looks open (or a closed one with its
// tail intact). Returns false when no tangent is open (or the chat is gone) —
// a stale second window resolves to a 409, never a double delete. Neither
// outcome bumps updated_at: resolution is curation of the chat's tail, not new
// activity — same reasoning as deleteLatestTurnPair.
export function resolveTangent(chatId: string, outcome: 'canon' | 'discard'): boolean {
  const row = getTangentStmt.get(chatId) as { tangent_start: number | null } | undefined;
  if (!row || row.tangent_start === null) return false;
  const boundary = row.tangent_start;
  if (outcome === 'canon') {
    setTangentStmt.run(null, chatId);
    return true;
  }
  const txn = db.transaction(() => {
    deleteTailStmt.run(chatId, boundary);
    setTangentStmt.run(null, chatId);
  });
  txn();
  return true;
}
