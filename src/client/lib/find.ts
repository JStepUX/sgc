// FIND IN THREAD — the literal Ctrl-F. A case-insensitive SUBSTRING scan over
// the loaded thread, exhaustive by construction: every message containing the
// text is a match, in thread order. Deliberately not the grep (time-score.ts):
// that ranks the best few candidates by concept; this one answers "show me
// every place this string appears" and nothing cleverer. No model, no index,
// no scoring.

/** Indexes (into `messages`) of every message containing `query`, ascending. */
export function findMatches(messages: readonly { content: string }[], query: string): number[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const out: number[] = [];
  messages.forEach((m, i) => {
    if (m.content.toLowerCase().includes(needle)) out.push(i);
  });
  return out;
}

/**
 * Where the active match sits within `count` matches, given the stored cursor
 * (null = "the newest"). -1 only when there are no matches: a cursor that is
 * stale for the CURRENT result set — out of range, or left over from a moment
 * with no matches at all — resolves to a valid match, never to "0 of 1". The
 * result set changes under a fixed query whenever the thread does (a chat
 * switch, a new turn), so the cursor can't be trusted to fit it.
 */
export function resolveActive(cursor: number | null, count: number): number {
  if (count === 0) return -1;
  if (cursor === null || cursor < 0) return count - 1;
  return Math.min(cursor, count - 1);
}

/** Step through `count` matches with wrap-around. -1 when there are none. */
export function stepMatch(current: number, count: number, dir: 1 | -1): number {
  if (count === 0) return -1;
  return (current + dir + count) % count;
}
