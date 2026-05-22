// SGC persistence — SQLite via better-sqlite3.
//
// Storage lives in ./data/sgc.db (gitignored). Schema is created on first
// open. Chats + turns are scoped to a chat (cascade on delete); memories are
// GLOBAL across chats — they evolve over the user's lifetime in the system, a
// chat doesn't own its memory state.
//
// This module owns the DB connection, the schema, and a set of pure helpers
// callers (the Express routes in index.ts) compose into endpoints. It does no
// HTTP and no model work. Phase 1.5 invariant: persistence is plumbing, never
// a reasoning component.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DB_PATH = process.env.SGC_DB_PATH || resolve(process.cwd(), 'data', 'sgc.db');

// Ensure the parent directory exists — better-sqlite3 won't create it.
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    inspector_json TEXT,
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_turns_chat ON turns(chat_id, ordinal);

  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    confidence INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memory_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    delta INTEGER NOT NULL,
    new_score INTEGER NOT NULL,
    turn_global INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

// Migration: DBs created before the chat memory editor predate turns.active.
// CREATE TABLE IF NOT EXISTS won't add a column to an existing table, so add it
// explicitly when missing. Default 1 means every pre-existing turn stays
// retrievable — gating is opt-out, never silently applied.
{
  const turnCols = db.prepare(`PRAGMA table_info(turns)`).all() as { name: string }[];
  if (!turnCols.some((c) => c.name === 'active')) {
    db.exec(`ALTER TABLE turns ADD COLUMN active INTEGER NOT NULL DEFAULT 1`);
  }
}

// Migration: per-chat persona + assistant mask. Additive, same pattern as
// turns.active above. NULL persona → DEFAULT_PERSONA is resolved client-side at
// prompt-build time; NULL/'' mask → "Sal" at render time. Old chats are
// untouched and read as default-Sal. The server stores both as opaque strings —
// it never interprets the persona (it forwards the fully-built system prompt)
// and the mask never reaches the model at all (display-only).
{
  const chatCols = db.prepare(`PRAGMA table_info(chats)`).all() as { name: string }[];
  if (!chatCols.some((c) => c.name === 'persona')) {
    db.exec(`ALTER TABLE chats ADD COLUMN persona TEXT`);
  }
  if (!chatCols.some((c) => c.name === 'mask')) {
    db.exec(`ALTER TABLE chats ADD COLUMN mask TEXT`);
  }
}

// ============================================================
// TYPES — shape on the wire (camelCase). DB columns are snake_case
// and get mapped explicitly in each helper.
// ============================================================

export interface ChatSummary {
  id: string;
  title: string;
  snippet: string;
  updatedAt: number;
  turnCount: number;
  /** Display-only assistant mask. null/'' → rendered as "Sal". Never sent to the model. */
  mask: string | null;
}

export interface ChatTurn {
  id: number;
  ordinal: number;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  inspectorJson: string | null;
  /** Whether this turn participates in cosine-grep retrieval (chat memory editor gate). */
  active: boolean;
}

export interface ChatDetail {
  id: string;
  title: string;
  turns: ChatTurn[];
  latestInspector: unknown | null;
  /** Per-chat system-prompt persona. null → client resolves DEFAULT_PERSONA. */
  persona: string | null;
  /** Display-only assistant mask. null/'' → "Sal". Never sent to the model. */
  mask: string | null;
}

export interface MemoryRow {
  id: string;
  text: string;
  confidence: number;
}

export interface MemoryHistoryRow {
  memoryId: string;
  delta: number;
  newScore: number;
  turnGlobal: number;
  createdAt: number;
}

// ============================================================
// CHAT HELPERS
// ============================================================

const NEW_CHAT_TITLE = 'New chat';

// Derive a chat title from the first user message — trimmed, single-line,
// capped at 60 chars. The UI truncates visually; we don't append an ellipsis.
export function deriveTitle(userContent: string): string {
  const oneLine = userContent.replace(/\s+/g, ' ').trim();
  if (!oneLine) return NEW_CHAT_TITLE;
  return oneLine.length > 60 ? oneLine.slice(0, 60).trimEnd() : oneLine;
}

const insertChatStmt = db.prepare(`
  INSERT INTO chats (id, title, created_at, updated_at, persona, mask)
  VALUES (?, ?, ?, ?, ?, ?)
`);

// Create a chat. `persona` is the per-chat system-prompt head (null → the
// client resolves DEFAULT_PERSONA at build time); `mask` is the display-only
// assistant label (null/'' → "Sal"). Both are stored as opaque strings — the
// server never interprets the persona and the mask never reaches the model.
export function createChat(
  id: string,
  persona?: string | null,
  mask?: string | null,
): { id: string } {
  const now = Date.now();
  insertChatStmt.run(id, NEW_CHAT_TITLE, now, now, persona ?? null, mask ?? null);
  return { id };
}

