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
import { createAnthropicProvider, createOpenAIProvider, type TurnProvider, type ProviderId } from './providers.js';
import { registerTurnRoute } from './turn-route.js';
import {
  MAX_CONSTITUTIONAL_CHARS,
  appendPromptVersion as dbAppendPromptVersion,
  createChat as dbCreateChat,
  deleteChat as dbDeleteChat,
  deleteLatestTurnPair as dbDeleteLatestTurnPair,
  deleteManualTurnPair as dbDeleteManualTurnPair,
  listChats as dbListChats,
  loadChat as dbLoadChat,
  prependManualTurnPair as dbPrependManualTurnPair,
  saveTurnPair as dbSaveTurnPair,
  setChatConstitutional as dbSetChatConstitutional,
  setTurnsActive as dbSetTurnsActive,
  updateTurnContent as dbUpdateTurnContent,
  type ManualTurnInput,
  type SaveTurnInput,
  type TurnActiveState,
} from './db.js';
import { getChatBrains as dbGetChatBrains } from './db-brains.js';
import { registerBrainRoutes } from './brains-routes.js';

const PORT = Number(process.env.PORT) || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5555';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-7';
const MAX_TOKENS = Number(process.env.ANTHROPIC_MAX_TOKENS) || 16384;
const API_KEY = process.env.ANTHROPIC_API_KEY;

// --- Local OpenAI-compatible provider config (KoboldCPP / Ollama / …) ---
// The client picks a provider per turn; the server holds the URL + key. A local
// provider is just a different (still ephemeral) Sal — see providers.ts.
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL; // e.g. http://localhost:5001/v1
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''; // KoboldCPP ignores this
const LLM_MODEL = process.env.LLM_MODEL || 'koboldcpp'; // label only — local server serves whatever is loaded
const LLM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS) || 512;

// ProviderId ('anthropic' | 'openai') and the per-turn routing rule live in
// providers.ts (resolveTurnProvider) so the routing logic is unit-tested.

// Construct the Anthropic client only when a key is present. With no key the
// server still starts (so UI-only dev still works), but the anthropic provider
// is simply absent from the registry and selecting it returns a clear setup
// error instead of a generic 500. A turn is a single short request; 60s is
// generous and well under the SDK's 10-min default, so a wedged turn fails
// fast instead of hanging the UI.
const anthropic = API_KEY ? new Anthropic({ apiKey: API_KEY, timeout: 60_000 }) : null;

// Provider registry. A provider is "available" when its config is present
// (Anthropic key set / OPENAI_BASE_URL set) — config-presence only; a live
// /v1/models ping is deferred (spec: availability). LLM_MAX_TOKENS is small by
// default because local context windows are small (configured in KoboldCPP).
const providers: Partial<Record<ProviderId, TurnProvider>> = {};
if (anthropic) {
  providers.anthropic = createAnthropicProvider({ client: anthropic, model: MODEL, maxTokens: MAX_TOKENS });
}
if (OPENAI_BASE_URL) {
  providers.openai = createOpenAIProvider({
    baseUrl: OPENAI_BASE_URL,
    apiKey: OPENAI_API_KEY,
    model: LLM_MODEL,
    maxTokens: LLM_MAX_TOKENS,
  });
}

// Which providers are configured. Computed once (config is fixed at boot) and
// shared by /api/health and the per-turn resolver.
const providerAvailable: Record<ProviderId, boolean> = {
  anthropic: providers.anthropic !== undefined,
  openai: providers.openai !== undefined,
};

// Boot default used when the client doesn't specify (or sends an invalid /
// unavailable token). Honour LLM_PROVIDER when it points at an available
// provider; otherwise fall back to whatever IS available (anthropic first).
function resolveDefaultProvider(): ProviderId | null {
  const requested = process.env.LLM_PROVIDER as ProviderId | undefined;
  if (requested && providers[requested]) return requested;
  if (providers.anthropic) return 'anthropic';
  if (providers.openai) return 'openai';
  return null;
}
const DEFAULT_PROVIDER = resolveDefaultProvider();

// Human-facing model label per provider, for the health response / picker.
const providerModel: Record<ProviderId, string> = {
  anthropic: MODEL,
  openai: LLM_MODEL,
};

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
// One JSON limit for everything except brain-pack import: a knowledge pack is
// a legitimately multi-MB blob, and a route-level parser can't raise a limit
// the global parser already enforced — so the split happens here, once.
const defaultJsonParser = express.json({ limit: '1mb' });
const packJsonParser = express.json({ limit: '32mb' });
app.use((req, res, next) =>
  req.method === 'POST' && req.path === '/api/brains'
    ? packJsonParser(req, res, next)
    : defaultJsonParser(req, res, next),
);

