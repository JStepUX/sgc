// SGC's ANTHROPIC turn provider + the provider-routing rule — the model side
// of the one-call-per-turn loop.
//
// Sal is ephemeral: every turn a fresh instance gets a context rebuilt from the
// curated tiers (memories + local buffer + cosine grep), runs once, and is
// retired. A *provider* is just where that one reasoning call is sent. Today
// there are two — this file has the Anthropic one; openai-provider.ts (any
// OpenAI-compatible server, e.g. KoboldCPP/Ollama) was split out by the
// anti-god-object ratchet (see src/architecture.test.ts). Both are just a
// different Sal: switching mid-chat is harmless (no state carried between
// turns either way), and neither touches the memory/retrieval path (cosine
// grep + URL pre-fetch stay deterministic, client-side and in /api/fetch-url
// respectively). See CLAUDE.md → Mission Brief and the local-provider spec's
// invariant_check.
//
// The TurnProvider contract (provider-types.ts) is deliberately narrow: a
// provider yields text deltas, 0..n tool_use chunks, and one final usage+
// stopReason frame. turn-route.ts maps those onto the delta/tool_use/done/
// error SSE frames the browser parses, so the wire contract is unchanged
// regardless of which provider ran.

import Anthropic from '@anthropic-ai/sdk';
import type { ProviderId, ProviderResolution, TurnProvider } from './provider-types.js';

export type { TurnChunk, TurnProvider, ProviderId, ProviderResolution } from './provider-types.js';
export type { ContentBlock, WireMessage, WireTool } from './wire-types.js';

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
// response, so index.ts can map it onto delta/done/tool_use frames.
//
// No SERVER-side tools are attached. Sal has no live web access: the only
// outside-world input is the deterministic Readability pre-fetch of a pasted
// URL (POST /api/fetch-url), folded into the prompt as a LINKED PAGE before
// this call. Anthropic's server-side web_search / web_fetch tools were
// removed — they injected ~4-5k tokens of tool scaffolding into EVERY turn's
// input (a just-in-case cost paid whether or not Sal browsed), which wasn't
// worth it next to the free, deterministic pre-fetch. See AGENTS.md.
//
// CLIENT-DEFINED tools (e.g. the deliberate-recall `recall` tool — see
// docs/01_deliberate-recall-spec.yaml) are a different thing: this server has
// no idea what they do, just forwards the `tools` array verbatim to the SDK
// when the caller supplies one, and it costs nothing when absent — the field
// is simply omitted from the request, not sent as an empty array.
// ============================================================

export function createAnthropicProvider(opts: {
  client: Anthropic;
  model: string;
  maxTokens: number;
}): TurnProvider {
  const { client, model, maxTokens } = opts;
  return {
    async *streamTurn(system, messages, tools, signal) {
      // One API call per ROUND — streamed. messages.stream() is a single
      // request to Anthropic; it just delivers the response incrementally.
      // The stream ends on end_turn, tool_use (a client-defined tool was
      // invoked — only possible when `tools` is non-empty), or max_tokens;
      // never pause_turn (that's a server-side tool concept, and we attach
      // none). The recall loop (client-side) decides whether stop_reason
      // 'tool_use' means "run another round" — this provider only reports it.
      //
      // No prompt caching: the system prompt is rebuilt every turn from the
      // memory tiers, so there is no stable prefix worth caching. Adaptive
      // thinking is left off (Opus 4.7 default) to keep the turn fast and the
      // latency readout in the UI honest.
      const stream = client.messages.stream({
        model,
        max_tokens: maxTokens,
        system,
        // WireMessage matches Anthropic's MessageParam shape structurally —
        // this cast is the one place that assumption is named; the server
        // itself never inspects a content block.
        messages: messages as unknown as Anthropic.MessageParam[],
        // Attached only when the caller supplied a non-empty array — an
        // absent `tools` field costs nothing (see the comment above).
        ...(tools && tools.length > 0 ? { tools: tools as unknown as Anthropic.Tool[] } : {}),
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
      let toolUseBlocks: Anthropic.ToolUseBlock[] = [];
      let stopReason = 'end_turn';

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
          // finalMessage() hands back the fully-assembled message in one
          // shot — simpler and less error-prone than accumulating a
          // tool_use block's input across raw `input_json_delta` events by
          // hand, and the tool input here is small (see spec
          // out_of_scope: no streaming UI for tool_use input deltas).
          toolUseBlocks = final.content.filter(
            (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
          );
          stopReason = final.stop_reason ?? 'end_turn';
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
        for (const block of toolUseBlocks) {
          yield { kind: 'tool_use', id: block.id, name: block.name, input: block.input };
        }
        yield { kind: 'done', usage, stopReason };
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

// The OpenAI-compatible provider (createOpenAIProvider), its SSE parser
// (parseOpenAIStream, re-exported below for the existing test import path),
// and the message-flattening helper live in openai-provider.ts.
export { createOpenAIProvider, parseOpenAIStream, type OpenAIStreamResult } from './openai-provider.js';
