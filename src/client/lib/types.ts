// Shared domain types for the SGC memory architecture.

/** One message in the conversation log. */
export interface ChatEntry {
  role: 'user' | 'assistant';
  content: string;
  /**
   * DB turn-row id, present when this entry was loaded from persistence.
   * Absent for entries created in-session before their first save. The chat
   * memory editor uses it to address individual turns when gating them.
   */
  id?: number;
  /**
   * Whether this turn participates in cosine-grep retrieval. `undefined`/`true`
   * = retrievable; `false` = gated off by the user in the chat memory editor.
   * Gating curates the cosine-grep corpus (older history) only — the local
   * buffer still sends the last 2 turns verbatim regardless. Deterministic
   * curation, no model in the loop: it strengthens the Phase 1.5 thesis.
   */
  active?: boolean;
}

/** A single confidence-score change applied to a memory on one turn. */
export interface MemoryHistoryEntry {
  delta: number;
  score: number;
  turn: number;
}

/**
 * A constitutional memory — a curated, durable fact about the user. Its
 * `confidence` (0-100) is re-scored by the model every turn; `history` is the
 * append-only trail of those changes, rendered as a sparkline in the UI.
 */
export interface Memory {
  id: string;
  text: string;
  confidence: number;
  history: MemoryHistoryEntry[];
}

/**
 * A web page the user linked, pre-fetched and extracted (Readability) on the
 * server BEFORE the turn, then folded into the prompt as ephemeral, this-turn-
 * only context. Deterministic retrieval — no model in the loop. `truncated` is
 * set when the extracted text exceeded the server's character cap.
 */
export interface FetchedDoc {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}
