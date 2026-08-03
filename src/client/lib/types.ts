// Shared domain types for the SGC memory architecture.

/**
 * The turn summary produced for every completed turn — a fresh, per-turn
 * structured observation, never accumulated:
 *  - persistent: things true until explicitly changed
 *  - volatile: things that shifted this turn
 *  - established_patterns: behavioral rules that have been demonstrated
 *
 * Produced by the post-reply state turn (lib/dynamic-state.ts) alongside the
 * DynamicState below — Sal's own reply no longer carries a `<turn-summary>`
 * block. Rendered as a dimmed one-line appendage beneath the reply and fed
 * forward (last couple of turns only) as the distilled summary buffer. It does
 * NOT touch retrieval.
 */
export interface TurnSummary {
  persistent: string[];
  volatile: string[];
  established_patterns: string[];
}

/**
 * Sal's bounded inner state after a turn — the OTHER half of the post-reply
 * state turn's output (lib/dynamic-state.ts). Regenerated every turn from live
 * context (not an accreting document) and rendered into the NEXT prompt as the
 * private YOUR INNER STATE block, flattened to labeled lines — never as JSON.
 *
 * This is a deliberate recurrence: the state prompt consumes the previous
 * state, which turn summaries never do. It is bounded three ways — schema caps,
 * per-turn regeneration, and user curation (the rail's Dynamic State card is
 * editable), so the drift surface is also a control surface.
 *
 * Nullable fields are genuinely absent when nothing fits; the flattener omits
 * them rather than rendering an empty label.
 */
export interface DynamicState {
  goal: string;
  appraisal: string;
  association: string | null;
  passing_thought: string | null;
  noticed: string[];
  unexpressed_impulse: string | null;
}

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
   * compiler catches a missing stamp at every construction site — see the
   * replayEntry helper (hooks/useChatSession.ts) and the live-turn append
   * (hooks/useTurnRunner.ts).
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
  /**
   * The turn summary produced for this (assistant) message by the post-reply
   * state turn, rendered as a dimmed one-line appendage beneath the reply.
   * Absent on user rows and ignored by the cosine grep; the prompt builder
   * reads it only for the distilled summary buffer. Persisted inside the turn's
   * `inspector_json` blob and rehydrated on load.
   */
  summary?: TurnSummary;
  /**
   * Sal's inner state after this (assistant) turn — the other half of the
   * post-reply state turn. Mirrors `summary`'s lifecycle exactly (assistant
   * rows only, persisted in `inspector_json`, rehydrated on load) and is
   * likewise invisible to the cosine grep. Unlike `summary` it IS consumed by a
   * later prompt: assembleTurnContext takes the newest one in the log and
   * renders it as the next turn's private inner-state block.
   */
  dynamicState?: DynamicState;
  /**
   * The spontaneity operator that fired on this (assistant) turn, if any —
   * rendered as a dimmed "⟐ Name" marker beneath the reply so a perturbed turn is
   * recognizable at a glance. Display-only, mirroring `summary`: absent on user
   * rows and on turns where nothing fired, rehydrated from `inspector_json` on
   * load, and IGNORED by the cosine grep / local buffer / prompt builder. The
   * directive's actual injection happens via the prompt path, not this field.
   */
  spontaneity?: { label: string };
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

/**
 * One chunk of a knowledge pack (the KNOWLEDGE axis — separate from the three
 * memory tiers). `text` is what Sal sees when the chunk retrieves; `summary`,
 * `topics`, and `aliases` are retrieval surface only (indexed, never rendered).
 * `aliases` is THE load-bearing field: a hand-editable synonym bridge across
 * the author gap — the corpus author's vocabulary is not the query author's.
 */
export interface BrainChunk {
  id: string;
  title: string;
  text: string;
  summary: string;
  topics: string[];
  aliases: string[];
  source: { file: string; doc: string; position: number };
  /** Build-time token estimate — inspector display only. */
  tokens: number;
}

/**
 * A knowledge pack compiled offline by Atlantis (`python -m atlantis export`)
 * and imported into SGC as a mountable "brain". Plain text + lexical metadata
 * only — embeddings never cross this contract; runtime retrieval over chunks
 * is the same deterministic TF-IDF cosine math as the memory grep.
 * `source.stub` is true for fully model-free builds (surfaced in the UI).
 */
export interface BrainPack {
  schema: 'sgc-brain/1';
  id: string;
  name: string;
  description: string;
  version: string;
  built_at: string;
  source: { tool: string; schema: string; stub: boolean };
  chunks: BrainChunk[];
}

/** The list-route projection of a pack — everything but the chunks. */
export interface BrainManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  built_at: string;
  stub: boolean;
  chunkCount: number;
}
