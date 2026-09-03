// Tests for the pure helpers in api.ts, plus runTurn's SSE dispatch (the
// deliberate-recall spec widened its signature to messages/tools and added
// tool_use/stopReason frames — worth pinning with a fake fetch rather than
// only exercising it live). fetchUrl stays untested here (network-only).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { extractUrls, runTurn } from './api';

describe('extractUrls', () => {
  it('pulls a bare http(s) URL out of prose', () => {
    expect(extractUrls('see https://example.com/post for more')).toEqual([
      'https://example.com/post',
    ]);
  });

  it('keeps balanced parentheses in the path (Wikipedia regression)', () => {
    const url = 'https://en.wikipedia.org/wiki/Stack_(abstract_data_type)';
    expect(extractUrls(`read ${url} please`)).toEqual([url]);
  });

  it('strips an unbalanced closing paren when the link is wrapped in prose', () => {
    expect(extractUrls('(see https://example.com/p)')).toEqual(['https://example.com/p']);
  });

  it('trims trailing sentence punctuation', () => {
    expect(extractUrls('go to https://example.com/a.')).toEqual(['https://example.com/a']);
    expect(extractUrls('https://example.com/a, then stop')).toEqual(['https://example.com/a']);
  });

  it('keeps a balanced paren even when a sentence period follows', () => {
    const text = 'see https://en.wikipedia.org/wiki/Stack_(data).';
    expect(extractUrls(text)).toEqual(['https://en.wikipedia.org/wiki/Stack_(data)']);
  });

  it('dedupes and preserves order', () => {
    const text = 'https://a.com and https://b.com and https://a.com again';
    expect(extractUrls(text)).toEqual(['https://a.com', 'https://b.com']);
  });

  it('caps the number of URLs returned', () => {
    const text = 'https://a.com https://b.com https://c.com https://d.com';
    expect(extractUrls(text, 2)).toEqual(['https://a.com', 'https://b.com']);
  });

  it('returns nothing when there is no URL', () => {
    expect(extractUrls('just some plain text, no links here')).toEqual([]);
  });
});

// One SSE frame, `event: <name>\ndata: <json>\n\n` — the exact shape
// api.ts's dispatch loop parses.
function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// A fake /api/turn response: a plain 200 whose body streams the given frames.
// Real network code (fetch, ReadableStream) — no mock of api.ts's own logic.
function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

describe('runTurn', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accumulates deltas, tool_use frames, and stopReason from done', async () => {
    const frames = [
      sseFrame('delta', { text: 'Hello' }),
      sseFrame('tool_use', { id: 't1', name: 'recall', input: { query: 'maren' } }),
      sseFrame('delta', { text: ', world' }),
      sseFrame('done', { inputTokens: 10, outputTokens: 5, stopReason: 'tool_use' }),
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(frames)));

    const result = await runTurn('system prompt', [{ role: 'user', content: 'hi' }]);

    expect(result.text).toBe('Hello, world');
    expect(result.toolUses).toEqual([{ id: 't1', name: 'recall', input: { query: 'maren' } }]);
    expect(result.stopReason).toBe('tool_use');
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(5);
  });

  it('defaults stopReason to end_turn and toolUses to empty (back-compat / no-tool turn)', async () => {
    const frames = [sseFrame('delta', { text: 'hi' }), sseFrame('done', { inputTokens: 1, outputTokens: 1 })];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(frames)));

    const result = await runTurn('sys', [{ role: 'user', content: 'hi' }]);

    expect(result.stopReason).toBe('end_turn');
    expect(result.toolUses).toEqual([]);
  });

  it('posts {system, messages, provider, tools?}, omitting tools when empty/absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([sseFrame('done', { inputTokens: 0, outputTokens: 0 })]));
    vi.stubGlobal('fetch', fetchMock);

    await runTurn('sys', [{ role: 'user', content: 'hi' }], undefined, 'anthropic', []);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], provider: 'anthropic' });
  });

  it('includes tools in the body when a non-empty array is supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([sseFrame('done', { inputTokens: 0, outputTokens: 0 })]));
    vi.stubGlobal('fetch', fetchMock);
    const tools = [{ name: 'recall', description: 'reach back', input_schema: { type: 'object' } }];

    await runTurn('sys', [{ role: 'user', content: 'hi' }], undefined, 'anthropic', tools);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.tools).toEqual(tools);
  });
});

