// ============================================================
// THE STATE TURN — call → PATCH → stamp.
//
// The impure half of Dynamic State: one small model call after the reply has
// already been promoted, then the post-hoc write that attaches its two outputs
// (turn summary + inner state) to the turn that just finished.
//
// Shared by BOTH producers of an assistant reply — the live turn
// (hooks/useTurnRunner) and a saved edit or re-spin (hooks/useResponseEditor) —
// so a hand-crafted reply gets a real summary and state exactly like a streamed
// one, from one code path (D9).
//
// Split in two on purpose: `callStateTurn` needs nothing but prompt inputs, so
// the live turn fires it in PARALLEL with saving the pair; `commitStateTurn`
// needs the DB row id that save returns. The two join, then write.
//
// Discipline, inherited from the existing non-blocking persist: this NEVER
// blocks the composer, never surfaces an error, and never retries. A failure
// leaves the turn summary-less and state-less; the previous state stays live in
// the log (D13), so nothing blanks. If the user submits the next turn before
// this lands, that turn assembles from the newest COMPLETED state — a one-turn
// stale inner state is diegetically fine (moods lag).
//
// The write is a CONDITIONAL, inspector-only PATCH (the one sanctioned
// amendment to the spec's server-untouched line, 2026-08-03): content is never
// rewritten, and the server's UPDATE carries `AND content = expectedContent`,
// so a state result whose reply was edited while the call was in flight
// matches zero rows and comes back 409 — atomically, in SQLite, with no
// check-then-write gap. The client abandons on 409 and never retries.
//
// In FRONT of that sits the WRITE EPOCH, the in-memory half of the same
// discipline: whoever rewrites a turn (a saved edit, a hand-edited state)
// bumps the row's epoch and passes the new value as its own chain's
// `expectedEpoch`. A chain that lands to find the epoch moved abandons before
// making the request at all — and, unlike the content condition, the epoch
// also catches a rewrite that left content IDENTICAL (a hand-edited state,
// D11, which must not be overwritten by the model's own late result).
// Abandoning loses nothing: the write that bumped the epoch fired its own
// state chain (D9) or WAS the user's curation, either of which outranks a
// stale model result.
// ============================================================

import type { Dispatch, SetStateAction } from 'react';
import type { ChatEntry, DynamicState, TurnSummary } from './types';
import type { TurnData } from './turn-data';
import { buildStatePrompt, parseStateResponse } from './dynamic-state';
import { runTurn, type ProviderId } from './api';
import { updateTurnInspector as apiUpdateTurnInspector } from './persistence';

// ---- WRITE EPOCHS (see header) ----
// Session-lived, keyed by row: SQLite turn ids are unique across chats and
// never reused, so the raw id is key enough. A row missing from the map is at
// epoch 0 — its content is still the text it was born with, which is why the
// live turn passes expectedEpoch 0 without ever registering: nothing can have
// rewritten a row that its own save only just created.
const writeEpochs = new Map<number, number>();

/** The row is about to be rewritten: bump its epoch (invalidating every state
 *  chain already in flight for it) and return the new value for the rewriter's
 *  own chain to carry. */
export function bumpWriteEpoch(assistantTurnId: number): number {
  const next = (writeEpochs.get(assistantTurnId) ?? 0) + 1;
  writeEpochs.set(assistantTurnId, next);
  return next;
}

function currentWriteEpoch(assistantTurnId: number): number {
  return writeEpochs.get(assistantTurnId) ?? 0;
}

/** What identifies the turn being written to, on both sides of the boundary:
 *  its DB row (for the PATCH) and its in-memory entries (for the stamp). The
 *  setters are the shared session's, passed in rather than imported so this
 *  stays a plain module (see useChatSession — the hooks are namespaces over ONE
 *  session, not stores). */
export interface StateTurnTarget {
  chatId: string;
  /** DB id of the ASSISTANT row — the PATCH target. */
  assistantTurnId: number;
  /** The reply text this chain's result describes — the conditional write's
   *  expectedContent, NOT a payload: content is never rewritten. */
  content: string;
  /** The row's write epoch when this chain's content was authored — 0 for a
   *  live turn (fresh row), the bumped value for an edit. The commit abandons
   *  if the row has been rewritten past it. */
  expectedEpoch: number;
  /** This turn's TurnData. Also the staleness guard: the rail is only
   *  overwritten while it still holds THIS object (reference identity), so a
   *  late-landing state call can't clobber a newer turn's diagnostics (D6). */
  baseTurnData: TurnData;
  /** Which in-memory entries belong to this turn — matched on the shared
   *  turnStartedAt for a live turn, on the row id for an edit. */
  matches: (entry: ChatEntry) => boolean;
  setMessages: Dispatch<SetStateAction<ChatEntry[]>>;
  setChatLog: Dispatch<SetStateAction<ChatEntry[]>>;
  setLatestTurn: Dispatch<SetStateAction<TurnData | null>>;
}