// One row per chat: title, updated_at, count of turns, and the most recent
// assistant turn's content (snippet source). LEFT JOIN so empty chats survive.
const listChatsStmt = db.prepare(`
  SELECT
    c.id           AS id,
    c.title        AS title,
    c.mask         AS mask,
    c.updated_at   AS updated_at,
    (SELECT COUNT(*) FROM turns t WHERE t.chat_id = c.id)                       AS turn_count,
    (SELECT t.content
       FROM turns t
      WHERE t.chat_id = c.id AND t.role = 'assistant'
      ORDER BY t.ordinal DESC
      LIMIT 1)                                                                  AS last_assistant
  FROM chats c
  ORDER BY c.updated_at DESC
`);

interface ListChatRow {
  id: string;
  title: string;
  mask: string | null;
  updated_at: number;
  turn_count: number;
  last_assistant: string | null;
}

export function listChats(): ChatSummary[] {
  const rows = listChatsStmt.all() as ListChatRow[];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    snippet: r.last_assistant
      ? r.last_assistant.replace(/\s+/g, ' ').trim().slice(0, 120)
      : '',
    updatedAt: r.updated_at,
    turnCount: r.turn_count,
    mask: r.mask,
  }));
}

const getChatStmt = db.prepare(`SELECT id, title, persona, mask FROM chats WHERE id = ?`);
const getChatTurnsStmt = db.prepare(`
  SELECT id, ordinal, role, content, created_at, inspector_json, active
  FROM turns
  WHERE chat_id = ?
  ORDER BY ordinal ASC
`);

interface ChatHeaderRow { id: string; title: string; persona: string | null; mask: string | null }
interface TurnRow {
  id: number;
  ordinal: number;
  role: 'user' | 'assistant';
  content: string;
  created_at: number;
  inspector_json: string | null;
  active: number;
}

export function loadChat(id: string): ChatDetail | null {
  const header = getChatStmt.get(id) as ChatHeaderRow | undefined;
  if (!header) return null;
  const rows = getChatTurnsStmt.all(id) as TurnRow[];
  const turns: ChatTurn[] = rows.map((r) => ({
    id: r.id,
    ordinal: r.ordinal,
    role: r.role,
    content: r.content,
    createdAt: r.created_at,
    inspectorJson: r.inspector_json,
    active: r.active !== 0,
  }));
  // The latest assistant turn carries the inspector blob worth restoring into
  // the right-rail diagnostics — older turns' blobs aren't displayed.
  let latestInspector: unknown | null = null;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'assistant' && turns[i].inspectorJson) {
      try {
        latestInspector = JSON.parse(turns[i].inspectorJson as string);
      } catch {
        latestInspector = null;
      }
      break;
    }
  }
  return {
    id: header.id,
    title: header.title,
    turns,
    latestInspector,
    persona: header.persona,
    mask: header.mask,
  };
}

const deleteChatStmt = db.prepare(`DELETE FROM chats WHERE id = ?`);
export function deleteChat(id: string): boolean {
  return deleteChatStmt.run(id).changes > 0;
}

