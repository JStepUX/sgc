// Behavioral tests for the prompt-version DB helpers — the edit history of a
// chat's persona. Uses an in-memory SQLite (SGC_DB_PATH=':memory:') so the suite
// never touches the real data/sgc.db. The env is set BEFORE the dynamic import
// below because db.ts opens its connection at module load from that var.
//
// The append logic has real branching worth pinning: first-edit baseline
// seeding, monotonic forward-only numbering, and the live-persona mirror that
// keeps the buildPrompt path in sync with the head version.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { beforeAll, describe, expect, it, vi } from 'vitest';

let dbmod: typeof import('./db');
let brainsmod: typeof import('./db-brains');
let seq = 0;
const newChatId = () => `chat-${++seq}`;

beforeAll(async () => {
  process.env.SGC_DB_PATH = ':memory:';
  dbmod = await import('./db');
  brainsmod = await import('./db-brains');
});

describe('prompt versions', () => {
  it('starts empty; a default chat resolves persona null with no versions', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    const detail = dbmod.loadChat(id);
    expect(detail?.persona).toBeNull();
    expect(detail?.versions).toEqual([]);
    expect(dbmod.getPromptVersions(id)).toEqual([]);
  });

  it('freezes the baseline as v1 and lands the edit as v2 on the first save', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    const versions = dbmod.appendPromptVersion(id, 'edited prompt', 'BASELINE');
    // Newest-first: v2 (the edit) then v1 (the frozen baseline).
    expect(versions.map((v) => v.n)).toEqual([2, 1]);
    expect(versions[0].text).toBe('edited prompt');
    expect(versions[1].text).toBe('BASELINE');
    // The live persona mirrors the new head, so the next prompt build uses it.
    expect(dbmod.loadChat(id)?.persona).toBe('edited prompt');
  });

  it('numbers forward-only and ignores baselineText once versions exist', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    dbmod.appendPromptVersion(id, 'v2 text', 'BASELINE'); // seeds v1 + v2
    const after = dbmod.appendPromptVersion(id, 'v3 text', 'IGNORED'); // baseline ignored
    expect(after.map((v) => v.n)).toEqual([3, 2, 1]);
    expect(after.map((v) => v.text)).toEqual(['v3 text', 'v2 text', 'BASELINE']);
    // The second baseline must NOT be re-seeded — only one baseline ever exists.
    expect(after.some((v) => v.text === 'IGNORED')).toBe(false);
  });

  it('seeds no phantom baseline when none is provided', () => {
    const id = newChatId();
    dbmod.createChat(id, 'custom persona', null);
    const versions = dbmod.appendPromptVersion(id, 'first edit'); // no baselineText
    expect(versions.map((v) => v.n)).toEqual([1]);
    expect(versions[0].text).toBe('first edit');
    expect(dbmod.loadChat(id)?.persona).toBe('first edit');
  });

  it('cascades versions away when the chat is deleted', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    dbmod.appendPromptVersion(id, 'edited', 'BASELINE');
    expect(dbmod.getPromptVersions(id).length).toBe(2);
    dbmod.deleteChat(id);
    expect(dbmod.getPromptVersions(id)).toEqual([]);
  });

  it('throws for an unknown chat', () => {
    expect(() => dbmod.appendPromptVersion('does-not-exist', 'x')).toThrow(/chat not found/);
  });
});

describe('saveTurnPair', () => {
  it('returns the two new row ids, matching the persisted turns', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    const ids = dbmod.saveTurnPair(id, {
      user: { content: 'hello' },
      assistant: { content: 'hi there', inspectorJson: null },
    });
    expect(Number.isInteger(ids.userId)).toBe(true);
    expect(Number.isInteger(ids.assistantId)).toBe(true);
    expect(ids.userId).not.toBe(ids.assistantId);

    const turns = dbmod.loadChat(id)!.turns;
    const user = turns.find((t) => t.role === 'user')!;
    const assistant = turns.find((t) => t.role === 'assistant')!;
    expect(user.id).toBe(ids.userId);
    expect(assistant.id).toBe(ids.assistantId);
  });
});

