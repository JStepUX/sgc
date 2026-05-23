// Behavioral tests for the time formatters. Pure functions over (ts, now),
// so every test pins both for determinism.

import { formatTimestamp, formatRelative } from './format-time';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('formatTimestamp', () => {
  // Pin "now" to a known weekday so the past-week branch is deterministic.
  // 2026-05-23 is a Saturday.
  const now = new Date(2026, 4, 23, 14, 30); // 23 May 2026, 14:30 local

  it('renders today as a 12-hour time-of-day', () => {
    const ts = new Date(2026, 4, 23, 9, 5).getTime();
    expect(formatTimestamp(ts, now)).toBe('9:05 AM');
  });

  it('renders today afternoon with PM', () => {
    const ts = new Date(2026, 4, 23, 17, 0).getTime();
    expect(formatTimestamp(ts, now)).toBe('5:00 PM');
  });

  it('renders yesterday as "Yesterday"', () => {
    const ts = new Date(2026, 4, 22, 23, 59).getTime();
    expect(formatTimestamp(ts, now)).toBe('Yesterday');
  });

  it('renders within the past week as a weekday short name', () => {
    // 4 days back from Saturday → Tuesday
    const ts = new Date(2026, 4, 19, 12, 0).getTime();
    expect(formatTimestamp(ts, now)).toBe('Tue');
  });

  it('renders older this year as "Mon DD"', () => {
    const ts = new Date(2026, 0, 15, 12, 0).getTime();
    // toLocaleDateString varies by locale; assert the substring shape rather
    // than the exact formatting.
    const out = formatTimestamp(ts, now);
    expect(out).toMatch(/Jan/);
    expect(out).toMatch(/15/);
    expect(out).not.toMatch(/2026/);
  });

  it('renders older prior year with the year included', () => {
    const ts = new Date(2025, 5, 1, 12, 0).getTime();
    const out = formatTimestamp(ts, now);
    expect(out).toMatch(/Jun/);
    expect(out).toMatch(/2025/);
  });
});

describe('formatRelative', () => {
  const now = new Date(2026, 4, 23, 14, 30).getTime();

  it('returns "just now" for < 60 seconds', () => {
    expect(formatRelative(now - 30_000, now)).toBe('just now');
  });

  it('returns minutes for < 60 minutes', () => {
    expect(formatRelative(now - 5 * 60_000, now)).toBe('5 min ago');
  });

  it('returns hours for < 24 hours', () => {
    expect(formatRelative(now - 3 * HOUR, now)).toBe('3 hr ago');
  });

  it('returns "yesterday" for 1 calendar day back', () => {
    // 26 hours earlier → calendar day diff = 1 → "yesterday"
    expect(formatRelative(now - 26 * HOUR, now)).toBe('yesterday');
  });

  it('returns "N days ago" for 2-6 calendar days back', () => {
    expect(formatRelative(now - 3 * DAY, now)).toBe('3 days ago');
    expect(formatRelative(now - 6 * DAY, now)).toBe('6 days ago');
  });

  it('falls through to a short date for ≥ 7 days back', () => {
    const ts = new Date(2026, 4, 1, 12, 0).getTime(); // 22 days back from May 23
    const out = formatRelative(ts, now);
    expect(out).toMatch(/may/);
    expect(out).toMatch(/1/);
  });

  it('clamps future timestamps to "just now"', () => {
    expect(formatRelative(now + 5_000, now)).toBe('just now');
  });

  it('is anchored on calendar days, not raw 24h windows', () => {
    // 11pm yesterday → 9am today is < 24h but crosses one calendar boundary.
    // The < 24h branch reports "10 hr ago" — that's the documented behavior,
    // since "yesterday" only kicks in once the elapsed time exceeds a day.
    // This test pins that boundary so a future tweak doesn't accidentally
    // shift it without an intentional choice.
    const yesterdayLate = new Date(2026, 4, 22, 23, 0).getTime();
    expect(formatRelative(yesterdayLate, now)).toBe('15 hr ago');
  });
});
