// Client → server transport.
//
// This replaces the Phase 1.5 artifact's direct browser fetch to
// api.anthropic.com (which only worked inside the Claude Artifact runtime).
// The key now lives on the server; the browser only ever calls /api/turn.
//
// /api/turn streams its response as Server-Sent Events: `delta` frames carry
// text as Sal produces it, `tool_use` frames carry a client-defined tool call
// (0..n per round — see the deliberate-recall spec), a final `done` frame
// carries token usage + stopReason, and an `error` frame reports a mid-stream
// failure. Each POST is still ONE model call — the turn is just delivered
// incrementally; a MULTI-round turn (the recall loop) is multiple POSTs
// orchestrated client-side in recall-loop.ts, not multiple calls per POST.

import type { FetchedDoc } from './types';

// A structural content block — mirrors the server's (and ultimately
// Anthropic's) text / tool_use / tool_result shapes. Neither side interprets
// what's inside; kept loose on purpose (see server/wire-types.ts, which this
// mirrors — client and server build separately, so the shapes are duplicated
// rather than shared, the existing pattern in this codebase).
export interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

// One turn message on the wire. `content` is a plain string for the common
// case; a content-block array once a round has run a tool — see
// recall-loop.ts, the only producer of that shape (Sal's tool_use block +
// this client's tool_result reply, built between rounds).
export interface WireMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

// A client-defined tool, forwarded to the server verbatim. Only ever sent
// when the resolved provider is 'anthropic' (D2 in the deliberate-recall
// spec) — the caller is responsible for that gate, not this file.
export interface WireTool {
  name: string;
  description?: string;
  input_schema: unknown;
}

/**
 * Pull http(s) URLs out of a user message — deduped, in order, capped. Used to
 * decide which links to pre-fetch before the turn. Trailing sentence punctuation
 * is stripped so "see https://x.com/p." doesn't fetch a URL ending in a dot.
 */
