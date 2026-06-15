// Per-turn context assembly — the deterministic half of a turn, factored out of
// processInput so the live turn and a re-spin (assistant-response editor) share
// ONE code path. Given a chat log, a query, and a reference instant, it slices
// the three memory tiers and builds the system prompt. No model in the loop:
// localBuffer is a verbatim slice, the summary window is a distilled slice, and
// the cosine grep is pure TF-IDF math (searchScored). Re-running it for a past
// turn with `priorLog` sliced to before that turn + `now` pinned to the turn's
// original instant reproduces exactly the HISTORY tiers that turn saw (buffer +
// summary window + grep) — no later-turn content can leak in, and recency tags
// compute against the same anchor. The other inputs (memories, persona,
// fetchedDocs) are NOT reconstructed here: they're caller-supplied, and the
// re-spin passes the CURRENT memories/persona + a live link re-fetch, since none
// of those are snapshotted per turn.
//
// Keeping this single is what guarantees the re-spin reproduces the live history
// assembly to the byte: the buffer math, the summary window, the grep options,
// and the buildPrompt argument order all live here, in one place.

import type { ChatEntry, FetchedDoc, Memory } from './types';
import { LOCAL_BUFFER_SIZE, SUMMARY_BUFFER_SIZE } from './constants';
import { searchScored, type ScoredResult } from './time-score';
import { buildPrompt } from './prompt';

export interface TurnContextInput {
  /** The user message driving retrieval (live: the new input; re-spin: the target turn's user text). */
  query: string;
  /** Everything BEFORE this turn's user message. Live: the full chatLog. Re-spin: chatLog sliced to the turn. */
  priorLog: ChatEntry[];
  memories: Memory[];
  persona: string;
  /** Reference instant — turnStartedAt for the live turn, the target turn's createdAt for a re-spin. */
  now: number;
  fetchedDocs: FetchedDoc[];
  failedUrls: string[];
}

export interface TurnContextResult {
  systemPrompt: string;
  /** Empty when nothing fired. The caller maps these into TurnData diagnostics. */
  grepResults: ScoredResult[];
  localBufferSize: number;
}

export function assembleTurnContext(input: TurnContextInput): TurnContextResult {
  const { query, priorLog, memories, persona, now, fetchedDocs, failedUrls } = input;

  // ---- LOCAL BUFFER: last 2 turns (4 entries: user+assistant pairs) ----
  const localBuffer = priorLog.slice(-LOCAL_BUFFER_SIZE);

  // ---- SUMMARY BUFFER: the SUMMARY_BUFFER_SIZE entries JUST BEHIND the
  // verbatim buffer, carried forward distilled. Sliced so it ends exactly where
  // the local buffer begins — no overlap. buildPrompt filters these to the
  // assistant entries that actually carry a non-empty summary.
  const bufStart = Math.max(0, priorLog.length - LOCAL_BUFFER_SIZE);
  const summaryWindow = priorLog.slice(Math.max(0, bufStart - SUMMARY_BUFFER_SIZE), bufStart);

  // ---- COSINE GREP + TIME SCORER: two-dimensional retrieval ----
  // Pure math (TF-IDF cosine × time score). Phase 1.5 invariant intact: no model
  // in the retrieval path. excludeLastN matches the buffer slice so the two tiers
  // never overlap (same constant — see lib/constants.ts).
  const grepResults = searchScored(query, priorLog, now, {
    excludeLastN: LOCAL_BUFFER_SIZE,
    topK: 3,
    threshold: 0.08,
  });

  // ---- BUILD THE SINGLE-CALL PROMPT ----
  // `now` gives retrieved turns a relative-time prefix computed against the same
  // reference the time scorer used; the distilled summary window is the final arg.
  const systemPrompt = buildPrompt(
    memories,
    localBuffer,
    grepResults.length > 0 ? grepResults : null,
    fetchedDocs,
    failedUrls,
    persona,
    now,
    summaryWindow,
  );

  return { systemPrompt, grepResults, localBufferSize: localBuffer.length };
}
