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
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import {
  createChat as dbCreateChat,
  deleteChat as dbDeleteChat,
  getMemories as dbGetMemories,
  listChats as dbListChats,
  loadChat as dbLoadChat,
  saveMemories as dbSaveMemories,
  saveTurnPair as dbSaveTurnPair,
  setTurnsActive as dbSetTurnsActive,
  type SaveMemoryInput,
  type SaveTurnInput,
  type TurnActiveState,
} from './db.js';

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
  // web_search / web_fetch are Anthropic SERVER-SIDE tools: their search/fetch
  // loop runs INSIDE this one request, so the single-call invariant survives.
  // This is web/knowledge retrieval — a different axis from the cosine-grep
  // MEMORY retrieval, which stays pure math with no model in the loop. (See
  // AGENTS.md: "no model-based retrieval" was always about memory.) The one
  // edge: if the server-side loop hits its iteration cap the stream ends with
  // stop_reason 'pause_turn' instead of 'end_turn'; we deliberately do NOT
  // resume (resuming is a second call) — see the finalMessage handler below.
  // Fetch is unrestricted (no allowed_domains) by design.
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
    tools: [
      { type: 'web_search_20260209', name: 'web_search' },
      { type: 'web_fetch_20260209', name: 'web_fetch' },
    ],
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
    // The server-side web-tool loop hit its iteration cap. Resuming would be a
    // second API call; the one-call-per-turn invariant is worth more than the
    // rare over-long research turn, so we let it end here and just log it. If
    // this ever fires in practice, that's the signal to reconsider — not a bug.
    if (final.stop_reason === 'pause_turn') {
      console.warn('turn ended on pause_turn (web-tool loop cap) — not resuming; one-call invariant held');
    }
    send('done', {
      inputTokens: final.usage.input_tokens,
      outputTokens: final.usage.output_tokens,
      // Server-side web tool counts (0 when Sal didn't reach for the web).
      webSearchRequests: final.usage.server_tool_use?.web_search_requests ?? 0,
      webFetchRequests: final.usage.server_tool_use?.web_fetch_requests ?? 0,
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

// ============================================================
// URL PRE-FETCH (deterministic, NO model)
//
// For the "read this page" case the browser sends a pasted URL here BEFORE the
// turn. We fetch it and run Readability extraction — a pure algorithm, no model,
// no drift — and hand back clean article text. The browser folds that into the
// single /api/turn prompt as a LINKED PAGE block, so the page is read in ONE
// model call and counted ONCE. This is far cheaper than the server-side
// web_fetch tool, which dumps full page chrome into context and re-counts it
// across the internal tool loop (the 94k-token turn that prompted this). It is
// the web-knowledge analogue of the cosine grep: mechanical retrieval, no model
// in the loop. web_search / web_fetch stay on /api/turn for the case where Sal
// must DISCOVER what to read.
// ============================================================

const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 5_000_000; // refuse to ingest a monster page
const MAX_EXTRACT_CHARS = 60_000; // ~15k tokens — the deterministic content cap
const MAX_REDIRECT_HOPS = 5;

// This endpoint fetches an arbitrary user-supplied URL server-side — an SSRF
// surface. The request originates inside the host's trust boundary, so a crafted
// link could otherwise reach localhost services, the LAN, or cloud metadata
// (169.254.169.254). Defence is layered:
//   1. asFetchableUrl   — scheme must be http(s); reject obvious by-name hosts.
//   2. assertPublicHost — resolve DNS and reject if ANY address is private, so a
//      public hostname pointing at a private IP (DNS rebinding) is caught.
//   3. safeFetch        — redirects are followed MANUALLY and every hop is
//      re-validated through (1)+(2), so a 30x to a private target can't slip past.
// Residual: resolve→connect is a TOCTOU window — a hostile resolver could return
// a public IP for our check and a private one for fetch's own lookup. Closing it
// fully needs connecting to the validated IP directly (a pinned agent); that's
// out of scope for a local prototype, noted so this isn't mistaken for airtight.

class BlockedUrlError extends Error {}

function asFetchableUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // Numeric private/loopback hosts are caught by assertPublicHost (which also
  // covers DNS); here we only fast-reject by-name hosts that may never resolve.
  if (host === 'localhost' || host.endsWith('.local')) return null;
  return u;
}

function isPrivateIp(addr: string): boolean {
  let ip = addr;
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i); // IPv4-mapped IPv6
  if (mapped) ip = mapped[1];
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) || // link-local, incl. cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) // CGNAT
    );
  }
  const v6 = ip.toLowerCase();
  return (
    v6 === '::1' ||
    v6 === '::' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') || // fc00::/7 unique-local
    /^fe[89ab]/.test(v6) // fe80::/10 link-local
  );
}

