// /api/turn — the ONE model-call route. Split from index.ts by the
// anti-god-object ratchet (see src/architecture.test.ts) — same pattern as
// brains-routes.ts. index.ts still owns provider construction (env, keys) and
// hands the resolved registry in; this module is just the wire-parsing +
// SSE-framing glue, and it does not know what `recall` (or any other
// client-defined tool) is — see docs/01_deliberate-recall-spec.yaml.

import type { Express } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { resolveTurnProvider } from './providers.js';
import type { ProviderId, TurnProvider } from './provider-types.js';
import type { ContentBlock, WireMessage, WireTool } from './wire-types.js';

interface TurnRequestBody {
  system?: unknown;
  message?: unknown;
  messages?: unknown;
  tools?: unknown;
  provider?: unknown;
}

// Normalize to WireMessage[]: legacy `message` (string) becomes one user
// message; `messages` (the recall loop's shape) validates role/content
// PRESENCE only — a content-block array rides through opaque (never
// interpreted, see wire-types.ts). null = invalid, caller 400s.
function parseWireMessages(message: unknown, messages: unknown): WireMessage[] | null {
  if (typeof message === 'string') return [{ role: 'user', content: message }];
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const parsed: WireMessage[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (r.role !== 'user' && r.role !== 'assistant') return null;
    if (typeof r.content !== 'string' && !Array.isArray(r.content)) return null;
    parsed.push({ role: r.role, content: r.content as string | ContentBlock[] });
  }
  return parsed;
}

export function registerTurnRoute(
  app: Express,
  opts: {
    providers: Partial<Record<ProviderId, TurnProvider>>;
    providerAvailable: Record<ProviderId, boolean>;
    defaultProvider: ProviderId | null;
  },
): void {
  const { providers, providerAvailable, defaultProvider } = opts;

  app.post('/api/turn', async (req, res) => {
    const { system, message, messages: rawMessages, tools: rawTools, provider: rawProvider } =
      (req.body ?? {}) as TurnRequestBody;
    if (typeof system !== 'string') {
      res.status(400).json({ error: 'Body must include a string `system`.' });
      return;
    }
    const messages = parseWireMessages(message, rawMessages);
    if (!messages) {
      res.status(400).json({ error: 'Body must include a string `message` or a non-empty `messages` array.' });
      return;
    }
    // Forwarded verbatim (openai ignores it always — D2); validated for array-ness only.
    let tools: WireTool[] | undefined;
    if (rawTools !== undefined) {
      if (!Array.isArray(rawTools)) {
        res.status(400).json({ error: 'tools must be an array when provided.' });
        return;
      }
      tools = rawTools as WireTool[];
    }

    // Resolve which provider runs this turn. The client sends only a token
    // ('anthropic' | 'openai'); the server holds keys/URLs. An EXPLICIT but
    // unavailable token is rejected, not silently rerouted — a LOCAL request must
    // never be answered by the cloud. Only an absent/unrecognised token falls
    // back to the boot default. (spec: architecture.key_invariant; resolver +
    // tests in providers.ts.) These guards stay plain JSON (pre-flushHeaders), so
    // the client surfaces a clean error rather than a stream `error`.
    const resolution = resolveTurnProvider(rawProvider, providerAvailable, defaultProvider);
    if (!resolution.ok) {
      res.status(resolution.status).json({ error: resolution.error });
      return;
    }
    const provider = providers[resolution.id]!;

    // Open the SSE stream. The guards above stay plain JSON-over-HTTP — they run
    // BEFORE flushHeaders, so a bad request still gets a clean 400/500. Everything
    // past this point is an event stream: failures become an `error` frame,
    // because the HTTP status line is already on the wire. The delta/tool_use/
    // done/error frame shapes are IDENTICAL regardless of provider — the wire
    // contract to the browser is unchanged by which provider ran.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering if proxied
    res.flushHeaders();

    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // One reasoning call per ROUND — streamed onto delta/tool_use/done frames.
    // Whether to run ANOTHER round on a 'tool_use' stopReason is decided
    // entirely client-side (the recall loop) — this route has no idea what a
    // `recall` tool even is.
    //
    // If the browser hangs up mid-turn, abort the upstream call so we don't pay
    // for a completion nobody will read. This MUST hang off the response, not the
    // request: req's 'close' fires as soon as the (already fully-read) POST body
    // stream is destroyed — within a few ms of the handler starting, long before
    // the turn finishes streaming — so a req-close abort would kill every normal
    // turn. res's 'close' fires only when the response itself ends: cleanly
    // (writableEnded === true) or because the client disconnected first.
    const controller = new AbortController();
    let settled = false;
    res.on('close', () => {
      if (!settled && !res.writableEnded) controller.abort();
    });

    try {
      for await (const chunk of provider.streamTurn(system, messages, tools, controller.signal)) {
        if (chunk.kind === 'delta') {
          send('delta', { text: chunk.text });
        } else if (chunk.kind === 'tool_use') {
          send('tool_use', { id: chunk.id, name: chunk.name, input: chunk.input });
        } else {
          settled = true;
          send('done', {
            inputTokens: chunk.usage.inputTokens,
            outputTokens: chunk.usage.outputTokens,
            stopReason: chunk.stopReason,
          });
        }
      }
      settled = true;
      if (!res.writableEnded) res.end();
    } catch (err) {
      settled = true;
      // The stream is already open, so the error rides it as an `error` frame
      // rather than an HTTP status. Surface the upstream message for an
      // Anthropic.APIError (so the client can tell a 401 from a 529) or a local
      // provider's fetch error; keep anything else generic.
      let detail: string;
      if (err instanceof Anthropic.APIError) {
        detail = err.message;
      } else if (err instanceof Error && resolution.id === 'openai') {
        detail = err.message;
      } else {
        detail = 'Internal error generating the turn response.';
        console.error('turn error:', err);
      }
      if (!res.writableEnded) {
        send('error', { error: detail });
        res.end();
      }
    }
  });
}
