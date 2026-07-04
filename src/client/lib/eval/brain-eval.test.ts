// ============================================================
// BRAIN RETRIEVAL EVAL — PROBE SUITE (the knowledge axis)
//
// Sibling of retrieval-eval.test.ts, aimed at searchBrains over the COMMITTED
// Atlantis fixture pack (fixtures/brain-fixture.json — 3 stub-built documents,
// 8 chunks, hand-authored aliases on each document's intro chunk). Same
// ledger discipline as the memory suite:
//
//   'pass'      — expectChunks must surface; forbidChunks must not.
//   'known-gap' — expectChunks must NOT surface (documents the lexical
//                 engine's synonymy limit; failing means the gap closed —
//                 promote to 'pass' and investigate what bridged it).
//
// The alias-bridge category is THE load-bearing one: it proves the pack's
// hand-authored aliases repair the cross-author vocabulary gap. Per AGENTS.md,
// zero-shared-vocabulary is measured on STEMS: an alias-bridge query must
// share no stem with any chunk's text/summary/topics — only with an alias.
//
// Determinism: the index is a pure function of the pack; no Date.now() here.
// ============================================================

import { describe, it, expect } from 'vitest';
import { buildBrainIndex, searchBrains } from '../brains';
import type { BrainPack } from '../types';
import { recallAtK, mrr } from './metrics';
import brainFixtureJson from './fixtures/brain-fixture.json';

const FIXTURE_PACK = brainFixtureJson as BrainPack;
const INDEX = buildBrainIndex([FIXTURE_PACK]);

// ---- Ratchet baselines (set just below measured values at implementation
//      time, mirroring the memory suite's convention) ----
// Measured 2026-07-04 (suite created): recall@3 = 1.000, MRR = 1.000 over the
// 8 pass-probes. Ratchet at 0.90 allows one probe to slip a rank after engine
// tuning without failing, but catches widespread regressions.
const RATCHET_RECALL_AT_3 = 0.90;
const RATCHET_MRR         = 0.90;

interface BrainProbe {
  id: string;
  query: string;
  /** Chunk ids that SHOULD surface ('pass') or must NOT ('known-gap'). */
  expectChunks: string[];
  forbidChunks?: string[];
  expectation: 'pass' | 'known-gap';
  note?: string;
}

// ---- fixture chunk map (for readability) ----
// couscous-recipe_000            intro + ingredients  · aliases: maftoul, ptitim
// couscous-recipe_001            method
// kimura-grip-mechanics_000      intro / wrist control · aliases: ude-garami, hammerlock
// kimura-grip-mechanics_001      breaking the grip / elbow drive
// kimura-grip-mechanics_002      finishing / rotation
// minnesota-facts_000            intro / Twin Cities   · aliases: gopher-state, l-etoile-du-nord
// minnesota-facts_001            geography / lakes / Itasca
// minnesota-facts_002            climate / icebox

const PROBES: BrainProbe[] = [

  // ============================================================
  // CATEGORY: direct-term recall — the chunk's own vocabulary.
  // ============================================================

  {
    id: 'brain.direct-kimura-wristlock',
    query: 'kimura double wristlock closed guard',
    expectChunks: ['kimura-grip-mechanics_000'],
    expectation: 'pass',
    note: 'Distinctive vocabulary of the kimura intro chunk.',
  },
  {
    id: 'brain.direct-elbow-drive',
    query: 'drive the elbow toward the far hip to isolate the shoulder',
    expectChunks: ['kimura-grip-mechanics_001'],
    expectation: 'pass',
    note: 'Section-specific vocabulary — must hit the grip-breaking chunk, not just the doc intro.',
  },
  {
    id: 'brain.direct-lake-itasca',
    query: 'Mississippi river Lake Itasca lakes',
    expectChunks: ['minnesota-facts_001'],
    expectation: 'pass',
    note: 'Geography chunk vocabulary.',
  },
  {
    id: 'brain.direct-couscous-steam',
    query: 'pour boiling stock over couscous and cover',
    expectChunks: ['couscous-recipe_001'],
    expectation: 'pass',
    note: 'Method-chunk vocabulary (fluff, absorb, steam).',
  },

  // ============================================================
  // CATEGORY: alias-bridge recall — query shares ZERO stems with any
  // chunk text/summary/topics; the hit rides the hand-authored alias
  // alone (spec D2/D9 — the deterministic synonym bridge).
  // ============================================================

  {
    id: 'brain.alias-ude-garami',
    query: 'ude garami hammerlock',
    expectChunks: ['kimura-grip-mechanics_000'],
    expectation: 'pass',
    note: 'The judo/catch-wrestling names for the same lock — present only in the alias.',
  },
  {
    id: 'brain.alias-etoile-du-nord',
    query: 'etoile du nord gopher',
    expectChunks: ['minnesota-facts_000'],
    expectation: 'pass',
    note: 'State nicknames — present only in the alias. (The tokenizer drops the 2-char "du".)',
  },
  {
    id: 'brain.alias-maftoul',
    query: 'maftoul ptitim',
    expectChunks: ['couscous-recipe_000'],
    expectation: 'pass',
    note: 'Levantine/Israeli names for couscous-like pastas — present only in the alias.',
  },

  // ============================================================
  // CATEGORY: false-positive guard.
  // ============================================================

  {
    id: 'brain.false-positive-astronomy',
    query: 'telescope nebula astronomy stargazing',
    expectChunks: [],
    forbidChunks: FIXTURE_PACK.chunks.map((c) => c.id),
    expectation: 'pass',
    note: 'Astronomy appears nowhere in the fixture corpus; the result set must be empty.',
  },

  // ============================================================
  // CATEGORY: synonymy ledger (known-gap) — a synonym absent from
  // text AND aliases must not match. When one of these passes, a
  // vocabulary bridge appeared somewhere — promote and investigate.
  // ============================================================

  {
    id: 'brain.gap-armlock-for-kimura',
    query: 'armlock submission wrestling',
    expectChunks: ['kimura-grip-mechanics_000'],
    expectation: 'known-gap',
    note: "The kimura IS an armlock/submission, but neither word (nor a shared stem) appears in the chunk text or its aliases — the lexical engine cannot know. Closing this without a hand-authored alias means something non-lexical entered retrieval: investigate before celebrating.",
  },
  {
    id: 'brain.gap-casserole-for-hotdish',
    query: 'hotdish casserole cuisine',
    expectChunks: ['minnesota-facts_000', 'minnesota-facts_001', 'minnesota-facts_002'],
    expectation: 'known-gap',
    note: 'Deeply Minnesotan vocabulary the fixture corpus never uses — cultural association is exactly what a lexical engine cannot bridge (and what an alias could, deliberately).',
  },
];

