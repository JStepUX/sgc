// Behavioral tests for the prompt-version DB helpers — the edit history of a
// chat's persona. Uses an in-memory SQLite (SGC_DB_PATH=':memory:') so the suite
// never touches the real data/sgc.db. The env is set BEFORE the dynamic import
// below because db.ts opens its connection at module load from that var.
//
// The append logic has real branching worth pinning: first-edit baseline
// seeding, monotonic forward-only numbering, and the live-persona mirror that
// keeps the buildPrompt path in sync with the head version.

import { beforeAll, describe, expect, it } from 'vitest';

let dbmod: typeof import('./db');
let seq = 0;
const newChatId = () => `chat-${++seq}`;

beforeAll(async () => {
  process.env.SGC_DB_PATH = ':memory:';
  dbmod = await import('./db');
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
