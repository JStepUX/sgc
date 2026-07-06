// ============================================================
// DELIBERATE RECALL — the executor for Sal's `recall` tool.
//
// Pure and synchronous: no React, no network, no model. Sal authors only the
// QUERY (or points at a turn it has already seen); everything below — ranking,
// thresholds, ordering, neighbor selection — is the same deterministic engine
// the ambient tier uses (searchScored → tfidf.ts). The model proposes; the
// math disposes. The per-turn tool LOOP lives in recall-loop.ts; this module
// is one tool call's worth of retrieval, which is what makes it unit-testable
// without a server.
// ============================================================

import type { ChatEntry } from './types';
import type { WireTool } from './api';
import { LOCAL_BUFFER_SIZE, SUMMARY_BUFFER_SIZE } from './constants';
import { searchScored } from './time-score';
import { formatGrepFragment } from './prompt';

/** The `recall` tool as Sal sees it — attached per turn only on the
 * 'anthropic' provider (D2; the turn runner owns that gate). All copy is
 * diegetic: no engine jargon reaches the model. `required` stays empty by
 * design — at-least-one-field is enforced by executeRecall's honest-empty,
 * never by a schema error that would abort the turn. */
export const RECALL_TOOL: WireTool = {
  name: 'recall',
  description:
    'Reach back through the older history of this conversation for something ' +
    'specific. Use it when retrieved history hints there is more, when the ' +
    "person refers to something you can't see, or when nothing surfaced but " +
    'the topic feels like it has roots here. Search with `query`: a few ' +
    'distinctive words (names, places, terms) likely to appear in the ' +
    'original exchange — not a full sentence. Or pass `around_turn` with a ' +
    "turn number you've already seen to read what was said just before and " +
    'after it. Results are excerpts from this same conversation. If nothing ' +
    "comes back, the memory likely isn't there — say so rather than guessing.",
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'a few distinctive words to search the older history for',
      },
      around_turn: {
        type: 'integer',
        description: 'a turn number already shown to you — returns its immediate neighbors',
      },
    },
    required: [],
  },
};

/** The `recall` tool's input — at least one field meaningful. Enforced here
 * (honest-empty), not in the JSON schema, so a malformed call never throws. */
export interface RecallInput {
  query?: string;
  around_turn?: number;
}

export interface RecallOutcome {
  /** The tool_result text handed back to Sal. */
  content: string;
  /** turnIndexes newly surfaced (for the caller's dedup set + the inspector). */
  surfaced: number[];
  mode: 'query' | 'neighbors';
}

/** Honest absence — nothing retrievable matched. Diegetic copy: Sal sees this
 * verbatim, so no engine jargon. */
const NOTHING_CAME_BACK =
  "Nothing came back for that — it may not exist in this conversation's older history.";

/** Everything that DID match was already surfaced this turn (ambient grep or a
 * prior recall round). Distinct from absence — "it may not exist" would be a
 * lie here, and recall must widen context, never duplicate it (D5). */
const ALL_ALREADY_SURFACED =
  'Everything that matched is already in front of you in this turn\'s context.';

/**
 * Execute one recall tool call against the chat's own history.
 *
 * `query` mode runs the SAME scored search as ambient retrieval (identical
 * params — the tool is a second chance to ask, not a stronger engine).
 * `around_turn` mode fetches turn N±1 deterministically — the bounded episode
 * mechanic: "what was around that?" without a topic-shaped query.
 *
 * Turn-index mapping (shared with time-score.ts): turnIndex is 1-based over
 * user+assistant pairs; chatLog indices are userIdx=(turnIndex-1)*2,
 * assistIdx=userIdx+1.
 */
export function executeRecall(
  input: RecallInput,
  chatLog: ChatEntry[],
  now: number,
  alreadySurfaced: ReadonlySet<number>,
): RecallOutcome {
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (query.length > 0) {
    return recallByQuery(query, chatLog, now, alreadySurfaced);
  }
  if (typeof input.around_turn === 'number' && Number.isInteger(input.around_turn)) {
    return recallNeighbors(input.around_turn, chatLog, now, alreadySurfaced);
  }
  // Neither field usable — honest-empty, never a throw (the loop would abort
  // the whole turn on an exception; a bad tool call doesn't deserve that).
  return { content: NOTHING_CAME_BACK, surfaced: [], mode: 'query' };
}