describe('deleteLatestTurnPair (turn undo)', () => {
  const pair = (n: number) => ({
    user: { content: `question ${n}` },
    assistant: { content: `answer ${n}`, inspectorJson: null },
  });

  it('deletes the latest pair and leaves earlier turns intact', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    dbmod.saveTurnPair(id, pair(1));
    const ids2 = dbmod.saveTurnPair(id, pair(2));
    expect(dbmod.deleteLatestTurnPair(id, ids2.assistantId)).toBe(true);
    const turns = dbmod.loadChat(id)!.turns;
    expect(turns.map((t) => t.content)).toEqual(['question 1', 'answer 1']);
  });

  it('undoes repeatedly, back to an empty chat', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    const ids1 = dbmod.saveTurnPair(id, pair(1));
    const ids2 = dbmod.saveTurnPair(id, pair(2));
    expect(dbmod.deleteLatestTurnPair(id, ids2.assistantId)).toBe(true);
    expect(dbmod.deleteLatestTurnPair(id, ids1.assistantId)).toBe(true);
    expect(dbmod.loadChat(id)!.turns).toEqual([]);
  });

  it('refuses a stale assistant id (a newer turn landed since) and deletes nothing', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    const ids1 = dbmod.saveTurnPair(id, pair(1));
    dbmod.saveTurnPair(id, pair(2));
    expect(dbmod.deleteLatestTurnPair(id, ids1.assistantId)).toBe(false);
    expect(dbmod.loadChat(id)!.turns.length).toBe(4);
  });

  it('refuses the user half\'s id — only the latest ASSISTANT id addresses the pair', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    const ids = dbmod.saveTurnPair(id, pair(1));
    expect(dbmod.deleteLatestTurnPair(id, ids.userId)).toBe(false);
    expect(dbmod.loadChat(id)!.turns.length).toBe(2);
  });

  it('refuses a chat whose only turns are timeless manual memories', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    dbmod.prependManualTurnPair(id, {
      user: { content: 'remember this' },
      assistant: { content: 'remembered' },
    });
    const assistantRow = dbmod.loadChat(id)!.turns.find((t) => t.role === 'assistant')!;
    expect(dbmod.deleteLatestTurnPair(id, assistantRow.id)).toBe(false);
    expect(dbmod.loadChat(id)!.turns.length).toBe(2);
  });

  it('never touches manual memories below a streamed pair being undone', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    dbmod.prependManualTurnPair(id, {
      user: { content: 'remember this' },
      assistant: { content: 'remembered' },
    });
    const ids = dbmod.saveTurnPair(id, pair(1));
    expect(dbmod.deleteLatestTurnPair(id, ids.assistantId)).toBe(true);
    const turns = dbmod.loadChat(id)!.turns;
    expect(turns.map((t) => t.content)).toEqual(['remember this', 'remembered']);
  });

  it('returns false for an unknown chat', () => {
    expect(dbmod.deleteLatestTurnPair('does-not-exist', 1)).toBe(false);
  });
});

