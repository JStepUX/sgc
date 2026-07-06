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

import type { ChatEntry, FetchedDoc } from './types';
import { LOCAL_BUFFER_SIZE, SUMMARY_BUFFER_SIZE } from './constants';
import { searchScored, type ScoredResult } from './time-score';
import { searchBrains, type BrainIndex, type KnowledgeBlock } from './brains';
import { buildPrompt } from './prompt';

export interface TurnContextInput {
  /** The user message driving retrieval (live: the new input; re-spin: the target turn's user text). */
  query: string;
  /** Everything BEFORE this turn's user message. Live: the full chatLog. Re-spin: chatLog sliced to the turn. */
  priorLog: ChatEntry[];
  /** This chat's constitutional document — freeform prose, rendered verbatim by buildPrompt. */
  constitutional: string;
  persona: string;
  /** Reference instant — turnStartedAt for the live turn, the target turn's createdAt for a re-spin. */
  now: number;
  fetchedDocs: FetchedDoc[];
  failedUrls: string[];
  /**
   * A spontaneity operator's directive to inject this turn, or null/undefined for
   * none. The DECISION + random draw happen in the CALLER (it's non-deterministic,
   * so it can't live in this pure assembler) — the live turn passes a fresh draw,
   * a re-spin passes the turn's SNAPSHOTTED directive so it reproduces faithfully.
   * See lib/spontaneity/. Deliberately NOT folded into estimateNaiveContextTokens.
   */
  spontaneityDirective?: string | null;
  /**
   * The union index over this chat's mounted brains (the KNOWLEDGE axis —
   * lib/brains.ts), or null/undefined when nothing is mounted. Caller-supplied
   * like memories/persona: the re-spin passes the CURRENT mounts (spec D8 —
   * packs aren't snapshotted per turn), so this joins the not-reconstructed
   * list in the header comment.
   */
  brainIndex?: BrainIndex | null;
  /**
   * Whether the `recall` tool will be attached to this turn's model call(s).
   * MUST mirror the caller's tool-attachment decision (deliberate-recall D2:
   * prompt framing and tool attach toggle together from one value — never
   * tell Sal about a tool it doesn't have). Defaults false; the re-spin path
   * doesn't attach tools, so its default reproduces a plain prompt.
   */
  recallEnabled?: boolean;
}

export interface TurnContextResult {
  systemPrompt: string;
  /** Empty when nothing fired. The caller maps these into TurnData diagnostics. */
  grepResults: ScoredResult[];
  /** Digests + retrieved fragments for the mounted brains; null when none mounted. */
  knowledge: KnowledgeBlock | null;
  localBufferSize: number;
}

export function assembleTurnContext(input: TurnContextInput): TurnContextResult {
  const { query, priorLog, constitutional, persona, now, fetchedDocs, failedUrls, spontaneityDirective, brainIndex, recallEnabled = false } = input;

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

  // ---- PERSONA KNOWLEDGE: the knowledge axis, separate from memory ----
  // Same deterministic engine style over the mounted brains' union index
  // (concept score only — knowledge is timeless, spec D4). Digests render
  // whenever anything is mounted, even with zero hits (spec D10). The memory
  // grep above is untouched by this: the two axes never share state.
  const knowledge: KnowledgeBlock | null =
    brainIndex && brainIndex.digests.length > 0
      ? { digests: brainIndex.digests, results: searchBrains(query, brainIndex) }
      : null;

  // Older history exists beyond BOTH buffers — the distinction the absence
  // marker needs: "nothing surfaced" is only worth saying when there was a
  // corpus to surface from (deliberate-recall spec, D7 rationale).
  const hasOlderHistory = priorLog.length > LOCAL_BUFFER_SIZE + SUMMARY_BUFFER_SIZE;

  // ---- BUILD THE PROMPT ----
  // `now` gives retrieved turns a relative-time prefix computed against the same
  // reference the time scorer used; the distilled summary window follows it.
  const systemPrompt = buildPrompt(
    constitutional,
    localBuffer,
    grepResults.length > 0 ? grepResults : null,
    fetchedDocs,
    failedUrls,
    persona,
    now,
    summaryWindow,
    spontaneityDirective,
    knowledge,
    recallEnabled,
    hasOlderHistory,
  );

  return { systemPrompt, grepResults, knowledge, localBufferSize: localBuffer.length };
}