// Report which providers are configured + their model labels so the header
// picker can render and disable accordingly. `default` is the boot provider the
// client should adopt when it has no stored preference. `keyConfigured` /
// `model` are kept for back-compat with anything reading the old shape.
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    model: MODEL,
    keyConfigured: anthropic !== null,
    default: DEFAULT_PROVIDER,
    providers: {
      anthropic: { available: providerAvailable.anthropic, model: providerModel.anthropic },
      openai: { available: providerAvailable.openai, model: providerModel.openai, label: 'LOCAL' },
    },
  });
});

// The single model-call route — split into turn-route.ts by the anti-god-
// object ratchet (see src/architecture.test.ts; same pattern as
// registerBrainRoutes below). This server still constructs the provider
// registry (env, keys) right here; the route module only parses the wire
// shape and frames the SSE response.
registerTurnRoute(app, { providers, providerAvailable, defaultProvider: DEFAULT_PROVIDER });

// ============================================================
// URL PRE-FETCH (deterministic, NO model)
//
// For the "read this page" case the browser sends a pasted URL here BEFORE the
// turn. We fetch it and run Readability extraction — a pure algorithm, no model,
// no drift — and hand back clean article text. The browser folds that into the
// single /api/turn prompt as a LINKED PAGE block, so the page is read in ONE
// model call and counted ONCE. This is the ONLY way Sal reaches the outside
// world: the server-side web_search / web_fetch tools were removed (they cost
// ~4-5k tokens of scaffolding on every turn, browsing or not). It is the
// web-knowledge analogue of the cosine grep: mechanical retrieval, no model in
// the loop, no live search. Sal cannot discover or open a page on its own — the
// person must paste a link (or the text).
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

// Caps on the per-chat persona + mask. The persona becomes the head of the
// per-turn system prompt (a generous cap — body limit is already 1MB); the mask
// is a short display-only label (NEVER reaches the model — see prompt path).
const MAX_PERSONA_CHARS = 20_000;
const MAX_MASK_CHARS = 80;
// The constitutional cap (same size + rationale as the persona: it rides every
// turn's system prompt — spec D5) is imported from db.ts, which shares it with
// the legacy-chips migration clamp so route and storage can never disagree.

interface CreateChatBody {
  persona?: unknown;
  mask?: unknown;
  constitutional?: unknown;
}

