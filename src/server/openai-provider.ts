// OPENAI-COMPATIBLE PROVIDER — split from providers.ts by the anti-god-object
// ratchet (see src/architecture.test.ts).
//
// Raw fetch() to {base}/chat/completions with stream:true. No new npm dep — the
// SSE parse loop below mirrors the client's parser in src/client/lib/api.ts.
// KoboldCPP / Ollama / any OpenAI-compatible server share this one code path;
// only OPENAI_BASE_URL differs. The deterministic URL pre-fetch (/api/fetch-url)
// is the only outside-world input, and it works identically on both providers.
// Context length is configured in the local server, not here.
//
// Tools are IGNORED entirely here (D2 in the deliberate-recall spec: the
// client never sends `tools` to this provider — OpenAI-compatible local
// servers have wildly inconsistent tool support). `streamTurn` still takes
// the same (system, messages, tools, signal) shape as the Anthropic provider
// for uniformity; `messages` is flattened into this provider's existing
// chat-array shape (see flattenWireContent below) rather than kept as a live
// multi-round tool exchange — a degenerate path, since a recall round trip
// can only happen when the resolved provider is 'anthropic'.

import type { ContentBlock } from './wire-types.js';
import type { TurnProvider } from './provider-types.js';

// Render one WireMessage's content down to plain text for the openai path.
// The common case is already a string; a content-block array only appears
// when a caller built a multi-round exchange (tool_use / tool_result blocks),
// which — per D2 above — should never actually reach this provider. Handled
// anyway so the shared signature can't silently misbehave if it ever does:
// text blocks join as prose, tool_use/tool_result blocks render as a plain
// descriptive line rather than being silently dropped.
function flattenWireContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => {
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      if (block.type === 'tool_use') {
        return `[called ${String(block.name)} with ${JSON.stringify(block.input)}]`;
      }
      if (block.type === 'tool_result') {
        const inner = block.content;
        if (typeof inner === 'string') return inner;
        if (Array.isArray(inner)) {
          return inner
            .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text?: unknown }).text ?? '') : ''))
            .join('\n');
        }
        return '';
      }
      return '';
    })
    .filter((line) => line.length > 0)
    .join('\n');
}

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
    async *streamTurn(system, messages, _tools, signal) {
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
          // Flatten each WireMessage's content into this provider's existing
          // {role, content: string} shape — see flattenWireContent above.
          messages: [
            { role: 'system', content: system },
            ...messages.map((m) => ({ role: m.role, content: flattenWireContent(m.content) })),
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
        // This path never sees tools (D2), so it never has a tool_use round
        // to report — always the plain end-of-turn reason.
        stopReason: 'end_turn',
      };
    },
  };
}