// ---- REPLY PACING on the wire (lib/pacing.ts) ----
describe('runTurn — pacing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const done = (stopReason: string) => sseFrame('done', { inputTokens: 1, outputTokens: 1, stopReason });

  it('sends maxParagraphs in the body only when asked for', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([done('end_turn')]));
    vi.stubGlobal('fetch', fetchMock);
    await runTurn('sys', [{ role: 'user', content: 'hi' }], undefined, undefined, undefined, { maxParagraphs: 3 });
    await runTurn('sys', [{ role: 'user', content: 'hi' }]);
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(bodies[0].maxParagraphs).toBe(3);
    expect('maxParagraphs' in bodies[1]).toBe(false);
  });

  it('trims a paced reply back to its last full paragraph when the hard cap fired', async () => {
    const frames = [sseFrame('delta', { text: 'One.\n\nTwo.\n\nThree was cut mi' }), done('max_tokens')];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(frames)));
    const r = await runTurn('sys', [{ role: 'user', content: 'hi' }], undefined, undefined, undefined, { maxParagraphs: 5 });
    expect(r.text).toBe('One.\n\nTwo.');
    expect(r.pacingTrimmed).toBe(true);
    expect(r.stopReason).toBe('max_tokens'); // the honest reason survives the trim
  });

  it('leaves an untrimmable capped reply visible (no paragraph break)', async () => {
    const frames = [sseFrame('delta', { text: 'one long paragraph cut mi' }), done('max_tokens')];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(frames)));
    const r = await runTurn('sys', [{ role: 'user', content: 'hi' }], undefined, undefined, undefined, { maxParagraphs: 5 });
    expect(r.text).toBe('one long paragraph cut mi');
    expect(r.pacingTrimmed).toBe(false);
  });

  it('never trims an UNPACED call, even on max_tokens (the state turn\'s JSON has blank lines too)', async () => {
    const frames = [sseFrame('delta', { text: '{\n\n"a": 1,\n\n"b": "cut' }), done('max_tokens')];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(frames)));
    const r = await runTurn('sys', [{ role: 'user', content: 'hi' }]);
    expect(r.text).toBe('{\n\n"a": 1,\n\n"b": "cut');
    expect(r.pacingTrimmed).toBe(false);
  });

  it('does not trim a paced reply that ended naturally or at the ceiling', async () => {
    for (const reason of ['end_turn', 'max_paragraphs']) {
      const frames = [sseFrame('delta', { text: 'One.\n\nTwo, half' }), done(reason)];
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(frames)));
      const r = await runTurn('sys', [{ role: 'user', content: 'hi' }], undefined, undefined, undefined, { maxParagraphs: 2 });
      expect(r.text).toBe('One.\n\nTwo, half');
      expect(r.pacingTrimmed).toBe(false);
    }
  });
});

// ---- UNKNOWN USAGE is estimated and flagged, never reported as a measured 0 ----
describe('runTurn — usage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps measured usage and reports it as measured', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      sseFrame('delta', { text: 'hello there' }),
      sseFrame('done', { inputTokens: 123, outputTokens: 7, stopReason: 'end_turn' }),
    ])));
    const r = await runTurn('sys', [{ role: 'user', content: 'hi' }]);
    expect(r).toMatchObject({ inputTokens: 123, outputTokens: 7, usageEstimated: false });
  });

  it('estimates from what was sent + received when the done frame carries null (a paragraph cut)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      sseFrame('delta', { text: 'x'.repeat(40) }),
      sseFrame('done', { inputTokens: null, outputTokens: null, stopReason: 'max_paragraphs' }),
    ])));
    const r = await runTurn('s'.repeat(400), [{ role: 'user', content: 'u'.repeat(80) }]);
    expect(r.usageEstimated).toBe(true);
    expect(r.inputTokens).toBe(100 + 20); // ~4 chars/token over system + message
    expect(r.outputTokens).toBe(10);
  });

  it('treats a measured 0 as unknown too (a local server that omits usage)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      sseFrame('delta', { text: 'four' }),
      sseFrame('done', { inputTokens: 0, outputTokens: 0 }),
    ])));
    const r = await runTurn('sys', [{ role: 'user', content: 'hi' }]);
    expect(r.usageEstimated).toBe(true);
    expect(r.inputTokens).toBeGreaterThan(0);
    expect(r.outputTokens).toBe(1);
  });
});
