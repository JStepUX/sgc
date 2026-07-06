// ============================================================
// THE RECALL LOOP — per-turn orchestrator for deliberate recall.
//
// Deterministic control flow only: rounds, caps, message assembly. The
// REASONING lives in the model (which authors recall queries); the RETRIEVAL
// lives in executeRecall (pure math). This module just carries messages
// between them, entirely WITHIN one turn — the multi-round exchange is
// assembled here, sent per round, and discarded when the turn ends. Nothing
// model-generated persists into any later turn's context (Sal stays
// ephemeral); worst case 1 + MAX_RECALL_ROUNDS calls per turn (consciously
// amended guardrail — see CLAUDE.md Mission Brief).
//
// Dependencies are injected (callTurn, executeTool) so the loop unit-tests
// without a server — see recall-loop.test.ts.
// ============================================================

import { runTurn, type ContentBlock, type ProviderId, type WireMessage, type WireTool } from './api';
import type { RecallInput, RecallOutcome } from './recall';

/** Cap on recall round-trips per turn (D3): tools are attached to the first
 * MAX_RECALL_ROUNDS calls; the final permitted call goes WITHOUT tools so the
 * model must answer. Worst case 1 + MAX_RECALL_ROUNDS = 3 calls per turn.
 * Exported beside the loop (not constants.ts) — it's the loop's own knob. */
export const MAX_RECALL_ROUNDS = 2;

/** One recall the model performed this turn, for the inspector's
 * "Deliberate recall" tile (persisted inside inspector_json). `round` is the
 * API-call round it happened in (1-based) — a round can carry several tool
 * calls, so events may share a round. */
export interface RecallEvent {
  round: number;
  input: RecallInput;
  matches: number;
}

export interface TurnWithRecallResult {
  /** Sal's text concatenated across rounds (D6) — one turn, one reply,
   * however many pauses-to-remember it contained. */
  text: string;
  /** Summed across rounds — each round bills its own input, so recall turns
   * read visibly larger on the token chart. Expected, not a bug. */
  inputTokens: number;
  outputTokens: number;
  /** Summed round-trip latency in ms (the local retrieval between rounds is
   * effectively free — pure TF-IDF, no network). */
  elapsed: number;
  /** Empty when Sal never reached for the tool. */
  recalls: RecallEvent[];
  /** Model calls this turn actually took (1 on the common no-recall path) —
   * the inspector's honest replacement for its hardcoded "1 API call" copy. */
  apiCalls: number;
}

/** Coerce a tool_use block's raw input into RecallInput. Unknown fields drop;
 * wrong types drop (executeRecall answers a fully-empty input honestly, so a
 * malformed call degrades to "nothing came back", never a crash). */
function toRecallInput(raw: unknown): RecallInput {
  if (typeof raw !== 'object' || raw === null) return {};
  const o = raw as Record<string, unknown>;
  const input: RecallInput = {};
  if (typeof o.query === 'string') input.query = o.query;
  if (typeof o.around_turn === 'number') input.around_turn = o.around_turn;
  return input;
}

/** D6 join: rounds concatenate with a blank line when both sides are non-empty. */
function joinRounds(a: string, b: string): string {
  if (a && b) return `${a}\n\n${b}`;
  return a || b;
}

/**
 * Run one full turn, with up to MAX_RECALL_ROUNDS deliberate-recall
 * round-trips when `tools` is provided.
 *
 * `tools: null` → exactly one round, no tools attached — the LOCAL provider
 * path (D2) and the recall-disabled path are the same code path as today.
 *
 * `onDelta` receives the CROSS-ROUND concatenation (committed rounds + the
 * streaming round), so the caller renders one continuous reply. `onStatus`
 * flips to 'remembering' while tool results are being produced between rounds
 * and back to 'streaming' on the next round's first delta.
 *
 * An error in ANY round rejects the whole promise (D8) — no partial-turn
 * salvage; the caller's existing catch path owns the failure.
 */
