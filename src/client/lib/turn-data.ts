import type { SpontaneityInspector } from './spontaneity/engine';
import type { PacingInspector } from './pacing';
import { operatorLabel } from './spontaneity/flexDeck';
import type { ChatEntry, DynamicState, TurnSummary } from './types';
import type { ChatTurn } from './persistence';
import type { RecallEvent } from './recall-loop';
import { parseTurnResponse } from './turn-parser';

// ============================================================
// TURN DIAGNOSTICS TYPES
// TurnData is the per-turn inspector blob: rendered live in the right rail,
// persisted as inspector_json, and read back on load by the two rehydration
// parsers below.
// ============================================================

/** One ambient grep hit, projected for the inspector's citation cards and the
 * RetrievalDetailModal. Beyond `preview` (the card's one-liner), it records the
 * FULL text as served to the prompt — the honest diagnostic: immune to later
 * memory edits, exactly what Sal read. All fields past `preview` are optional
 * because rows persisted before 2026-08-30 carry only the 80-char preview; the
 * modal degrades to the preview plus a "not recorded" note for those. */
export interface GrepDetail {
  turnIndex: number;
  /** The combined (concept × time) score — the ranking actually used. */
  score: number;
  preview: string;
  /** Full user half of the retrieved turn-pair, as served. */
  userContent?: string;
  /** Full assistant half of the retrieved turn-pair, as served. */
  assistContent?: string;
  /** The engine's provenance terms (stemmed vocabulary, ranked by
   * contribution) — the modal's highlight set. */
  matchedTerms?: string[];
  conceptScore?: number;
  timeScore?: number;
  /** Epoch ms + timeless flag, so the modal can date the retrieved turn
   * (relative to viewing time — the prompt's own prefix was relative to
   * serve time, which isn't persisted). */
  createdAt?: number;
  timeless?: boolean;
}

/** One retrieved knowledge fragment (the knowledge axis — lib/brains.ts),
 * projected for the inspector's Knowledge tile. Mirrors GrepDetail, including
 * the optional full `text` (absent on rows persisted before 2026-08-30). */
export interface KnowledgeDetail {
  brainName: string;
  chunkId: string;
  title: string;
  score: number;
  preview: string;
  /** Full fragment text as served to the prompt. */
  text?: string;
}

// Spontaneity diagnostics come from SpontaneityInspector (lib/spontaneity/engine):
// `spontaneitySimilarity` is the average pairwise cosine "slack" reading recorded
// EVERY turn (even when nothing fired) so the inspector can show how close the
// conversation came to firing — the live calibration signal. The operator fields
// are set only on a fire; `spontaneityDirective` is the snapshot a re-spin
// replays. They're sourced from the shared interface (not redeclared) so the
// restore reader can't drift on field names. Turns persisted before this feature
// lack them — read defensively after a JSON parse.
//
// Pacing diagnostics come from PacingInspector (lib/pacing.ts) the same way:
// `pacingCeiling` is the paragraph ceiling drawn for the reply — the no-repeat
// draw reads the latest turn's value, a re-spin replays it — and
// `pacingOutcome` / `pacingTrimmed` record how the reply actually ended.
export interface TurnData extends SpontaneityInspector, PacingInspector {
  turnNumber: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * inputTokens/outputTokens are client-side ESTIMATES, not the API's measured
   * usage — a paragraph-cut reply (the usage frame never arrives) or a local
   * server that omits usage. The Context-Savings tile labels Sent accordingly.
   * Optional: rows persisted before this field carry measured usage (or the
   * old silent 0 on usage-less local servers).
   */
  usageEstimated?: boolean;
  totalLatency: number;
  localBufferSize: number;
  grepFired: boolean;
  grepMatches: number;
  grepDetails: GrepDetail[] | null;
  /**
   * The per-turn summary (persistent / volatile / established_patterns),
   * produced by the post-reply state turn. Persisted in this turn's
   * inspector_json so it survives reload and rehydrates onto the message.
   * Null until that background call lands (and permanently if it failed).
   */
  summary: TurnSummary | null;
  /**
   * Sal's inner state after this turn — the state turn's other half, written
   * into inspector_json by the same post-hoc PATCH as `summary`. Optional
   * because turns persisted before the feature don't carry it; null when the
   * state call failed. Consumed by the NEXT prompt (see turn-context.ts, D13)
   * and editable from the rail's Dynamic State card.
   */
  dynamicState?: DynamicState | null;
  /**
   * Tokens the state call itself billed. Deliberately SEPARATE from
   * inputTokens/outputTokens: the Context-Savings tile compares memory
   * curation against the naive baseline, and folding a second call's usage
   * into that comparison would make it dishonest. Rendered as a small dimmed
   * footer in the Dynamic State card instead (D12).
   */
  stateTokens?: { input: number; output: number };
  /**
   * Estimated tokens the naive "send everything every turn" baseline would
   * have used (persona + memories + full chat history + user input). The
   * delta vs `inputTokens` is the SGC savings. Optional because turns
   * persisted before this field existed don't carry it.
   */
  naiveTokens?: number;
  /**
   * Knowledge fragments retrieved from mounted brains this turn (the knowledge
   * axis), for the inspector's Knowledge tile. null = brains mounted but
   * nothing matched; optional because turns persisted before brains existed
   * don't carry it. NOT part of the naive baseline (spec D7).
   */
  knowledgeDetails?: KnowledgeDetail[] | null;
  /**
   * Deliberate recalls Sal performed this turn (the recall tool loop), for the
   * inspector's "Deliberate recall" tile. Empty = tool available but unused;
   * optional because turns persisted before the feature don't carry it. Also
   * the raw material for a future usage-based salience factor — a deliberate
   * recall is the strongest rehearsal signal (out-of-scope note, spec 01).
   */
  recalls?: RecallEvent[];
  /**
   * Model calls this turn took: 1 + one per recall round. Optional (old
   * turns); the inspector falls back to 1. naiveTokens deliberately ignores
   * this — recall is an SGC capability the naive pipeline lacks.
   */
  apiCalls?: number;
}