function recallByQuery(
  query: string,
  chatLog: ChatEntry[],
  now: number,
  alreadySurfaced: ReadonlySet<number>,
): RecallOutcome {
  // Identical params to the ambient tier (turn-context.ts) — deliberate: a
  // recall differs from ambient retrieval only in WHO authored the query.
  const results = searchScored(query, chatLog, now, {
    excludeLastN: LOCAL_BUFFER_SIZE,
    topK: 3,
    threshold: 0.08,
  });
  const fresh = results.filter((r) => !alreadySurfaced.has(r.turnIndex));
  if (fresh.length === 0) {
    return {
      content: results.length > 0 ? ALL_ALREADY_SURFACED : NOTHING_CAME_BACK,
      surfaced: [],
      mode: 'query',
    };
  }
  return {
    content: fresh.map((r) => formatGrepFragment(r, now)).join('\n\n'),
    surfaced: fresh.map((r) => r.turnIndex),
    mode: 'query',
  };
}

function recallNeighbors(
  aroundTurn: number,
  chatLog: ChatEntry[],
  now: number,
  alreadySurfaced: ReadonlySet<number>,
): RecallOutcome {
  // The retrievable range mirrors the grep corpus: everything before the
  // verbatim local buffer. Turns INSIDE the buffers are handled below with an
  // honest note instead of silence.
  const preBufferLen = Math.max(0, chatLog.length - LOCAL_BUFFER_SIZE);
  const maxRetrievableTurn = Math.ceil(preBufferLen / 2);
  const totalTurns = Math.ceil(chatLog.length / 2);
  // The summary window: entries just behind the local buffer, distilled into
  // the prompt each turn (turn-context.ts slices identically). Verbatim
  // re-retrieval of those would duplicate context Sal already holds.
  const summaryWindowStart = preBufferLen - SUMMARY_BUFFER_SIZE;

  const fragments: string[] = [];
  const notes: string[] = [];
  const surfaced: number[] = [];

  for (const n of [aroundTurn - 1, aroundTurn + 1]) {
    if (n < 1 || n > totalTurns) continue; // clamped: no such turn
    if (alreadySurfaced.has(n)) continue; // D5: never duplicate this turn's context
    const userIdx = (n - 1) * 2;
    if (n > maxRetrievableTurn || userIdx >= summaryWindowStart) {
      // Local buffer (verbatim) or summary window (distilled) — either way
      // it's already in Sal's context this turn; say so rather than skipping
      // silently, so Sal doesn't read the gap as a missing memory.
      notes.push(`Turn ${n} is already in your recent context.`);
      continue;
    }
    const userEntry = chatLog[userIdx];
    const assistEntry = chatLog[userIdx + 1];
    // Gated halves (chat memory editor) stay unretrievable — same rule as the
    // cosine corpus. A fully-gated turn contributes nothing, deliberately
    // indistinguishable from absence: the person switched it off.
    const userContent = userEntry && userEntry.active !== false ? userEntry.content : '';
    const assistContent = assistEntry && assistEntry.active !== false ? assistEntry.content : '';
    if (userContent === '' && assistContent === '') continue;
    fragments.push(
      formatGrepFragment(
        {
          turnIndex: n,
          userContent,
          assistContent,
          createdAt: userEntry?.createdAt ?? assistEntry?.createdAt ?? now,
          timeless: userEntry?.timeless === true,
          matchedTerms: [], // no query — nothing matched, these were pointed at
        },
        now,
      ),
    );
    surfaced.push(n);
  }

  const parts = [...fragments, ...notes];
  return {
    content: parts.length > 0 ? parts.join('\n\n') : NOTHING_CAME_BACK,
    surfaced,
    mode: 'neighbors',
  };
}
