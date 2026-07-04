// Behavioral tests for the brain union index (the knowledge axis). Like the
// memory grep, this is pure deterministic math — if these break, mounted
// knowledge silently stops retrieving or stops being deterministic.

import { buildBrainDigest, buildBrainIndex, searchBrains } from './brains';
import type { BrainPack } from './types';
import { BRAIN_DIGEST_CHAR_CAP } from './constants';
import brainFixtureJson from './eval/fixtures/brain-fixture.json';

// The committed Atlantis fixture pack: 3 stub-built documents / 8 chunks,
// hand-authored aliases on each document's intro chunk (spec D9 workflow).
const fixturePack = brainFixtureJson as BrainPack;

/** A tiny synthetic second brain for union-index tests. */
function makeGlassPack(): BrainPack {
  return {
    schema: 'sgc-brain/1',
    id: 'glassblowing',
    name: 'Glassblowing Notes',
    description: 'Studio notes on working hot glass.',
    version: '1.0',
    built_at: '2026-07-04T00:00:00Z',
    source: { tool: 'atlantis', schema: 'atlantis-salience-v1', stub: true },
    chunks: [
      {
        id: 'glass_000',
        title: 'Gathering from the Furnace',
        text: 'Gathering molten glass onto the blowpipe requires steady rotation at the furnace mouth.',
        summary: 'How to gather molten glass on the blowpipe.',
        topics: ['gathering', 'furnace-work'],
        aliases: ['parison'],
        source: { file: 'raw/glass.md', doc: 'glass-notes', position: 0 },
        tokens: 20,
      },
      {
        id: 'glass_001',
        title: 'Annealing Schedules',
        text: 'Annealing relieves internal stress by holding the piece at temperature before a slow cool.',
        summary: 'Annealing basics for small pieces.',
        topics: ['annealing', 'kiln-work'],
        aliases: [],
        source: { file: 'raw/glass.md', doc: 'glass-notes', position: 1 },
        tokens: 18,
      },
    ],
  };
}

describe('the committed fixture pack', () => {
  it('matches the sgc-brain/1 contract this suite builds on', () => {
    expect(fixturePack.schema).toBe('sgc-brain/1');
    expect(fixturePack.id).toBe('brain-fixture');
    expect(fixturePack.source.stub).toBe(true);
    expect(fixturePack.chunks).toHaveLength(8);
    for (const c of fixturePack.chunks) {
      expect(c.text.length).toBeGreaterThan(0);
      expect(c.text.length).toBeLessThanOrEqual(8000);
      expect(c.title).toBeTruthy();
      expect(Array.isArray(c.topics)).toBe(true);
      expect(Array.isArray(c.aliases)).toBe(true);
    }
  });
});

describe('buildBrainIndex', () => {
  it('is deterministic: same packs produce a deeply identical index', () => {
    const a = buildBrainIndex([fixturePack, makeGlassPack()]);
    const b = buildBrainIndex([fixturePack, makeGlassPack()]);
    expect(a).toEqual(b);
  });

  it('builds ONE union index: every doc carries its mount provenance', () => {
    const index = buildBrainIndex([fixturePack, makeGlassPack()]);
    expect(index.docs).toHaveLength(10); // 8 fixture + 2 glass
    const brainIds = new Set(index.docs.map((d) => d.brainId));
    expect(brainIds).toEqual(new Set(['brain-fixture', 'glassblowing']));
    for (const doc of index.docs) {
      expect(doc.brainName).toBe(
        doc.brainId === 'brain-fixture' ? 'Fixture Corpus' : 'Glassblowing Notes',
      );
    }
  });

  it('drops chunks whose lexical surface tokenizes to nothing', () => {
    const empty: BrainPack = {
      ...makeGlassPack(),
      id: 'stopwords-only',
      chunks: [
        {
          id: 'x_000',
          title: 'Nothing',
          text: 'the and but',
          summary: '',
          topics: [],
          aliases: [],
          source: { file: 'f', doc: 'd', position: 0 },
          tokens: 3,
        },
      ],
    };
    expect(buildBrainIndex([empty]).docs).toHaveLength(0);
  });
});