// Resolve a host and throw unless every address it maps to is public. Literal
// IPs are checked directly; names are resolved (all records) so a name pointing
// at a private address is rejected.
async function assertPublicHost(host: string): Promise<void> {
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare)) {
    if (isPrivateIp(bare)) throw new BlockedUrlError(`blocked private address ${bare}`);
    return;
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(bare, { all: true });
  } catch {
    throw new BlockedUrlError(`could not resolve host ${bare}`);
  }
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
    throw new BlockedUrlError(`host ${bare} resolves to a non-public address`);
  }
}

// Fetch with MANUAL redirect handling; re-validate scheme/host and resolved IP
// at every hop. Throws BlockedUrlError if any hop targets a non-public address.
async function safeFetch(start: URL, signal: AbortSignal): Promise<Response> {
  let current: URL = start;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    await assertPublicHost(current.hostname);
    const resp = await fetch(current, {
      signal,
      redirect: 'manual',
      headers: {
        // Some sites refuse the default fetch User-Agent.
        'User-Agent': 'Mozilla/5.0 (compatible; SGC-Sal/0.1; local prototype)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (resp.status < 300 || resp.status >= 400) return resp;
    const loc = resp.headers.get('location');
    await resp.body?.cancel(); // free the socket; the 3xx body is unused
    if (!loc) return resp; // redirect with no target — caller will see non-OK
    const next = asFetchableUrl(new URL(loc, current).href);
    if (!next) throw new BlockedUrlError('redirect to a blocked or invalid URL');
    current = next;
  }
  throw new BlockedUrlError('too many redirects');
}

// Read a body as UTF-8, enforcing a byte cap DURING the read so an unbounded or
// oversized response can't buffer the whole thing into memory. Returns null when
// the cap is exceeded.
async function readCapped(resp: Response, maxBytes: number): Promise<string | null> {
  if (!resp.body) return '';
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

app.post('/api/fetch-url', async (req, res) => {
  const { url } = (req.body ?? {}) as { url?: unknown };
  if (typeof url !== 'string') {
    res.status(400).json({ error: 'Body must include a string `url`.' });
    return;
  }
  const parsed = asFetchableUrl(url);
  if (!parsed) {
    res.status(400).json({ error: 'URL must be a public http(s) address.' });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const upstream = await safeFetch(parsed, controller.signal);
    if (!upstream.ok) {
      res.status(502).json({ error: `Upstream returned HTTP ${upstream.status}.` });
      return;
    }
    const ctype = upstream.headers.get('content-type') ?? '';
    if (!ctype.includes('html') && !ctype.includes('text')) {
      res.status(415).json({ error: `Unsupported content-type: ${ctype || 'unknown'}.` });
      return;
    }
    const html = await readCapped(upstream, MAX_HTML_BYTES);
    if (html === null) {
      res.status(413).json({ error: 'Page too large to extract.' });
      return;
    }

    // JSDOM runs no scripts and loads no subresources by default, so this parse
    // is inert. Pass the final (post-redirect) URL so relative links resolve.
    const finalUrl = upstream.url || parsed.href;
    const dom = new JSDOM(html, { url: finalUrl });
    const article = new Readability(dom.window.document).parse();
    const text = (article?.textContent ?? '').trim();
    if (!text) {
      res.status(422).json({ error: 'No readable article content found.' });
      return;
    }

    const truncated = text.length > MAX_EXTRACT_CHARS;
    res.json({
      url: finalUrl,
      title: (article?.title ?? '').trim() || parsed.hostname,
      text: truncated ? text.slice(0, MAX_EXTRACT_CHARS) : text,
      truncated,
    });
  } catch (err) {
    if (err instanceof BlockedUrlError) {
      res.status(400).json({ error: `Refused: ${err.message}.` });
      return;
    }
    const aborted = err instanceof Error && err.name === 'AbortError';
    if (!aborted) console.error('fetch-url failed:', err);
    res.status(aborted ? 504 : 502).json({
      error: aborted ? 'Fetch timed out.' : 'Failed to fetch or parse the URL.',
    });
  } finally {
    clearTimeout(timer);
  }
});

// ============================================================
// PERSISTENCE ROUTES
//
// Plain JSON-over-HTTP (NOT SSE — SSE is /api/turn only). These routes hold
// chats, turns, and the global memory set. They do not call the model and
// must not — the Phase 1.5 contract is "one API call per turn" and that call
// is /api/turn alone.
// ============================================================

app.get('/api/chats', (_req, res) => {
  try {
    res.json(dbListChats());
  } catch (err) {
    console.error('listChats failed:', err);
    res.status(500).json({ error: 'Failed to list chats.' });
  }
});

app.post('/api/chats', (_req, res) => {
  try {
    const id = randomUUID();
    dbCreateChat(id);
    res.json({ id });
  } catch (err) {
    console.error('createChat failed:', err);
    res.status(500).json({ error: 'Failed to create chat.' });
  }
});

app.get('/api/chats/:id', (req, res) => {
  try {
    const chat = dbLoadChat(req.params.id);
    if (!chat) {
      res.status(404).json({ error: 'Chat not found.' });
      return;
    }
    res.json(chat);
  } catch (err) {
    console.error('loadChat failed:', err);
    res.status(500).json({ error: 'Failed to load chat.' });
  }
});

app.delete('/api/chats/:id', (req, res) => {
  try {
    const ok = dbDeleteChat(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Chat not found.' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('deleteChat failed:', err);
    res.status(500).json({ error: 'Failed to delete chat.' });
  }
});

interface SaveTurnBody {
  user?: { content?: unknown };
  assistant?: { content?: unknown; inspectorJson?: unknown };
}

app.post('/api/chats/:id/turns', (req, res) => {
  const body = (req.body ?? {}) as SaveTurnBody;
  const userContent = body.user?.content;
  const assistantContent = body.assistant?.content;
  const inspectorJson = body.assistant?.inspectorJson;

  if (typeof userContent !== 'string' || typeof assistantContent !== 'string') {
    res.status(400).json({ error: 'Body requires {user:{content}, assistant:{content,inspectorJson?}}.' });
    return;
  }
  if (inspectorJson !== null && inspectorJson !== undefined && typeof inspectorJson !== 'string') {
    res.status(400).json({ error: 'assistant.inspectorJson must be a string or null.' });
    return;
  }

  const input: SaveTurnInput = {
    user: { content: userContent },
    assistant: {
      content: assistantContent,
      inspectorJson: typeof inspectorJson === 'string' ? inspectorJson : null,
    },
  };

  try {
    dbSaveTurnPair(req.params.id, input);
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    if (msg.startsWith('chat not found')) {
      res.status(404).json({ error: 'Chat not found.' });
      return;
    }
    console.error('saveTurn failed:', err);
    res.status(500).json({ error: 'Failed to save turn.' });
  }
});

// Toggle the cosine-grep gate on turns (chat memory editor). Bulk by design —
// the editor's "All off" / select-mode actions flip many turns in one request.
// This is NOT a model route: gating is deterministic curation of the memory
// tier, the Phase 1.5 "no model in the retrieval path" line holds.
interface SetTurnActiveBody {
  states?: unknown;
}

app.put('/api/chats/:id/turn-active', (req, res) => {
  const body = (req.body ?? {}) as SetTurnActiveBody;
  if (!Array.isArray(body.states)) {
    res.status(400).json({ error: 'states must be an array of {id, active}.' });
    return;
  }
  const states: TurnActiveState[] = [];
  for (const raw of body.states) {
    if (!raw || typeof raw !== 'object') {
      res.status(400).json({ error: 'each state must be {id: number, active: boolean}.' });
      return;
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'number' || typeof r.active !== 'boolean') {
      res.status(400).json({ error: 'each state must be {id: number, active: boolean}.' });
      return;
    }
    states.push({ id: r.id, active: r.active });
  }
  try {
    dbSetTurnsActive(req.params.id, states);
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    if (msg.startsWith('chat not found')) {
      res.status(404).json({ error: 'Chat not found.' });
      return;
    }
    console.error('setTurnsActive failed:', err);
    res.status(500).json({ error: 'Failed to update turn states.' });
  }
});

app.get('/api/memories', (_req, res) => {
  try {
    res.json(dbGetMemories());
  } catch (err) {
    console.error('getMemories failed:', err);
    res.status(500).json({ error: 'Failed to load memories.' });
  }
});

interface SaveMemoriesBody {
  memories?: unknown;
}

function parseMemoryInput(x: unknown): SaveMemoryInput | null {
  if (!x || typeof x !== 'object') return null;
  const r = x as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  if (typeof r.text !== 'string') return null;
  if (typeof r.confidence !== 'number') return null;
  if (!Array.isArray(r.history)) return null;
  const history: SaveMemoryInput['history'] = [];
  for (const h of r.history) {
    if (!h || typeof h !== 'object') return null;
    const hr = h as Record<string, unknown>;
    if (
      typeof hr.delta !== 'number'
      || typeof hr.newScore !== 'number'
      || typeof hr.turnGlobal !== 'number'
    ) return null;
    history.push({ delta: hr.delta, newScore: hr.newScore, turnGlobal: hr.turnGlobal });
  }
  return { id: r.id, text: r.text, confidence: r.confidence, history };
}

app.put('/api/memories', (req, res) => {
  const body = (req.body ?? {}) as SaveMemoriesBody;
  if (!Array.isArray(body.memories)) {
    res.status(400).json({ error: 'memories must be an array.' });
    return;
  }
  const parsed: SaveMemoryInput[] = [];
  for (const raw of body.memories) {
    const m = parseMemoryInput(raw);
    if (!m) {
      res.status(400).json({
        error: 'each memory must be {id, text, confidence, history: [{delta, newScore, turnGlobal}]}.',
      });
      return;
    }
    parsed.push(m);
  }
  try {
    dbSaveMemories({ memories: parsed });
    res.json({ ok: true });
  } catch (err) {
    console.error('saveMemories failed:', err);
    res.status(500).json({ error: 'Failed to save memories.' });
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
