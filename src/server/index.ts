// SGC server — the one server-side component.
//
// It exists for exactly one reason: the browser must never hold the Anthropic
// API key. The React client POSTs a fully-built system prompt + user message to
// /api/turn; this server attaches the key, calls the model, and returns the
// text + token usage. No memory architecture lives here — the tiers (memories,
// local buffer, cosine grep) are assembled client-side. This is dumb plumbing
// on purpose.

import 'dotenv/config';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';

const PORT = Number(process.env.PORT) || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-7';
const MAX_TOKENS = Number(process.env.ANTHROPIC_MAX_TOKENS) || 4096;
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

  try {
    // No prompt caching: the system prompt is ~1-2k tokens (below Opus 4.7's
    // 4096-token cache minimum) and is rebuilt every turn from the memory
    // tiers — there is no stable prefix to cache. Adaptive thinking is left
    // off (Opus 4.7 default) to keep the turn fast and the latency readout in
    // the UI honest; enable it here if Sal's confidence scoring needs depth.
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: 'user', content: message }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    res.json({
      text,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      // Surface the upstream status so the client can distinguish a 401
      // (bad key) from a 529 (overloaded) etc.
      res.status(err.status ?? 502).json({ error: err.message });
      return;
    }
    console.error('turn error:', err);
    res.status(500).json({ error: 'Internal error generating the turn response.' });
  }
});

// Serve the built client when it exists — i.e. after `npm run build`. This is
// presence-based, not NODE_ENV-based: `npm start` then works without anyone
// having to set NODE_ENV. In dev it stays inert — the server runs from
// src/server/, so clientDir resolves to src/client/, which has no index.html
// (index.html lives at the repo root and Vite serves the client on :5173).
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
