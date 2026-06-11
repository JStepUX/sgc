// SGC persistence — SQLite via better-sqlite3.
//
// Storage lives in ./data/sgc.db (gitignored). Schema is created on first
// open. Chats + turns are scoped to a chat (cascade on delete); memories are
// too — each chat owns its own constitutional set (chat_id FK, cascade on
// delete), so different conversations can hold completely different memories
// and a new chat starts empty. (Memories were GLOBAL before; see the migration
// below for the one-time re-scope.)
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

  -- Edit history of a chat's system prompt (persona). Append-only, forward-only:
  -- each save mints a new version at the head (n = max(n)+1) and that head IS the
  -- live prompt — its text is mirrored into chats.persona so the buildPrompt path
  -- (which reads persona) is untouched. There is no "set an old version live"
  -- and no rewind, matching the relay: selecting an old version loads it into the
  -- editor as a draft; saving makes a NEW head. Per-chat, cascade on chat delete.
  CREATE TABLE IF NOT EXISTS prompt_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    n INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(chat_id, n)
  );
  CREATE INDEX IF NOT EXISTS idx_prompt_versions_chat ON prompt_versions(chat_id, n);
`);

// Constitutional memories — plain durable facts, scoped per chat via chat_id
// (cascade on chat delete). No confidence/history: the per-turn grading was
// retired for the <turn-summary> channel. Held in a const so the fresh-create
// path and the legacy migration below share one DDL source of truth.
const MEMORIES_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memories_chat ON memories(chat_id);
`;

// Migration: a deliberate ONE-TIME DROP of any legacy `memories` shape, run
// before the schema DDL so the DDL rebuilds the table cleanly. Two obsolete
// shapes have no honest forward mapping:
//   - GLOBAL memories (no chat_id) — rows that belong to no chat.
//   - CONFIDENCE-GRADED memories (a `confidence` column + a memory_history
//     table) — grading was retired for the <turn-summary> channel, so the
//     scores and their sparkline history are discarded by design.
// Child table first so the parent has no dangling references when it goes.
// (Confirmed acceptable: the local DB is a research-prototype store; the
// discarded data is intentional — same rationale as the original re-scope drop.)
{
  const memCols = db.prepare(`PRAGMA table_info(memories)`).all() as { name: string }[];
  const legacyGlobal = memCols.length > 0 && !memCols.some((c) => c.name === 'chat_id');
  const legacyGraded = memCols.some((c) => c.name === 'confidence');
  if (legacyGlobal || legacyGraded) {
    db.exec(`DROP TABLE IF EXISTS memory_history; DROP TABLE IF EXISTS memories;`);
  }
}
db.exec(MEMORIES_SCHEMA_SQL);

