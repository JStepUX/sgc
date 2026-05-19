// Client → server transport.
//
// This replaces the Phase 1.5 artifact's direct browser fetch to
// api.anthropic.com (which only worked inside the Claude Artifact runtime).
// The key now lives on the server; the browser only ever calls /api/turn.

/** What a completed turn returns to the UI. */
export interface TurnResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** Round-trip latency in ms, measured client-side. */
  elapsed: number;
}

export async function runTurn(
  systemPrompt: string,
  userMessage: string,
): Promise<TurnResult> {
  const startTime = Date.now();

  const response = await fetch('/api/turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system: systemPrompt, message: userMessage }),
  });

  const elapsed = Date.now() - startTime;

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

  const data = (await response.json()) as {
    text?: string;
    inputTokens?: number;
    outputTokens?: number;
  };

  return {
    text: data.text ?? '',
    inputTokens: data.inputTokens ?? 0,
    outputTokens: data.outputTokens ?? 0,
    elapsed,
  };
}
