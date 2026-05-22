// SGC turn providers — the model side of the one-call-per-turn loop.
//
// Sal is ephemeral: every turn a fresh instance gets a context rebuilt from the
// curated tiers (memories + local buffer + cosine grep), runs once, and is
// retired. A *provider* is just where that one reasoning call is sent. Today
// there are two:
//
//   anthropicProvider — Claude via @anthropic-ai/sdk.
//   openaiProvider     — any OpenAI-compatible server (KoboldCPP, Ollama, …) via
//                        a raw fetch() to {base}/chat/completions.
//
// Both are just a different Sal. Switching providers mid-chat is harmless — no
// state is carried between turns either way — and neither touches the memory /
// retrieval path (cosine grep + URL pre-fetch stay deterministic, client-side
// and in /api/fetch-url respectively). See CLAUDE.md → Mission Brief and the
// local-provider spec's invariant_check.
//
// The contract below is deliberately narrow: a provider yields text deltas and
// one final usage frame. index.ts maps those chunks onto the exact same
// delta/done/error SSE frames the browser already parses, so the wire contract
// is unchanged regardless of which provider ran.

import Anthropic from '@anthropic-ai/sdk';

// What a provider streams back, one chunk at a time.
export type TurnChunk =
  | { kind: 'delta'; text: string }
  | {
      kind: 'done';
      usage: {
        inputTokens: number;
        outputTokens: number;
      };
    };

export interface TurnProvider {
  // One reasoning call. `system` and `message` are the already-built prompt and
  // user turn; `signal` aborts the upstream request when the browser hangs up.
  streamTurn(system: string, message: string, signal: AbortSignal): AsyncIterable<TurnChunk>;
}

// The provider token a client may send. Lives here (next to the providers) so
// both index.ts and the pure resolver below share one definition.
export type ProviderId = 'anthropic' | 'openai';

// The outcome of deciding which provider runs a turn: either a resolved id or a
// rejection the caller turns into an HTTP error.
export type ProviderResolution =
  | { ok: true; id: ProviderId }
  | { ok: false; status: number; error: string };

// Decide which provider serves one turn. PURE over its inputs (registry =
// which providers are configured; `fallback` = the boot default) so the
// load-bearing routing rule is unit-testable, not buried in an Express handler.
//
// The rule, and why it matters: an EXPLICIT, valid provider token is honoured
// exactly or REJECTED — never silently rerouted to a different provider. A user
// who selected LOCAL did so to keep their text off the cloud; answering that
// turn from Anthropic instead would betray the one guarantee LOCAL exists to
// make. Only an absent or unrecognised token falls back to the boot default.
export function resolveTurnProvider(
  rawProvider: unknown,
  available: Record<ProviderId, boolean>,
  fallback: ProviderId | null,
): ProviderResolution {
  if (rawProvider === 'anthropic' || rawProvider === 'openai') {
    if (available[rawProvider]) return { ok: true, id: rawProvider };
    // Valid token, but that provider isn't configured. Fail loudly rather than
    // fall back — see the contract note above.
    return {
      ok: false,
      status: 503,
      error:
        rawProvider === 'openai'
          ? 'Local provider (LOCAL) was requested but is not configured: set ' +
            'OPENAI_BASE_URL (e.g. http://localhost:5001/v1) and restart the ' +
            'server. Refusing to silently answer from a different provider.'
          : 'Anthropic provider was requested but is not configured: set ' +
            'ANTHROPIC_API_KEY and restart the server. Refusing to silently ' +
            'answer from a different provider.',
    };
  }
  // Absent or unrecognised token → boot default (itself derived from what's
  // available). Guarded so a null/stale default still yields a clean error.
  if (fallback && available[fallback]) return { ok: true, id: fallback };
  return {
    ok: false,
    status: 500,
    error:
      'Server misconfigured: no model provider available. Set ANTHROPIC_API_KEY ' +
      '(or OPENAI_BASE_URL for a local model) in .env and restart the server.',
  };
}

// ============================================================
// ANTHROPIC PROVIDER
//
// This wraps the existing messages.stream() loop — same model and max_tokens.
// The result is yielded as TurnChunks instead of written directly to the SSE
// response, so index.ts can map it onto delta/done frames.
//
// No tools are attached. Sal has no live web access: the only outside-world
// input is the deterministic Readability pre-fetch of a pasted URL
// (POST /api/fetch-url), folded into the prompt as a LINKED PAGE before this
// call. Anthropic's server-side web_search / web_fetch tools were removed —
// they injected ~4-5k tokens of tool scaffolding into EVERY turn's input (a
// just-in-case cost paid whether or not Sal browsed), which wasn't worth it
// next to the free, deterministic pre-fetch. See AGENTS.md.
// ============================================================

