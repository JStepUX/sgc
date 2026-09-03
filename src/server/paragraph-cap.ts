// PARAGRAPH CAP — the server half of reply pacing (client half + rationale:
// src/client/lib/pacing.ts). A reply call may carry `maxParagraphs`; this
// counter watches the visible delta stream and says STOP at the Nth paragraph
// break, so a model that ignores the ceiling it was told still ends on a
// paragraph it finished. Pure counting over blank lines — no sentence
// detection, no punctuation, no model. turn-route.ts owns the consequences
// (abort upstream, emit the done frame with stopReason 'max_paragraphs').
//
// Streaming makes one thing subtle: a break can straddle two fragments
// ("…end.\n" then "\nNext…"). The counter therefore holds back a trailing
// "\n[ \t]*" run until the next fragment says whether it completes a break;
// held whitespace is re-prepended, never lost, and `flush()` releases it at
// a natural end. Only whitespace is ever delayed — visible text streams as
// it arrives.
//
// An EMPTY paragraph never counts: a reply that opens with "\n\n", or a run of
// three newlines, is one break at most and only once real text preceded it.
// Otherwise a chatty model's blank-line habits would eat the ceiling.

/** One paragraph break: newline, optional horizontal whitespace, newline.
 *  MUST stay identical to src/client/lib/pacing.ts PARAGRAPH_BREAK — both are
 *  pinned against the same fixtures in their tests. */
export const PARAGRAPH_BREAK = /\n[ \t]*\n/g;

export interface ParagraphCap {
  /** Feed the next visible fragment. `emit` is what may go to the client now
   *  (possibly empty while whitespace is held back); `reached` flips true on
   *  the fragment that completes the Nth break — `emit` then ends on that
   *  paragraph and everything after it is dropped. Once reached, every
   *  further feed returns nothing. */
  feed(fragment: string): { emit: string; reached: boolean };
  /** Natural end of stream: release any held-back whitespace. Empty after
   *  the cap was reached (there is nothing to release past a cut). */
  flush(): string;
  /** Complete paragraphs counted so far. */
  readonly count: number;
}

export function createParagraphCap(max: number): ParagraphCap {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`paragraph cap must be a positive integer, got ${String(max)}`);
  }
  let pending = '';
  let count = 0;
  let hasContent = false; // non-whitespace seen in the paragraph in progress
  let reached = false;

  return {
    get count() {
      return count;
    },
    feed(fragment) {
      if (reached) return { emit: '', reached: true };
      const s = pending + fragment;
      pending = '';
      const re = new RegExp(PARAGRAPH_BREAK.source, 'g');
      let scanFrom = 0;
      for (let m = re.exec(s); m !== null; m = re.exec(s)) {
        if (/\S/.test(s.slice(scanFrom, m.index))) hasContent = true;
        scanFrom = m.index + m[0].length;
        if (!hasContent) continue; // empty paragraph — not a paragraph
        count += 1;
        hasContent = false;
        if (count >= max) {
          reached = true;
          return { emit: s.slice(0, m.index).replace(/[ \t]+$/, ''), reached: true };
        }
      }
      if (/\S/.test(s.slice(scanFrom))) hasContent = true;
      // Hold back a trailing newline run that the next fragment might complete
      // into a break. (If s ends exactly on a counted break, its final "\n" is
      // held too — harmless: it is re-prepended, and a break it then forms
      // sits on an empty paragraph, which never counts.)
      const hold = /\n[ \t]*$/.exec(s);
      if (hold) {
        pending = hold[0];
        return { emit: s.slice(0, hold.index), reached: false };
      }
      return { emit: s, reached: false };
    },
    flush() {
      if (reached) return '';
      const out = pending;
      pending = '';
      return out;
    },
  };
}