export interface StateTurnInput {
  persona: string;
  constitutional: string;
  /** The last STATE_CONTEXT_SIZE entries INCLUDING the pair just finished. */
  recentEntries: ChatEntry[];
  /** The state this turn began from — null on the first ever turn. */
  prevState: DynamicState | null;
  /** The operator injected into the turn being distilled, when one fired. */
  spontaneityDirective?: string | null;
  provider?: ProviderId;
}

/** A completed state call: both halves plus what it cost. Null halves are a
 *  bork (that side unreadable) — the readable side still lands, and BOTH null
 *  still commits, because the tokens were billed either way: apiCalls and
 *  stateTokens must count exactly the failure cases someone would need to
 *  diagnose. Only a failed CALL (no response at all) yields no outcome. */
export interface StateTurnOutcome {
  summary: TurnSummary | null;
  state: DynamicState | null;
  tokens: { input: number; output: number };
}

/**
 * Run the state call and read it back. Provider-agnostic by construction: a
 * plain call with no tools and no delta handler, so the LOCAL path runs it
 * identically to Anthropic (unlike recall, which is Anthropic-only).
 *
 * Returns null ONLY when the call itself failed (no response) — never throws,
 * so the caller's join can't be broken by it. A response that parses to
 * nothing still returns an outcome with null halves: the tokens were billed,
 * so they get recorded (see StateTurnOutcome).
 */
export async function callStateTurn(input: StateTurnInput): Promise<StateTurnOutcome | null> {
  try {
    const { system, user } = buildStatePrompt(
      input.persona,
      input.constitutional,
      input.recentEntries,
      input.prevState,
      input.spontaneityDirective,
    );
    const result = await runTurn(system, [{ role: 'user', content: user }], undefined, input.provider);
    const { summary, state } = parseStateResponse(result.text);
    if (!summary && !state) {
      // Billed but unreadable — still an outcome, so the usage is recorded.
      console.warn('state turn returned nothing parseable — turn left summary-less');
    }
    return { summary, state, tokens: { input: result.inputTokens, output: result.outputTokens } };
  } catch (err) {
    console.warn('state turn failed:', err);
    return null;
  }
}

/**
 * Write a turn's summary + state through: PATCH the persisted blob first, then
 * stamp the in-memory entries and the rail. Persist-first mirrors the response
 * editor's discipline — a failed write leaves the session exactly as it was
 * rather than showing state that isn't durable.
 */
async function commit(
  target: StateTurnTarget,
  merged: TurnData,
  summary: TurnSummary | null,
  state: DynamicState | null,
): Promise<void> {
  // Stale chain — the row was rewritten while this was in flight. The
  // rewriter's own chain owns the row now; don't even make the request.
  if (currentWriteEpoch(target.assistantTurnId) !== target.expectedEpoch) {
    console.warn('state write abandoned: the turn was edited while it was in flight');
    return;
  }
  // Conditional on the content this result describes — a concurrent edit that
  // slipped past the epoch check makes this 409 (throw) instead of landing,
  // and the throw skips the stamps below, so memory never shows what SQLite
  // refused.
  await apiUpdateTurnInspector(
    target.chatId,
    target.assistantTurnId,
    JSON.stringify(merged),
    target.content,
  );

  const stamp = (entry: ChatEntry): ChatEntry =>
    target.matches(entry)
      ? { ...entry, summary: summary ?? undefined, dynamicState: state ?? undefined }
      : entry;
  target.setMessages((prev) => prev.map(stamp));
  target.setChatLog((prev) => prev.map(stamp));
  // Only while the rail still shows THIS turn — see baseTurnData's note.
  target.setLatestTurn((cur) => (cur === target.baseTurnData ? merged : cur));
}

/** Attach a completed state call to its turn. Failures warn and stop (D5). */
export async function commitStateTurn(
  target: StateTurnTarget,
  outcome: StateTurnOutcome,
): Promise<void> {
  const merged: TurnData = {
    ...target.baseTurnData,
    summary: outcome.summary,
    dynamicState: outcome.state,
    stateTokens: outcome.tokens,
    // The state call is a real call and says so — but only here. The main
    // input/output counts stay the reply's own (D12).
    apiCalls: (target.baseTurnData.apiCalls ?? 1) + 1,
  };
  try {
    await commit(target, merged, outcome.summary, outcome.state);
  } catch (err) {
    console.warn('state write failed:', err);
  }
}

/** Call + commit in one, for the edit path — where the row id is known before
 *  the call starts, so there is nothing to parallelize. */
export async function runStateTurn(
  target: StateTurnTarget,
  input: StateTurnInput,
): Promise<void> {
  const outcome = await callStateTurn(input);
  if (outcome) await commitStateTurn(target, outcome);
}

/**
 * Replace a turn's inner state with a hand-edited one (D11) — the curation half
 * of "recurrence with curation". No model call: the user IS the author here.
 * Rejects on failure so the modal can surface it (unlike the background chain,
 * this one the user asked for).
 */
export async function saveDynamicState(
  target: StateTurnTarget,
  state: DynamicState,
): Promise<void> {
  const merged: TurnData = { ...target.baseTurnData, dynamicState: state };
  await commit(target, merged, target.baseTurnData.summary, state);
}