describe('searchBrains', () => {
  it('retrieves by direct chunk vocabulary', () => {
    const index = buildBrainIndex([fixturePack]);
    const results = searchBrains('kimura shoulder lock from closed guard', index);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunkId).toBe('kimura-grip-mechanics_000');
    expect(results[0].brainId).toBe('brain-fixture');
    expect(results[0].title).toBe('Kimura Grip Mechanics from Closed Guard');
  });

  it('retrieves via an alias token that never appears in the chunk text', () => {
    const index = buildBrainIndex([fixturePack]);
    // 'hammerlock' exists only in the hand-authored alias of the kimura intro
    // chunk — the synonym bridge across the author gap (spec D2).
    for (const c of fixturePack.chunks) {
      expect(c.text.toLowerCase()).not.toContain('hammerlock');
    }
    const results = searchBrains('hammerlock', index);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunkId).toBe('kimura-grip-mechanics_000');
  });

  it('union IDF: a doc score shifts deterministically when the mount set changes', () => {
    const alone = buildBrainIndex([fixturePack]);
    const together = buildBrainIndex([fixturePack, makeGlassPack()]);
    const query = 'couscous with herbs';
    const scoreAlone = searchBrains(query, alone)[0]?.score;
    const scoreTogether = searchBrains(query, together)[0]?.score;
    expect(scoreAlone).toBeGreaterThan(0);
    expect(scoreTogether).toBeGreaterThan(0);
    // Rarity is measured against everything mounted, so the score moves...
    expect(scoreTogether).not.toBe(scoreAlone);
    // ...but deterministically: rebuilding reproduces it exactly.
    expect(searchBrains(query, buildBrainIndex([fixturePack, makeGlassPack()]))[0]?.score).toBe(
      scoreTogether,
    );
  });

  it('reaches across brains in one search, provenance intact', () => {
    const index = buildBrainIndex([fixturePack, makeGlassPack()]);
    const results = searchBrains('annealing molten glass on the blowpipe', index);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].brainId).toBe('glassblowing');
  });

  it('respects topK and threshold', () => {
    const index = buildBrainIndex([fixturePack]);
    const broad = searchBrains('minnesota lakes winters minneapolis', index, 2, 0);
    expect(broad.length).toBeLessThanOrEqual(2);
    const strict = searchBrains('minnesota', index, 3, 0.999);
    expect(strict).toHaveLength(0);
  });

  it('returns [] for an empty index and for a content-free query', () => {
    expect(searchBrains('anything', buildBrainIndex([]))).toEqual([]);
    const index = buildBrainIndex([fixturePack]);
    expect(searchBrains('the and but', index)).toEqual([]);
  });

  it('result text is the chunk text — summary/aliases are retrieval surface only', () => {
    const index = buildBrainIndex([fixturePack]);
    const [top] = searchBrains('hammerlock', index);
    expect(top.text).not.toContain('hammerlock');
    expect(top.text).toContain('kimura');
  });
});

describe('buildBrainDigest', () => {
  it('carries name, description, document titles, and primary topics', () => {
    const digest = buildBrainDigest(fixturePack);
    expect(digest.brainId).toBe('brain-fixture');
    expect(digest.brainName).toBe('Fixture Corpus');
    expect(digest.text).toContain('Fixture Corpus');
    expect(digest.text).toContain('Kimura Grip Mechanics from Closed Guard');
    expect(digest.text).toContain('Minnesota Facts');
    expect(digest.text).toContain('Simple Herbed Couscous');
    expect(digest.text).toContain('geography');
  });

  it('caps the digest so a fat brain cannot flood the tier', () => {
    const fat: BrainPack = {
      ...makeGlassPack(),
      id: 'fat-brain',
      chunks: Array.from({ length: 120 }, (_, i) => ({
        id: `fat_${String(i).padStart(3, '0')}`,
        title: `An Exhaustively Titled Treatise on Subject Number ${i}`,
        text: `Body ${i}.`,
        summary: '',
        topics: [`topic-number-${i}`],
        aliases: [],
        source: { file: 'f', doc: `doc-${i}`, position: i },
        tokens: 2,
      })),
    };
    const digest = buildBrainDigest(fat);
    expect(digest.text.length).toBeLessThanOrEqual(BRAIN_DIGEST_CHAR_CAP);
    expect(digest.text.endsWith('…')).toBe(true);
  });

  it('is included per mounted brain in the index, even for brains with zero retrievable chunks', () => {
    const index = buildBrainIndex([fixturePack, makeGlassPack()]);
    expect(index.digests.map((d) => d.brainId)).toEqual(['brain-fixture', 'glassblowing']);
  });
});
