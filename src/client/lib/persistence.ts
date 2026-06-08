// Client transport for chat + memory persistence.
//
// These are plain JSON fetches against the Express persistence routes. No
// model calls — the Phase 1.5 invariant "one API call per turn" is owned by
// /api/turn (lib/api.ts). The functions here are POST/GET/PUT/DELETE plumbing
// the UI uses to load history on mount, save turns after they finish
// streaming, and sync each chat's own (per-chat) memory set.

import type { Memory } from './types';

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

/** Raw /api/chats/:id payload. Memories arrive as plain {id, text} rows — they
 *  are already the domain `Memory` shape (no scoring, no history). */
interface ChatDetailWire {
  id: string;
  title: string;
  turns: ChatTurn[];
  latestInspector: unknown | null;
  persona: string | null;
  mask: string | null;
  memories: { id: string; text: string }[];
}

export interface ChatDetail {
  id: string;
  title: string;
  turns: ChatTurn[];
  /** Parsed TurnData JSON from the chat's latest assistant turn (server-decoded). */
  latestInspector: unknown | null;
  /** Per-chat system-prompt persona. null → resolve DEFAULT_PERSONA at build time. */
  persona: string | null;
  /** Display-only assistant mask. null/'' → "Sal". Never sent to the model. */
  mask: string | null;
  /** This chat's constitutional memories — plain durable facts (id/text). */
  memories: Memory[];
}

export interface SaveTurnArgs {
  user: { content: string };
  assistant: { content: string; inspectorJson: string | null };
}

/** Wire shape for PUT /api/memories: chat-scoped; each memory is a plain {id, text}. */
export interface SaveMemoriesArgs {
  chatId: string;
  memories: { id: string; text: string }[];
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
    memories: wire.memories,
  };
}

/**
 * Create a chat, optionally with a per-chat persona + display-only mask.
 * Called with no args for the default-Sal flow (hydration spawn, delete-fallback)
 * and with { persona, mask } from the Confirm Persona modal. The mask is stored
 * for display only — it never crosses into the prompt or /api/turn.
 */
export function createChat(args?: { persona?: string; mask?: string }): Promise<{ id: string }> {
  const body: Record<string, string> = {};
  if (args?.persona !== undefined) body.persona = args.persona;
  if (args?.mask !== undefined) body.mask = args.mask;
  return jsonFetch<{ id: string }>('/api/chats', { method: 'POST', body: JSON.stringify(body) });
}

export function deleteChat(id: string): Promise<{ ok: true }> {
  return jsonFetch<{ ok: true }>(`/api/chats/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function saveTurn(chatId: string, args: SaveTurnArgs): Promise<{ ok: true }> {
  return jsonFetch<{ ok: true }>(
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
// MEMORIES
// ============================================================

// Persist one chat's memory set — the full domain Memory[] for this chat, mapped
// to the {id, text} wire shape. The server upserts these and deletes any of this
// chat's memories absent from the payload (scoped to chatId).
export function saveMemories(chatId: string, memories: Memory[]): Promise<{ ok: true }> {
  const args: SaveMemoriesArgs = {
    chatId,
    memories: memories.map((m) => ({ id: m.id, text: m.text })),
  };
  return jsonFetch<{ ok: true }>('/api/memories', {
    method: 'PUT',
    body: JSON.stringify(args),
  });
}
