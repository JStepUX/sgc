// ============================================================
// RETRIEVAL EVAL — PROBE TABLE
//
// Each probe is a declarative assertion over searchScored against
// one of the FIXTURES in fixtures.ts.  Two expectations:
//
//   'pass'      — expectTurns must surface; forbidTurns must not.
//   'known-gap' — expectTurns must NOT surface (documents a real
//                 engine limitation; failing this assertion means
//                 the gap closed — promote to 'pass').
//
// Probes run with production defaults (excludeLastN: 4, topK: 3,
// threshold: 0.08) unless params explicitly overrides a boundary.
//
// Category coverage (one probe minimum per category):
//   • exact-term recall
//   • multi-word topical recall
//   • false-positive guard
//   • time-intent anchoring
//   • default recency tiebreak
//   • concept rescue
//   • gated exclusion
//   • timeless ranking
//   • buffer exclusion
//   • synonymy ledger (known-gap)
// ============================================================

import { FIXTURES } from './fixtures';

export interface Probe {
  /** Unique id used as the Vitest test name.  Pattern: '<fixture>.<category>'. */
  id: string;
  fixture: keyof typeof FIXTURES;
  query: string;
  /**
   * 1-based turnIndex values that SHOULD appear in results.
   * For 'known-gap' probes these are the turns expected NOT to surface.
   */
  expectTurns: number[];
  /** turnIndexes that MUST NOT appear in results (any expectation). */
  forbidTurns?: number[];
  /**
   * 1-based turnIndex that must be the TOP-RANKED result (got[0]). Set this on
   * probes whose category contract is ORDERING (time-intent anchoring, default
   * recency) — membership assertions alone let a rank regression pass, and the
   * aggregate MRR ratchet absorbs a single slip to rank 2-3 without failing.
   * Only meaningful with expectation 'pass'.
   */
  expectTopTurn?: number;
  expectation: 'pass' | 'known-gap';
  /** Why this probe exists, or what limitation it documents. */
  note?: string;
  /** Override production params to test a specific boundary. */
  params?: { topK?: number; threshold?: number; excludeLastN?: number };
}

// ---- topical fixture turn map (for readability) ----
// turn 1  entries [0,1]   gardening / compost
// turn 2  entries [2,3]   gardening / browns-greens
// turn 3  entries [4,5]   PLANTED: Maren glassblowing Tacoma
// turn 4  entries [6,7]   chess / knights / pawns
// turn 5  entries [8,9]   chess / Sicilian / opening
// turn 6  entries [10,11] baking / sourdough
// turn 7  entries [12,13] baking / bulk-ferment
// turn 8  entries [14,15] PLANTED: refractor telescope
// turn 9  entries [16,17] BUFFER: eyepiece / Saturn / magnification
// turn 10 entries [18,19] BUFFER: turbulence / refractor

// ---- temporal fixture turn map ----
// turn 1  entries [0,1]   daysAgo(30)  terracotta / kiln
// turn 2  entries [2,3]   daysAgo(20)  celestial / sextant (filler)
// turn 3  entries [4,5]   daysAgo(7)   adhesive / substrate
// turn 4  entries [6,7]   daysAgo(5)   knitting / needles (filler)
// turn 5  entries [8,9]   daysAgo(1)   bathroom / grout
// turn 6  entries [10,11] BUFFER: podcast / microphone
// turn 7  entries [12,13] BUFFER: audio / noise

// ---- gated fixture turn map ----
// turn 1  entries [0,1]   GATED (active:false): Maren glassblowing Tacoma
// turn 2  entries [2,3]   plumbing / faucet
// turn 3  entries [4,5]   typography / serif
// turn 4  entries [6,7]   hiking / alpine
// turn 5  entries [8,9]   BUFFER: waterproof boots
// turn 6  entries [10,11] BUFFER: trekking poles

// ---- timeless fixture turn map ----
// turn 1  entries [0,1]   TIMELESS: Persimmon hyperthyroidism methimazole
// turn 2  entries [2,3]   cycling / derailleur
// turn 3  entries [4,5]   painting / primer
// turn 4  entries [6,7]   fermentation / kimchi
// turn 5  entries [8,9]   photography / shutter
// turn 6  entries [10,11] BUFFER: camera lens cleaning
// turn 7  entries [12,13] BUFFER: mirrorless vs DSLR

