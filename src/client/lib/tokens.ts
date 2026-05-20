// ============================================================
// TOKEN ESTIMATION
//
// The savings tile in the inspector needs to compare *what we actually sent*
// (real, from `usage.input_tokens` on the API response) against *what a naive
// "send everything every turn" pipeline would have sent* — and the second
// half is by definition counterfactual. We never send the full history, so
// we have to estimate.
//
// CHOICE: ~4 chars/token heuristic.
//
// Why not gpt-tokenizer / js-tiktoken? Those tokenize for OpenAI's BPE, not
// Claude's. Using one would produce a number that LOOKS precise to three
// significant figures but is the wrong tokenizer — false rigour. For a
// research-prototype savings ratio, ±15% on the naive baseline is fine and
// honest; what matters is the order-of-magnitude story ("we sent 1.2k of a
// notional 47k"), not the second decimal place.
//
// Why not a real Claude tokenizer? Anthropic doesn't ship one for JS, and
// pulling in a heavyweight Python-ported BPE just for a UI tile fails the
// "no heavy deps" smell test. The savings tile is telemetry, not billing.
//
// If we ever DO get a real Claude tokenizer in JS, swap the body of
// `estimateTokens` and every caller stays correct — that's why this lives
// in a one-function module.
// ============================================================

/**
 * Estimate token count for a string using a mechanistic ~4-chars-per-token
 * heuristic.
 *
 * Good enough for the inspector's savings ratio. NOT for billing, NOT for
 * truncation decisions, NOT for context-window math. If you need a real
 * count, read `usage.input_tokens` from the API response.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