export interface TokenHistoryEntry {
  turn: number;
  inputTokens: number;
}

/**
 * Rebuild a ChatEntry from a persisted turn row — the ONE replay path shared by
 * hydration, chat switch, and the memory-editor resync (hooks/useChatSession).
 *
 * Assistant content is passed back through parseTurnResponse so a legacy row
 * whose stored text still carries a leaked <turn-summary> block (turns
 * persisted before the parser learned to salvage borked blocks) renders — and
 * enters the grep corpus — clean. Rows already clean pass through unchanged;
 * the DB row itself is untouched (it heals on the next edit/save of that turn).
 * User rows are always verbatim — they're the person's own words.
 */
export function replayEntry(t: ChatTurn): ChatEntry {
  return {
    role: t.role,
    content: t.role === 'assistant' ? parseTurnResponse(t.content).displayText : t.content,
    id: t.id,
    active: t.active,
    createdAt: t.createdAt,
    timeless: t.timeless,
    summary: summaryFromInspector(t.inspectorJson),
    dynamicState: dynamicStateFromInspector(t.inspectorJson),
    spontaneity: spontaneityFromInspector(t.inspectorJson),
  };
}

/**
 * The tangent boundary projected into ENTRY-INDEX space: how many of a chat's
 * replayed entries are canon (ordinal <= tangent_start), or null when no
 * tangent is open. Server truth is ordinal space (chats.tangent_start); the
 * thread renders entries, so the divider/guards need this projection. Counts
 * timeless prepends too (their negative ordinals sit below any boundary) —
 * matching exactly what replayEntry puts on screen after a reload.
 */
export function canonEntryCount(
  turns: { ordinal: number }[],
  tangentStart: number | null,
): number | null {
  if (tangentStart === null) return null;
  return turns.filter((t) => t.ordinal <= tangentStart).length;
}

/**
 * Pull a turn's summary back out of its persisted inspector_json blob (the
 * TurnData stored on save) so a reloaded assistant turn can rehydrate its dimmed
 * summary line. Tolerant: a null blob, a parse failure, or an old turn saved
 * before summaries existed all yield undefined (nothing renders).
 */
export function summaryFromInspector(inspectorJson: string | null): TurnSummary | undefined {
  if (!inspectorJson) return undefined;
  try {
    return (JSON.parse(inspectorJson) as Partial<TurnData>).summary ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pull a turn's inner state back out of its persisted inspector_json — the
 * mirror of summaryFromInspector, and the reason a reloaded chat's NEXT prompt
 * still carries the state the last turn ended on. Equally tolerant: a null
 * blob, a parse failure, a legacy turn, or an explicit null all yield
 * undefined (no state renders, and the assembler scans further back).
 */
export function dynamicStateFromInspector(inspectorJson: string | null): DynamicState | undefined {
  if (!inspectorJson) return undefined;
  try {
    return (JSON.parse(inspectorJson) as Partial<TurnData>).dynamicState ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pull a turn's fired spontaneity operator back out of its persisted
 * inspector_json so a reloaded reply can rehydrate its dimmed "⟐ Name" marker.
 * The label is derived from the snapshotted directive (single source — see
 * operatorLabel), so it survives even if the deck later changes. Tolerant: a null
 * blob, a parse failure, a non-fire, or an old turn predating the feature all
 * yield undefined (no marker renders).
 */
export function spontaneityFromInspector(inspectorJson: string | null): { label: string } | undefined {
  if (!inspectorJson) return undefined;
  try {
    const td = JSON.parse(inspectorJson) as Partial<TurnData>;
    if (!td.spontaneityFired || !td.spontaneityDirective) return undefined;
    return { label: operatorLabel(td.spontaneityDirective) };
  } catch {
    return undefined;
  }
}
