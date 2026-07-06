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