export function createAnthropicProvider(opts: {
  client: Anthropic;
  model: string;
  maxTokens: number;
}): TurnProvider {
  const { client, model, maxTokens } = opts;
  return {
    async *streamTurn(system, message, signal) {
      // One API call per turn — streamed. messages.stream() is a single request
      // to Anthropic; it just delivers the response incrementally. No tools, so
      // no server-side tool loop: the stream ends on end_turn (or max_tokens),
      // never pause_turn.
      //
      // No prompt caching: the system prompt is rebuilt every turn from the
      // memory tiers, so there is no stable prefix worth caching. Adaptive
      // thinking is left off (Opus 4.7 default) to keep the turn fast and the
      // latency readout in the UI honest.
      const stream = client.messages.stream({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: message }],
      });

      // The error event is surfaced via the finalMessage() rejection below; this
      // no-op listener just stops an emitted `error` from becoming an unhandled
      // EventEmitter exception that would crash the process.
      stream.on('error', () => {});

      // Abort the upstream call if the caller's signal fires (browser hung up).
      const onAbort = () => stream.abort();
      if (signal.aborted) stream.abort();
      else signal.addEventListener('abort', onAbort, { once: true });

      // Bridge the SDK's 'text' events into an async queue so we can `yield`
      // them. The SDK pushes via callbacks; we pull via the generator.
      const queue: string[] = [];
      let notify: (() => void) | null = null;
      let finished = false;
      let failure: unknown = null;
      let usage = { inputTokens: 0, outputTokens: 0 };

      stream.on('text', (delta: string) => {
        queue.push(delta);
        notify?.();
      });

      const finalPromise = stream
        .finalMessage()
        .then((final) => {
          usage = {
            inputTokens: final.usage.input_tokens,
            outputTokens: final.usage.output_tokens,
          };
        })
        .catch((err) => {
          failure = err;
        })
        .finally(() => {
          finished = true;
          signal.removeEventListener('abort', onAbort);
          notify?.();
        });

      try {
        while (true) {
          while (queue.length > 0) {
            yield { kind: 'delta', text: queue.shift()! };
          }
          if (finished) break;
          await new Promise<void>((resolve) => {
            notify = () => {
              notify = null;
              resolve();
            };
          });
        }
        // Drain anything that arrived between the last check and finish.
        while (queue.length > 0) {
          yield { kind: 'delta', text: queue.shift()! };
        }
        await finalPromise;
        if (failure) throw failure;
        yield { kind: 'done', usage };
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

// ============================================================
// OPENAI-COMPATIBLE PROVIDER
//
// Raw fetch() to {base}/chat/completions with stream:true. No new npm dep — the
// SSE parse loop below mirrors the client's parser in src/client/lib/api.ts.
// KoboldCPP / Ollama / any OpenAI-compatible server share this one code path;
// only OPENAI_BASE_URL differs. Like the Anthropic path, no tools — the
// deterministic URL pre-fetch (/api/fetch-url) is the only outside-world input,
// and it works identically on both providers. Context length is configured in
// the local server, not here.
// ============================================================

// One parsed event off an OpenAI-style SSE stream. Exported for the SSE-parse
// unit test (the pure logic the spec names as a Vitest target).
export interface OpenAIStreamResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

// Parse a complete OpenAI chat-completions SSE stream into accumulated text +
// usage, invoking `onDelta` for each content fragment. PURE over its inputs:
// feed it the raw byte chunks (as the network delivered them, frames may split
// across chunks) and it returns the assembled result. This is the openaiProvider
// SSE parse the spec calls out for Vitest coverage.
//
// OpenAI frame shape: `data: {json}\n\n`, where json carries
// choices[0].delta.content (a text fragment) and, on the final usage frame
// (stream_options.include_usage), a top-level `usage` object. The stream
// terminates with the literal `data: [DONE]`.
export async function parseOpenAIStream(
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  onDelta?: (textSoFar: string) => void,
): Promise<OpenAIStreamResult> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;

  // Handle one complete `data:` payload line.
  const handleData = (data: string): void => {
    const trimmed = data.trim();
    if (trimmed === '' || trimmed === '[DONE]') return;
    let payload: {
      choices?: { delta?: { content?: string | null } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: unknown;
    };
    try {
      payload = JSON.parse(trimmed);
    } catch {
      return; // ignore a malformed frame rather than abort the whole turn
    }
    // An OpenAI-compatible server can emit an error frame AFTER the HTTP 200 —
    // context overflow, a backend OOM, a proxy failing mid-stream. Without this
    // the frame is parsed, found to carry no content/usage, and dropped, so the
    // turn ends as an empty (or truncated) reply plus a normal `done` and the
    // failure is never surfaced. Throw instead: the provider's parse promise
    // rejects, streamTurn rethrows, and index.ts emits an `error` SSE frame.
    if (payload.error != null) {
      const e = payload.error as { message?: unknown };
      const detail =
        typeof payload.error === 'string'
          ? payload.error
          : typeof e.message === 'string'
            ? e.message
            : JSON.stringify(payload.error);
      throw new Error(`local model server reported an error mid-stream: ${detail}`);
    }
    const fragment = payload.choices?.[0]?.delta?.content;
    if (typeof fragment === 'string' && fragment.length > 0) {
      text += fragment;
      onDelta?.(text);
    }
    if (payload.usage) {
      if (typeof payload.usage.prompt_tokens === 'number') inputTokens = payload.usage.prompt_tokens;
      if (typeof payload.usage.completion_tokens === 'number') {
        outputTokens = payload.usage.completion_tokens;
      }
    }
  };

  // SSE frames are separated by a blank line; `data:` fields may repeat within a
  // frame and concatenate. A single frame can split across network chunks, so
  // the line buffer lives outside the read loop (mirrors the client parser).
  let dataAccum = '';
  const flushLines = (final: boolean): void => {
    const lines = buffer.split('\n');
    buffer = final ? '' : (lines.pop() ?? '');
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, '');
      if (line.startsWith('data:')) {
        dataAccum += line.slice(5).replace(/^ /, '');
      } else if (line === '') {
        if (dataAccum) {
          handleData(dataAccum);
          dataAccum = '';
        }
      }
      // Other SSE fields (event:, id:, : comments) are ignored.
    }
  };

  for await (const chunk of chunks as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    flushLines(false);
  }
  // Flush any trailing bytes + a frame not terminated by a blank line.
  buffer += decoder.decode();
  flushLines(true);
  if (dataAccum) handleData(dataAccum);

  return { text, inputTokens, outputTokens };
}

