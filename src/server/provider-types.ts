// The provider abstraction shared by providers.ts (Anthropic) and
// openai-provider.ts (any OpenAI-compatible server) — split into its own file
// so neither concrete provider has to import the other just to share these
// shapes. See docs/01_deliberate-recall-spec.yaml design.wire_protocol.

import type { WireMessage, WireTool } from './wire-types.js';

// What a provider streams back, one chunk at a time.
export type TurnChunk =
  | { kind: 'delta'; text: string }
  // 0..n per round, emitted after the text stream ends and before `done` —
  // one per tool_use content block the model produced this round.
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | {
      kind: 'done';
      usage: {
        inputTokens: number;
        outputTokens: number;
      };
      // Why the model stopped this round: 'end_turn' | 'tool_use' |
      // 'max_tokens' | ... — the client-orchestrated recall loop reads this to
      // decide whether to run another round. Always 'end_turn' from the
      // openai path (it never sees tools).
      stopReason: string;
    };

export interface TurnProvider {
  // One reasoning call. `system` is the already-built prompt; `messages` is
  // the turn(s) so far (a single user message today, or a multi-round
  // tool_use/tool_result exchange once the recall loop is in play); `tools`
  // is forwarded verbatim when the caller supplies a non-empty array;
  // `signal` aborts the upstream request when the browser hangs up.
  streamTurn(
    system: string,
    messages: WireMessage[],
    tools: WireTool[] | undefined,
    signal: AbortSignal,
  ): AsyncIterable<TurnChunk>;
}

// The provider token a client may send. Lives here so both index.ts (via
// turn-route.ts) and the pure resolver in providers.ts share one definition.
export type ProviderId = 'anthropic' | 'openai';

// The outcome of deciding which provider runs a turn: either a resolved id or a
// rejection the caller turns into an HTTP error.
export type ProviderResolution =
  | { ok: true; id: ProviderId }
  | { ok: false; status: number; error: string };
