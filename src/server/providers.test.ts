// Behavioral tests for the openaiProvider SSE parse (parseOpenAIStream).
//
// This is the pure logic the local-provider spec names as a Vitest target: feed
// canned OpenAI chat-completions stream bytes and assert the assembled
// text/usage and the delta sequence. No network, no model — same spirit as the
// TF-IDF engine tests: the parse is deterministic and must stay correct or the
// local-model path silently drops content.

import { parseOpenAIStream, resolveTurnProvider, createOpenAIProvider, separateThinking } from './providers';

const enc = new TextEncoder();

// Build an async iterable of byte chunks from a list of strings, so we can
// control exactly where the stream is sliced (frames may split across reads).
function bytes(...frames: string[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const f of frames) yield enc.encode(f);
  })();
}

// One well-formed OpenAI streaming content frame.
function contentFrame(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

describe('parseOpenAIStream', () => {
  it('assembles content fragments in order and reports the delta sequence', async () => {
    const deltas: string[] = [];
    const result = await parseOpenAIStream(
      bytes(contentFrame('Hello'), contentFrame(', '), contentFrame('world'), 'data: [DONE]\n\n'),
      (soFar) => deltas.push(soFar),
    );
    expect(result.text).toBe('Hello, world');
    // onDelta receives the accumulated text each time, mirroring the client.
    expect(deltas).toEqual(['Hello', 'Hello, ', 'Hello, world']);
  });

  it('captures usage from the final include_usage frame', async () => {
    const usageFrame =
      `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 42, completion_tokens: 7 } })}\n\n`;
    const result = await parseOpenAIStream(bytes(contentFrame('hi'), usageFrame, 'data: [DONE]\n\n'));
    expect(result.text).toBe('hi');
    expect(result.inputTokens).toBe(42);
    expect(result.outputTokens).toBe(7);
  });

  it('defaults usage to 0 when the server omits it (e.g. KoboldCPP)', async () => {
    const result = await parseOpenAIStream(bytes(contentFrame('local only'), 'data: [DONE]\n\n'));
    expect(result.text).toBe('local only');
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  it('reassembles a frame split across byte chunks', async () => {
    // Split a single content frame down the middle of its JSON payload.
    const whole = contentFrame('split me');
    const mid = Math.floor(whole.length / 2);
    const result = await parseOpenAIStream(bytes(whole.slice(0, mid), whole.slice(mid), 'data: [DONE]\n\n'));
    expect(result.text).toBe('split me');
  });

  it('handles multiple frames arriving in one chunk', async () => {
    const lump = contentFrame('a') + contentFrame('b') + contentFrame('c');
    const result = await parseOpenAIStream(bytes(lump, 'data: [DONE]\n\n'));
    expect(result.text).toBe('abc');
  });

  it('ignores a malformed frame rather than aborting the stream', async () => {
    const result = await parseOpenAIStream(
      bytes(contentFrame('good'), 'data: {not valid json\n\n', contentFrame('still good'), 'data: [DONE]\n\n'),
    );
    expect(result.text).toBe('goodstill good');
  });

  it('skips empty/null content deltas (role-only opening frame)', async () => {
    const roleFrame = `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`;
    const nullFrame = `data: ${JSON.stringify({ choices: [{ delta: { content: null } }] })}\n\n`;
    const deltas: string[] = [];
    const result = await parseOpenAIStream(
      bytes(roleFrame, nullFrame, contentFrame('text'), 'data: [DONE]\n\n'),
      (soFar) => deltas.push(soFar),
    );
    expect(result.text).toBe('text');
    expect(deltas).toEqual(['text']); // only the real content fragment fired onDelta
  });

  it('handles a final frame not terminated by a trailing blank line', async () => {
    // Some servers close the socket right after the last data: line.
    const result = await parseOpenAIStream(bytes(contentFrame('one'), 'data: [DONE]'));
    expect(result.text).toBe('one');
  });

  it('tolerates CRLF line endings', async () => {
    const crlf = `data: ${JSON.stringify({ choices: [{ delta: { content: 'crlf' } }] })}\r\n\r\n`;
    const result = await parseOpenAIStream(bytes(crlf, 'data: [DONE]\r\n\r\n'));
    expect(result.text).toBe('crlf');
  });

  // An OpenAI-compatible server (Ollama, a litellm proxy, even KoboldCPP under
  // load) can emit an error frame AFTER the HTTP 200. Without surfacing it the
  // turn would end as an empty/partial reply plus a normal done, hiding the
  // failure. The parser must throw so the provider rejects → index.ts sends an
  // `error` SSE frame.
  it('throws on a structured { error: { message } } frame', async () => {
    await expect(
      parseOpenAIStream(bytes(`data: ${JSON.stringify({ error: { message: 'context overflow' } })}\n\n`)),
    ).rejects.toThrow(/context overflow/);
  });

  it('throws on a string-form error frame', async () => {
    await expect(
      parseOpenAIStream(bytes(`data: ${JSON.stringify({ error: 'backend OOM' })}\n\n`)),
    ).rejects.toThrow(/backend OOM/);
  });

  it('throws on an error frame that arrives after some content (no silent truncation)', async () => {
    await expect(
      parseOpenAIStream(
        bytes(contentFrame('partial answer'), `data: ${JSON.stringify({ error: { message: 'stream aborted' } })}\n\n`),
      ),
    ).rejects.toThrow(/stream aborted/);
  });
});

// The per-turn routing rule. This is the privacy-critical contract: an explicit
// provider token is honoured exactly or rejected — NEVER silently rerouted. The
// silent-fallback regression (a LOCAL request answered by Anthropic) lives or
// dies on these assertions.
// ---- THINKING SEPARATION (Qwen3 & co. on the LOCAL path) ----
// A reasoning model's <think>…</think> block must never reach the reply: not
// the stream, not the persisted turn, not the buffers/Grepory, not the state
// turn's JSON parse. Separation happens once, in the provider's SSE parse.
describe('separateThinking', () => {
  it('leaves a stream with no thinking byte-identical (leading whitespace included)', () => {
    expect(separateThinking('\n\nHello  there', true)).toEqual({ visible: '\n\nHello  there', reasoning: '' });
  });

  it('splits a leading think block from the reply and trims the gap after it', () => {
    const r = separateThinking('<think>\nLet me weigh this.\n</think>\n\nSure thing.', true);
    expect(r).toEqual({ visible: 'Sure thing.', reasoning: '\nLet me weigh this.\n' });
  });

  it('handles an empty think block (Qwen3 /no_think shape)', () => {
    expect(separateThinking('<think>\n\n</think>\n\nReply.', true).visible).toBe('Reply.');
  });

  it('handles multiple blocks and text between them', () => {
    const r = separateThinking('A <think>x</think> B <think>y</think>\nC', true);
    expect(r.visible).toBe('A B C');
    expect(r.reasoning).toBe('xy');
  });

  it('HOLDS BACK a trailing partial tag while streaming, and releases it on final', () => {
    // Mid-stream: "<thi" could still become "<think>" — must not be shown yet.
    expect(separateThinking('Hello <thi', false).visible).toBe('Hello ');
    expect(separateThinking('Hello <', false).visible).toBe('Hello ');
    expect(separateThinking('Hello </th', false).visible).toBe('Hello ');
    // Final: it was a literal "<thi" after all.
    expect(separateThinking('Hello <thi', true).visible).toBe('Hello <thi');
    // An unambiguous tail streams immediately.
    expect(separateThinking('Hello <b>', false).visible).toBe('Hello <b>');
  });

  it('is prefix-stable across every streaming cut of a thinking reply', () => {
    // The append-only delta contract: visible text at any cut must be a prefix
    // of the visible text at every later cut. Walk one character at a time.
    const raw = '<think>\nplan: greet.\n</think>\n\nHi! A <b>bold</b> hello — 1 < 2, and a stray </think> here.';
    let prev = '';
    for (let i = 1; i <= raw.length; i++) {
      const { visible } = separateThinking(raw.slice(0, i), i === raw.length);
      expect(visible.startsWith(prev)).toBe(true);
      prev = visible;
    }
    expect(prev).toBe('Hi! A <b>bold</b> hello — 1 < 2, and a stray here.');
  });

  it('drops a stray close tag but keeps the prose before it (pre-filled-open-tag templates are NOT re-classified)', () => {
    const r = separateThinking('already on the wire </think>\n\nreply', true);
    expect(r.visible).toBe('already on the wire reply');
    expect(r.reasoning).toBe('');
  });

  it('classifies an unterminated block as reasoning (the cap landed mid-thought)', () => {
    const r = separateThinking('<think>\nstill thinking when the budget ran', true);
    expect(r.visible).toBe('');
    expect(r.reasoning).toBe('\nstill thinking when the budget ran');
  });
});

describe('parseOpenAIStream — thinking models', () => {
  it('strips an inline <think> block and only ever emits clean reply deltas', async () => {
    const deltas: string[] = [];
    const result = await parseOpenAIStream(
      bytes(
        contentFrame('<think>'),
        contentFrame('\nponder'),
        contentFrame('</think>'),
        contentFrame('\n\nHel'),
        contentFrame('lo'),
        'data: [DONE]\n\n',
      ),
      (soFar) => deltas.push(soFar),
    );
    expect(result.text).toBe('Hello');
    expect(result.reasoning).toBe('\nponder');
    expect(deltas).toEqual(['Hel', 'Hello']);
    expect(deltas.some((d) => d.includes('think'))).toBe(false);
  });

  it('copes with a tag split across content frames', async () => {
    const result = await parseOpenAIStream(
      bytes(contentFrame('<th'), contentFrame('ink>secret</th'), contentFrame('ink>Reply'), 'data: [DONE]\n\n'),
    );
    expect(result.text).toBe('Reply');
    expect(result.reasoning).toBe('secret');
  });

  it('releases a held-back literal "<" at end of stream', async () => {
    const deltas: string[] = [];
    const result = await parseOpenAIStream(
      bytes(contentFrame('1 <'), 'data: [DONE]\n\n'),
      (soFar) => deltas.push(soFar),
    );
    expect(result.text).toBe('1 <');
    expect(deltas).toEqual(['1 ', '1 <']);
  });

  it('routes a reasoning_content delta (llama.cpp/vLLM split) to reasoning, never to text', async () => {
    const frame = (delta: Record<string, string>) =>
      `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
    const result = await parseOpenAIStream(
      bytes(frame({ reasoning_content: 'hmm' }), frame({ content: 'ok' }), 'data: [DONE]\n\n'),
    );
    expect(result.text).toBe('ok');
    expect(result.reasoning).toBe('hmm');
  });

  it('maps finish_reason to the client vocabulary: stop → end_turn, length → max_tokens', async () => {
    const fin = (finish_reason: string) =>
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason }] })}\n\n`;
    expect((await parseOpenAIStream(bytes(contentFrame('a'), fin('stop'), 'data: [DONE]\n\n'))).stopReason).toBe('end_turn');
    expect((await parseOpenAIStream(bytes(contentFrame('a'), fin('length'), 'data: [DONE]\n\n'))).stopReason).toBe('max_tokens');
    expect((await parseOpenAIStream(bytes(contentFrame('a'), 'data: [DONE]\n\n'))).stopReason).toBe('end_turn');
  });
});

describe('createOpenAIProvider — thinking-only replies', () => {
  // Stub fetch to serve a canned SSE body; the provider's stream loop is
  // otherwise real. Restored after each test.
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  function serve(...frames: string[]) {
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            for (const f of frames) c.enqueue(enc.encode(f));
            c.close();
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
  }
  async function run() {
    const provider = createOpenAIProvider({ baseUrl: 'http://local/v1', apiKey: '', model: 'm', maxTokens: 512 });
    const chunks: unknown[] = [];
    for await (const c of provider.streamTurn('sys', [{ role: 'user', content: 'hi' }], undefined, new AbortController().signal)) {
      chunks.push(c);
    }
    return chunks;
  }
  const fin = (finish_reason: string) =>
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason }] })}\n\n`;

  it('throws an actionable error naming LLM_MAX_TOKENS when the budget ran out mid-<think>', async () => {
    serve(contentFrame('<think>\nendless'), fin('length'), 'data: [DONE]\n\n');
    await expect(run()).rejects.toThrow(/512-token output budget thinking.*LLM_MAX_TOKENS/);
  });

  it('throws (not a silent blank turn) when the reply was ONLY a closed think block', async () => {
    serve(contentFrame('<think>all thought</think>'), fin('stop'), 'data: [DONE]\n\n');
    await expect(run()).rejects.toThrow(/only a <think> block/);
  });

  it('streams the clean reply and forwards max_tokens when a real reply got cut', async () => {
    serve(contentFrame('<think>t</think>\nPartial rep'), fin('length'), 'data: [DONE]\n\n');
    const chunks = await run();
    expect(chunks).toEqual([
      { kind: 'delta', text: 'Partial rep' },
      { kind: 'done', usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'max_tokens' },
    ]);
  });

  it('an empty reply with NO thinking still completes normally (unchanged behaviour)', async () => {
    serve(fin('stop'), 'data: [DONE]\n\n');
    const chunks = await run();
    expect(chunks).toEqual([{ kind: 'done', usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'end_turn' }]);
  });
});

describe('resolveTurnProvider', () => {
  const both = { anthropic: true, openai: true };
  const anthropicOnly = { anthropic: true, openai: false };
  const openaiOnly = { anthropic: false, openai: true };

  it('honours an explicit, available token', () => {
    expect(resolveTurnProvider('openai', both, 'anthropic')).toEqual({ ok: true, id: 'openai' });
    expect(resolveTurnProvider('anthropic', both, 'openai')).toEqual({ ok: true, id: 'anthropic' });
  });

  it('REJECTS an explicit LOCAL request when LOCAL is unconfigured — never falls back to Anthropic', () => {
    const r = resolveTurnProvider('openai', anthropicOnly, 'anthropic');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(503);
      expect(r.error).toMatch(/silently/i); // refuses to reroute to the cloud
    }
  });

  it('REJECTS an explicit Anthropic request when Anthropic is unconfigured', () => {
    const r = resolveTurnProvider('anthropic', openaiOnly, 'openai');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(503);
  });

  it('falls back to the boot default when the token is absent', () => {
    expect(resolveTurnProvider(undefined, both, 'anthropic')).toEqual({ ok: true, id: 'anthropic' });
    expect(resolveTurnProvider(undefined, openaiOnly, 'openai')).toEqual({ ok: true, id: 'openai' });
  });

  it('falls back to the boot default for an unrecognised token', () => {
    expect(resolveTurnProvider('gpt-5', both, 'anthropic')).toEqual({ ok: true, id: 'anthropic' });
    expect(resolveTurnProvider('', both, 'openai')).toEqual({ ok: true, id: 'openai' });
    expect(resolveTurnProvider(null, both, 'anthropic')).toEqual({ ok: true, id: 'anthropic' });
  });

  it('errors (500) when nothing is available, even with a fallback named', () => {
    const r = resolveTurnProvider(undefined, { anthropic: false, openai: false }, 'anthropic');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(500);
  });
});
