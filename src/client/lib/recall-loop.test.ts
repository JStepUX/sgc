// Tests for the recall loop — deterministic round orchestration with an
// injected callTurn (no server) and an injected executeTool (no retrieval).
// What's under test is the CONTROL FLOW: round caps, tools attachment,
// message assembly between rounds, text concatenation (D6), dedup threading
// (D5), error propagation (D8), token summing, and status ordering.

import { runTurnWithRecall, MAX_RECALL_ROUNDS, type RecallEvent } from './recall-loop';
import type { runTurn, TurnResult, WireMessage, WireTool, TurnOptions } from './api';
import type { RecallInput, RecallOutcome } from './recall';

const TOOLS: WireTool[] = [{ name: 'recall', input_schema: { type: 'object' } }];

const result = (over: Partial<TurnResult>): TurnResult => ({
  text: '',
  inputTokens: 100,
  outputTokens: 50,
  elapsed: 1000,
  stopReason: 'end_turn',
  toolUses: [],
  pacingTrimmed: false,
  usageEstimated: false,
  ...over,
});

/** A scripted callTurn: pops the next TurnResult per call, records what it
 * was called with, and replays the text through onDelta in two chunks. */
function scriptedCallTurn(script: TurnResult[]) {
  const calls: { messages: WireMessage[]; tools: WireTool[] | undefined; options: TurnOptions | undefined }[] = [];
  const fake = (async (
    _system: string,
    messages: WireMessage[],
    onDelta?: (rawSoFar: string) => void,
    _provider?: unknown,
    tools?: WireTool[],
    options?: TurnOptions,
  ) => {
    // Snapshot messages — the loop mutates its array between rounds.
    calls.push({ messages: JSON.parse(JSON.stringify(messages)) as WireMessage[], tools, options });
    const next = script[calls.length - 1];
    if (!next) throw new Error('scripted callTurn ran out of rounds');
    if (next.text) {
      const mid = Math.ceil(next.text.length / 2);
      onDelta?.(next.text.slice(0, mid));
      onDelta?.(next.text);
    }
    return next;
  }) as unknown as typeof runTurn;
  return { fake, calls };
}

const okOutcome = (over?: Partial<RecallOutcome>): RecallOutcome => ({
  content: '[Turn 2 · yesterday · via "maren"] User: maren q\n  ... Assistant: maren a',
  surfaced: [2],
  mode: 'query',
  ...over,
});

const baseOpts = (fake: typeof runTurn, tools: WireTool[] | null) => ({
  systemPrompt: 'SYSTEM',
  userMessage: 'hello',
  tools,
  onDelta: () => {},
  onStatus: () => {},
  executeTool: () => okOutcome(),
  callTurn: fake,
});

