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
  // The reply proper — what the user sees, what gets persisted, what the state
  // turn parses, what re-enters the buffers and Grepory. Thinking is NOT here.
  text: string;
  // Everything the model emitted as reasoning (inline <think>…</think> blocks
  // and/or a `reasoning_content` delta field). Dropped on the floor by
  // streamTurn today — kept in the result so the caller can tell "the model
  // said nothing" apart from "the model only thought" (see the empty-reply
  // guard in createOpenAIProvider).
  reasoning: string;
  inputTokens: number;
  outputTokens: number;
  // Normalised to the Anthropic vocabulary the client already speaks:
  // finish_reason 'stop' → 'end_turn', 'length' → 'max_tokens', anything else
  // passed through verbatim. 'end_turn' when the server never sent one.
  stopReason: string;
}

// ---- THINKING SEPARATION -----------------------------------------------------
//
// Reasoning models (Qwen3, DeepSeek-R1 distills, …) emit their chain of thought
// as an inline `<think>…</think>` block ahead of the reply when served by
// KoboldCPP (and by llama.cpp/Ollama unless told to split it). SGC has no use
// for that text: it must not stream into the thread, must not be persisted as
// the reply, must not become buffer or Grepory input, and must not sit in
// front of the state turn's JSON. So the separation happens HERE, at the
// provider boundary, once, for both producers (live turn and state turn).
//
// `separateThinking` is a PURE function of the whole raw content-so-far. The
// parser re-runs it on every fragment rather than keeping a state machine,
// which makes its output trivially prefix-stable (the streaming contract:
// deltas are append-only, the client cannot retract) PROVIDED two rules hold:
//
//   1. A trailing run that could still grow into a tag (`<`, `</th`, …) is
//      HELD BACK until the next fragment disambiguates it (`final` releases
//      it — a real `<` the model meant to say). Without this, "<thi" would be
//      streamed as prose and then need un-streaming when "nk>" arrived.
//   2. Whitespace directly after a `</think>` is trimmed — models put "\n\n"
//      between the block and the reply — and NOTHING else is trimmed. The
//      first segment is never touched, so a stream with no thinking at all is
//      byte-identical to today's behaviour.
//
// One shape is deliberately NOT handled: a template that pre-fills `<think>`
// in the generation prompt, so the content starts inside the block and only
// a bare `</think>` ever arrives (DeepSeek-R1's own template does this). It is
// undecidable mid-stream — the prose before the close tag is already on the
// wire as visible text — so a stray `</think>` is simply dropped and the
// preceding text stays visible. The fix for that shape lives in the local
// server: llama.cpp `--reasoning-format deepseek` (and vLLM's reasoning
// parsers) move the block into `delta.reasoning_content`, which the parser
// below DOES route to `reasoning`.
const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

// Length of the longest suffix of `s` that is a proper prefix of one of the
// tags — the run to hold back while streaming. 0 when the tail is unambiguous.
function danglingTagPrefix(s: string): number {
  const max = Math.min(s.length, THINK_CLOSE.length - 1);
  for (let n = max; n >= 1; n--) {
    const tail = s.slice(s.length - n);
    if (THINK_OPEN.startsWith(tail) || THINK_CLOSE.startsWith(tail)) return n;
  }
  return 0;
}

/** Split raw model content into the visible reply and its reasoning. Exported
 *  for the unit tests; see the block comment above for the contract. */
export function separateThinking(raw: string, final: boolean): { visible: string; reasoning: string } {
  let visible = '';
  let reasoning = '';
  let inThink = false;
  let afterClose = false; // the segment now being appended follows a </think>
  let pos = 0;

  const append = (segment: string): void => {
    if (inThink) {
      reasoning += segment;
      return;
    }
    if (afterClose) {
      segment = segment.replace(/^\s+/, '');
      if (segment.length === 0) return; // still only whitespace — keep trimming
      afterClose = false;
    }
    visible += segment;
  };

  while (pos < raw.length) {
    const tag = inThink ? THINK_CLOSE : THINK_OPEN;
    let idx = raw.indexOf(tag, pos);
    // A stray close tag while NOT in a block: drop the tag, keep the text.
    let strayClose = -1;
    if (!inThink) {
      strayClose = raw.indexOf(THINK_CLOSE, pos);
      if (strayClose !== -1 && (idx === -1 || strayClose < idx)) idx = strayClose;
      else strayClose = -1;
    }
    if (idx === -1) {
      let tail = raw.slice(pos);
      if (!final) {
        const hold = danglingTagPrefix(tail);
        if (hold > 0) tail = tail.slice(0, tail.length - hold);
      }
      append(tail);
      break;
    }
    append(raw.slice(pos, idx));
    if (strayClose !== -1) {
      pos = idx + THINK_CLOSE.length;
      afterClose = true;
      continue;
    }
    pos = idx + tag.length;
    if (inThink) {
      inThink = false;
      afterClose = true;
    } else {
      inThink = true;
    }
  }
  return { visible, reasoning };
}

