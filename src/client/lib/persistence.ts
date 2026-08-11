// Client transport for chat + memory persistence.
//
// These are plain JSON fetches against the Express persistence routes. No
// model calls — the Phase 1.5 invariant "one API call per turn" is owned by
// /api/turn (lib/api.ts). The functions here are POST/GET/PUT/DELETE plumbing
// the UI uses to load history on mount, save turns after they finish
// streaming, and sync each chat's own (per-chat) constitutional document.

import type { BrainManifest, BrainPack } from './types';

// ============================================================
// SHAPES ON THE WIRE
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
  /** Manually-inserted memory whose recency the time scorer negates (always active). */
  timeless: boolean;
}

/** One frozen entry in a chat's system-prompt edit history. `n` is a stable,
 *  monotonically-increasing per-chat label; the head (max n / versions[0]) is
 *  the live prompt. Forward-only — saving always mints a new head. */
export interface PromptVersion {
  id: number;
  n: number;
  text: string;
  createdAt: number;
}

/** Raw /api/chats/:id payload. `constitutional` is the chat's freeform
 *  constitutional document — plain prose, no scoring, no history. */
interface ChatDetailWire {
  id: string;
  title: string;
  turns: ChatTurn[];
  latestInspector: unknown | null;
  persona: string | null;
  mask: string | null;
  constitutional: string;
  versions: PromptVersion[];
  brainIds?: string[];
  tangentStart?: number | null;
}

export interface ChatDetail {
  id: string;
  title: string;
  turns: ChatTurn[];
  /** Parsed TurnData JSON from the chat's latest assistant turn (server-decoded). */
  latestInspector: unknown | null;
  /** Per-chat system-prompt persona — the LIVE prompt. null → resolve
   *  DEFAULT_PERSONA at build time. Mirrors versions[0].text when versions exist. */
  persona: string | null;
  /** Display-only assistant mask. null/'' → "Sal". Never sent to the model. */
  mask: string | null;
  /** This chat's constitutional document — a freeform prose "about me", edited
   *  in the ConstitutionalEditorModal, rendered verbatim into the prompt. */
  constitutional: string;
  /** Edit history of the persona, newest-first. Empty when never edited (the UI
   *  synthesises a baseline from `persona`). versions[0] is the live prompt. */
  versions: PromptVersion[];
  /** Ids of the knowledge packs this chat has mounted (the knowledge axis). */
  brainIds: string[];
  /** Open ephemeral-tangent boundary — MAX(ordinal) at entry, null when none
   *  is open (spec 04). Harness state only; Sal is never told (D5). */
  tangentStart: number | null;
}

export interface SaveTurnArgs {
  user: { content: string };
  assistant: { content: string; inspectorJson: string | null };
}

// ============================================================
// FETCH HELPER
// ============================================================

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      // not json — keep status detail
    }
    throw new Error(`${init?.method ?? 'GET'} ${url} failed: ${detail}`);
  }
  return (await res.json()) as T;
}

// ============================================================
// CHATS
// ============================================================

export function listChats(): Promise<ChatSummary[]> {
  return jsonFetch<ChatSummary[]>('/api/chats');
}

export async function loadChat(id: string): Promise<ChatDetail> {
  const wire = await jsonFetch<ChatDetailWire>(`/api/chats/${encodeURIComponent(id)}`);
  return {
    id: wire.id,
    title: wire.title,
    turns: wire.turns,
    latestInspector: wire.latestInspector,
    persona: wire.persona,
    mask: wire.mask,
    constitutional: wire.constitutional,
    // Tolerate an older server that predates versioning by defaulting to [].
    versions: wire.versions ?? [],
    // Same tolerance for a server that predates the brains routes.
    brainIds: wire.brainIds ?? [],
    // …and for one that predates tangents — absent reads as "none open".
    tangentStart: wire.tangentStart ?? null,
  };
}

// Append a new live version of this chat's system prompt (persona). Forward-only:
// the server mints a new head and mirrors it into the live persona, returning the
// fresh history (newest-first). `baselineText` is the pre-edit live prompt — the
// server uses it ONLY to freeze the original as v1 on the chat's first edit
// (DEFAULT_PERSONA is client-side, so the baseline can't be resolved server-side).
export function savePromptVersion(
  chatId: string,
  text: string,
  baselineText?: string,
): Promise<{ versions: PromptVersion[] }> {
  const body: { text: string; baselineText?: string } = { text };
  if (baselineText !== undefined) body.baselineText = baselineText;
  return jsonFetch<{ versions: PromptVersion[] }>(
    `/api/chats/${encodeURIComponent(chatId)}/prompt-versions`,
    { method: 'POST', body: JSON.stringify(body) },
  );
}