describe('updateTurnContent', () => {
  it('rewrites content while preserving created_at and ordinal', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    const { assistantId } = dbmod.saveTurnPair(id, {
      user: { content: 'q' },
      assistant: { content: 'original answer', inspectorJson: '{"summary":null}' },
    });
    const before = dbmod.loadChat(id)!.turns.find((t) => t.id === assistantId)!;

    const ok = dbmod.updateTurnContent(id, assistantId, 'edited answer');
    expect(ok).toBe(true);

    const after = dbmod.loadChat(id)!.turns.find((t) => t.id === assistantId)!;
    expect(after.content).toBe('edited answer');
    // Editing is curation of an existing turn — the recency/order anchors hold.
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.ordinal).toBe(before.ordinal);
    // inspectorJson absent in the call → blob untouched.
    expect(after.inspectorJson).toBe('{"summary":null}');
  });

  it('overwrites inspector_json when provided (string or null)', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    const { assistantId } = dbmod.saveTurnPair(id, {
      user: { content: 'q' },
      assistant: { content: 'a', inspectorJson: '{"summary":{"persistent":["x"],"volatile":[],"established_patterns":[]}}' },
    });

    dbmod.updateTurnContent(id, assistantId, 'a2', '{"summary":null}');
    expect(dbmod.loadChat(id)!.turns.find((t) => t.id === assistantId)!.inspectorJson).toBe('{"summary":null}');

    dbmod.updateTurnContent(id, assistantId, 'a3', null);
    expect(dbmod.loadChat(id)!.turns.find((t) => t.id === assistantId)!.inspectorJson).toBeNull();
  });

  it('is chat-scoped: a turn id from another chat is not rewritten', () => {
    const a = newChatId();
    const b = newChatId();
    dbmod.createChat(a, null, null);
    dbmod.createChat(b, null, null);
    const { assistantId } = dbmod.saveTurnPair(a, {
      user: { content: 'q' },
      assistant: { content: 'a-answer', inspectorJson: null },
    });

    // Same id, wrong chat → no-op, returns false; chat a's turn is untouched.
    expect(dbmod.updateTurnContent(b, assistantId, 'hijacked')).toBe(false);
    expect(dbmod.loadChat(a)!.turns.find((t) => t.id === assistantId)!.content).toBe('a-answer');
  });

  it('returns false for an unknown turn id', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    expect(dbmod.updateTurnContent(id, 999999, 'x')).toBe(false);
  });

  it('refuses to rewrite a user row (assistant-reply editor only)', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    const { userId } = dbmod.saveTurnPair(id, {
      user: { content: 'user question' },
      assistant: { content: 'a', inspectorJson: null },
    });
    expect(dbmod.updateTurnContent(id, userId, 'hijacked user text')).toBe(false);
    expect(dbmod.loadChat(id)!.turns.find((t) => t.id === userId)!.content).toBe('user question');
  });

  it('refuses to rewrite a timeless manual memory (curated via the memory editor)', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    dbmod.prependManualTurnPair(id, {
      user: { content: 'memory q' },
      assistant: { content: 'memory a' },
    });
    const memory = dbmod.loadChat(id)!.turns.find((t) => t.role === 'assistant' && t.timeless)!;
    expect(dbmod.updateTurnContent(id, memory.id, 'rewritten memory')).toBe(false);
    expect(dbmod.loadChat(id)!.turns.find((t) => t.id === memory.id)!.content).toBe('memory a');
  });
});