app.post('/api/chats', (req, res) => {
  // Optional { persona, mask, constitutional }; each must be a string when
  // present. The server stores all three as opaque strings — it never
  // interprets the persona or the constitutional document (both are forwarded
  // verbatim into the system prompt on /api/turn) and the mask is display-only.
  // `constitutional` is how "Begin again"'s carry-forward seeds a new chat's
  // document at birth (D3) — absent/empty means the chat starts with nothing
  // curated, same as before this tier existed.
  const { persona, mask, constitutional } = (req.body ?? {}) as CreateChatBody;
  if (persona !== undefined && typeof persona !== 'string') {
    res.status(400).json({ error: 'persona must be a string when provided.' });
    return;
  }
  if (mask !== undefined && typeof mask !== 'string') {
    res.status(400).json({ error: 'mask must be a string when provided.' });
    return;
  }
  if (constitutional !== undefined && typeof constitutional !== 'string') {
    res.status(400).json({ error: 'constitutional must be a string when provided.' });
    return;
  }
  if (typeof persona === 'string' && persona.length > MAX_PERSONA_CHARS) {
    res.status(400).json({ error: `persona exceeds ${MAX_PERSONA_CHARS} characters.` });
    return;
  }
  if (typeof mask === 'string' && mask.length > MAX_MASK_CHARS) {
    res.status(400).json({ error: `mask exceeds ${MAX_MASK_CHARS} characters.` });
    return;
  }
  if (typeof constitutional === 'string' && constitutional.length > MAX_CONSTITUTIONAL_CHARS) {
    res.status(400).json({ error: `constitutional exceeds ${MAX_CONSTITUTIONAL_CHARS} characters.` });
    return;
  }
  try {
    const id = randomUUID();
    dbCreateChat(
      id,
      typeof persona === 'string' ? persona : null,
      typeof mask === 'string' ? mask : null,
      typeof constitutional === 'string' ? constitutional : undefined,
    );
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
    // brainIds composed here (not in loadChat) so db.ts stays free of the
    // brains concern — the wire payload is the contract, not the db helper.
    res.json({ ...chat, brainIds: dbGetChatBrains(req.params.id) });
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
    // Return the two new row ids so the client can stamp the in-session entries
    // without a reload — the assistant-response editor addresses turns by id.
    const ids = dbSaveTurnPair(req.params.id, input);
    res.json({ ok: true, ...ids });
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

// Insert a manual "brain surgery" memory: a full user+assistant pair that lands
// as the OLDEST turns in the chat, flagged timeless (the client's time scorer
// negates recency for it). NOT a model route — it's deterministic curation of
// the memory tier, same class as turn-active. Both fields are required and
// capped; empty content would add a turn the cosine engine can't index.
const MAX_MANUAL_TURN_CHARS = 20_000;

interface AddManualTurnBody {
  user?: { content?: unknown };
  assistant?: { content?: unknown };
}

app.post('/api/chats/:id/manual-turns', (req, res) => {
  const body = (req.body ?? {}) as AddManualTurnBody;
  const userContent = body.user?.content;
  const assistantContent = body.assistant?.content;
  if (typeof userContent !== 'string' || typeof assistantContent !== 'string') {
    res.status(400).json({ error: 'Body requires {user:{content}, assistant:{content}} as strings.' });
    return;
  }
  if (!userContent.trim() || !assistantContent.trim()) {
    res.status(400).json({ error: 'Both user and assistant content must be non-empty.' });
    return;
  }
  if (userContent.length > MAX_MANUAL_TURN_CHARS || assistantContent.length > MAX_MANUAL_TURN_CHARS) {
    res.status(400).json({ error: `Each field must be ${MAX_MANUAL_TURN_CHARS} characters or fewer.` });
    return;
  }
  const input: ManualTurnInput = {
    user: { content: userContent },
    assistant: { content: assistantContent },
  };
  try {
    dbPrependManualTurnPair(req.params.id, input);
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    if (msg.startsWith('chat not found')) {
      res.status(404).json({ error: 'Chat not found.' });
      return;
    }
    console.error('addManualTurn failed:', err);
    res.status(500).json({ error: 'Failed to add memory.' });
  }
});

// Delete a manual memory pair by either half's turn id. The DB helper removes
// both rows and refuses any non-timeless turn, so this can never delete a real
// streamed turn even if handed an arbitrary id.
app.delete('/api/chats/:id/turns/:turnId', (req, res) => {
  const turnId = Number(req.params.turnId);
  if (!Number.isInteger(turnId)) {
    res.status(400).json({ error: 'turnId must be an integer.' });
    return;
  }
  try {
    const ok = dbDeleteManualTurnPair(req.params.id, turnId);
    if (!ok) {
      res.status(404).json({ error: 'No deletable memory turn with that id in this chat.' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('deleteManualTurn failed:', err);
    res.status(500).json({ error: 'Failed to delete memory.' });
  }
});

// Undo the latest streamed turn pair (the thread's undo control). The client
// names the assistant turn id it believes is latest; the DB helper verifies
// that before deleting, so a stale client — a turn landed since, another
// window already undid — 409s instead of deleting the wrong pair.
app.delete('/api/chats/:id/latest-turn/:assistantTurnId', (req, res) => {
  const assistantTurnId = Number(req.params.assistantTurnId);
  if (!Number.isInteger(assistantTurnId)) {
    res.status(400).json({ error: 'assistantTurnId must be an integer.' });
    return;
  }
  try {
    const ok = dbDeleteLatestTurnPair(req.params.id, assistantTurnId);
    if (!ok) {
      res.status(409).json({ error: 'That turn is no longer the latest — reload and try again.' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('deleteLatestTurn failed:', err);
    res.status(500).json({ error: 'Failed to undo the turn.' });
  }
});

// Replace a turn's content in place (assistant-response editor). PATCH because
// it's a partial update of an existing turn — content (and optionally the
// inspector blob) only; created_at/ordinal/active/timeless are left untouched by
// the DB helper, so ordering + time-score stay anchored. NOT a model route:
// the re-spin's model call happens client-side via /api/turn; this is just the
// durable write of whatever text the editor settled on. Empty content is
// rejected (the cosine engine indexes user+assistant per pair — a blank half
// silently degrades retrieval). inspectorJson absent = leave the blob as-is;
// string/null = overwrite (a manual edit clears the summary, a re-spin replaces it).
interface UpdateTurnBody {
  content?: unknown;
  inspectorJson?: unknown;
}

app.patch('/api/chats/:id/turns/:turnId', (req, res) => {
  const turnId = Number(req.params.turnId);
  if (!Number.isInteger(turnId)) {
    res.status(400).json({ error: 'turnId must be an integer.' });
    return;
  }
  const body = (req.body ?? {}) as UpdateTurnBody;
  if (typeof body.content !== 'string' || !body.content.trim()) {
    res.status(400).json({ error: 'content must be a non-empty string.' });
    return;
  }
  if (body.content.length > MAX_MANUAL_TURN_CHARS) {
    res.status(400).json({ error: `content must be ${MAX_MANUAL_TURN_CHARS} characters or fewer.` });
    return;
  }
  const hasInspector = 'inspectorJson' in body;
  if (hasInspector && body.inspectorJson !== null && typeof body.inspectorJson !== 'string') {
    res.status(400).json({ error: 'inspectorJson must be a string or null.' });
    return;
  }
  try {
    const ok = dbUpdateTurnContent(
      req.params.id,
      turnId,
      body.content,
      hasInspector ? (body.inspectorJson as string | null) : undefined,
    );
    if (!ok) {
      res.status(404).json({ error: 'No turn with that id in this chat.' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('updateTurn failed:', err);
    res.status(500).json({ error: 'Failed to update turn.' });
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

// Append a new version of the chat's system prompt (persona) and make it live.
// Append-only / forward-only: the new version becomes the head and its text is
// mirrored into chats.persona, so the next /api/turn build picks it up. NOT a
// model route — it's curation of the active chat's prompt, the same class as
// turn-active / manual-turns. `baselineText` is the pre-edit live prompt the
// client resolved (DEFAULT_PERSONA lives client-side); the DB uses it only to
// freeze the original as v1 when this is the chat's first edit (see db.ts).
interface SavePromptVersionBody {
  text?: unknown;
  baselineText?: unknown;
}

app.post('/api/chats/:id/prompt-versions', (req, res) => {
  const { text, baselineText } = (req.body ?? {}) as SavePromptVersionBody;
  if (typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'text must be a non-empty string.' });
    return;
  }
  if (baselineText !== undefined && typeof baselineText !== 'string') {
    res.status(400).json({ error: 'baselineText must be a string when provided.' });
    return;
  }
  // Same cap as the persona (this IS the persona, versioned).
  if (text.length > MAX_PERSONA_CHARS) {
    res.status(400).json({ error: `text exceeds ${MAX_PERSONA_CHARS} characters.` });
    return;
  }
  if (typeof baselineText === 'string' && baselineText.length > MAX_PERSONA_CHARS) {
    res.status(400).json({ error: `baselineText exceeds ${MAX_PERSONA_CHARS} characters.` });
    return;
  }
  try {
    const versions = dbAppendPromptVersion(
      req.params.id,
      text,
      typeof baselineText === 'string' ? baselineText : undefined,
    );
    res.json({ versions });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    if (msg.startsWith('chat not found')) {
      res.status(404).json({ error: 'Chat not found.' });
      return;
    }
    console.error('appendPromptVersion failed:', err);
    res.status(500).json({ error: 'Failed to save prompt version.' });
  }
});

// The constitutional document is per-chat, one column: there is no global
// GET — a chat's document rides along in its /api/chats/:id (loadChat)
// payload. This PUT overwrites it wholesale, scoped by chatId, mirroring
// turn-active / prompt-versions above. NOT a model route: saving the document
// is curation the user typed themselves, same "no model in the memory tier"
// line every other route in this section holds.
interface SaveConstitutionalBody {
  text?: unknown;
}

app.put('/api/chats/:id/constitutional', (req, res) => {
  const { text } = (req.body ?? {}) as SaveConstitutionalBody;
  if (typeof text !== 'string') {
    res.status(400).json({ error: 'text must be a string.' });
    return;
  }
  if (text.length > MAX_CONSTITUTIONAL_CHARS) {
    res.status(400).json({ error: `text exceeds ${MAX_CONSTITUTIONAL_CHARS} characters.` });
    return;
  }
  try {
    dbSetChatConstitutional(req.params.id, text);
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    if (msg.startsWith('chat not found')) {
      res.status(404).json({ error: 'Chat not found.' });
      return;
    }
    console.error('setChatConstitutional failed:', err);
    res.status(500).json({ error: 'Failed to save constitutional document.' });
  }
});

// Brain routes — knowledge packs, the knowledge axis. Split into their own
// module (brains-routes.ts) by the anti-god-object ratchet: pack-file storage,
// contract validation, and mount bindings all live there.
registerBrainRoutes(app);

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
  const available = Object.keys(providers).join(', ') || 'none';
  console.log(
    `SGC server listening on :${PORT} (providers: ${available}; default: ${DEFAULT_PROVIDER ?? 'none'})`,
  );
  if (providers.anthropic) console.log(`  anthropic → ${MODEL}`);
  if (providers.openai) console.log(`  openai (LOCAL) → ${OPENAI_BASE_URL} (${LLM_MODEL})`);
  if (!DEFAULT_PROVIDER) {
    console.warn('  No model provider configured — /api/turn will return a setup error.');
    console.warn('  Set ANTHROPIC_API_KEY (or OPENAI_BASE_URL for a local model) in .env.');
  }
});