// Parse a complete OpenAI chat-completions SSE stream into accumulated text +
// usage, invoking `onDelta` for each content fragment. PURE over its inputs:
// feed it the raw byte chunks (as the network delivered them, frames may split
// across chunks) and it returns the assembled result. This is the openaiProvider
// SSE parse the spec calls out for Vitest coverage.
//
// OpenAI frame shape: `data: {json}\n\n`, where json carries
// choices[0].delta.content (a text fragment), optionally
// choices[0].delta.reasoning_content (a reasoning fragment — servers that split
// thinking out for you), choices[0].finish_reason on the last content frame,
// and, on the final usage frame (stream_options.include_usage), a top-level
// `usage` object. The stream terminates with the literal `data: [DONE]`.
//
// `onDelta` receives the VISIBLE text so far — thinking already removed (see
// separateThinking above) — so a consumer diffing successive calls gets clean,
// append-only reply fragments.
export async function parseOpenAIStream(
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  onDelta?: (textSoFar: string) => void,
): Promise<OpenAIStreamResult> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let rawContent = ''; // every content fragment, tags and all
  let text = ''; // visible reply so far (thinking removed)
  let fieldReasoning = ''; // reasoning the server split out for us
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = 'end_turn';

  // Re-derive the visible text from the raw accumulation and surface any new
  // visible fragment. Prefix-stability is separateThinking's contract, so a
  // plain length check is enough to know whether anything new appeared.
  const emitVisible = (final: boolean): void => {
    const { visible } = separateThinking(rawContent, final);
    if (visible.length > text.length) {
      text = visible;
      onDelta?.(text);
    }
  };

  // Handle one complete `data:` payload line.
  const handleData = (data: string): void => {
    const trimmed = data.trim();
    if (trimmed === '' || trimmed === '[DONE]') return;
    let payload: {
      choices?: {
        delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null };
        finish_reason?: string | null;
      }[];
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
    const choice = payload.choices?.[0];
    const fragment = choice?.delta?.content;
    if (typeof fragment === 'string' && fragment.length > 0) {
      rawContent += fragment;
      emitVisible(false);
    }
    // Servers that split thinking out for us (llama.cpp --reasoning-format,
    // vLLM reasoning parsers, DeepSeek's own API) put it here. Never visible.
    const split = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
    if (typeof split === 'string' && split.length > 0) fieldReasoning += split;
    const finish = choice?.finish_reason;
    if (typeof finish === 'string' && finish.length > 0) {
      stopReason = finish === 'stop' ? 'end_turn' : finish === 'length' ? 'max_tokens' : finish;
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

  // Final pass releases any held-back tag prefix (a real `<` after all).
  emitVisible(true);
  const inline = separateThinking(rawContent, true).reasoning;
  const reasoning = [inline, fieldReasoning].filter((s) => s.length > 0).join('\n');

  return { text, reasoning, inputTokens, outputTokens, stopReason };
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
      let result: OpenAIStreamResult = {
        text: '',
        reasoning: '',
        inputTokens: 0,
        outputTokens: 0,
        stopReason: 'end_turn',
      };

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
      // A reasoning model that spent its whole output budget inside <think>
      // (or a server that split every token into reasoning_content) leaves an
      // EMPTY visible reply. Before thinking separation this landed as a raw
      // thought-blob; with it, it would land as a silent blank turn — worse,
      // since the buffers and state turn would then run on nothing. Surface it
      // as the actionable error it is instead (index.ts emits an `error`
      // frame; no visible delta was ever sent, so nothing needs retracting).
      if (result.text.trim().length === 0 && result.reasoning.trim().length > 0) {
        throw new Error(
          result.stopReason === 'max_tokens'
            ? `the local model spent its entire ${maxTokens}-token output budget thinking and never ` +
              'reached a reply — raise LLM_MAX_TOKENS (thinking models routinely need 2-4k of headroom), ' +
              'or turn thinking off in the local server'
            : 'the local model produced only a <think> block and no reply',
        );
      }
      yield {
        kind: 'done',
        usage: {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        },
        // This path never sees tools (D2), so 'tool_use' can't occur; what CAN
        // is 'max_tokens' (finish_reason 'length'), which used to be masked as
        // 'end_turn' — a truncated reply looked like a finished one.
        stopReason: result.stopReason,
      };
    },
  };
}
