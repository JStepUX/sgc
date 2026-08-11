// Behavioral tests for the ephemeral-tangent boundary helpers (spec 04).
// Uses an in-memory SQLite (SGC_DB_PATH=':memory:') so the suite never touches
// the real data/sgc.db — same harness as db.test.ts; the env is set BEFORE the
// dynamic import because db.ts opens its connection at module load.
//
// The load-bearing claims pinned here: the boundary is ordinal-stable (manual
// prepends can't move or cross it), a discard deletes exactly the non-timeless
// tail, resolution is idempotent-safe (a stale second resolve refuses), and
// none of the lifecycle bumps updated_at.

import { beforeAll, describe, expect, it } from 'vitest';

let dbmod: typeof import('./db');
let tangentmod: typeof import('./db-tangent');
let seq = 0;
const newChatId = () => `tangent-chat-${++seq}`;

const pair = (n: number) => ({
  user: { content: `question ${n}` },
  assistant: { content: `answer ${n}`, inspectorJson: null },
});

beforeAll(async () => {
  process.env.SGC_DB_PATH = ':memory:';
  dbmod = await import('./db');
  tangentmod = await import('./db-tangent');
});

describe('beginTangent', () => {
  it('stamps MAX(ordinal) as the boundary and surfaces it on the detail payload', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    dbmod.saveTurnPair(id, pair(1));
    dbmod.saveTurnPair(id, pair(2)); // ordinals 1..4

    expect(tangentmod.beginTangent(id)).toBe(4);
    expect(dbmod.loadChat(id)?.tangentStart).toBe(4);
  });

  it('refuses an empty chat (D3 — no ghost titles from a wiped first turn)', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    expect(tangentmod.beginTangent(id)).toBe(null);
    expect(dbmod.loadChat(id)?.tangentStart).toBeNull();
  });

  it('refuses while a tangent is already open, leaving the boundary unchanged', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    dbmod.saveTurnPair(id, pair(1));
    expect(tangentmod.beginTangent(id)).toBe(2);
    dbmod.saveTurnPair(id, pair(2)); // a tangent turn lands…
    expect(tangentmod.beginTangent(id)).toBe(null); // …no nesting (D3)
    expect(dbmod.loadChat(id)?.tangentStart).toBe(2);
  });

  it('throws for an unknown chat (mirrors saveTurnPair)', () => {
    expect(() => tangentmod.beginTangent('does-not-exist')).toThrow(/chat not found/);
  });

  it('every pre-tangent chat reads as "no tangent" (migration default)', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    expect(dbmod.loadChat(id)?.tangentStart).toBeNull();
  });
});

describe('resolveTangent — canon', () => {
  it('clears the boundary and deletes nothing (turns were canon-shaped all along)', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    dbmod.saveTurnPair(id, pair(1));
    tangentmod.beginTangent(id);
    dbmod.saveTurnPair(id, pair(2));

    expect(tangentmod.resolveTangent(id, 'canon')).toBe(true);
    const detail = dbmod.loadChat(id)!;
    expect(detail.tangentStart).toBeNull();
    expect(detail.turns.map((t) => t.content)).toEqual([
      'question 1', 'answer 1', 'question 2', 'answer 2',
    ]);
  });
});

describe('resolveTangent — discard', () => {
  it('deletes exactly the tail past the boundary and clears the column', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    dbmod.saveTurnPair(id, pair(1));
    tangentmod.beginTangent(id);
    dbmod.saveTurnPair(id, pair(2));
    dbmod.saveTurnPair(id, pair(3));

    expect(tangentmod.resolveTangent(id, 'discard')).toBe(true);
    const detail = dbmod.loadChat(id)!;
    expect(detail.tangentStart).toBeNull();
    expect(detail.turns.map((t) => t.content)).toEqual(['question 1', 'answer 1']);
    // Survivors keep strict user/assistant alternation (the cosine engine's
    // standing assumption).
    expect(detail.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
  });

  it('spares a manual memory prepended DURING the tangent (lands below the boundary — the D2 ordinal-stability claim, tested not trusted)', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    dbmod.saveTurnPair(id, pair(1));
    tangentmod.beginTangent(id); // boundary = 2
    dbmod.saveTurnPair(id, pair(2)); // tangent pair, ordinals 3,4
    dbmod.prependManualTurnPair(id, {
      user: { content: 'remember this' },
      assistant: { content: 'remembered' },
    }); // curation mid-tangent — prepends below min, survives a wipe (D6)

    expect(tangentmod.resolveTangent(id, 'discard')).toBe(true);
    const turns = dbmod.loadChat(id)!.turns;
    expect(turns.map((t) => t.content)).toEqual([
      'remember this', 'remembered', 'question 1', 'answer 1',
    ]);
  });

  it('spares a timeless row even if one somehow sits past the boundary (defense-in-depth guard in the DELETE itself)', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    dbmod.saveTurnPair(id, pair(1));
    tangentmod.beginTangent(id); // boundary = 2
    // No public path lands a timeless row past the boundary — force one with
    // raw SQL to prove the mutation-level guard holds without the UI's help.
    dbmod.db.prepare(
      `INSERT INTO turns (chat_id, ordinal, role, content, created_at, inspector_json, active, timeless)
       VALUES (?, 99, 'user', 'forced timeless', 0, NULL, 1, 1)`,
    ).run(id);
    dbmod.saveTurnPair(id, pair(2)); // ordinals 100,101 (past the forced row)

    expect(tangentmod.resolveTangent(id, 'discard')).toBe(true);
    const contents = dbmod.loadChat(id)!.turns.map((t) => t.content);
    expect(contents).toContain('forced timeless');
    expect(contents).not.toContain('question 2');
  });

  it('refuses when no tangent is open, and a stale second resolve refuses (no double delete)', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    dbmod.saveTurnPair(id, pair(1));
    expect(tangentmod.resolveTangent(id, 'discard')).toBe(false);

    tangentmod.beginTangent(id);
    dbmod.saveTurnPair(id, pair(2));
    expect(tangentmod.resolveTangent(id, 'discard')).toBe(true);
    expect(tangentmod.resolveTangent(id, 'discard')).toBe(false);
    expect(dbmod.loadChat(id)!.turns.length).toBe(2);
  });

  it('returns false for an unknown chat', () => {
    expect(tangentmod.resolveTangent('does-not-exist', 'canon')).toBe(false);
  });
});

describe('tangent lifecycle vs updated_at', () => {
  it('neither begin nor either resolve outcome bumps updated_at (curation, not activity)', () => {
    const id = newChatId();
    dbmod.createChat(id, null, null);
    dbmod.saveTurnPair(id, pair(1));
    const before = dbmod.db.prepare(`SELECT updated_at FROM chats WHERE id = ?`).get(id) as { updated_at: number };

    tangentmod.beginTangent(id);
    tangentmod.resolveTangent(id, 'canon');
    tangentmod.beginTangent(id);
    tangentmod.resolveTangent(id, 'discard');

    const after = dbmod.db.prepare(`SELECT updated_at FROM chats WHERE id = ?`).get(id) as { updated_at: number };
    expect(after.updated_at).toBe(before.updated_at);
  });
});
