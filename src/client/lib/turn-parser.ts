// ============================================================
// TURN-RESPONSE PARSER — the read half of the prompt contract.
//
// buildPrompt (lib/prompt.ts) writes the <turn-summary> contract into the
// system prompt; this module reads Sal's side of it back out: splitting a
// finished reply into display text + the trailing summary block, and hiding
// the block (and partial opening tags) while a reply is still streaming.
// Split from prompt.ts by the anti-god-object ratchet — builder and parser
// are one contract but two concerns.
//
// Sal's turn summary is delimited by an explicit <turn-summary>…
// </turn-summary> tag pair rather than a ```json fence. The tags are
// unambiguous: the streaming UI can hide the block the instant the opening
// tag appears (see stripStreamingMeta), and the parser never has to guess
// which fenced block is the summary versus an example block inside Sal's
// prose. The block runs fresh every turn and is NOT fed back into the next
// prompt — it's a per-turn observation surface, not accumulated memory.
// ============================================================

import type { TurnSummary } from './types';

/** Delimiters wrapping Sal's trailing turn-summary block. */
export const META_OPEN = '<turn-summary>';
export const META_CLOSE = '</turn-summary>';

/** Result of splitting a raw turn response into prose + the turn summary. */
export interface ParsedTurn {
  displayText: string;
  summary: TurnSummary | null;
}

/**
 * Coerce one parsed JSON field into a clean string[] — drop non-strings, trim,
 * drop empties. Missing or non-array input yields []. This keeps a malformed
 * single list from failing the whole summary parse.
 */
function toStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Coerce a parsed JSON value into a TurnSummary, or null if it isn't one.
 * Accepted only if it looks like a summary — at least one of the three known
 * keys present — so a stray JSON object in prose isn't mistaken for the block.
 */
function coerceSummary(parsed: unknown): TurnSummary | null {
  if (parsed === null || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (!('persistent' in o || 'volatile' in o || 'established_patterns' in o)) return null;
  return {
    persistent: toStringList(o.persistent),
    volatile: toStringList(o.volatile),
    established_patterns: toStringList(o.established_patterns),
  };
}

/**
 * Complete a truncated JSON fragment: close an unterminated string, drop a
 * dangling trailing comma, then close every bracket/brace still open. Purely
 * mechanical — if the result still doesn't parse, the caller cuts the fragment
 * back to its last structural boundary and tries once more.
 */
function completeJson(s: string): string {
  const closers: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') closers.push('}');
    else if (ch === '[') closers.push(']');
    else if (ch === '}' || ch === ']') closers.pop();
  }
  let out = s;
  if (inString) out += '"';
  out = out.replace(/,\s*$/, '');
  for (let i = closers.length - 1; i >= 0; i--) out += closers[i];
  return out;
}

/** Unwrap a ```-fenced body (```json … ```), tolerant of a missing closing fence. */
function unwrapFence(s: string): string {
  if (!s.startsWith('```')) return s;
  return s.replace(/^```[a-zA-Z]*[ \t]*\r?\n?/, '').replace(/\r?\n?```\s*$/, '');
}

/**
 * Try hard to read a summary out of a block body. Strict parse first — the
 * compliant path never gets reinterpreted — then progressively lenient
 * recoveries for the ways a small local model borks the block: JSON wrapped in
 * a code fence despite instructions, output truncated mid-string / mid-list
 * (the token cap), or cut off mid-key. Deterministic string surgery only — no
 * model in the loop. Returns null when hopeless.
 */
function tryParseSummary(slice: string): TurnSummary | null {
  const attempts: string[] = [];
  const push = (s: string) => {
    if (s && !attempts.includes(s)) attempts.push(s);
  };
  const t = slice.trim();
  push(t);
  const u = unwrapFence(t);
  push(u);
  push(completeJson(u));
  // Last resort: a cut mid-key can't be string-closed into valid JSON — drop
  // the truncated tail fragment back to the last structural boundary and
  // complete from there, salvaging the lists that DID finish.
  const cut = Math.max(u.lastIndexOf(','), u.lastIndexOf('['), u.lastIndexOf('{'));
  if (cut > 0) push(completeJson(u.slice(0, u[cut] === ',' ? cut : cut + 1)));
  for (const candidate of attempts) {
    try {
      const summary = coerceSummary(JSON.parse(candidate));
      if (summary) return summary;
    } catch {
      /* try the next, more lenient candidate */
    }
  }
  return null;
}

