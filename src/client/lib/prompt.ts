// ============================================================
// PROMPT BUILDER + RESPONSE PARSER
//
// buildPrompt assembles the three memory tiers (constitutional memories,
// local buffer, cosine-grep results) into the single system prompt handed to
// Sal. parseTurnResponse splits Sal's reply into display text + the trailing
// JSON metadata block.
// ============================================================

import type { Memory, ChatEntry } from './types';
import type { GrepResult } from './tfidf';

/** The JSON metadata block Sal appends to every response. */
export interface TurnMetadata {
  confidence_scores: Record<string, number>;
}

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

OUTPUT FORMAT — you MUST end your response with a fenced JSON block:

\`\`\`json
{
  "confidence_scores": {
    "M1": 50,
    "M2": 55,
    "M3": 48
  }
}
\`\`\`

IMPORTANT: The JSON block must be the very last thing in your response. Natural language first, then the JSON block.`;
}

/**
 * Split a raw turn response into display text and the trailing JSON metadata
 * block.
 *
 * Sal is instructed to end every response with the metadata block, so this
 * anchors on the *last* fenced ```json block — not the first. (Sal's
 * natural-language answer may itself contain an earlier JSON example; matching
 * the first block would mis-parse that example as metadata and truncate the
 * visible answer at it.) The trailing block is only treated as metadata if it
 * sits at the very end of the response AND carries a `confidence_scores`
 * object; anything else is left intact as display text.
 */
export function parseTurnResponse(raw: string): ParsedTurn {
  const blocks = [...raw.matchAll(/```json\s*([\s\S]*?)\s*```/g)];
  const last = blocks.at(-1);

  if (last) {
    const start = last.index ?? 0;
    const trailing = raw.slice(start + last[0].length).trim();
    // Require the block to be the last thing in the response.
    if (trailing === '') {
      try {
        const parsed: unknown = JSON.parse(last[1]);
        if (parsed !== null && typeof parsed === 'object' && 'confidence_scores' in parsed) {
          const scores = (parsed as Record<string, unknown>).confidence_scores;
          if (scores !== null && typeof scores === 'object') {
            return { displayText: raw.slice(0, start).trim(), metadata: parsed as TurnMetadata };
          }
        }
      } catch (e) {
        console.warn('Failed to parse turn metadata:', e);
      }
    }
  }

  // No valid trailing metadata — treat the whole response as display text
  // rather than risk truncating it at an in-answer code block.
  return { displayText: raw, metadata: null };
}
