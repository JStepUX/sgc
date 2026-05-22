// Behavioral tests for the openaiProvider SSE parse (parseOpenAIStream).
//
// This is the pure logic the local-provider spec names as a Vitest target: feed
// canned OpenAI chat-completions stream bytes and assert the assembled
// text/usage and the delta sequence. No network, no model — same spirit as the
// TF-IDF engine tests: the parse is deterministic and must stay correct or the
// local-model path silently drops content.

import { parseOpenAIStream, resolveTurnProvider } from './providers';

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