const insertTurnStmt = db.prepare(`
  INSERT INTO turns (chat_id, ordinal, role, content, created_at, inspector_json)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const nextOrdinalStmt = db.prepare(`
  SELECT COALESCE(MAX(ordinal), 0) AS max_ord FROM turns WHERE chat_id = ?
`);
const touchChatStmt = db.prepare(`UPDATE chats SET updated_at = ? WHERE id = ?`);
const setTitleStmt = db.prepare(`UPDATE chats SET title = ? WHERE id = ?`);
const turnCountForChatStmt = db.prepare(
  `SELECT COUNT(*) AS n FROM turns WHERE chat_id = ?`,
);

export interface SaveTurnInput {
  user: { content: string };
  assistant: { content: string; inspectorJson: string | null };
}

// Insert one user + assistant pair atomically. On the first turn, derive the
// chat title from the user content. Bumps updated_at so the chat surfaces at
// the top of the history list.
export function saveTurnPair(chatId: string, input: SaveTurnInput): void {
  const exists = (getChatStmt.get(chatId) as ChatHeaderRow | undefined);
  if (!exists) throw new Error(`chat not found: ${chatId}`);
  const txn = db.transaction(() => {
    const before = (turnCountForChatStmt.get(chatId) as { n: number }).n;
    const baseOrdinal = (nextOrdinalStmt.get(chatId) as { max_ord: number }).max_ord;
    const now = Date.now();
    insertTurnStmt.run(chatId, baseOrdinal + 1, 'user', input.user.content, now, null);
    insertTurnStmt.run(
      chatId,
      baseOrdinal + 2,
      'assistant',
      input.assistant.content,
      now,
      input.assistant.inspectorJson,
    );
    if (before === 0) {
      setTitleStmt.run(deriveTitle(input.user.content), chatId);
    }
    touchChatStmt.run(now, chatId);
  });
  txn();
}

const setTurnActiveStmt = db.prepare(
  `UPDATE turns SET active = ? WHERE id = ? AND chat_id = ?`,
);

export interface TurnActiveState {
  id: number;
  active: boolean;
}

// Toggle the cosine-grep gate on one or more turns (chat memory editor). The
// UPDATE is scoped by chat_id as well as id, so a turn-id from another chat
// can't be flipped through this chat's route. Does NOT bump updated_at: gating
// is a curation of an existing chat, not new activity, so it shouldn't
// reshuffle the history list's recency order.
export function setTurnsActive(chatId: string, states: TurnActiveState[]): void {
  const exists = getChatStmt.get(chatId) as ChatHeaderRow | undefined;
  if (!exists) throw new Error(`chat not found: ${chatId}`);
  const txn = db.transaction(() => {
    for (const s of states) {
      setTurnActiveStmt.run(s.active ? 1 : 0, s.id, chatId);
    }
  });
  txn();
}

// ============================================================
// MEMORY HELPERS
// ============================================================

const listMemoriesStmt = db.prepare(`
  SELECT id, text, confidence
  FROM memories
  ORDER BY created_at ASC
`);
const listMemoryHistoryStmt = db.prepare(`
  SELECT memory_id, delta, new_score, turn_global, created_at
  FROM memory_history
  ORDER BY id ASC
`);

interface MemoryDbRow { id: string; text: string; confidence: number }
interface MemoryHistoryDbRow {
  memory_id: string;
  delta: number;
  new_score: number;
  turn_global: number;
  created_at: number;
}

export function getMemories(): { memories: MemoryRow[]; history: MemoryHistoryRow[] } {
  const memories = (listMemoriesStmt.all() as MemoryDbRow[]).map((r) => ({
    id: r.id,
    text: r.text,
    confidence: r.confidence,
  }));
  const history = (listMemoryHistoryStmt.all() as MemoryHistoryDbRow[]).map((r) => ({
    memoryId: r.memory_id,
    delta: r.delta,
    newScore: r.new_score,
    turnGlobal: r.turn_global,
    createdAt: r.created_at,
  }));
  return { memories, history };
}

const listMemoryIdsStmt = db.prepare(`SELECT id FROM memories`);
const deleteMemoryStmt = db.prepare(`DELETE FROM memories WHERE id = ?`);
const upsertMemoryStmt = db.prepare(`
  INSERT INTO memories (id, text, confidence, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    text = excluded.text,
    confidence = excluded.confidence,
    updated_at = excluded.updated_at
`);
const deleteHistoryForMemoryStmt = db.prepare(
  `DELETE FROM memory_history WHERE memory_id = ?`,
);
const insertMemoryHistoryStmt = db.prepare(`
  INSERT INTO memory_history (memory_id, delta, new_score, turn_global, created_at)
  VALUES (?, ?, ?, ?, ?)
`);

export interface SaveMemoryInput {
  id: string;
  text: string;
  confidence: number;
  history: Array<{ delta: number; newScore: number; turnGlobal: number }>;
}

export interface SaveMemoriesInput {
  memories: SaveMemoryInput[];
}

// Each memory carries its own (full, authoritative) history slice. The client
// already holds the canonical Memory.history[] sparkline state — including
// rows it just hydrated from us — so it round-trips faithfully. We upsert the
// memory rows (preserving created_at on existing ones) and replace the history
// slice per memory_id. Memories absent from the payload are deleted, which
// cascades their history. Critically, we do NOT bulk-DELETE memories first:
// the previous semantics nuked every memory_history row via cascade and then
// only repopulated what the client sent in an optional appendHistory — which
// the client never sent — so each save erased the entire sparkline.
export function saveMemories(input: SaveMemoriesInput): void {
  const now = Date.now();
  const incomingIds = new Set(input.memories.map((m) => m.id));
  const txn = db.transaction(() => {
    const existing = listMemoryIdsStmt.all() as { id: string }[];
    for (const row of existing) {
      if (!incomingIds.has(row.id)) deleteMemoryStmt.run(row.id);
    }
    for (const m of input.memories) {
      upsertMemoryStmt.run(m.id, m.text, m.confidence, now, now);
      deleteHistoryForMemoryStmt.run(m.id);
      for (const h of m.history) {
        insertMemoryHistoryStmt.run(m.id, h.delta, h.newScore, h.turnGlobal, now);
      }
    }
  });
  txn();
}