describe('chat brains (mount bindings — db-brains.ts)', () => {
  it('starts empty and round-trips a mount set (sorted, deduped)', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    expect(brainsmod.getChatBrains(id)).toEqual([]);

    brainsmod.setChatBrains(id, ['zeta-brain', 'alpha-brain', 'alpha-brain']);
    expect(brainsmod.getChatBrains(id)).toEqual(['alpha-brain', 'zeta-brain']);
  });

  it('PUT semantics: setting replaces the whole mount set', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    brainsmod.setChatBrains(id, ['a', 'b']);
    brainsmod.setChatBrains(id, ['c']);
    expect(brainsmod.getChatBrains(id)).toEqual(['c']);
    brainsmod.setChatBrains(id, []);
    expect(brainsmod.getChatBrains(id)).toEqual([]);
  });

  it('throws chat-not-found for a missing chat (mirrors saveMemories)', () => {
    expect(() => brainsmod.setChatBrains('no-such-chat', ['a'])).toThrow(/chat not found/);
  });

  it('cascade, chat side: deleting a chat removes its bindings only', () => {
    const doomed = newChatId();
    const survivor = newChatId();
    dbmod.createChat(doomed, null, null);
    dbmod.createChat(survivor, null, null);
    brainsmod.setChatBrains(doomed, ['shared-brain']);
    brainsmod.setChatBrains(survivor, ['shared-brain']);

    dbmod.deleteChat(doomed);
    // Recreate the doomed id to prove its bindings are gone (not just orphaned).
    dbmod.createChat(doomed, null, null);
    expect(brainsmod.getChatBrains(doomed)).toEqual([]);
    expect(brainsmod.getChatBrains(survivor)).toEqual(['shared-brain']);
  });

  it('cascade, brain side: deleting a brain removes its bindings across ALL chats', () => {
    const one = newChatId();
    const two = newChatId();
    dbmod.createChat(one, null, null);
    dbmod.createChat(two, null, null);
    brainsmod.setChatBrains(one, ['doomed-brain', 'kept-brain']);
    brainsmod.setChatBrains(two, ['doomed-brain']);

    brainsmod.deleteBrainBindings('doomed-brain');
    expect(brainsmod.getChatBrains(one)).toEqual(['kept-brain']);
    expect(brainsmod.getChatBrains(two)).toEqual([]);
  });
});

describe('constitutional document', () => {
  it('a fresh chat starts with the empty-string default (column exists from CREATE, not ALTER)', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    expect(dbmod.loadChat(id)?.constitutional).toBe('');
  });

  it('setChatConstitutional overwrites the document; the detail payload carries it', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    dbmod.setChatConstitutional(id, 'Alex prefers async updates.\nWorks EST hours.');
    expect(dbmod.loadChat(id)?.constitutional).toBe('Alex prefers async updates.\nWorks EST hours.');

    // A second save fully replaces (no append/merge) — one column, one value.
    dbmod.setChatConstitutional(id, 'Replaced entirely.');
    expect(dbmod.loadChat(id)?.constitutional).toBe('Replaced entirely.');
  });

  it('setChatConstitutional throws for an unknown chat (mirrors dbSetChatBrains)', () => {
    expect(() => dbmod.setChatConstitutional('does-not-exist', 'x')).toThrow(/chat not found/);
  });

  it('createChat accepts an optional constitutional seed for carry-forward, defaulting to \'\' when absent', () => {
    const seeded = newChatId();
    dbmod.createChat(seeded, null, null, 'carried over from the outgoing chat');
    expect(dbmod.loadChat(seeded)?.constitutional).toBe('carried over from the outgoing chat');

    const bare = newChatId();
    dbmod.createChat(bare, null, null);
    expect(dbmod.loadChat(bare)?.constitutional).toBe('');
  });
});

