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