/**
 * Create a chat, optionally with a per-chat persona + display-only mask +
 * a carried-forward constitutional document. Called with no args for the
 * default-Sal flow (hydration spawn, delete-fallback) and with
 * { persona, mask, constitutional } from the Confirm Persona modal's carry-
 * forward step. The mask is stored for display only — it never crosses into
 * the prompt or /api/turn.
 */
export function createChat(args?: {
  persona?: string;
  mask?: string;
  constitutional?: string;
}): Promise<{ id: string }> {
  const body: Record<string, string> = {};
  if (args?.persona !== undefined) body.persona = args.persona;
  if (args?.mask !== undefined) body.mask = args.mask;
  if (args?.constitutional !== undefined) body.constitutional = args.constitutional;
  return jsonFetch<{ id: string }>('/api/chats', { method: 'POST', body: JSON.stringify(body) });
}

export function deleteChat(id: string): Promise<{ ok: true }> {
  return jsonFetch<{ ok: true }>(`/api/chats/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** POST /turns response — the two new row ids let the caller stamp the
 *  in-session entries without a reload (assistant-response editor edits by id). */
export interface SaveTurnResult {
  ok: true;
  userId: number;
  assistantId: number;
}

export function saveTurn(chatId: string, args: SaveTurnArgs): Promise<SaveTurnResult> {
  return jsonFetch<SaveTurnResult>(
    `/api/chats/${encodeURIComponent(chatId)}/turns`,
    { method: 'POST', body: JSON.stringify(args) },
  );
}

export interface AddManualTurnArgs {
  user: { content: string };
  assistant: { content: string };
}

// Insert a manual "brain surgery" memory — a full user+assistant pair that lands
// as the oldest turns in the chat, flagged timeless server-side. No model call;
// deterministic curation of the memory tier (see /api/chats/:id/manual-turns).
export function addManualTurn(
  chatId: string,
  args: AddManualTurnArgs,
): Promise<{ ok: true }> {
  return jsonFetch<{ ok: true }>(
    `/api/chats/${encodeURIComponent(chatId)}/manual-turns`,
    { method: 'POST', body: JSON.stringify(args) },
  );
}

// Delete a manual memory pair by either half's turn id. The server removes both
// rows and refuses non-timeless turns.
export function deleteManualTurn(chatId: string, turnId: number): Promise<{ ok: true }> {
  return jsonFetch<{ ok: true }>(
    `/api/chats/${encodeURIComponent(chatId)}/turns/${turnId}`,
    { method: 'DELETE' },
  );
}

// Undo the latest streamed turn pair. `assistantTurnId` is the id the client
// believes is latest — the server verifies before deleting (409 when stale).
export function deleteLatestTurn(chatId: string, assistantTurnId: number): Promise<{ ok: true }> {
  return jsonFetch<{ ok: true }>(
    `/api/chats/${encodeURIComponent(chatId)}/latest-turn/${assistantTurnId}`,
    { method: 'DELETE' },
  );
}

// Open an ephemeral tangent (spec 04): the server stamps the boundary
// (MAX ordinal) and returns it. 409 when one is already open or the chat has
// no turns yet — the client gates both, this is the backstop.
export function beginTangent(chatId: string): Promise<{ ok: true; tangentStart: number }> {
  return jsonFetch<{ ok: true; tangentStart: number }>(
    `/api/chats/${encodeURIComponent(chatId)}/tangent`,
    { method: 'POST', body: JSON.stringify({}) },
  );
}

// Resolve the open tangent: 'canon' clears the boundary, 'discard' also wipes
// the non-timeless tail past it. 409 when nothing is open (stale window).
export function resolveTangent(
  chatId: string,
  outcome: 'canon' | 'discard',
): Promise<{ ok: true }> {
  return jsonFetch<{ ok: true }>(
    `/api/chats/${encodeURIComponent(chatId)}/tangent/resolve`,
    { method: 'POST', body: JSON.stringify({ outcome }) },
  );
}

export interface UpdateTurnArgs {
  content: string;
  /** Present = overwrite inspector_json (string or null); absent = leave the
   *  existing blob. A manual edit clears the summary (pass a blob with summary:
   *  null); a re-spin replaces it with fresh TurnData. */
  inspectorJson?: string | null;
}

// Rewrite a turn's content in place (assistant-response editor). created_at /
// ordinal are preserved server-side so ordering + time-score stay anchored; the
// next searchScored re-reads the new text automatically (tfidf is uncached).
export function updateTurn(
  chatId: string,
  turnId: number,
  args: UpdateTurnArgs,
): Promise<{ ok: true }> {
  const body: UpdateTurnArgs = { content: args.content };
  if ('inspectorJson' in args) body.inspectorJson = args.inspectorJson;
  return jsonFetch<{ ok: true }>(
    `/api/chats/${encodeURIComponent(chatId)}/turns/${turnId}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
}

// The state turn's write: attach an inspector blob WITHOUT touching content,
// conditional on the content still being `expectedContent` (the text the state
// call reflected on). The server refuses with 409 when the row moved or is
// gone — the caller treats the rejection as "abandon", never retries.
export function updateTurnInspector(
  chatId: string,
  turnId: number,
  inspectorJson: string | null,
  expectedContent: string,
): Promise<{ ok: true }> {
  return jsonFetch<{ ok: true }>(
    `/api/chats/${encodeURIComponent(chatId)}/turns/${turnId}`,
    { method: 'PATCH', body: JSON.stringify({ inspectorJson, expectedContent }) },
  );
}

/** One turn's gate state for {@link setTurnsActive}. */
export interface TurnActiveState {
  id: number;
  active: boolean;
}

// Persist the cosine-grep gate for one or more turns (chat memory editor).
// Bulk so a mass action ("All off", select-mode apply) is a single round-trip.
export function setTurnsActive(
  chatId: string,
  states: TurnActiveState[],
): Promise<{ ok: true }> {
  return jsonFetch<{ ok: true }>(
    `/api/chats/${encodeURIComponent(chatId)}/turn-active`,
    { method: 'PUT', body: JSON.stringify({ states }) },
  );
}

// ============================================================
// CONSTITUTIONAL DOCUMENT
// ============================================================

// Persist one chat's constitutional document — a single freeform prose blob,
// chat-scoped. Replaces the old chip-list PUT /api/memories entirely (D6):
// the resource is a property of the chat now, like persona/mask, so it lives
// at the chat-scoped URL rather than a standalone memories collection.
export function saveConstitutional(chatId: string, text: string): Promise<{ ok: true }> {
  return jsonFetch<{ ok: true }>(
    `/api/chats/${encodeURIComponent(chatId)}/constitutional`,
    { method: 'PUT', body: JSON.stringify({ text }) },
  );
}

// ============================================================
// BRAINS — knowledge packs (the knowledge axis, lib/brains.ts).
// The server stores/validates pack files; retrieval never happens
// server-side, so these are pure plumbing like everything above.
// ============================================================

export function listBrains(): Promise<BrainManifest[]> {
  return jsonFetch<BrainManifest[]>('/api/brains');
}

export function getBrain(id: string): Promise<BrainPack> {
  return jsonFetch<BrainPack>(`/api/brains/${encodeURIComponent(id)}`);
}

// Import a pack (the parsed JSON of an Atlantis export). Same id overwrites —
// that's the hand-edit-aliases-and-re-export flow. Returns the manifest.
export function importBrain(pack: BrainPack): Promise<BrainManifest> {
  return jsonFetch<BrainManifest>('/api/brains', {
    method: 'POST',
    body: JSON.stringify(pack),
  });
}

// Delete a pack file; the server also removes its bindings across ALL chats.
export function deleteBrain(id: string): Promise<{ ok: true }> {
  return jsonFetch<{ ok: true }>(`/api/brains/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// Replace a chat's mount set wholesale (PUT semantics).
export function setChatBrains(chatId: string, brainIds: string[]): Promise<{ ok: true }> {
  return jsonFetch<{ ok: true }>(
    `/api/chats/${encodeURIComponent(chatId)}/brains`,
    { method: 'PUT', body: JSON.stringify({ brainIds }) },
  );
}