export async function runTurnWithRecall(opts: {
  systemPrompt: string;
  userMessage: string;
  tools: WireTool[] | null;
  provider?: ProviderId;
  onDelta: (textSoFar: string) => void;
  onStatus: (status: 'streaming' | 'remembering') => void;
  executeTool: (input: RecallInput, surfaced: ReadonlySet<number>) => RecallOutcome;
  /** Seed for the dedup set (D5) — the ambient grep's already-surfaced
   * turnIndexes, so a recall never re-fetches what the prompt already carries. */
  initialSurfaced?: Iterable<number>;
  /** Injectable for tests. */
  callTurn?: typeof runTurn;
}): Promise<TurnWithRecallResult> {
  const callTurn = opts.callTurn ?? runTurn;

  // D5: one dedup set for the whole turn — seeded from ambient retrieval,
  // grown by every recall round, consulted by every executeTool call.
  const surfaced = new Set<number>(opts.initialSurfaced ?? []);

  const messages: WireMessage[] = [{ role: 'user', content: opts.userMessage }];
  const recalls: RecallEvent[] = [];
  let committedText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let elapsed = 0;

  // Total calls: 1 when no tools; otherwise up to 1 + MAX_RECALL_ROUNDS, with
  // tools attached only while another recall round would still be permitted.
  const maxCalls = opts.tools ? 1 + MAX_RECALL_ROUNDS : 1;
  for (let call = 1; call <= maxCalls; call++) {
    const toolsThisRound =
      opts.tools && call <= MAX_RECALL_ROUNDS ? opts.tools : undefined;

    let firstDelta = true;
    const result = await callTurn(
      opts.systemPrompt,
      messages,
      (rawSoFar) => {
        if (firstDelta) {
          firstDelta = false;
          opts.onStatus('streaming');
        }
        opts.onDelta(joinRounds(committedText, rawSoFar));
      },
      opts.provider,
      toolsThisRound,
    );
    inputTokens += result.inputTokens;
    outputTokens += result.outputTokens;
    elapsed += result.elapsed;

    if (result.stopReason === 'tool_use' && result.toolUses.length > 0 && toolsThisRound) {
      // Sal paused to remember. Commit this round's text, run every tool call
      // through the deterministic executor, and hand the results back as the
      // next round's tool_result blocks.
      committedText = joinRounds(committedText, result.text);
      opts.onStatus('remembering');

      const assistantContent: ContentBlock[] = [];
      // Anthropic rejects empty text blocks — a text-free tool_use round
      // contributes only its tool_use blocks.
      if (result.text.trim().length > 0) {
        assistantContent.push({ type: 'text', text: result.text });
      }
      const resultBlocks: ContentBlock[] = [];
      for (const tu of result.toolUses) {
        const input = toRecallInput(tu.input);
        const outcome = opts.executeTool(input, surfaced);
        for (const idx of outcome.surfaced) surfaced.add(idx);
        recalls.push({ round: call, input, matches: outcome.surfaced.length });
        // Echo the tool_use block back verbatim (id/name/input) — the
        // provider requires every tool_use answered by a matching tool_result.
        assistantContent.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
        resultBlocks.push({ type: 'tool_result', tool_use_id: tu.id, content: outcome.content });
      }
      messages.push({ role: 'assistant', content: assistantContent });
      messages.push({ role: 'user', content: resultBlocks });
      continue;
    }

    // Terminal round — end_turn, or a tool_use we can't (or won't) serve.
    return {
      text: joinRounds(committedText, result.text),
      inputTokens,
      outputTokens,
      elapsed,
      recalls,
      apiCalls: call,
    };
  }

  // Unreachable: the last permitted call carries no tools, so its stopReason
  // can't be tool_use and the loop returns from inside. Kept for the compiler.
  return { text: committedText, inputTokens, outputTokens, elapsed, recalls, apiCalls: maxCalls };
}
