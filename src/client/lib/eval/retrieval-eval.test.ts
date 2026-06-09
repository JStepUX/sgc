// ============================================================
// RETRIEVAL EVAL — PROBE SUITE
//
// Drives the PROBES table in probes.ts through the real
// searchScored orchestrator with production params.
//
// Two kinds of test:
//   1. One it() per probe (name = probe.id).
//   2. One aggregate it() that computes recall@3 and MRR over
//      the 'pass' probes, console.tables the breakdown, and
//      asserts the ratchet baselines recorded in
//      implementation_notes of the spec YAML.
//
// Determinism guarantee: every searchScored call injects
// FIXED_NOW as `now`.  No Date.now() in this suite.
// ============================================================

import { describe, it, expect } from 'vitest';
import { searchScored } from '../time-score';
import { FIXED_NOW, FIXTURES } from './fixtures';
import { recallAtK, mrr } from './metrics';
import { PROBES, type Probe } from './probes';
import { LOCAL_BUFFER_SIZE } from '../constants';

// ---- Production defaults (mirror SalienceGatedCognition.tsx) ----
const PROD_EXCLUDE_LAST_N = LOCAL_BUFFER_SIZE; // 4
const PROD_TOP_K          = 3;
const PROD_THRESHOLD      = 0.08;

// ---- Ratchet baselines (set just below measured values at
//      implementation time — see implementation_notes in spec) ----
// Measured 2026-06-09: recall@3 = 1.000, MRR = 1.000 (14 pass-probes, all hit).
// Ratchet set at 0.90 — allows one probe to regress (e.g. after engine tuning)
// without failing the suite, but catches widespread regressions.
const RATCHET_RECALL_AT_3 = 0.90;
const RATCHET_MRR         = 0.90;

// ============================================================
// HELPERS
// ============================================================

function runProbe(probe: Probe) {
  const fixture = FIXTURES[probe.fixture];
  const params = {
    excludeLastN: probe.params?.excludeLastN ?? PROD_EXCLUDE_LAST_N,
    topK:         probe.params?.topK         ?? PROD_TOP_K,
    threshold:    probe.params?.threshold    ?? PROD_THRESHOLD,
  };
  const results = searchScored(probe.query, fixture.log, FIXED_NOW, params);
  return results.map((r) => r.turnIndex);
}

// ============================================================
// METRICS UNIT TESTS
// ============================================================

describe('metrics', () => {
  describe('recallAtK', () => {
    it('returns 1 when all expected turns are present', () => {
      expect(recallAtK([1, 2], [1, 2, 3])).toBeCloseTo(1);
    });

    it('returns 0.5 when half of expected turns are present', () => {
      expect(recallAtK([1, 2], [2, 3])).toBeCloseTo(0.5);
    });

    it('returns 0 when no expected turns are present', () => {
      expect(recallAtK([1, 2], [3, 4])).toBe(0);
    });

    it('returns 1 vacuously for empty expected list', () => {
      expect(recallAtK([], [1, 2])).toBe(1);
    });
  });

  describe('mrr', () => {
    it('returns 1 when the first expected turn is rank-1', () => {
      expect(mrr([1], [1, 2, 3])).toBeCloseTo(1);
    });

    it('returns 0.5 when the first expected turn is rank-2', () => {
      expect(mrr([2], [1, 2, 3])).toBeCloseTo(0.5);
    });

    it('returns 1/3 when the first expected turn is rank-3', () => {
      expect(mrr([3], [1, 2, 3])).toBeCloseTo(1 / 3);
    });

    it('returns 0 when no expected turn is present', () => {
      expect(mrr([5], [1, 2, 3])).toBe(0);
    });

    it('returns 1 vacuously for empty expected list', () => {
      expect(mrr([], [1, 2, 3])).toBe(1);
    });
  });
});

// ============================================================
// PER-PROBE TESTS
// ============================================================

describe('retrieval probes', () => {
  for (const probe of PROBES) {
    it(probe.id, () => {
      const got = runProbe(probe);

      if (probe.expectation === 'pass') {
        // Every expected turn must surface.
        for (const ti of probe.expectTurns) {
          expect(
            got,
            `[${probe.id}] expected turnIndex ${ti} to surface — query: "${probe.query}"`,
          ).toContain(ti);
        }
        // No forbidden turn must surface.
        for (const ti of probe.forbidTurns ?? []) {
          expect(
            got,
            `[${probe.id}] turnIndex ${ti} must NOT surface — query: "${probe.query}"`,
          ).not.toContain(ti);
        }
      } else {
        // 'known-gap': expected turns must NOT be present.
        for (const ti of probe.expectTurns) {
          expect(
            got,
            `[${probe.id}] gap closed — turnIndex ${ti} now surfaces; promote this probe from 'known-gap' to 'pass' — query: "${probe.query}"`,
          ).not.toContain(ti);
        }
      }
    });
  }
});

// ============================================================
// AGGREGATE TEST — RATCHET BASELINES
// ============================================================

describe('aggregate metrics (ratchet)', () => {
  it('recall@3 and MRR over pass-probes meet ratchet baselines', () => {
    const passProbes = PROBES.filter((p) => p.expectation === 'pass');

    interface Row {
      id: string;
      recall: number;
      mrr: number;
      got: number[];
    }
    const rows: Row[] = [];

    for (const probe of passProbes) {
      const got = runProbe(probe);
      rows.push({
        id: probe.id,
        recall: recallAtK(probe.expectTurns, got),
        mrr: mrr(probe.expectTurns, got),
        got,
      });
    }

    // Breakdown visible under --reporter=verbose or on failure.
    console.table(
      rows.map((r) => ({
        probe:  r.id,
        recall: r.recall.toFixed(2),
        mrr:    r.mrr.toFixed(2),
        got:    r.got.join(','),
      })),
    );

    const avgRecall = rows.reduce((s, r) => s + r.recall, 0) / (rows.length || 1);
    const avgMrr    = rows.reduce((s, r) => s + r.mrr,    0) / (rows.length || 1);

    console.log(`\nAggregate recall@3: ${avgRecall.toFixed(3)}  MRR: ${avgMrr.toFixed(3)}`);
    console.log(`Ratchet  recall@3: ${RATCHET_RECALL_AT_3}     MRR: ${RATCHET_MRR}`);

    expect(
      avgRecall,
      `recall@3 ${avgRecall.toFixed(3)} fell below ratchet ${RATCHET_RECALL_AT_3}`,
    ).toBeGreaterThanOrEqual(RATCHET_RECALL_AT_3);

    expect(
      avgMrr,
      `MRR ${avgMrr.toFixed(3)} fell below ratchet ${RATCHET_MRR}`,
    ).toBeGreaterThanOrEqual(RATCHET_MRR);
  });
});