// The legacy `memories` table -> chats.constitutional migration (D1 in
// docs/ignored/00_constitutional-document-spec.yaml) runs once, at module load, from
// db.ts's top-level init code — so exercising it means booting a SEPARATE
// module instance against a SEPARATE file-backed DB we've pre-seeded with the
// legacy shape (an in-memory DB can't be pre-seeded from outside: every
// `new Database(':memory:')` is its own isolated database, and the shared
// suite instance above already boot-migrated once). vi.resetModules() + a
// fresh `SGC_DB_PATH` forces db.ts's module-scope `new Database(...)` to run
// again against that file.
describe('constitutional document migration (legacy memories table)', () => {
  function seedLegacyDb(
    dbPath: string,
    extraMemories: Array<[id: string, text: string, atOffset: number]> = [],
  ): void {
    const raw = new Database(dbPath);
    // The pre-migration shape: a bare `chats` table (no persona/mask/
    // constitutional columns — those are additive ALTERs db.ts applies later)
    // and an ordinary chat-scoped `memories` table (the shape that survived
    // the original global/graded re-scope; see db.ts's migration comment).
    raw.exec(`
      CREATE TABLE chats (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_memories_chat ON memories(chat_id);
    `);
    const now = Date.now();
    raw.prepare(
      `INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).run('chat-a', 'Chat A', now, now);
    raw.prepare(
      `INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).run('chat-b', 'Chat B', now, now);
    const insertMem = raw.prepare(
      `INSERT INTO memories (id, chat_id, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    );
    // Inserted OUT of created_at order, to prove the migration sorts by
    // created_at rather than trusting row/insertion order.
    insertMem.run('m1', 'chat-a', 'second fact', now + 20, now + 20);
    insertMem.run('m2', 'chat-a', 'first fact', now + 10, now + 10);
    insertMem.run('m3', 'chat-b', 'only fact for chat b', now + 5, now + 5);
    // Chip rows were never capped, so a legacy set can aggregate past
    // MAX_CONSTITUTIONAL_CHARS — the clamp test below appends these.
    for (const [id, text, at] of extraMemories) {
      insertMem.run(id, 'chat-a', text, now + at, now + at);
    }
    raw.close();
  }

  it('folds legacy rows into chats.constitutional (per-chat, created_at ASC, newline-joined) and drops memories', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sgc-migration-'));
    const dbPath = join(dir, 'legacy.db');
    seedLegacyDb(dbPath);

    process.env.SGC_DB_PATH = dbPath;
    vi.resetModules();
    const migrated: typeof import('./db') = await import('./db');

    expect(migrated.loadChat('chat-a')?.constitutional).toBe('first fact\nsecond fact');
    expect(migrated.loadChat('chat-b')?.constitutional).toBe('only fact for chat b');

    const memoriesTable = migrated.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'`)
      .all();
    expect(memoriesTable).toEqual([]);

    process.env.SGC_DB_PATH = ':memory:';
    vi.resetModules();
  });

  it('clamps an over-cap legacy aggregate to MAX_CONSTITUTIONAL_CHARS (chip rows were uncapped; every post-migration write path rejects over-cap text, so an unclamped fold would be un-saveable and un-carry-forwardable)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sgc-migration-'));
    const dbPath = join(dir, 'legacy.db');
    // chat-a's ordinary rows ('first fact\nsecond fact') + one giant chip →
    // the joined aggregate comfortably exceeds the cap.
    seedLegacyDb(dbPath, [['m-big', 'X'.repeat(25_000), 30]]);

    process.env.SGC_DB_PATH = dbPath;
    vi.resetModules();
    const migrated: typeof import('./db') = await import('./db');

    const doc = migrated.loadChat('chat-a')?.constitutional ?? '';
    expect(doc.length).toBe(migrated.MAX_CONSTITUTIONAL_CHARS);
    // Order preserved: the clamp truncates the tail, never reorders the fold.
    expect(doc.startsWith('first fact\nsecond fact\n')).toBe(true);
    // chat-b's small set is untouched by chat-a's clamp.
    expect(migrated.loadChat('chat-b')?.constitutional).toBe('only fact for chat b');

    process.env.SGC_DB_PATH = ':memory:';
    vi.resetModules();
  });

  it('is idempotent: a second boot against the already-migrated file no-ops (no memories table left to fold)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sgc-migration-'));
    const dbPath = join(dir, 'legacy.db');
    seedLegacyDb(dbPath);

    process.env.SGC_DB_PATH = dbPath;
    vi.resetModules();
    const first: typeof import('./db') = await import('./db');
    const afterFirstBoot = first.loadChat('chat-a')?.constitutional;
    expect(afterFirstBoot).toBe('first fact\nsecond fact');

    vi.resetModules();
    const second: typeof import('./db') = await import('./db'); // re-boot, same file
    const afterSecondBoot = second.loadChat('chat-a')?.constitutional;

    expect(afterSecondBoot).toBe(afterFirstBoot);

    process.env.SGC_DB_PATH = ':memory:';
    vi.resetModules();
  });
});
