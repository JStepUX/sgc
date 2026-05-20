// ============================================================
// PROMPT BUILDER + RESPONSE PARSER
//
// buildPrompt assembles the three memory tiers (constitutional memories,
// local buffer, cosine-grep results) into the single system prompt handed to
// Sal. parseTurnResponse splits Sal's reply into display text + the trailing
// metadata block.
//
// Sal's confidence-score metadata is delimited by an explicit <turn-meta>…
// </turn-meta> tag pair rather than a ```json fence. The tags are unambiguous:
// the streaming UI can hide the block the instant the opening tag appears
// (see stripStreamingMeta), and the parser never has to guess which fenced
// block is metadata versus an example block inside Sal's prose.
// ============================================================

import type { Memory, ChatEntry } from './types';
import type { GrepResult } from './tfidf';
import { estimateTokens } from './tokens';

/** The metadata block Sal appends to every response. */
export interface TurnMetadata {
  confidence_scores: Record<string, number>;
}

/** Delimiters wrapping Sal's trailing metadata block. */
export const META_OPEN = '<turn-meta>';
export const META_CLOSE = '</turn-meta>';

/** Result of splitting a raw turn response into prose + metadata. */
export interface ParsedTurn {
  displayText: string;
  metadata: TurnMetadata | null;
}

export function buildPrompt(
  memories: Memory[],
  localBuffer: ChatEntry[],
  grepResults: GrepResult[] | null,
): string {
  const memBlock = memories
    .map((m, i) => `  [M${i + 1}] (confidence: ${m.confidence}%) ${m.text}`)
    .join('\n');

  let localBlock = '';
  if (localBuffer.length > 0) {
    localBlock = `\nRECENT CONTEXT (last exchange):\n${localBuffer
      .map((e) => `  ${e.role}: ${e.content}`)
      .join('\n')}`;
  }

  let grepBlock = '';
  if (grepResults && grepResults.length > 0) {
    const fragments = grepResults
      .map(
        (r) =>
          `  [Turn ${r.turnIndex}] User: ${r.userContent}\n  [Turn ${r.turnIndex}] Assistant: ${r.assistContent}`,
      )
      .join('\n\n');
    grepBlock = `\nRETRIEVED HISTORY (cosine similarity match):\n${fragments}`;
  }

  const hasBuffer = localBuffer.length > 0;
  const hasGrep = (grepResults?.length ?? 0) > 0;

  return `You are Sal — an ephemeral reasoning instance. You exist for exactly one turn, then you are retired. You have no memory of prior conversations. You will never exist again.

You know the user through constitutional memories — distilled, curated knowledge about who they are. These memories have confidence scores reflecting how consistently they've held across prior exchanges.

CONSTITUTIONAL MEMORIES:
${memBlock}
${localBlock}
${grepBlock}

YOUR TASK:
1. Respond to the user's input naturally and helpfully, informed by the memories${hasBuffer ? ', recent context' : ''}${hasGrep ? ', and retrieved history' : ''}.
2. After your response, output a JSON metadata block.

CONFIDENCE SCORING:
- For each memory, assess: did this exchange provide evidence for or against it?
- If irrelevant to a memory, return its current score unchanged.
- If reinforced, nudge upward (max +5 per turn).
- If contradicted, nudge downward (max -5 per turn).
- Scores clamp between 0 and 100. Be conservative. Most turns leave most scores unchanged.

OUTPUT FORMAT — you MUST end your response with a <turn-meta> block:

<turn-meta>
{
  "confidence_scores": {
    "M1": 50,
    "M2": 55,
    "M3": 48
  }
}
</turn-meta>

IMPORTANT: The <turn-meta> block must be the very last thing in your response. Natural language first, then the block. Write the raw JSON directly between the tags — do NOT wrap it in code fences. The tags let the UI hide the metadata while your reply streams in.`;
}

/**
 * Estimate the token count of the *naive* counterfactual prompt: persona +
 * memories + the FULL chat history + this turn's user input — i.e. what we
 * would have sent if we weren't doing SGC's tiered curation.
 *
 * The actual SGC prompt only carries the last 2 turns (local buffer) plus
 * any cosine-grep matches — typically a tiny fraction of `chatLog`. The
 * difference between this number and `usage.input_tokens` is the savings the
 * inspector tile surfaces.
 *
 * Implementation note: reuses `buildPrompt` with the entire chat log fed in
 * as the "local buffer" position. The block ends up labelled "RECENT
 * CONTEXT" in the rendered prompt — semantically loose, but for token
 * counting the label is a fixed ~30 chars in the noise of a multi-thousand-
 * char prompt. Reusing the real builder is worth the inaccuracy because it
 * guarantees the persona/memory framing stays in sync if `buildPrompt`
 * changes.
 */
export function estimateNaiveContextTokens(
  memories: Memory[],
  fullChatLog: ChatEntry[],
  userInput: string,
): number {
  const naiveSystem = buildPrompt(memories, fullChatLog, null);
  return estimateTokens(naiveSystem) + estimateTokens(userInput);
}

/**
 * Split a completed turn response into display text and the trailing metadata
 * block.
 *
 * Sal is instructed to end every response with a <turn-meta> block, so this
 * anchors on the *last* opening tag — not the first. (Sal's natural-language
 * answer may itself mention the tag; matching the first occurrence could
 * mis-parse that mention as metadata and truncate the visible answer at it.)
 * The block is only treated as metadata if it sits at the very end of the
 * response AND carries a `confidence_scores` object; anything else is left
 * intact as display text.
 */
export function parseTurnResponse(raw: string): ParsedTurn {
  const open = raw.lastIndexOf(META_OPEN);
  if (open === -1) return { displayText: raw, metadata: null };

  const close = raw.indexOf(META_CLOSE, open + META_OPEN.length);
  if (close === -1) return { displayText: raw, metadata: null };

  // Require the block to be the last thing in the response — text after the
  // closing tag means this isn't a clean trailing metadata block.
  if (raw.slice(close + META_CLOSE.length).trim() !== '') {
    return { displayText: raw, metadata: null };
  }

  try {
    const parsed: unknown = JSON.parse(raw.slice(open + META_OPEN.length, close));
    if (parsed !== null && typeof parsed === 'object' && 'confidence_scores' in parsed) {
      const scores = (parsed as Record<string, unknown>).confidence_scores;
      if (scores !== null && typeof scores === 'object') {
        return { displayText: raw.slice(0, open).trim(), metadata: parsed as TurnMetadata };
      }
    }
  } catch (e) {
    console.warn('Failed to parse turn metadata:', e);
  }

  // No valid trailing metadata — treat the whole response as display text
  // rather than risk truncating it at a stray tag mention.
  return { displayText: raw, metadata: null };
}

/**
 * Trim a partial, mid-stream turn response down to just the prose safe to show.
 *
 * While Sal's reply streams in token by token, the trailing <turn-meta> block
 * would otherwise flicker into the chat bubble before the turn completes. This
 * drops everything from that block's opening tag onward — and also holds back a
 * trailing *partial* of the tag, since `<turn-meta>` can arrive split across
 * SSE chunks (`<turn-` in one chunk, `meta>` in the next).
 *
 * Crucially, only a *JSON-bearing* <turn-meta> is the metadata block: Sal may
 * legitimately mention the tag in prose ("I emit a <turn-meta> block"), and
 * that mention must stay visible — which keeps this consistent with
 * parseTurnResponse, which likewise only treats a JSON block as metadata. A
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
