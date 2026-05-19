// Shared domain types for the SGC memory architecture.

/** One message in the conversation log. */
export interface ChatEntry {
  role: 'user' | 'assistant';
  content: string;
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