/**
 * Split a completed turn response into display text and the trailing
 * turn-summary block.
 *
 * The summary payload is free-form strings, which may THEMSELVES contain the
 * literal tags (e.g. a value like "asked about <turn-summary> tags", or a
 * mention of "</turn-summary>"). So neither a naive `lastIndexOf(open)` nor a
 * `indexOf(close, open)` is safe — either could anchor *inside* the JSON string
 * and corrupt the parse, leaving the raw block visible in the finalized message.
 *
 * Clean path:
 *  - Anchor the CLOSE on the LAST `</turn-summary>` (the block is always trailing
 *    and must end the response). A literal close inside a string can't be the
 *    last one, so it never truncates the block.
 *  - Find the OPEN by scanning `<turn-summary>` candidates front-to-back and
 *    accepting the FIRST whose slice to that close reads as a summary
 *    (strict-first, see tryParseSummary). The real opener is the earliest one
 *    whose slice is the JSON: a prose mention before it doesn't parse, and an
 *    inner-string occurrence after it doesn't either.
 *
 * Borked-block salvage (small local models routinely truncate the block at the
 * token cap or malform its JSON; the raw leak used to be hand-deleted from the
 * chat): when no clean trailing block resolves but the model DID open a
 * JSON-bearing block (`{` or nothing follows the tag — the same rule
 * stripStreamingMeta streams by, so prose mentions of the tag stay visible),
 * the tagged region is stripped from display unconditionally and whatever
 * summary repairs out of it is salvaged. Display never shows a borked block;
 * streaming and finalized views now agree.
 */
export function parseTurnResponse(raw: string): ParsedTurn {
  const close = raw.lastIndexOf(META_CLOSE);

  // Clean trailing block: a close tag ends the response.
  if (close !== -1 && raw.slice(close + META_CLOSE.length).trim() === '') {
    for (let from = 0; ; ) {
      const open = raw.indexOf(META_OPEN, from);
      if (open === -1 || open >= close) break;
      const summary = tryParseSummary(raw.slice(open + META_OPEN.length, close));
      if (summary) return { displayText: raw.slice(0, open).trim(), summary };
      from = open + META_OPEN.length;
    }
  }

  // Borked-block salvage: first JSON-bearing opener wins; the region through
  // the close tag (or to the end when the close never arrived) is stripped.
  // Prose after a closed-but-malformed block survives on the far side.
  for (let from = 0; ; ) {
    const open = raw.indexOf(META_OPEN, from);
    if (open === -1 || (close !== -1 && open >= close)) break;
    const rest = raw.slice(open + META_OPEN.length);
    if (/^\s*\{/.test(rest) || /^\s*$/.test(rest)) {
      const hasClose = close > open;
      const summary = tryParseSummary(
        raw.slice(open + META_OPEN.length, hasClose ? close : raw.length),
      );
      if (!summary) console.warn('Unparseable turn-summary block — stripped from display');
      const before = raw.slice(0, open).trim();
      const after = hasClose ? raw.slice(close + META_CLOSE.length).trim() : '';
      return { displayText: after ? `${before}\n\n${after}` : before, summary };
    }
    from = open + META_OPEN.length;
  }

  return { displayText: raw, summary: null };
}

/**
 * Trim a partial, mid-stream turn response down to just the prose safe to show.
 *
 * While Sal's reply streams in token by token, the trailing <turn-summary> block
 * would otherwise flicker into the chat bubble before the turn completes. This
 * drops everything from that block's opening tag onward — and also holds back a
 * trailing *partial* of the tag, since `<turn-summary>` can arrive split across
 * SSE chunks (`<turn-` in one chunk, `summary>` in the next).
 *
 * Crucially, only a *JSON-bearing* <turn-summary> is the block: Sal may
 * legitimately mention the tag in prose ("I emit a <turn-summary> block"), and
 * that mention must stay visible — which keeps this consistent with
 * parseTurnResponse, which likewise only treats a JSON block as the summary. A
 * mention is followed by words; the real block is followed by `{`. Once the
 * turn finishes, call parseTurnResponse on the full raw text for the
 * authoritative split.
 */
export function stripStreamingMeta(partial: string): string {
  for (let from = 0; ;) {
    const open = partial.indexOf(META_OPEN, from);
    if (open === -1) break;
    const after = partial.slice(open + META_OPEN.length);
    // `{` → the JSON block has started. All-whitespace (including empty) → the
    // block almost certainly just opened and its `{` is still streaming in.
    // Either way, hide from here. Anything else is a prose mention of the tag —
    // skip it and keep looking for the real block.
    if (/^\s*\{/.test(after) || /^\s*$/.test(after)) {
      return partial.slice(0, open).replace(/\s+$/, '');
    }
    from = open + META_OPEN.length;
  }

  // No opening tag yet — hold back any trailing suffix that could be the start
  // of one, so a tag split across SSE chunks never half-leaks into the bubble.
  for (let n = META_OPEN.length - 1; n > 0; n--) {
    if (partial.endsWith(META_OPEN.slice(0, n))) {
      return partial.slice(0, partial.length - n);
    }
  }
  return partial;
}
