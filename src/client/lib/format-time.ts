// ============================================================
// TIME FORMATTING — shared between the history list, the chat memory editor,
// and the cosine-grep prompt block. Pure functions over a timestamp + an
// injectable "now" for deterministic tests.
//
// formatTimestamp is the relative-then-absolute pattern previously inline in
// ChatHistoryModal (lifted here so all three consumers share one implementation).
// formatRelative is its compact sibling — short, prose-shaped strings suitable
// for inline metadata ("3 hr ago", "yesterday") that Sal can read naturally.
// ============================================================

const MS_PER_MIN = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MIN;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * History-style stamp: time-of-day for today, "Yesterday", weekday for the
 * past week, "Mon DD" for this year, "Mon DD, YYYY" for older.
 *
 * Pulled verbatim from the inline helper that lived in ChatHistoryModal so the
 * history list, the rail row, and any future caller share one source.
 */
export function formatTimestamp(ts: number, now: Date): string {
  const d = new Date(ts);
  const today = startOfDay(now);
  if (ts >= today) {
    const h = d.getHours();
    const m = d.getMinutes();
    const meridiem = h >= 12 ? 'PM' : 'AM';
    const h12 = ((h + 11) % 12) + 1;
    return `${h12}:${m.toString().padStart(2, '0')} ${meridiem}`;
  }
  if (ts >= today - MS_PER_DAY) return 'Yesterday';
  if (ts >= today - 6 * MS_PER_DAY) return WEEKDAY[d.getDay()];
  // Older: short date, no year unless not-this-year.
  const sameYear = d.getFullYear() === now.getFullYear();
  return sameYear
    ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Compact relative form for inline metadata: "just now" / "5 min ago" /
 * "3 hr ago" / "yesterday" / "3 days ago", falling back to formatTimestamp's
 * short date for anything ≥ 7 days old. Lowercase so it slots cleanly into
 * Sal's prompt and the memory editor's quiet meta row.
 *
 * `now` is an epoch ms (matches the timestamp shape on the wire) — `formatTimestamp`
 * takes a Date because it was lifted unchanged. Both signatures are intentional.
 */
export function formatRelative(ts: number, now: number): string {
  const diff = Math.max(0, now - ts); // future timestamps clamp to "just now"
  if (diff < MS_PER_MIN) return 'just now';
  if (diff < MS_PER_HOUR) {
    const m = Math.floor(diff / MS_PER_MIN);
    return `${m} min ago`;
  }
  if (diff < MS_PER_DAY) {
    const h = Math.floor(diff / MS_PER_HOUR);
    return `${h} hr ago`;
  }
  // Day-level: by here at least 24h has elapsed (the < MS_PER_DAY branch above
  // already handled the within-24h case as "N hr ago", regardless of calendar
  // boundary — so a turn from 11pm yesterday at 9am today reads "10 hr ago",
  // not "yesterday"). Once we're past 24h, calendar-day arithmetic decides the
  // wording so a turn from 25h ago reads "yesterday" rather than "1 day ago".
  const nowDay = startOfDay(new Date(now));
  const tsDay = startOfDay(new Date(ts));
  const daysOff = Math.round((nowDay - tsDay) / MS_PER_DAY);
  if (daysOff <= 1) return 'yesterday';
  if (daysOff < 7) return `${daysOff} days ago`;
  // ≥ 7 days: hand off to the absolute formatter so the prompt prefix and the
  // editor meta row read identically for older turns.
  return formatTimestamp(ts, new Date(now)).toLowerCase();
}
