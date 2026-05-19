// Client → server transport.
//
// This replaces the Phase 1.5 artifact's direct browser fetch to
// api.anthropic.com (which only worked inside the Claude Artifact runtime).
// The key now lives on the server; the browser only ever calls /api/turn.
//
// /api/turn streams its response as Server-Sent Events: `delta` frames carry
// text as Sal produces it, a final `done` frame carries token usage, and an
// `error` frame reports a mid-stream failure. This is still ONE API call per
// turn — the turn is just delivered incrementally instead of all at once.

/** What a completed turn returns to the UI. */
export interface TurnResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** Round-trip latency in ms, measured client-side. */
  elapsed: number;
}

/**
 * Run one turn against the server.
 *
 * `onDelta`, if given, is called every time more text arrives, with the full
 * raw text accumulated so far (not just the new chunk). The caller is free to
 * strip the trailing <turn-meta> block for display — see stripStreamingMeta.
 */
export async function runTurn(
  systemPrompt: string,
  userMessage: string,
  onDelta?: (rawSoFar: string) => void,
): Promise<TurnResult> {
  const startTime = Date.now();

  const response = await fetch('/api/turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system: systemPrompt, message: userMessage }),
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
    } else if (name === 'done') {
      const d = payload as { inputTokens?: number; outputTokens?: number };
      inputTokens = d.inputTokens ?? 0;
      outputTokens = d.outputTokens ?? 0;
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
  };
}