// ---- synonymy fixture turn map ----
// turn 1  entries [0,1]   PLANTED: bistro
// turn 2  entries [2,3]   origami / paper (filler)
// turn 3  entries [4,5]   PLANTED: manager / budget
// turn 4  entries [6,7]   aquarium / water (filler)
// turn 5  entries [8,9]   PLANTED: Subaru / oil
// turn 6  entries [10,11] yoga / back
// turn 7  entries [12,13] BUFFER: miso soup
// turn 8  entries [14,15] BUFFER: miso paste

export const PROBES: Probe[] = [

  // ============================================================
  // CATEGORY: exact-term recall
  // Distinctive low-frequency proper noun from a planted fact.
  // ============================================================

  {
    id: 'topical.exact-sister-name',
    fixture: 'topical',
    query: 'Maren',
    expectTurns: [3],
    expectation: 'pass',
    note: "Proper noun 'Maren' appears only in turn 3; IDF weight is maximal.",
  },

  {
    id: 'topical.exact-city-glassblowing',
    fixture: 'topical',
    query: 'Tacoma glassblowing',
    expectTurns: [3],
    expectation: 'pass',
    note: "Both 'Tacoma' and 'glassblowing' are unique to turn 3; co-occurrence raises cosine score.",
  },

  // ============================================================
  // CATEGORY: multi-word topical recall
  // No single rare term carries it — multiple ordinary terms
  // must co-occur.
  // ============================================================

  {
    id: 'topical.multi-word-glassblowing-classes',
    fixture: 'topical',
    query: 'glassblowing classes teaching craft',
    expectTurns: [3],
    expectation: 'pass',
    note: 'Multi-word query across the planted fact; teaches/students/craft vocabulary.',
  },

  {
    id: 'topical.multi-word-telescope-stargazing',
    fixture: 'topical',
    query: 'refractor telescope stargazing bought',
    expectTurns: [8],
    expectation: 'pass',
    note: 'Turn 8 is the second planted detail (refractor telescope); this is another searchable turn.',
  },

  // ============================================================
  // CATEGORY: false-positive guard
  // Topic never mentioned anywhere in the fixture.
  // ============================================================

  {
    id: 'topical.false-positive-origami',
    fixture: 'topical',
    query: 'origami paper folding',
    expectTurns: [],
    forbidTurns: [1, 2, 3, 4, 5, 6, 7, 8],
    expectation: 'pass',
    note: 'Origami never appears in topical fixture; result set must be empty.',
  },

  {
    id: 'temporal.false-positive-cycling',
    fixture: 'temporal',
    query: 'bicycle derailleur chain sprocket',
    expectTurns: [],
    forbidTurns: [1, 2, 3, 4, 5],
    expectation: 'pass',
    note: 'Cycling not in temporal fixture; empty result required.',
  },

  // ============================================================
  // CATEGORY: time-intent anchoring
  // A query with a temporal phrase should rank the turn from the
  // matching time window above turns from other windows.
  // ============================================================

  {
    id: 'temporal.time-intent-yesterday-bathroom',
    fixture: 'temporal',
    query: 'what did I say yesterday about tiling the bathroom',
    expectTurns: [5],
    expectTopTurn: 5,
    expectation: 'pass',
    note: "Intent anchor ~daysAgo(1); turn 5 (bathroom/grout, daysAgo(1)) should outrank turn 3 (adhesive, daysAgo(7)) and turn 1 (kiln, daysAgo(30)) by combined score.",
  },

  // ============================================================
  // CATEGORY: default recency tiebreak
  // No time phrase → recent topical turn beats older topical turn
  // when cosine scores are similar.
  // ============================================================

  {
    id: 'temporal.default-recency-ceramic-tile',
    fixture: 'temporal',
    query: 'ceramic tile',
    expectTurns: [5],
    expectTopTurn: 5,
    expectation: 'pass',
    note: "No time intent; turn 5 (daysAgo(1)) should have the highest combined score because default recency decay favours it over turns 3 (daysAgo(7)) and 1 (daysAgo(30)).",
  },

  // ============================================================
  // CATEGORY: concept rescue
  // Strong 30-day-old match survives WITHOUT a time phrase.
  // The rescue gate (conceptScore >= CONCEPT_RESCUE_THRESHOLD)
  // keeps old relevant content reachable.
  // ============================================================

  {
    id: 'temporal.concept-rescue-kiln-terracotta',
    fixture: 'temporal',
    query: 'kiln terracotta tile',
    expectTurns: [1],
    expectation: 'pass',
    note: "Turn 1 (daysAgo(30)) carries the only kiln/terracotta vocabulary. Combined score may be low but conceptScore >= 0.08 rescues it through CONCEPT_RESCUE_THRESHOLD.",
  },

  // ============================================================
  // CATEGORY: gated exclusion
  // A turn with active:false on both halves must NEVER surface,
  // even on a perfect-match query.
  // ============================================================

  {
    id: 'gated.exact-match-excluded',
    fixture: 'gated',
    query: 'Maren glassblowing Tacoma',
    expectTurns: [],
    forbidTurns: [1],
    expectation: 'pass',
    note: 'Turn 1 has active:false on both halves; the gated turn must not appear regardless of query specificity.',
  },

  // ============================================================
  // CATEGORY: timeless ranking
  // Manual memory (timeless:true) surfaces on concept despite
  // extreme age (365 days), because timeScore is forced to 1.0.
  // ============================================================

  {
    id: 'timeless.ancient-fact-surfaces',
    fixture: 'timeless',
    query: 'Persimmon hyperthyroidism medication',
    expectTurns: [1],
    expectation: 'pass',
    note: "Turn 1 is timeless:true at daysAgo(365). timeScore is forced to 1.0 so combined = conceptScore, which should clear the threshold on distinctive vocabulary.",
  },

  {
    id: 'timeless.methimazole-exact',
    fixture: 'timeless',
    query: 'methimazole cat thyroid',
    expectTurns: [1],
    expectation: 'pass',
    note: "'methimazole' is unique to the timeless turn; IDF is maximal, timeless=true pins timeScore to 1.0.",
  },

  // ============================================================
  // CATEGORY: buffer exclusion
  // A fact INSIDE the local-buffer tail must not surface from
  // the grep tier — that's the no-double-dip invariant.
  // ============================================================

  {
    id: 'topical.buffer-exclusion-saturn',
    fixture: 'topical',
    query: 'Saturn rings eyepiece magnification',
    expectTurns: [],
    forbidTurns: [9, 10],
    expectation: 'pass',
    note: "Turns 9 and 10 are inside the last-4 buffer; searchScored must not return them even though Saturn/eyepiece/magnification vocabulary is unique to those turns.",
  },

  {
    id: 'temporal.buffer-exclusion-podcast',
    fixture: 'temporal',
    query: 'microphone podcast home recording condenser',
    expectTurns: [],
    forbidTurns: [6, 7],
    expectation: 'pass',
    note: "Turns 6 and 7 are in the buffer; podcast/microphone vocabulary is unique to those turns, so the result set must be empty.",
  },

  // ============================================================
  // CATEGORY: synonymy ledger (known-gap)
  // TF-IDF has no vocabulary bridge. Queries in synonym
  // vocabulary must NOT match planted facts in different words.
  // When one of these starts passing it means vocabulary bridging
  // has been added — promote the probe to 'pass'.
  // ============================================================

  {
    id: 'synonymy.restaurant-for-bistro',
    fixture: 'synonymy',
    query: 'restaurant nearby ate outside',
    expectTurns: [1],
    expectation: 'known-gap',
    note: "Planted fact uses 'bistro'; query uses 'restaurant'. TF-IDF has no synonym map. Gap closed → promote to 'pass'.",
  },

  {
    id: 'synonymy.boss-for-manager',
    fixture: 'synonymy',
    query: 'boss supervisor workplace approval',
    expectTurns: [3],
    expectation: 'known-gap',
    note: "Planted fact uses 'manager'; query uses 'boss' and 'supervisor'. Synonym gap — no vocabulary bridge in TF-IDF. Gap closed → promote to 'pass'.",
  },

  {
    id: 'synonymy.car-for-subaru',
    fixture: 'synonymy',
    query: 'car vehicle maintenance service',
    expectTurns: [5],
    expectation: 'known-gap',
    note: "Planted fact uses 'Subaru'; query uses 'car' and 'vehicle'. TF-IDF has no brand-to-category bridge. Gap closed → promote to 'pass'.",
  },
];
