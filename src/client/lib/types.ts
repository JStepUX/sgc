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
  /**
   * Epoch milliseconds at which this turn was created. Hydrated from
   * `turns.created_at` for persisted entries; stamped at `Date.now()` for
   * in-session pairs before they're saved. Required (not optional) so the
   * compiler catches a missing stamp at every construction site — see
   * SalienceGatedCognition.tsx hydration/load/append paths.
   *
   * Consumed by the time scorer (lib/time-score.ts) as the second deterministic
   * dimension alongside the TF-IDF cosine grep, and by the prompt builder to
   * surface relative-time tags ("3 hr ago") on retrieved turns so Sal can
   * reason about recency in natural language.
   */
  createdAt: number;
  /**
   * Manually-inserted memory ("brain surgery"). When true, the time scorer
   * NEGATES recency — the turn's time score is forced to 1.0 regardless of age
   * or any time intent in the query, so it ranks on concept alone (a curated
   * fact isn't tied to when it was said). Manual entries are inserted as the
   * OLDEST turns in a chat and are always retrievable (no per-turn gate); the
   * chat memory editor renders them with a delete control instead of a toggle.
   * `undefined`/`false` = an ordinary streamed turn. Still pure curation, no
   * model in the loop — the Phase 1.5 thesis holds.
   */
  timeless?: boolean;
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
