// Brain routes — knowledge packs ("brains", the knowledge axis).
//
// Packs are FILES in <dirname(DB_PATH)>/brains/<id>.json (SGC_BRAINS_DIR
// overrides); SQLite holds only the (chat_id, brain_id) bindings
// (db-brains.ts). The server validates and stores packs — it never searches
// them: retrieval is client-side TF-IDF math (lib/brains.ts), same as the
// memory grep. NOT model routes, any of these. Split from index.ts by the
// anti-god-object ratchet.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Express } from 'express';
import { DB_PATH } from './db.js';
import {
  deleteBrainBindings as dbDeleteBrainBindings,
  setChatBrains as dbSetChatBrains,
} from './db-brains.js';

const BRAINS_DIR = process.env.SGC_BRAINS_DIR || resolve(dirname(DB_PATH), 'brains');

const BRAIN_ID_RE = /^[a-z0-9-]{1,64}$/;
const BRAIN_PACK_SCHEMA = 'sgc-brain/1';
const MAX_BRAIN_CHUNK_CHARS = 8000;

interface BrainPackFile {
  schema: string;
  id: string;
  name: string;
  description: string;
  version: string;
  built_at: string;
  source: { tool: string; schema: string; stub: boolean };
  chunks: {
    id: string;
    title: string;
    text: string;
    summary: string;
    topics: string[];
    aliases: string[];
    source: { file: string; doc: string; position: number };
    tokens: number;
  }[];
}

// Validate an imported pack against the sgc-brain/1 contract. Returns the
// first human-readable problem, or null when valid. Field-by-field on purpose:
// an import failure should say exactly what broke, not "invalid pack".
function validateBrainPack(pack: unknown): string | null {
  if (!pack || typeof pack !== 'object') return 'body must be a JSON pack object';
  const p = pack as Record<string, unknown>;
  if (p.schema !== BRAIN_PACK_SCHEMA) return `schema must be "${BRAIN_PACK_SCHEMA}"`;
  if (typeof p.id !== 'string' || !BRAIN_ID_RE.test(p.id)) {
    return 'id must match [a-z0-9-]{1,64}';
  }
  for (const field of ['name', 'description', 'version', 'built_at'] as const) {
    if (typeof p[field] !== 'string') return `${field} must be a string`;
  }
  const source = p.source as Record<string, unknown> | undefined;
  if (!source || typeof source !== 'object' || typeof source.stub !== 'boolean') {
    return 'source must be an object with a boolean stub flag';
  }
  if (!Array.isArray(p.chunks) || p.chunks.length === 0) {
    return 'chunks must be a non-empty array';
  }
  const seen = new Set<string>();
  for (const raw of p.chunks) {
    if (!raw || typeof raw !== 'object') return 'each chunk must be an object';
    const c = raw as Record<string, unknown>;
    const cid = typeof c.id === 'string' && c.id ? c.id : null;
    if (!cid) return 'a chunk is missing its id';
    if (seen.has(cid)) return `duplicate chunk id: ${cid}`;
    seen.add(cid);
    if (typeof c.title !== 'string' || !c.title) return `${cid}: title must be a non-empty string`;
    if (typeof c.text !== 'string' || c.text.length < 1 || c.text.length > MAX_BRAIN_CHUNK_CHARS) {
      return `${cid}: text length must be 1..${MAX_BRAIN_CHUNK_CHARS} characters`;
    }
    if (typeof c.summary !== 'string') return `${cid}: summary must be a string`;
    for (const field of ['topics', 'aliases'] as const) {
      const list = c[field];
      if (!Array.isArray(list) || list.some((t) => typeof t !== 'string')) {
        return `${cid}: ${field} must be an array of strings`;
      }
    }
    if (typeof c.tokens !== 'number' || !Number.isFinite(c.tokens)) {
      return `${cid}: tokens must be a number`;
    }
  }
  return null;
}

function brainPath(id: string): string {
  return resolve(BRAINS_DIR, `${id}.json`);
}

function projectManifest(pack: BrainPackFile) {
  return {
    id: pack.id,
    name: pack.name,
    description: pack.description,
    version: pack.version,
    built_at: pack.built_at,
    stub: pack.source.stub,
    chunkCount: pack.chunks.length,
  };
}