// ============================================================
// The alias-bridge zero-vocabulary invariant, checked structurally: every
// alias-bridge query stem must be absent from every chunk's text+summary+topics
// surface and present in at least one alias. This is what keeps the category
// honest — a probe that quietly overlaps chunk text would pass without the
// bridge (the 2026-06-09 'approval'/'approved' lesson, now measured on stems).
// ============================================================

import { tokenize } from '../tfidf';

const ALIAS_PROBE_IDS = ['brain.alias-ude-garami', 'brain.alias-etoile-du-nord', 'brain.alias-maftoul'];

describe('alias-bridge probes share zero stems with chunk content', () => {
  const contentStems = new Set(
    FIXTURE_PACK.chunks.flatMap((c) =>
      tokenize(`${c.text} ${c.summary} ${c.topics.join(' ')}`),
    ),
  );
  const aliasStems = new Set(FIXTURE_PACK.chunks.flatMap((c) => tokenize(c.aliases.join(' '))));

  for (const id of ALIAS_PROBE_IDS) {
    const probe = PROBES.find((p) => p.id === id)!;
    it(`${id}: query stems live in aliases only`, () => {
      const queryStems = tokenize(probe.query);
      expect(queryStems.length).toBeGreaterThan(0);
      for (const stem of queryStems) {
        expect(contentStems.has(stem), `stem "${stem}" leaks into chunk content — not a pure alias bridge`).toBe(false);
        expect(aliasStems.has(stem), `stem "${stem}" is not in any alias — the probe could never hit`).toBe(true);
      }
    });
  }
});

// ============================================================
// PER-PROBE TESTS
// ============================================================

function runProbe(probe: BrainProbe): string[] {
  return searchBrains(probe.query, INDEX).map((r) => r.chunkId);
}

describe('brain retrieval probes', () => {
  for (const probe of PROBES) {
    it(probe.id, () => {
      const got = runProbe(probe);

      if (probe.expectation === 'pass') {
        for (const id of probe.expectChunks) {
          expect(
            got,
            `[${probe.id}] expected chunk ${id} to surface — query: "${probe.query}"`,
          ).toContain(id);
        }
        for (const id of probe.forbidChunks ?? []) {
          expect(
            got,
            `[${probe.id}] chunk ${id} must NOT surface — query: "${probe.query}"`,
          ).not.toContain(id);
        }
      } else {
        for (const id of probe.expectChunks) {
          expect(
            got,
            `[${probe.id}] gap closed — chunk ${id} now surfaces; promote this probe to 'pass' and investigate the bridge — query: "${probe.query}"`,
          ).not.toContain(id);
        }
      }
    });
  }
});

// ============================================================
// AGGREGATE TEST — RATCHET BASELINES
// ============================================================

describe('brain aggregate metrics (ratchet)', () => {
  it('recall@3 and MRR over pass-probes meet ratchet baselines', () => {
    const passProbes = PROBES.filter((p) => p.expectation === 'pass');
    const rows = passProbes.map((probe) => {
      const got = runProbe(probe);
      // Metrics are defined over turn indexes in metrics.ts; map chunk ids to
      // positional numbers so the same functions apply unchanged.
      const idOf = new Map(FIXTURE_PACK.chunks.map((c, i) => [c.id, i + 1]));
      return {
        id: probe.id,
        recall: recallAtK(probe.expectChunks.map((c) => idOf.get(c)!), got.map((c) => idOf.get(c)!)),
        mrr: mrr(probe.expectChunks.map((c) => idOf.get(c)!), got.map((c) => idOf.get(c)!)),
        got,
      };
    });

    console.table(rows.map((r) => ({ probe: r.id, recall: r.recall.toFixed(2), mrr: r.mrr.toFixed(2), got: r.got.join(',') })));

    const avgRecall = rows.reduce((s, r) => s + r.recall, 0) / (rows.length || 1);
    const avgMrr    = rows.reduce((s, r) => s + r.mrr,    0) / (rows.length || 1);
    console.log(`\nBrain aggregate recall@3: ${avgRecall.toFixed(3)}  MRR: ${avgMrr.toFixed(3)}`);

    expect(avgRecall, `recall@3 ${avgRecall.toFixed(3)} fell below ratchet ${RATCHET_RECALL_AT_3}`).toBeGreaterThanOrEqual(RATCHET_RECALL_AT_3);
    expect(avgMrr, `MRR ${avgMrr.toFixed(3)} fell below ratchet ${RATCHET_MRR}`).toBeGreaterThanOrEqual(RATCHET_MRR);
  });
});
