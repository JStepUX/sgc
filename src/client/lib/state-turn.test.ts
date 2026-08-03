// ============================================================
// STATE-TURN COMMIT TESTS — the write-epoch guard + usage accounting.
//
// A state chain that lands AFTER its row was rewritten describes a reply that
// no longer exists. Two layers stop it: the client's write-epoch check pinned
// here (a chain whose expectedEpoch no longer matches abandons without
// touching the network or the in-memory logs), and behind it the server's
// conditional inspector-only write (`AND content = ?`, db-turn-edits.ts —
// pinned in db.test.ts), whose 409 must skip the in-memory stamps too.
//
// The network is mocked out; callStateTurn's model half is exercised
// end-to-end by the LOCAL sanity pass, not here — its usage-accounting
// contract (billed-but-unparseable still returns tokens) IS pinned below.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SetStateAction } from 'react';
import type { ChatEntry, DynamicState } from './types';
import type { TurnData } from './turn-data';
import {
  bumpWriteEpoch,
  callStateTurn,
  commitStateTurn,
  saveDynamicState,
  type StateTurnOutcome,
  type StateTurnTarget,
} from './state-turn';
import { updateTurnInspector } from './persistence';
import { runTurn } from './api';

vi.mock('./persistence', () => ({
  updateTurnInspector: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('./api', () => ({
  runTurn: vi.fn(),
}));

const mockedUpdateTurn = vi.mocked(updateTurnInspector);
const mockedRunTurn = vi.mocked(runTurn);

// A useState-shaped setter over a captured value, so stamps are observable.
function makeCell<T>(initial: T): { value: T; set: (action: SetStateAction<T>) => void } {
  const cell = {
    value: initial,
    set: (action: SetStateAction<T>) => {
      cell.value = typeof action === 'function' ? (action as (prev: T) => T)(cell.value) : action;
    },
  };
  return cell;
}

const baseTurnData = (turnNumber: number): TurnData => ({
  turnNumber,
  inputTokens: 100,
  outputTokens: 50,
  totalLatency: 1000,
  localBufferSize: 2,
  grepFired: false,
  grepMatches: 0,
  grepDetails: null,
  knowledgeDetails: null,
  summary: null,
  spontaneityFired: false,
  spontaneityOperatorId: null,
  spontaneityDirective: null,
  spontaneitySimilarity: 0,
});

const outcome: StateTurnOutcome = {
  summary: { persistent: ['likes tea'], volatile: [], established_patterns: [] },
  state: {
    goal: 'keep the thread warm',
    appraisal: 'settled',
    association: null,
    passing_thought: null,
    noticed: [],
    unexpressed_impulse: null,
  },
  tokens: { input: 400, output: 90 },
};

// Each test uses a distinct row id: the epoch registry is module-lived by
// design (it must outlive any one hook render), so ids must not collide.
function makeTarget(assistantTurnId: number, expectedEpoch: number) {
  const entry: ChatEntry = { role: 'assistant', content: 'original reply', createdAt: 1000, id: assistantTurnId };
  const messages = makeCell<ChatEntry[]>([entry]);
  const chatLog = makeCell<ChatEntry[]>([entry]);
  const data = baseTurnData(1);
  const latestTurn = makeCell<TurnData | null>(data);
  const target: StateTurnTarget = {
    chatId: 'chat-1',
    assistantTurnId,
    content: 'original reply',
    expectedEpoch,
    baseTurnData: data,
    matches: (e) => e.id === assistantTurnId,
    setMessages: messages.set,
    setChatLog: chatLog.set,
    setLatestTurn: latestTurn.set,
  };
  return { target, messages, chatLog, latestTurn, data };
}

beforeEach(() => {
  mockedUpdateTurn.mockClear();
});

describe('the write-epoch guard', () => {
  it('commits when the row is untouched (live-turn epoch 0)', async () => {
    const { target, messages, latestTurn, data } = makeTarget(101, 0);
    await commitStateTurn(target, outcome);

    expect(mockedUpdateTurn).toHaveBeenCalledTimes(1);
    const [, , inspectorJson, expectedContent] = mockedUpdateTurn.mock.calls[0];
    // Conditional write: content is the CONDITION, never a payload.
    expect(expectedContent).toBe('original reply');
    expect(JSON.parse(inspectorJson!).dynamicState.goal).toBe('keep the thread warm');
    expect(messages.value[0].summary).toEqual(outcome.summary);
    expect(messages.value[0].dynamicState).toEqual(outcome.state);
    // The rail held this turn's TurnData, so it advances to the merged blob.
    expect(latestTurn.value).not.toBe(data);
    expect(latestTurn.value?.dynamicState).toEqual(outcome.state);
    expect(latestTurn.value?.apiCalls).toBe(2);
  });

  it('abandons when the row was rewritten while the chain was in flight', async () => {
    const { target, messages, latestTurn, data } = makeTarget(202, 0);
    bumpWriteEpoch(202); // an edit saved between launch and landing
    await commitStateTurn(target, outcome);

    expect(mockedUpdateTurn).not.toHaveBeenCalled();
    expect(messages.value[0].summary).toBeUndefined();
    expect(latestTurn.value).toBe(data);
  });

  it("the rewriter's own chain — carrying the bumped epoch — still lands", async () => {
    const epoch = bumpWriteEpoch(303);
    const { target } = makeTarget(303, epoch);
    await commitStateTurn(target, outcome);
    expect(mockedUpdateTurn).toHaveBeenCalledTimes(1);
  });

  it('a second edit invalidates the first edit’s chain but not its own', async () => {
    const first = bumpWriteEpoch(404);
    const second = bumpWriteEpoch(404);
    const stale = makeTarget(404, first);
    const fresh = makeTarget(404, second);

    await commitStateTurn(stale.target, outcome);
    expect(mockedUpdateTurn).not.toHaveBeenCalled();

    await commitStateTurn(fresh.target, outcome);
    expect(mockedUpdateTurn).toHaveBeenCalledTimes(1);
  });

  it('epochs are per-row: bumping one row never invalidates another', async () => {
    bumpWriteEpoch(505);
    const { target } = makeTarget(506, 0);
    await commitStateTurn(target, outcome);
    expect(mockedUpdateTurn).toHaveBeenCalledTimes(1);
  });

  it('a late commit never clobbers a newer turn’s rail (reference guard)', async () => {
    const { target, latestTurn } = makeTarget(607, 0);
    const newerTurn = baseTurnData(2);
    latestTurn.set(newerTurn); // the next turn has since taken the rail
    await commitStateTurn(target, outcome);

    expect(mockedUpdateTurn).toHaveBeenCalledTimes(1); // the PATCH still lands
    expect(latestTurn.value).toBe(newerTurn); // the rail does not move
  });

  it('a refused conditional write (409) skips every stamp — memory never shows what SQLite rejected', async () => {
    mockedUpdateTurn.mockRejectedValueOnce(new Error('409: the turn changed'));
    const { target, messages, latestTurn, data } = makeTarget(809, 0);
    await commitStateTurn(target, outcome);

    expect(messages.value[0].summary).toBeUndefined();
    expect(messages.value[0].dynamicState).toBeUndefined();
    expect(latestTurn.value).toBe(data);
  });

  it('null halves still commit — the call was billed, so its usage is recorded', async () => {
    const { target, messages, latestTurn } = makeTarget(910, 0);
    await commitStateTurn(target, { summary: null, state: null, tokens: { input: 5, output: 1 } });

    expect(mockedUpdateTurn).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(mockedUpdateTurn.mock.calls[0][2]!);
    expect(persisted.stateTokens).toEqual({ input: 5, output: 1 });
    expect(persisted.apiCalls).toBe(2);
    // Nothing readable landed, so the entries stay unstamped — absent, not junk.
    expect(messages.value[0].summary).toBeUndefined();
    expect(messages.value[0].dynamicState).toBeUndefined();
    expect(latestTurn.value?.stateTokens).toEqual({ input: 5, output: 1 });
  });

  it('a hand-edited state (D11) writes at the epoch it bumped', async () => {
    const epoch = bumpWriteEpoch(708);
    const { target, messages } = makeTarget(708, epoch);
    const handState: DynamicState = { ...outcome.state!, goal: 'the user says so' };
    await saveDynamicState(target, handState);

    expect(mockedUpdateTurn).toHaveBeenCalledTimes(1);
    expect(messages.value[0].dynamicState).toEqual(handState);
  });
});

describe('callStateTurn usage accounting', () => {
  const input = { persona: 'P', constitutional: '', recentEntries: [], prevState: null };

  it('a billed-but-unparseable response still returns its usage, halves null', async () => {
    mockedRunTurn.mockResolvedValueOnce({
      text: 'total junk, no json here',
      inputTokens: 321,
      outputTokens: 12,
      elapsed: 500,
    } as Awaited<ReturnType<typeof runTurn>>);
    const out = await callStateTurn(input);
    expect(out).toEqual({ summary: null, state: null, tokens: { input: 321, output: 12 } });
  });

  it('a failed call (no response at all) yields no outcome', async () => {
    mockedRunTurn.mockRejectedValueOnce(new Error('network down'));
    expect(await callStateTurn(input)).toBeNull();
  });
});
