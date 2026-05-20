// Client transport for chat + memory persistence.
//
// These are plain JSON fetches against the Express persistence routes. No
// model calls — the Phase 1.5 invariant "one API call per turn" is owned by
// /api/turn (lib/api.ts). The functions here are POST/GET/PUT/DELETE plumbing
// the UI uses to load history on mount, save turns after they finish
// streaming, and sync the global memory set.

import type { Memory, MemoryHistoryEntry } from './types';

// ============================================================
// SHAPES ON THE WIRE
// ============================================================

export interface ChatSummary {
  id: string;
  title: string;
  snippet: string;
  updatedAt: number;
  turnCount: number;
}

export interface ChatTurn {
  id: number;
  ordinal: number;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  inspectorJson: string | null;
}

export interface ChatDetail {
  id: string;
  title: string;
  turns: ChatTurn[];
  /** Parsed TurnData JSON from the chat's latest assistant turn (server-decoded). */
  latestInspector: unknown | null;
}

export interface MemoryHistoryRow {
  memoryId: string;
  delta: number;
  newScore: number;
  turnGlobal: number;
  createdAt: number;
}

export interface SaveTurnArgs {
  user: { content: string };
  assistant: { content: string; inspectorJson: string | null };
}

/** Wire shape for PUT /api/memories: each memory carries its full history slice. */
export interface SaveMemoriesArgs {
  memories: {
    id: string;
    text: string;
    confidence: number;
    history: { delta: number; newScore: number; turnGlobal: number }[];
  }[];
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

export function loadChat(id: string): Promise<ChatDetail> {
  return jsonFetch<ChatDetail>(`/api/chats/${encodeURIComponent(id)}`);
}

export function createChat(): Promise<{ id: string }> {
  return jsonFetch<{ id: string }>('/api/chats', { method: 'POST', body: '{}' });
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

// ============================================================
// MEMORIES
// ============================================================

interface MemoriesResponse {
  memories: { id: string; text: string; confidence: number }[];
  history: MemoryHistoryRow[];
}

/**
 * Fetch the global memory set and the full history of confidence-score
 * changes. Memories are global across chats; the UI hydrates these on mount.
 *
 * The Memory shape in lib/types includes a `history` array (per-memory
 * sparkline data). We reassemble it here from the flat history rows so the
 * caller gets the same Memory shape it uses everywhere else.
 */
export async function getMemories(): Promise<Memory[]> {
  const { memories, history } = await jsonFetch<MemoriesResponse>('/api/memories');
  const byMem = new Map<string, MemoryHistoryEntry[]>();
  for (const h of history) {
    const list = byMem.get(h.memoryId) ?? [];
    list.push({ delta: h.delta, score: h.newScore, turn: h.turnGlobal });
    byMem.set(h.memoryId, list);
  }
  return memories.map((m) => ({
    id: m.id,
    text: m.text,
    confidence: m.confidence,
    history: byMem.get(m.id) ?? [],
  }));
}

// Accepts the full domain Memory[] and maps it to the wire shape inline. The
// per-memory `history` slice is the authoritative sparkline state — the client
// holds it, the server stores it verbatim. (See server's `saveMemories` for
// the matching semantics: upsert memories, replace history per memory_id.)
export function saveMemories(memories: Memory[]): Promise<{ ok: true }> {
  const args: SaveMemoriesArgs = {
    memories: memories.map((m) => ({
      id: m.id,
      text: m.text,
      confidence: m.confidence,
      history: m.history.map((h) => ({
        delta: h.delta,
        newScore: h.score,
        turnGlobal: h.turn,
      })),
    })),
  };
  return jsonFetch<{ ok: true }>('/api/memories', {
    method: 'PUT',
    body: JSON.stringify(args),
  });
}
