// SGC persistence — SQLite via better-sqlite3.
//
// Storage lives in ./data/sgc.db (gitignored). Schema is created on first
// open. Chats + turns are scoped to a chat (cascade on delete). Constitutional
// memory is a `constitutional TEXT` column on chats — ONE freeform document
// per chat (2-3 paragraphs of prose the user edits directly), not a table of
// rows: different conversations hold completely different documents and a new
// chat starts with '' (see docs/ignored/00_constitutional-document-spec.yaml). It was
// a per-chat `memories` table of chip-rows before that; before THAT it was
// GLOBAL — see the migrations below for both one-time re-scopes.
//
// This module owns the DB connection, the schema, and a set of pure helpers
// callers (the Express routes in index.ts) compose into endpoints. It does no
// HTTP and no model work. Phase 1.5 invariant: persistence is plumbing, never
// a reasoning component.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Exported so the brains routes (index.ts) can derive their pack directory
// from the same location — <dirname(DB_PATH)>/brains — meaning the Electron
// shell needs no change (it already sets SGC_DB_PATH). The cwd fallback is a
// DEV convenience only: packaged, cwd is Program Files (non-writable) and the
// mkdirSync below crashes at import time — which is why serverManager.ts
// treats SGC_DB_PATH as mandatory (<userData>/data/sgc.db, i.e. %APPDATA%\sgc).
export const DB_PATH = process.env.SGC_DB_PATH || resolve(process.cwd(), 'data', 'sgc.db');

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

  -- Which knowledge packs ("brains") a chat has mounted. The packs themselves
  -- are FILES in <dirname(DB_PATH)>/brains/<id>.json (multi-MB read-mostly
  -- blobs belong on the filesystem, not in rows) — SQLite stores only the
  -- bindings. chat side cascades with the chat; the brain side has no FK (no
  -- brains table exists) — deleteBrainBindings covers pack deletion.
  CREATE TABLE IF NOT EXISTS chat_brains (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    brain_id TEXT NOT NULL,
    PRIMARY KEY (chat_id, brain_id)
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
//
// `constitutional` joins the same ALTER block (NOT NULL DEFAULT '' — unlike
// persona/mask it's never null, since '' already means "nothing curated yet"
// and the prompt builder needs no null-check). Must run before the memories
// migration below, which writes into this column.
{
  const chatCols = db.prepare(`PRAGMA table_info(chats)`).all() as { name: string }[];
  if (!chatCols.some((c) => c.name === 'persona')) {
    db.exec(`ALTER TABLE chats ADD COLUMN persona TEXT`);
  }
  if (!chatCols.some((c) => c.name === 'mask')) {
    db.exec(`ALTER TABLE chats ADD COLUMN mask TEXT`);
  }
  if (!chatCols.some((c) => c.name === 'constitutional')) {
    db.exec(`ALTER TABLE chats ADD COLUMN constitutional TEXT NOT NULL DEFAULT ''`);
  }
  // Migration: ephemeral tangent boundary (docs/04_ephemeral-tangent-spec.yaml,
  // D2). NULL = no tangent open; else MAX(ordinal) of the chat's turns at entry.
  // Additive, same pattern as above — every existing chat reads as "no tangent".
  // Lifecycle (begin/resolve) lives in db-tangent.ts; this module owns only the
  // column and its ride on the detail payload.
  if (!chatCols.some((c) => c.name === 'tangent_start')) {
    db.exec(`ALTER TABLE chats ADD COLUMN tangent_start INTEGER`);
  }
}

// THE cap on a stored constitutional document — exported so index.ts backs
// its 400s (POST /api/chats, PUT /api/chats/:id/constitutional) with the same
// number the migration below clamps to. The invariant is "a STORED document
// never exceeds the cap": legacy chip rows were uncapped, and an over-cap
// aggregate would be un-saveable and un-carry-forwardable once loaded (every
// later write path rejects it), so the fold is where the cap must land.
export const MAX_CONSTITUTIONAL_CHARS = 20_000;

// Migration: the constitutional document replaces the per-chat `memories`
// table (docs/ignored/00_constitutional-document-spec.yaml, D1) — a ONE-TIME
// aggregate-then-drop, same house pattern as the legacy global/graded memory
// drop this table already survived once. Two obsolete row shapes still get
// the old no-mercy treatment (no honest per-chat mapping, discarded by
// design):
//   - GLOBAL memories (no chat_id) — rows that belong to no chat.
//   - CONFIDENCE-GRADED memories (a `confidence` column + a memory_history
//     table) — grading was retired for the <turn-summary> channel.
// Anything else is the ordinary chat-scoped shape memories has held since
// that original re-scope, and DOES have an honest mapping: per chat,
// concatenate its rows (created_at ASC, `text` joined with '\n') into
// chats.constitutional, then the table goes regardless of shape. Idempotent
// by construction: a second boot finds no `memories` table (PRAGMA returns no
// columns) and no-ops. DDL (the DROP) runs outside any transaction, same as
// every other migration here; only the per-chat UPDATE loop is wrapped, so
// schema changes and data movement don't straddle one transaction boundary.
{
  const memCols = db.prepare(`PRAGMA table_info(memories)`).all() as { name: string }[];
  if (memCols.length > 0) {
    const legacyGlobal = !memCols.some((c) => c.name === 'chat_id');
    const legacyGraded = memCols.some((c) => c.name === 'confidence');
    if (!legacyGlobal && !legacyGraded) {
      const rows = db
        .prepare(`SELECT chat_id, text FROM memories ORDER BY chat_id ASC, created_at ASC`)
        .all() as { chat_id: string; text: string }[];
      const byChat = new Map<string, string[]>();
      for (const r of rows) {
        const texts = byChat.get(r.chat_id) ?? [];
        texts.push(r.text);
        byChat.set(r.chat_id, texts);
      }
      const setConstitutionalStmt = db.prepare(`UPDATE chats SET constitutional = ? WHERE id = ?`);
      const txn = db.transaction(() => {
        for (const [chatId, texts] of byChat) {
          // Clamp to the shared cap (honest, documented data loss on a
          // pathological legacy set) — see MAX_CONSTITUTIONAL_CHARS above.
          setConstitutionalStmt.run(texts.join('\n').slice(0, MAX_CONSTITUTIONAL_CHARS), chatId);
        }
      });
      txn();
    }
    // Child table first (mirrors the historical drop order) — legacy shapes
    // skip straight here with nothing migrated; the ordinary shape just had
    // its rows folded into chats.constitutional above.
    db.exec(`DROP TABLE IF EXISTS memory_history; DROP TABLE IF EXISTS memories;`);
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
  /** This chat's constitutional document — freeform prose, verbatim into the
   *  CONSTITUTIONAL MEMORIES prompt block. '' → nothing curated yet. */
  constitutional: string;
  /** Edit history of this chat's persona, newest-first. Empty for a chat whose
   *  prompt has never been edited (the client synthesises a baseline from
   *  `persona`). The head (versions[0]) is the live prompt.
   *
   *  NOTE: the wire payload of GET /api/chats/:id also carries `brainIds` —
   *  composed in the route from db-brains.ts (getChatBrains), not here, so
   *  this module stays free of the brains concern. */
  versions: PromptVersion[];
  /** Open ephemeral tangent boundary — MAX(ordinal) at entry, null when no
   *  tangent is open. Harness state only; never prompt-visible (spec 04, D5). */
  tangentStart: number | null;
}

/** One frozen entry in a chat's prompt edit history. `n` is a stable,
 *  monotonically-increasing per-chat label; the head (max n) is live. */
export interface PromptVersion {
  id: number;
  n: number;
  text: string;
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
  INSERT INTO chats (id, title, created_at, updated_at, persona, mask, constitutional)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

// Create a chat. `persona` is the per-chat system-prompt head (null → the
// client resolves DEFAULT_PERSONA at build time); `mask` is the display-only
// assistant label (null/'' → "Sal"). `constitutional` seeds the new chat's
// document — the carry-forward copy at Begin Again, or '' for a chat that
// starts with nothing curated. Both persona and mask are stored as opaque
// strings — the server never interprets the persona and the mask never
// reaches the model.
export function createChat(
  id: string,
  persona?: string | null,
  mask?: string | null,
  constitutional?: string,
): { id: string } {
  const now = Date.now();
  insertChatStmt.run(id, NEW_CHAT_TITLE, now, now, persona ?? null, mask ?? null, constitutional ?? '');
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

const getChatStmt = db.prepare(
  `SELECT id, title, persona, mask, constitutional, tangent_start FROM chats WHERE id = ?`,
);
const getChatTurnsStmt = db.prepare(`
  SELECT id, ordinal, role, content, created_at, inspector_json, active, timeless
  FROM turns
  WHERE chat_id = ?
  ORDER BY ordinal ASC
`);

interface ChatHeaderRow {
  id: string;
  title: string;
  persona: string | null;
  mask: string | null;
  constitutional: string;
  tangent_start: number | null;
}
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
  return {
    id: header.id,
    title: header.title,
    turns,
    latestInspector,
    persona: header.persona,
    mask: header.mask,
    constitutional: header.constitutional,
    versions: getPromptVersions(id),
    tangentStart: header.tangent_start,
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
export function saveTurnPair(
  chatId: string,
  input: SaveTurnInput,
): { userId: number; assistantId: number } {
  const exists = (getChatStmt.get(chatId) as ChatHeaderRow | undefined);
  if (!exists) throw new Error(`chat not found: ${chatId}`);
  // db.transaction returns the wrapped fn's return value — surface the two new
  // row ids so the client can stamp the in-session entries without a reload (the
  // assistant-response editor addresses turns by id; see updateTurnContent).
  const txn = db.transaction(() => {
    const before = (turnCountForChatStmt.get(chatId) as { n: number }).n;
    const baseOrdinal = (nextOrdinalStmt.get(chatId) as { max_ord: number }).max_ord;
    const now = Date.now();
    const userInfo = insertTurnStmt.run(chatId, baseOrdinal + 1, 'user', input.user.content, now, null);
    const assistInfo = insertTurnStmt.run(
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
    return {
      userId: Number(userInfo.lastInsertRowid),
      assistantId: Number(assistInfo.lastInsertRowid),
    };
  });
  return txn();
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

const latestTurnRowStmt = db.prepare(
  `SELECT id, ordinal, role, timeless FROM turns WHERE chat_id = ? ORDER BY ordinal DESC LIMIT 1`,
);

// Undo the chat's LATEST streamed turn pair. The caller names the assistant
// turn id it believes is latest and the pair is deleted only if that's still
// true — a stale client (a turn landed since, another window already undid)
// gets `false`, never a wrong-pair delete. Both rows go, same alternation
// reasoning as deleteManualTurnPair. Restricted to the max-ordinal row being a
// non-timeless assistant: a chat whose latest rows are manual memories has no
// streamed turn to undo. Does NOT bump updated_at — undo is curation of the
// chat's tail, not new activity (same reasoning as prependManualTurnPair), and
// the pair's own save already surfaced the chat when it landed.
export function deleteLatestTurnPair(chatId: string, expectedAssistantId: number): boolean {
  const row = latestTurnRowStmt.get(chatId) as
    | { id: number; ordinal: number; role: 'user' | 'assistant'; timeless: number }
    | undefined;
  if (!row || row.role !== 'assistant' || row.timeless !== 0 || row.id !== expectedAssistantId) {
    return false;
  }
  const txn = db.transaction(() => {
    deleteTurnByOrdinalStmt.run(chatId, row.ordinal);
    deleteTurnByOrdinalStmt.run(chatId, row.ordinal - 1);
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

// Turn REWRITES (updateTurnContent, updateTurnInspector) live in
// db-turn-edits.ts — split out by the anti-god-object ratchet.

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
// CONSTITUTIONAL DOCUMENT HELPERS
// ============================================================

const setConstitutionalDocStmt = db.prepare(`UPDATE chats SET constitutional = ? WHERE id = ?`);

// Overwrite a chat's constitutional document wholesale — there's no
// reconciliation to do (it's one column, not a row set), so this is a single
// UPDATE. Throws 'chat not found' (mirroring dbSetChatBrains in db-brains.ts)
// so the route can map it to a 404 instead of silently no-op-ing on a stale
// or deleted chat id.
export function setChatConstitutional(chatId: string, text: string): void {
  if (!getChatStmt.get(chatId)) {
    throw new Error(`chat not found: ${chatId}`);
  }
  setConstitutionalDocStmt.run(text, chatId);
}