export function createOpenAIProvider(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
}): TurnProvider {
  const { baseUrl, apiKey, model, maxTokens } = opts;
  return {
    async *streamTurn(system, message, signal) {
      const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
      const resp = await fetch(url, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          // KoboldCPP ignores the key; a real OpenAI-compatible host may need it.
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          stream: true,
          // Local context windows are small; cap output modestly (LLM_MAX_TOKENS).
          max_tokens: maxTokens,
          // Ask for a final usage frame; KoboldCPP may omit it (then counts are
          // 0 — the Context-Savings tile still renders, computed client-side).
          stream_options: { include_usage: true },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: message },
          ],
        }),
      });

      if (!resp.ok || !resp.body) {
        let detail = `local model server returned HTTP ${resp.status}`;
        try {
          const body = await resp.text();
          if (body) detail += `: ${body.slice(0, 500)}`;
        } catch {
          /* keep the status-only detail */
        }
        throw new Error(detail);
      }

      // Reuse the pure parser, but yield deltas as they assemble. We feed the
      // body's byte chunks in and surface each new fragment via onDelta — the
      // generator forwards them, then emits the final done frame.
      const queue: string[] = [];
      let notify: (() => void) | null = null;
      let prevLen = 0;
      let finished = false;
      let failure: unknown = null;
      let result: OpenAIStreamResult = { text: '', inputTokens: 0, outputTokens: 0 };

      const reader = resp.body.getReader();
      const byteStream = (async function* () {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) yield value;
          }
        } finally {
          reader.releaseLock();
        }
      })();

      const parsePromise = parseOpenAIStream(byteStream, (textSoFar) => {
        const fragment = textSoFar.slice(prevLen);
        prevLen = textSoFar.length;
        if (fragment) {
          queue.push(fragment);
          notify?.();
        }
      })
        .then((r) => {
          result = r;
        })
        .catch((err) => {
          failure = err;
        })
        .finally(() => {
          finished = true;
          notify?.();
        });

      while (true) {
        while (queue.length > 0) {
          yield { kind: 'delta', text: queue.shift()! };
        }
        if (finished) break;
        await new Promise<void>((resolve) => {
          notify = () => {
            notify = null;
            resolve();
          };
        });
      }
      while (queue.length > 0) {
        yield { kind: 'delta', text: queue.shift()! };
      }
      await parsePromise;
      if (failure) throw failure;
      yield {
        kind: 'done',
        usage: {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        },
      };
    },
  };
}