describe('runTurnWithRecall — no tools (LOCAL / recall disabled)', () => {
  it('makes exactly one call with no tools and returns its result', async () => {
    const { fake, calls } = scriptedCallTurn([result({ text: 'plain answer' })]);
    const out = await runTurnWithRecall(baseOpts(fake, null));
    expect(calls).toHaveLength(1);
    expect(calls[0].tools).toBeUndefined();
    expect(calls[0].messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(out).toEqual({
      text: 'plain answer', inputTokens: 100, outputTokens: 50, elapsed: 1000, recalls: [], apiCalls: 1,
      stopReason: 'end_turn', pacingTrimmed: false, usageEstimated: false,
    });
    // No ceiling requested → no options on the wire (byte-identical to before pacing).
    expect(calls[0].options).toBeUndefined();
  });

  it('forwards the pacing ceiling to the call and surfaces how the reply ended', async () => {
    const { fake, calls } = scriptedCallTurn([
      result({ text: 'Two paragraphs.', stopReason: 'max_paragraphs' }),
    ]);
    const out = await runTurnWithRecall({ ...baseOpts(fake, null), maxParagraphs: 2 });
    expect(calls[0].options).toEqual({ maxParagraphs: 2 });
    expect(out.stopReason).toBe('max_paragraphs');
    expect(out.pacingTrimmed).toBe(false);
  });

  it('spends the ceiling ACROSS recall rounds — committed paragraphs come off the next round\'s allowance', async () => {
    const toolUse = { id: 'tu_1', name: 'recall', input: { query: 'x' } };
    const { fake, calls } = scriptedCallTurn([
      result({ text: 'One.\n\nTwo.', stopReason: 'tool_use', toolUses: [toolUse] }),
      result({ text: 'Three.', stopReason: 'tool_use', toolUses: [toolUse] }),
      result({ text: 'Four.' }),
    ]);
    const out = await runTurnWithRecall({ ...baseOpts(fake, TOOLS), maxParagraphs: 3 });
    expect(calls.map((c) => c.options?.maxParagraphs)).toEqual([3, 1, 1]); // 3 → 3-2=1 → floor 1
    expect(out.apiCalls).toBe(3);
  });

  it('ORs usageEstimated across rounds', async () => {
    const toolUse = { id: 'tu_1', name: 'recall', input: { query: 'x' } };
    const { fake } = scriptedCallTurn([
      result({ text: 'a', stopReason: 'tool_use', toolUses: [toolUse], usageEstimated: true }),
      result({ text: 'b' }),
    ]);
    const out = await runTurnWithRecall(baseOpts(fake, TOOLS));
    expect(out.usageEstimated).toBe(true);
  });

  it('carries the hard-cap trim flag out of the terminal round', async () => {
    const { fake } = scriptedCallTurn([
      result({ text: 'Trimmed.', stopReason: 'max_tokens', pacingTrimmed: true }),
    ]);
    const out = await runTurnWithRecall({ ...baseOpts(fake, null), maxParagraphs: 3 });
    expect(out.stopReason).toBe('max_tokens');
    expect(out.pacingTrimmed).toBe(true);
  });

  it('makes one call even if the model somehow reports tool_use (no tools were attached)', async () => {
    const { fake, calls } = scriptedCallTurn([result({ text: 'answer', stopReason: 'tool_use' })]);
    const out = await runTurnWithRecall(baseOpts(fake, null));
    expect(calls).toHaveLength(1);
    expect(out.text).toBe('answer');
  });
});

describe('runTurnWithRecall — one recall round', () => {
  const toolUse = { id: 'tu_1', name: 'recall', input: { query: 'maren glassblowing' } };

  it('executes the tool, hands the result back, and concatenates text across rounds (D6)', async () => {
    const { fake, calls } = scriptedCallTurn([
      result({ text: 'Let me think back.', stopReason: 'tool_use', toolUses: [toolUse] }),
      result({ text: 'Maren runs the studio.', inputTokens: 200, outputTokens: 80, elapsed: 500 }),
    ]);
    const seen: { input: RecallInput; surfaced: number[] }[] = [];
    const out = await runTurnWithRecall({
      ...baseOpts(fake, TOOLS),
      executeTool: (input, surfaced) => {
        seen.push({ input, surfaced: [...surfaced] });
        return okOutcome();
      },
    });

    // The executor got the parsed input and the (empty) dedup set.
    expect(seen).toEqual([{ input: { query: 'maren glassblowing' }, surfaced: [] }]);

    // Round 2's messages: original user + assistant(text + tool_use) + user(tool_result).
    expect(calls).toHaveLength(2);
    expect(calls[1].messages).toEqual([
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me think back.' },
          { type: 'tool_use', id: 'tu_1', name: 'recall', input: { query: 'maren glassblowing' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: okOutcome().content }],
      },
    ]);

    expect(out.text).toBe('Let me think back.\n\nMaren runs the studio.');
    expect(out.inputTokens).toBe(300);
    expect(out.outputTokens).toBe(130);
    expect(out.elapsed).toBe(1500);
    expect(out.recalls).toEqual<RecallEvent[]>([
      { round: 1, input: { query: 'maren glassblowing' }, matches: 1 },
    ]);
  });

  it('omits the text block when the tool_use round produced no text', async () => {
    const { fake, calls } = scriptedCallTurn([
      result({ text: '', stopReason: 'tool_use', toolUses: [toolUse] }),
      result({ text: 'Answer.' }),
    ]);
    const out = await runTurnWithRecall(baseOpts(fake, TOOLS));
    const assistant = calls[1].messages[1];
    expect(Array.isArray(assistant.content) && assistant.content[0]).toEqual(
      { type: 'tool_use', id: 'tu_1', name: 'recall', input: { query: 'maren glassblowing' } },
    );
    // No leading blank line from the empty first round.
    expect(out.text).toBe('Answer.');
  });

  it('answers every tool_use block in a multi-tool round, one recall event each', async () => {
    const { fake, calls } = scriptedCallTurn([
      result({
        stopReason: 'tool_use',
        toolUses: [
          { id: 'tu_1', name: 'recall', input: { query: 'maren' } },
          { id: 'tu_2', name: 'recall', input: { around_turn: 2 } },
        ],
      }),
      result({ text: 'Answer.' }),
    ]);
    const out = await runTurnWithRecall(baseOpts(fake, TOOLS));
    const toolResults = calls[1].messages[2];
    expect(Array.isArray(toolResults.content) ? toolResults.content : []).toHaveLength(2);
    // Both tool calls happened in API round 1 — events share the round number.
    expect(out.recalls.map((r) => r.round)).toEqual([1, 1]);
    expect(out.recalls[1].input).toEqual({ around_turn: 2 });
    expect(out.apiCalls).toBe(2);
  });

  it('threads dedup: ambient seed + round-1 surfacings reach round 2 (D5)', async () => {
    const { fake } = scriptedCallTurn([
      result({ stopReason: 'tool_use', toolUses: [toolUse] }),
      result({ stopReason: 'tool_use', toolUses: [{ ...toolUse, id: 'tu_2' }] }),
      result({ text: 'Answer.' }),
    ]);
    const snapshots: number[][] = [];
    let next = 10;
    await runTurnWithRecall({
      ...baseOpts(fake, TOOLS),
      initialSurfaced: [1, 3],
      executeTool: (_input, surfaced) => {
        snapshots.push([...surfaced].sort((a, b) => a - b));
        next += 1;
        return okOutcome({ surfaced: [next] });
      },
    });
    expect(snapshots).toEqual([
      [1, 3],
      [1, 3, 11],
    ]);
  });

  it('coerces malformed tool input to an empty RecallInput instead of crashing', async () => {
    const { fake } = scriptedCallTurn([
      result({ stopReason: 'tool_use', toolUses: [{ id: 't', name: 'recall', input: 'not-an-object' }] }),
      result({ text: 'Answer.' }),
    ]);
    const seen: RecallInput[] = [];
    await runTurnWithRecall({
      ...baseOpts(fake, TOOLS),
      executeTool: (input) => {
        seen.push(input);
        return okOutcome({ surfaced: [] });
      },
    });
    expect(seen).toEqual([{}]);
  });
});

