// Brain-binding persistence — which knowledge packs ("brains") a chat has
// mounted. The chat_brains table itself is declared in db.ts (schema is db.ts's
// job); these helpers own every read/write of it. The pack FILES are owned by
// the brains routes (brains-routes.ts); this module knows only the
// (chat_id, brain_id) bindings. Split from db.ts by the anti-god-object
// ratchet — same connection, one concern per module.

import { db } from './db.js';

const listChatBrainsStmt = db.prepare(
  `SELECT brain_id FROM chat_brains WHERE chat_id = ? ORDER BY brain_id ASC`,
);
const chatExistsStmt = db.prepare(`SELECT id FROM chats WHERE id = ?`);
const deleteChatBrainsStmt = db.prepare(`DELETE FROM chat_brains WHERE chat_id = ?`);
const insertChatBrainStmt = db.prepare(
  `INSERT INTO chat_brains (chat_id, brain_id) VALUES (?, ?)`,
);
const deleteBrainBindingsStmt = db.prepare(`DELETE FROM chat_brains WHERE brain_id = ?`);

/** The ids of the brains a chat has mounted (sorted for determinism). */
export function getChatBrains(chatId: string): string[] {
  return (listChatBrainsStmt.all(chatId) as { brain_id: string }[]).map((r) => r.brain_id);
}

// Replace a chat's mount set wholesale (the PUT semantics of the bindings
// route). Duplicates in the payload collapse via the primary key — we dedupe
// up front so the insert never throws on caller sloppiness. Does NOT bump
// updated_at: mounting is curation of the chat's config, not new activity —
// same reasoning as setTurnsActive/appendPromptVersion in db.ts.
export function setChatBrains(chatId: string, brainIds: string[]): void {
  if (!chatExistsStmt.get(chatId)) throw new Error(`chat not found: ${chatId}`);
  const unique = [...new Set(brainIds)];
  const txn = db.transaction(() => {
    deleteChatBrainsStmt.run(chatId);
    for (const brainId of unique) insertChatBrainStmt.run(chatId, brainId);
  });
  txn();
}

// Cascade for the brain side: when a pack file is deleted, its bindings across
// ALL chats go with it (the chat side cascades via the chats FK in db.ts).
export function deleteBrainBindings(brainId: string): void {
  deleteBrainBindingsStmt.run(brainId);
}