// Read one pack file, or null when missing/unreadable. Unreadable-but-present
// is logged: a corrupt pack should be visible in the server log, not silent.
function readBrainPack(id: string): BrainPackFile | null {
  const path = brainPath(id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BrainPackFile;
  } catch (err) {
    console.error(`brain pack ${id} is unreadable:`, err);
    return null;
  }
}

export function registerBrainRoutes(app: Express): void {
  mkdirSync(BRAINS_DIR, { recursive: true });

  // Manifests of every importable pack on disk, name-sorted for a stable picker.
  app.get('/api/brains', (_req, res) => {
    try {
      const manifests = readdirSync(BRAINS_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => readBrainPack(f.slice(0, -'.json'.length)))
        .filter((p): p is BrainPackFile => p !== null)
        .map(projectManifest)
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      res.json(manifests);
    } catch (err) {
      console.error('listBrains failed:', err);
      res.status(500).json({ error: 'Failed to list brains.' });
    }
  });

  app.get('/api/brains/:id', (req, res) => {
    if (!BRAIN_ID_RE.test(req.params.id)) {
      res.status(400).json({ error: 'Invalid brain id.' });
      return;
    }
    const pack = readBrainPack(req.params.id);
    if (!pack) {
      res.status(404).json({ error: 'Brain not found.' });
      return;
    }
    res.json(pack);
  });

  // Import a pack: the body IS the pack JSON (as exported by Atlantis). Validated
  // against the contract, then written atomically (tmp + rename) so a crashed
  // import can't leave a half-written pack; same id overwrites (re-export flow).
  // NOTE: index.ts routes this POST through the larger `packJsonParser` body
  // limit — packs are legitimately multi-MB.
  app.post('/api/brains', (req, res) => {
    const problem = validateBrainPack(req.body);
    if (problem) {
      res.status(400).json({ error: `Invalid pack: ${problem}.` });
      return;
    }
    const pack = req.body as BrainPackFile;
    try {
      const tmpPath = brainPath(pack.id) + '.tmp';
      writeFileSync(tmpPath, JSON.stringify(pack, null, 2), 'utf8');
      renameSync(tmpPath, brainPath(pack.id));
      res.json(projectManifest(pack));
    } catch (err) {
      console.error('importBrain failed:', err);
      res.status(500).json({ error: 'Failed to import brain.' });
    }
  });

  // Delete a pack file + its bindings across all chats (the brain-side cascade —
  // the chat side cascades in SQLite with the chat row).
  app.delete('/api/brains/:id', (req, res) => {
    if (!BRAIN_ID_RE.test(req.params.id)) {
      res.status(400).json({ error: 'Invalid brain id.' });
      return;
    }
    const path = brainPath(req.params.id);
    if (!existsSync(path)) {
      res.status(404).json({ error: 'Brain not found.' });
      return;
    }
    try {
      unlinkSync(path);
      dbDeleteBrainBindings(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      console.error('deleteBrain failed:', err);
      res.status(500).json({ error: 'Failed to delete brain.' });
    }
  });

  // Replace a chat's mount set. Every id must name a pack that exists on disk —
  // a binding to a missing pack would silently mount nothing on the next load.
  app.put('/api/chats/:id/brains', (req, res) => {
    const body = (req.body ?? {}) as { brainIds?: unknown };
    if (
      !Array.isArray(body.brainIds) ||
      body.brainIds.some((b) => typeof b !== 'string' || !BRAIN_ID_RE.test(b))
    ) {
      res.status(400).json({ error: 'brainIds must be an array of valid brain ids.' });
      return;
    }
    const brainIds = body.brainIds as string[];
    const missing = brainIds.filter((b) => !existsSync(brainPath(b)));
    if (missing.length > 0) {
      res.status(404).json({ error: `Unknown brains: ${missing.join(', ')}.` });
      return;
    }
    try {
      dbSetChatBrains(req.params.id, brainIds);
      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg.startsWith('chat not found')) {
        res.status(404).json({ error: 'Chat not found.' });
        return;
      }
      console.error('setChatBrains failed:', err);
      res.status(500).json({ error: 'Failed to set chat brains.' });
    }
  });
}