describe('runTurnWithRecall — the rounds cap (D3)', () => {
  const alwaysRecall = (id: string) =>
    result({ stopReason: 'tool_use', toolUses: [{ id, name: 'recall', input: { query: 'more' } }] });

  it('sends the final permitted round WITHOUT tools so the model must answer', async () => {
    const { fake, calls } = scriptedCallTurn([
      alwaysRecall('tu_1'),
      alwaysRecall('tu_2'),
      result({ text: 'Final answer.' }),
    ]);
    const out = await runTurnWithRecall(baseOpts(fake, TOOLS));
    expect(calls).toHaveLength(1 + MAX_RECALL_ROUNDS);
    expect(calls[0].tools).toEqual(TOOLS);
    expect(calls[1].tools).toEqual(TOOLS);
    expect(calls[2].tools).toBeUndefined();
    expect(out.recalls).toHaveLength(MAX_RECALL_ROUNDS);
    expect(out.recalls.map((r) => r.round)).toEqual([1, 2]);
    expect(out.text).toBe('Final answer.');
    expect(out.inputTokens).toBe(300); // 3 rounds × 100, summed
    expect(out.apiCalls).toBe(3);
  });
});

describe('runTurnWithRecall — error propagation (D8)', () => {
  it('rejects the whole turn when a later round rejects', async () => {
    const failing = (async (
      _system: string,
      messages: WireMessage[],
    ) => {
      if (messages.length > 1) throw new Error('boom mid-loop');
      return result({
        stopReason: 'tool_use',
        toolUses: [{ id: 't', name: 'recall', input: { query: 'q' } }],
      });
    }) as unknown as typeof runTurn;
    await expect(
      runTurnWithRecall(baseOpts(failing, TOOLS)),
    ).rejects.toThrow('boom mid-loop');
  });
});

describe('runTurnWithRecall — deltas and status', () => {
  it('streams the cross-round concatenation and orders status streaming → remembering → streaming', async () => {
    const toolUse = { id: 'tu_1', name: 'recall', input: { query: 'q' } };
    const { fake } = scriptedCallTurn([
      result({ text: 'Recalling now.', stopReason: 'tool_use', toolUses: [toolUse] }),
      result({ text: 'Here it is.' }),
    ]);
    const deltas: string[] = [];
    const statuses: string[] = [];
    await runTurnWithRecall({
      ...baseOpts(fake, TOOLS),
      onDelta: (t) => deltas.push(t),
      onStatus: (s) => statuses.push(s),
    });
    expect(statuses).toEqual(['streaming', 'remembering', 'streaming']);
    // Round-2 deltas carry round 1's committed text in front.
    expect(deltas.at(-1)).toBe('Recalling now.\n\nHere it is.');
    expect(deltas.some((d) => d.startsWith('Recalling now.\n\n') && d !== deltas.at(-1))).toBe(true);
  });
});