// Migration: DBs created before the chat memory editor predate turns.active.
// CREATE TABLE IF NOT EXISTS won't add a column to an existing table, so add it
// explicitly when missing. Default 1 means every pre-existing turn stays
// retrievable — gating is opt-out, never silently applied.
{
  const turnCols = db.prepare(`PRAGMA table_info(turns)`).all() as { name: string }[];
  if (!turnCols.some((c) => c.name === 'active')) {
    db.exec(`ALTER TABLE turns ADD COLUMN active INTEGER NOT NULL DEFAULT 1`);
  }
  // Migration: manually-inserted "brain surgery" memories carry timeless=1, which
  // the client's time scorer reads to negate recency. Default 0 means every
  // streamed turn is ordinary (recency applies as before). Additive, same
  // opt-in-never-silent pattern as active above.
  if (!turnCols.some((c) => c.name === 'timeless')) {
    db.exec(`ALTER TABLE turns ADD COLUMN timeless INTEGER NOT NULL DEFAULT 0`);
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
  /** Manually-inserted memory whose recency the client's time scorer negates. */
  timeless: boolean;
}

export interface ChatDetail {
  id: string;
  title: string;
  turns: ChatTurn[];
  latestInspector: unknown | null;
  /** Per-chat system-prompt persona — the LIVE prompt (mirrors prompt_versions
   *  head when any version exists). null → client resolves DEFAULT_PERSONA. */
  persona: string | null;
  /** Display-only assistant mask. null/'' → "Sal". Never sent to the model. */
  mask: string | null;
  /** This chat's constitutional memories — plain durable facts (id/text). */
  memories: MemoryRow[];
  /** Edit history of this chat's persona, newest-first. Empty for a chat whose
   *  prompt has never been edited (the client synthesises a baseline from
   *  `persona`). The head (versions[0]) is the live prompt. */
  versions: PromptVersion[];
}

/** One frozen entry in a chat's prompt edit history. `n` is a stable,
 *  monotonically-increasing per-chat label; the head (max n) is live. */
export interface PromptVersion {
  id: number;
  n: number;
  text: string;
  createdAt: number;
}

export interface MemoryRow {
  id: string;
  text: string;
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
  SELECT id, ordinal, role, content, created_at, inspector_json, active, timeless
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
  timeless: number;
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
    timeless: r.timeless !== 0,
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
  // Bundle this chat's memories into the detail so a single load hydrates the
  // constitutional tier alongside turns/persona (no separate round-trip).
  // getMemories is scoped to chat_id.
  const mem = getMemories(id);
  return {
    id: header.id,
    title: header.title,
    turns,
    latestInspector,
    persona: header.persona,
    mask: header.mask,
    memories: mem.memories,
    versions: getPromptVersions(id),
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

// Insert a timeless turn at an explicit ordinal. Separate from insertTurnStmt
// because manual memories set timeless=1 (always active) and need to land at a
// caller-chosen ordinal rather than the running max.
const insertTimelessTurnStmt = db.prepare(`
  INSERT INTO turns (chat_id, ordinal, role, content, created_at, inspector_json, active, timeless)
  VALUES (?, ?, ?, ?, ?, NULL, 1, 1)
`);
const minOrdinalStmt = db.prepare(`
  SELECT MIN(ordinal) AS min_ord FROM turns WHERE chat_id = ?
`);

export interface ManualTurnInput {
  user: { content: string };
  assistant: { content: string };
}

// Insert a manual "brain surgery" memory as the OLDEST turn-pair in a chat:
// two timeless rows (user then assistant) placed below the current minimum
// ordinal. Ordinals may go negative — they exist only to sort, and loadChat's
// ORDER BY ordinal keeps the user/assistant alternation the cosine engine
// relies on. Each new memory becomes the new oldest, pushing prior ones up.
//
// Does NOT bump updated_at: a manual memory is curation of an existing chat (it
// is, by construction, the *oldest* content), not new activity — surfacing the
// chat to the top of the history list would misrepresent it. Same reasoning as
// setTurnsActive. The only exception is title derivation on a still-empty chat,
// mirroring saveTurnPair so the first content seen names the chat.
export function prependManualTurnPair(chatId: string, input: ManualTurnInput): void {
  const exists = getChatStmt.get(chatId) as ChatHeaderRow | undefined;
  if (!exists) throw new Error(`chat not found: ${chatId}`);
  const txn = db.transaction(() => {
    const before = (turnCountForChatStmt.get(chatId) as { n: number }).n;
    const min = (minOrdinalStmt.get(chatId) as { min_ord: number | null }).min_ord;
    // Below the current floor (or 1,2 on an empty chat). Assistant sits one
    // above the user so the pair reads user→assistant in ordinal order.
    const userOrdinal = (min ?? 3) - 2;
    const assistantOrdinal = userOrdinal + 1;
    const now = Date.now();
    insertTimelessTurnStmt.run(chatId, userOrdinal, 'user', input.user.content, now);
    insertTimelessTurnStmt.run(chatId, assistantOrdinal, 'assistant', input.assistant.content, now);
    if (before === 0) {
      setTitleStmt.run(deriveTitle(input.user.content), chatId);
    }
  });
  txn();
}

const getTurnStmt = db.prepare(
  `SELECT ordinal, role, timeless FROM turns WHERE id = ? AND chat_id = ?`,
);
const deleteTurnByOrdinalStmt = db.prepare(
  `DELETE FROM turns WHERE chat_id = ? AND ordinal = ?`,
);

// Delete a manual memory pair given either half's turn id. Both rows go so the
// user/assistant alternation the cosine engine assumes stays intact — deleting
// a single half would desync every later pair's index mapping in searchScored.
// Restricted to timeless turns: this route must never remove a real streamed
// turn (the editor only ever calls it from a manual entry's delete control).
// Returns false when the turn doesn't exist or isn't timeless.
export function deleteManualTurnPair(chatId: string, turnId: number): boolean {
  const row = getTurnStmt.get(turnId, chatId) as
    | { ordinal: number; role: 'user' | 'assistant'; timeless: number }
    | undefined;
  if (!row || row.timeless === 0) return false;
  // The partner sits at the adjacent ordinal: assistant is user+1.
  const partnerOrdinal = row.role === 'user' ? row.ordinal + 1 : row.ordinal - 1;
  const txn = db.transaction(() => {
    deleteTurnByOrdinalStmt.run(chatId, row.ordinal);
    deleteTurnByOrdinalStmt.run(chatId, partnerOrdinal);
  });
  txn();
  return true;
}

// `AND timeless = 0` enforces the "manual memories are always retrievable"
// invariant at the mutation itself, not just in the UI. A timeless (manually-
// inserted) turn has no gate toggle and is excluded from mass actions, but an
// API caller or a future code path could still hand its id here; the guard
// makes that a silent no-op rather than letting a curated memory be gated off.
// (Core value: build the check, don't trust the self-report.)
const setTurnActiveStmt = db.prepare(
  `UPDATE turns SET active = ? WHERE id = ? AND chat_id = ? AND timeless = 0`,
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
// PROMPT-VERSION HELPERS — the edit history of a chat's persona.
// ============================================================

const listPromptVersionsStmt = db.prepare(`
  SELECT id, n, text, created_at
  FROM prompt_versions
  WHERE chat_id = ?
  ORDER BY n DESC
`);
const countPromptVersionsStmt = db.prepare(
  `SELECT COUNT(*) AS n FROM prompt_versions WHERE chat_id = ?`,
);
const maxPromptVersionNStmt = db.prepare(
  `SELECT COALESCE(MAX(n), 0) AS max_n FROM prompt_versions WHERE chat_id = ?`,
);
const insertPromptVersionStmt = db.prepare(`
  INSERT INTO prompt_versions (chat_id, n, text, created_at)
  VALUES (?, ?, ?, ?)
`);
const setPersonaStmt = db.prepare(`UPDATE chats SET persona = ? WHERE id = ?`);

interface PromptVersionDbRow { id: number; n: number; text: string; created_at: number }

// All of a chat's prompt versions, newest-first (head = live). Empty list for a
// chat whose prompt has never been edited through the editor.
export function getPromptVersions(chatId: string): PromptVersion[] {
  return (listPromptVersionsStmt.all(chatId) as PromptVersionDbRow[]).map((r) => ({
    id: r.id,
    n: r.n,
    text: r.text,
    createdAt: r.created_at,
  }));
}

// Append a new prompt version at the head and make it live.
//
// First-edit baseline: a chat created through the normal flow has NO version
// rows — its live prompt is just chats.persona (or DEFAULT_PERSONA when null,
// resolved client-side). To keep the original frozen in the history instead of
// being overwritten by the first edit, the caller passes the pre-edit live text
// as `baselineText`; when the chat has zero versions we insert that as v1 before
// the edit lands as v2. (DEFAULT_PERSONA lives client-side, so the client is the
// only place that can resolve the baseline — hence it's passed in, not derived
// here. The server stays persona-agnostic.)
//
// chats.persona is mirrored to the new head's text so the per-turn prompt build
// (which reads persona) uses the new live prompt with no other change. Does NOT
// bump updated_at: editing the prompt is curation of the active chat's config,
// not new conversational activity — same reasoning as setTurnsActive — so it
// shouldn't reshuffle the history list's recency order mid-edit.
export function appendPromptVersion(
  chatId: string,
  text: string,
  baselineText?: string,
): PromptVersion[] {
  const exists = getChatStmt.get(chatId) as ChatHeaderRow | undefined;
  if (!exists) throw new Error(`chat not found: ${chatId}`);
  const txn = db.transaction(() => {
    const now = Date.now();
    const count = (countPromptVersionsStmt.get(chatId) as { n: number }).n;
    if (count === 0 && typeof baselineText === 'string' && baselineText.length > 0) {
      insertPromptVersionStmt.run(chatId, 1, baselineText, now);
    }
    const nextN = (maxPromptVersionNStmt.get(chatId) as { max_n: number }).max_n + 1;
    insertPromptVersionStmt.run(chatId, nextN, text, now);
    setPersonaStmt.run(text, chatId);
  });
  txn();
  return getPromptVersions(chatId);
}

// ============================================================
// MEMORY HELPERS
// ============================================================

const listMemoriesStmt = db.prepare(`
  SELECT id, text
  FROM memories
  WHERE chat_id = ?
  ORDER BY created_at ASC
`);

interface MemoryDbRow { id: string; text: string }

export function getMemories(chatId: string): { memories: MemoryRow[] } {
  const memories = (listMemoriesStmt.all(chatId) as MemoryDbRow[]).map((r) => ({
    id: r.id,
    text: r.text,
  }));
  return { memories };
}

const listMemoryIdsStmt = db.prepare(`SELECT id FROM memories WHERE chat_id = ?`);
const deleteMemoryStmt = db.prepare(`DELETE FROM memories WHERE id = ?`);
// Which chat owns a given memory id, if any. `id` is a globally-unique UUID and
// the upsert keys on it alone, so an id must belong to exactly one chat for
// life — this lets saveMemories reject a cross-chat id reuse loudly instead of
// silently rebinding/corrupting the owning chat's row.
const memoryOwnerStmt = db.prepare(`SELECT chat_id FROM memories WHERE id = ?`);
const upsertMemoryStmt = db.prepare(`
  INSERT INTO memories (id, chat_id, text, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    text = excluded.text,
    updated_at = excluded.updated_at
`);

export interface SaveMemoryInput {
  id: string;
  text: string;
}

export interface SaveMemoriesInput {
  chatId: string;
  memories: SaveMemoryInput[];
}

// Upsert this chat's memories (preserving created_at on existing rows) and
// delete any of THIS chat's memories absent from the payload — another chat's
// memories are never touched. Reconciliation is scoped to input.chatId.
export function saveMemories(input: SaveMemoriesInput): void {
  const now = Date.now();
  const incomingIds = new Set(input.memories.map((m) => m.id));
  const txn = db.transaction(() => {
    // The chat must exist: the upsert's FK would catch a non-empty payload, but
    // an empty one (clearing a chat's memories) would otherwise no-op silently
    // for a deleted chat. Check up front so both cases surface as "chat not
    // found" (→ 404), mirroring saveTurnPair/prependManualTurnPair.
    if (!getChatStmt.get(input.chatId)) {
      throw new Error(`chat not found: ${input.chatId}`);
    }
    // Reject an id already owned by a DIFFERENT chat. Can't happen via the UI
    // (UUIDs, never copied), but the upsert keys on id alone and leaves chat_id
    // untouched on conflict — so without this a stray cross-chat id would
    // silently mutate the owner's row and drop the memory for this chat.
    for (const m of input.memories) {
      const owner = memoryOwnerStmt.get(m.id) as { chat_id: string } | undefined;
      if (owner && owner.chat_id !== input.chatId) {
        throw new Error(`memory chat mismatch: ${m.id} is owned by another chat`);
      }
    }
    const existing = listMemoryIdsStmt.all(input.chatId) as { id: string }[];
    for (const row of existing) {
      if (!incomingIds.has(row.id)) deleteMemoryStmt.run(row.id);
    }
    for (const m of input.memories) {
      upsertMemoryStmt.run(m.id, input.chatId, m.text, now, now);
    }
  });
  txn();
}
