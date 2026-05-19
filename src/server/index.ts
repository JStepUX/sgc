// SGC server — the one server-side component.
//
// It exists for exactly one reason: the browser must never hold the Anthropic
// API key. The React client POSTs a fully-built system prompt + user message to
// /api/turn; this server attaches the key, calls the model, and streams the
// text back as Server-Sent Events plus a final token-usage frame. No memory
// architecture lives here — the tiers (memories, local buffer, cosine grep) are
// assembled client-side. This is dumb plumbing on purpose.

import 'dotenv/config';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';

const PORT = Number(process.env.PORT) || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5555';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-7';
const MAX_TOKENS = Number(process.env.ANTHROPIC_MAX_TOKENS) || 16384;
const API_KEY = process.env.ANTHROPIC_API_KEY;

// Construct the client only when a key is present. With no key the server
// still starts (so UI-only dev still works), but /api/turn returns a clear
// setup error instead of a generic 500 — the SDK's missing-key error is a
// client-side AnthropicError, not an Anthropic.APIError, so it would otherwise
// fall through to the catch-all 500. A turn is a single short request; 60s is
// generous and well under the SDK's 10-min default, so a wedged turn fails
// fast instead of hanging the UI.
const anthropic = API_KEY ? new Anthropic({ apiKey: API_KEY, timeout: 60_000 }) : null;

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model: MODEL, keyConfigured: anthropic !== null });
});

interface TurnRequestBody {
  system?: unknown;
  message?: unknown;
}

app.post('/api/turn', async (req, res) => {
  if (!anthropic) {
    res.status(500).json({
      error:
        'Server misconfigured: ANTHROPIC_API_KEY is not set. ' +
        'Copy .env.example to .env and add your key, then restart the server.',
    });
    return;
  }

  const { system, message } = (req.body ?? {}) as TurnRequestBody;
  if (typeof system !== 'string' || typeof message !== 'string') {
    res.status(400).json({ error: 'Body must include string `system` and `message`.' });
    return;
  }

  // Open the SSE stream. The two guards above stay plain JSON-over-HTTP — they
  // run BEFORE flushHeaders, so a bad request still gets a clean 400/500.
  // Everything past this point is an event stream: failures become an `error`
  // frame, because the HTTP status line is already on the wire.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering if proxied
  res.flushHeaders();

  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // One API call per turn — streamed. messages.stream() is still a single
  // request to Anthropic; it just delivers the response incrementally. The
  // Phase 1.5 "one API call per turn" invariant holds.
  //
  // No prompt caching: the system prompt is ~1-2k tokens (below Opus 4.7's
  // 4096-token cache minimum) and is rebuilt every turn from the memory tiers —
  // there is no stable prefix to cache. Adaptive thinking is left off (Opus 4.7
  // default) to keep the turn fast and the latency readout in the UI honest.
  const stream = anthropic.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: message }],
  });

  // The error event is handled via the finalMessage() rejection below; this
  // no-op listener just stops an emitted `error` from becoming an unhandled
  // EventEmitter exception that would crash the process.
  stream.on('error', () => {});
  stream.on('text', (delta) => send('delta', { text: delta }));

  let settled = false;
  // If the browser hangs up mid-turn, abort the upstream call so we don't pay
  // for a completion nobody will read. This MUST hang off the response, not
  // the request: req's 'close' fires as soon as the (already fully-read) POST
  // body stream is destroyed — within a few ms of the handler starting, long
  // before the turn finishes streaming — so a req-close abort would kill every
  // normal turn. res's 'close' fires only when the response itself ends:
  // cleanly (writableEnded === true) or because the client disconnected first.
  res.on('close', () => {
    if (!settled && !res.writableEnded) stream.abort();
  });

  try {
    const final = await stream.finalMessage();
    settled = true;
    send('done', {
      inputTokens: final.usage.input_tokens,
      outputTokens: final.usage.output_tokens,
    });
    res.end();
  } catch (err) {
    settled = true;
    // The stream is already open, so the error rides it as an `error` frame
    // rather than an HTTP status. Surface the upstream message for an
    // Anthropic.APIError (so the client can tell a 401 from a 529); keep
    // anything else generic.
    const detail =
      err instanceof Anthropic.APIError
        ? err.message
        : 'Internal error generating the turn response.';
    if (!(err instanceof Anthropic.APIError)) console.error('turn error:', err);
    if (!res.writableEnded) {
      send('error', { error: detail });
      res.end();
    }
  }
});

// Serve the built client when it exists — i.e. after `npm run build`. This is
// presence-based, not NODE_ENV-based: `npm start` then works without anyone
// having to set NODE_ENV. In dev it stays inert — the server runs from
// src/server/, so clientDir resolves to src/client/, which has no index.html
// (index.html lives at the repo root and Vite serves the client on :5555).
const clientDir = resolve(dirname(fileURLToPath(import.meta.url)), '../client');
if (existsSync(resolve(clientDir, 'index.html'))) {
  app.use(express.static(clientDir));
  app.get('*', (_req, res) => {
    res.sendFile(resolve(clientDir, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`SGC server listening on :${PORT} (model: ${MODEL})`);
  if (!anthropic) {
    console.warn('  ANTHROPIC_API_KEY is not set — /api/turn will return a setup error.');
    console.warn('  Copy .env.example to .env and add your key.');
  }
});
