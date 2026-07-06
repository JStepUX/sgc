// Wire-shape types shared between providers.ts (which SENDS these to a model
// SDK / local server) and turn-route.ts (which PARSES them off the HTTP body).
// Split into their own file so neither of those two stays the sole owner —
// see docs/01_deliberate-recall-spec.yaml design.wire_protocol.

// A structural content block — Anthropic's text / tool_use / tool_result
// shapes all carry a `type` discriminant and nothing else this server reads.
// Kept as a loose Record (not a discriminated union) on purpose: the server
// forwards blocks verbatim to the SDK (or flattens them to text for the
// openai path) and must never need updating when the CLIENT invents a new
// block shape.
export interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

// One turn message on the wire. `content` is a plain string for the common
// case (today's single-message turn); it becomes a content-block array once a
// round has run a client-defined tool (Sal's tool_use block, the client's
// tool_result reply) — see the client's recall-loop.ts, which is the only
// producer of that shape. The server never interprets what's inside a block.
export interface WireMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

// A client-defined tool, forwarded to whichever provider accepts it (Anthropic
// only, per D2 in the deliberate-recall spec — the client never sends this to
// the openai path). Shape mirrors Anthropic's Tool loosely so a future
// client-defined tool needs no server change.
export interface WireTool {
  name: string;
  description?: string;
  input_schema: unknown;
}
