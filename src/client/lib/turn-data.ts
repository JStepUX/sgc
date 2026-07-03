import type { SpontaneityInspector } from './spontaneity/engine';
import { operatorLabel } from './spontaneity/flexDeck';
import type { TurnSummary } from './types';

// ============================================================
// TURN DIAGNOSTICS TYPES
// TurnData is the per-turn inspector blob: rendered live in the right rail,
// persisted as inspector_json, and read back on load by the two rehydration
// parsers below.
// ============================================================

export interface GrepDetail {
  turnIndex: number;
  score: number;
  preview: string;
}

// Spontaneity diagnostics come from SpontaneityInspector (lib/spontaneity/engine):
// `spontaneitySimilarity` is the average pairwise cosine "slack" reading recorded
// EVERY turn (even when nothing fired) so the inspector can show how close the
// conversation came to firing — the live calibration signal. The operator fields
// are set only on a fire; `spontaneityDirective` is the snapshot a re-spin
// replays. They're sourced from the shared interface (not redeclared) so the
// restore reader can't drift on field names. Turns persisted before this feature
// lack them — read defensively after a JSON parse.
export interface TurnData extends SpontaneityInspector {
  turnNumber: number;
  inputTokens: number;
  outputTokens: number;
  totalLatency: number;
  localBufferSize: number;
  grepFired: boolean;
  grepMatches: number;
  grepDetails: GrepDetail[] | null;
  /**
   * Sal's per-turn summary (persistent / volatile / established_patterns),
   * parsed from the `<turn-summary>` block. Persisted in this turn's
   * inspector_json so it survives reload and rehydrates onto the message.
   */
  summary: TurnSummary | null;
  /**
   * Estimated tokens the naive "send everything every turn" baseline would
   * have used (persona + memories + full chat history + user input). The
   * delta vs `inputTokens` is the SGC savings. Optional because turns
   * persisted before this field existed don't carry it.
   */
  naiveTokens?: number;
}

export interface TokenHistoryEntry {
  turn: number;
  inputTokens: number;
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