export function extractUrls(text: string, max = 3): string[] {
  // Allow parens in the path so Wikipedia-style links survive
  // (.../Stack_(abstract_data_type)). Then trim trailing sentence punctuation,
  // and strip a trailing ) or ] only when it's unbalanced — so a link wrapped in
  // prose, "(see https://x.com/p)", loses its ) but a balanced pair is kept.
  const re = /https?:\/\/[^\s<>]+/gi;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    let url = m[0].replace(/[.,;:!?'"]+$/, '');
    if (/[)\]]$/.test(url)) {
      const close = url.slice(-1);
      const open = close === ')' ? '(' : '[';
      const opens = url.split(open).length - 1;
      const closes = url.split(close).length - 1;
      if (closes > opens) url = url.slice(0, -1);
    }
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Pre-fetch + extract a single URL via the server (`POST /api/fetch-url`).
 * Returns null on ANY failure (bad URL, timeout, no article content) — the turn
 * then proceeds without the page (Sal is told it couldn't be loaded; there is no
 * web_fetch fallback). The caller folds successful results into the prompt as
 * ephemeral LINKED PAGE context. No model is involved here; this is the only
 * outside-world input Sal gets, and it is deterministic retrieval.
 */
export async function fetchUrl(url: string): Promise<FetchedDoc | null> {
  try {
    const res = await fetch('/api/fetch-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<FetchedDoc>;
    if (typeof data.url !== 'string' || typeof data.text !== 'string') return null;
    return {
      url: data.url,
      title: typeof data.title === 'string' && data.title ? data.title : data.url,
      text: data.text,
      truncated: Boolean(data.truncated),
    };
  } catch {
    return null;
  }
}

/** What a completed turn (one round-trip, one POST) returns to the caller. */
export interface TurnResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** Round-trip latency in ms, measured client-side. */
  elapsed: number;
  /** Why the model stopped this round: 'end_turn' | 'tool_use' | 'max_tokens' |
   * ... — defaults to 'end_turn' if the server omits it (back-compat). The
   * recall loop reads this to decide whether to run another round. */
  stopReason: string;
  /** Every tool_use block Sal emitted this round, in arrival order. Empty
   * unless `tools` was supplied and Sal invoked one. */
  toolUses: { id: string; name: string; input: unknown }[];
}

/** Which model backs Sal for a turn. The client sends only this token; the
 * server holds the key/URL and maps it to a provider. See server/providers.ts. */
export type ProviderId = 'anthropic' | 'openai';

/**
 * Run one round against the server (one POST, one model call).
 *
 * `messages` is the turn's WireMessage[] — a single user message for a plain
 * turn, or the full multi-round exchange-so-far once the recall loop has run
 * a tool (see recall-loop.ts, which owns assembling that array between
 * rounds; this function never mutates or interprets it).
 *
 * `onDelta`, if given, is called every time more text arrives, with the full
 * raw text accumulated so far (not just the new chunk). The caller is free to
 * strip the trailing <turn-summary> block for display — see stripStreamingMeta.
 *
 * `provider`, if given, selects the backing model for this turn ('anthropic' |
 * 'openai'); omitted, the server uses its boot default. Only the token crosses
 * the wire — never a URL or key.
 *
 * `tools`, if given (and non-empty), is forwarded to the server verbatim —
 * the caller is responsible for only ever passing tools on the 'anthropic'
 * provider (D2 in the deliberate-recall spec); this function has no opinion.
 */
export async function runTurn(
  systemPrompt: string,
  messages: WireMessage[],
  onDelta?: (rawSoFar: string) => void,
  provider?: ProviderId,
  tools?: WireTool[],
): Promise<TurnResult> {
  const startTime = Date.now();

  const response = await fetch('/api/turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system: systemPrompt,
      messages,
      ...(provider ? { provider } : {}),
      ...(tools && tools.length > 0 ? { tools } : {}),
    }),
  });

  // A non-OK status means the server rejected the request BEFORE opening the
  // SSE stream (bad body, missing key) — the body is a plain JSON error, not
  // an event stream. Failures *after* the stream opens arrive as `error`
  // frames instead, handled in the dispatch loop below.
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const errBody = (await response.json()) as { error?: string };
      if (errBody?.error) detail = errBody.error;
    } catch {
      // Non-JSON error body — keep the status-code detail.
    }
    throw new Error(`Turn request failed: ${detail}`);
  }
  if (!response.body) {
    throw new Error('Turn request failed: response has no body to stream.');
  }

  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = 'end_turn';
  const toolUses: { id: string; name: string; input: unknown }[] = [];

  // SSE frames are `event: <name>\ndata: <json>\n\n`. A single frame can be
  // split across network chunks, so the accumulator state lives OUTSIDE the
  // read loop — resetting it per chunk would drop an event whose `event:` and
  // `data:` lines land in different reads.
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let eventName = 'message';
  let eventData = '';

  // Dispatch one completed SSE frame. The stream ends naturally when the
  // server closes the connection (the read loop sees `done`); an `error`
  // frame instead throws straight out through the dispatch call.
  const dispatch = (): void => {
    const name = eventName;
    const data = eventData;
    eventName = 'message';
    eventData = '';
    if (!data) return;

    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      payload = data;
    }

    if (name === 'delta') {
      const chunk = (payload as { text?: string }).text;
      if (typeof chunk === 'string') {
        text += chunk;
        onDelta?.(text);
      }
    } else if (name === 'tool_use') {
      const d = payload as { id?: string; name?: string; input?: unknown };
      if (typeof d.id === 'string' && typeof d.name === 'string') {
        toolUses.push({ id: d.id, name: d.name, input: d.input });
      }
    } else if (name === 'done') {
      const d = payload as {
        inputTokens?: number;
        outputTokens?: number;
        stopReason?: string;
      };
      inputTokens = d.inputTokens ?? 0;
      outputTokens = d.outputTokens ?? 0;
      stopReason = d.stopReason ?? 'end_turn';
    } else if (name === 'error') {
      const message = (payload as { error?: string }).error ?? 'stream error';
      throw new Error(`Turn request failed: ${message}`);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // Keep the last (possibly incomplete) line buffered for the next read.
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('event: ')) eventName = line.slice(7).trim();
        else if (line.startsWith('data: ')) eventData += line.slice(6);
        else if (line === '') dispatch();
      }
    }
  } finally {
    reader.releaseLock();
  }

  return {
    text,
    inputTokens,
    outputTokens,
    elapsed: Date.now() - startTime,
    stopReason,
    toolUses,
  };
}
