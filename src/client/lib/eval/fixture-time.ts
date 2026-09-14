// ============================================================
// RETRIEVAL EVAL — PINNED CLOCK
//
// The fixed "now" every fixture and probe is measured from, plus the
// two offset helpers. Split out of fixtures.ts so sibling fixture files
// (fixtures-summaries.ts) can share it without a module cycle: a cycle
// would have a fixture module building its log before FIXED_NOW's const
// initialised (temporal dead zone), which fails at import time.
// ============================================================

// ---- Pinned reference instant -------------------------------------

/**
 * A fixed epoch-ms value used as "now" throughout every probe.
 * 2026-06-09 00:00:00 UTC — matches spec date; deliberately not
 * Date.now() so the suite is time-invariant.
 */
export const FIXED_NOW: number = 1780963200000; // 2026-06-09T00:00:00.000Z

// ---- Time helpers -------------------------------------------------

/** Epoch-ms for a moment `d` whole days before FIXED_NOW. */
export function daysAgo(d: number): number {
  return FIXED_NOW - d * 24 * 60 * 60 * 1000;
}

/** Epoch-ms for a moment `h` whole hours before FIXED_NOW. */
export function hoursAgo(h: number): number {
  return FIXED_NOW - h * 60 * 60 * 1000;
}
