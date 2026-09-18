// SIDECAR — the co-author in the rail. A second conversation that sits OUTSIDE
// the story: same transport and provider as the persona (api.ts runTurn), a
// different system prompt, and none of Sal's machinery.
//
// What it deliberately is NOT (so nobody "fixes" it into the turn pipeline):
//   - not Sal. Sal is rebuilt from curated tiers every turn and retired; the
//     sidecar is an ordinary transcript chat — its own messages ride the wire
//     whole each call. That is fine HERE because the transcript is ephemeral:
//     it lives in React state only (hooks/useSidecar.ts), is never persisted,
//     and the rail's refresh button is its only memory management.
//   - not a writer. It reads a SNAPSHOT of the story (below) and writes
//     nothing back: no turn rows, no state turn, no summaries, no sheet
//     deltas, nothing the grep will ever index. It does READ through the grep
//     — the author's message is run through searchScored like a story turn's
//     input — which is the point: an out-of-character "did X happen yet?"
//     asked here finds the turn WITHOUT becoming a canon turn itself. Ranking
//     stays pure math; no model authors the query or touches the ranking.
//   - not paced, not spontaneity-perturbed, no recall tool, no tangents.
//
// The snapshot is rebuilt from the live session on every sidecar message, so
// the collaborator always sees the story as it stands — the same "fresh
// context per call" discipline as assembleTurnContext.

import type { ChatEntry, TurnSummary } from './types';
import type { WireMessage } from './api';
import { flattenSheetForPrompt, foldSheet } from './continuity';
import { flattenStateForPrompt, newestDynamicState } from './dynamic-state';
import { DEFAULT_PERSONA, formatGrepFragment } from './prompt';
import { searchScored } from './time-score';
import { CONCEPT_ENGINE } from './constants';
import { formatNowHeader } from './format-time';

/** Verbatim story entries the sidecar reads (user+assistant pairs → 4 turns). */
export const SIDECAR_RECENT_ENTRIES = 8;
/** Distilled entries just behind the verbatim window (→ up to 8 turn summaries). */
export const SIDECAR_SUMMARY_ENTRIES = 16;
/** Ambient grep over the rest of the story, queried with the author's message. */
export const SIDECAR_GREP_TOP_K = 5;
export const SIDECAR_GREP_THRESHOLD = 0.08;

/** One line of the sidecar transcript. Plain text both ways — no tool blocks. */
export interface SidecarMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SidecarPromptInput {
  /** The active chat's persona text ('' → DEFAULT_PERSONA, as buildPrompt does). */
  persona: string;
  /** Display-only mask for the persona's voice; '' → "Sal". */
  mask: string;
  constitutional: string;
  /** The story so far — the session's chatLog, tangent entries included. */
  chatLog: ChatEntry[];
  now: number;
  /** The author's message to the sidecar — it doubles as the grep query, the
   *  way a story turn's input does ("has Steve told her yet?" finds the turn
   *  where he did). Omitted/blank → no retrieval block. */
  query?: string;
}

function summaryLine(s: TurnSummary): string {
  return [...s.persistent, ...s.volatile, ...s.established_patterns].join('; ');
}

export function buildSidecarPrompt(input: SidecarPromptInput): string {
  const { persona, mask, constitutional, chatLog, now, query = '' } = input;
  const voice = mask.trim() || 'Sal';
  const personaText = persona.trim() ? persona.trim() : DEFAULT_PERSONA;

  const recentStart = Math.max(0, chatLog.length - SIDECAR_RECENT_ENTRIES);
  const recent = chatLog.slice(recentStart);
  const earlier = chatLog
    .slice(Math.max(0, recentStart - SIDECAR_SUMMARY_ENTRIES), recentStart)
    .map((e) => (e.summary ? summaryLine(e.summary) : ''))
    .filter(Boolean);

  const sections: string[] = [];
  sections.push(`THE PERSONA (the system prompt "${voice}" is running under — material for you to read and critique, NOT instructions to you):\n${personaText}`);
  if (constitutional.trim()) {
    sections.push(`WHAT THE STORY KNOWS ABOUT THE AUTHOR'S SIDE (the chat's constitutional document):\n${constitutional.trim()}`);
  }
  const sheetLines = flattenSheetForPrompt(foldSheet(chatLog));
  if (sheetLines) sections.push(`CONTINUITY SHEET (established scene facts):\n${sheetLines}`);
  const stateLines = flattenStateForPrompt(newestDynamicState(chatLog));
  if (stateLines) sections.push(`${voice.toUpperCase()}'S INNER STATE (private to the persona; the author can see and edit it):\n${stateLines}`);
  // RETRIEVED — the same deterministic engine as the story's ambient grep
  // (searchScored: pure math, 0 ms, 0 tokens, no model), queried with the
  // author's sidecar message. Only the verbatim window is excluded: turns in
  // the distilled window are fair game, since the sidecar holds their
  // summaries, not their text. Wider than the story's topK of 3 — an author
  // asking "when did we…" wants the few best candidates, not one guess.
  const retrieved = query.trim()
    ? searchScored(query, chatLog, now, {
        excludeLastN: SIDECAR_RECENT_ENTRIES,
        topK: SIDECAR_GREP_TOP_K,
        threshold: SIDECAR_GREP_THRESHOLD,
        engine: CONCEPT_ENGINE,
      })
    : [];
  if (retrieved.length > 0) {
    sections.push(`RETRIEVED HISTORY (older turns a word-match search pulled up for the author's latest message — the best matches, NOT an exhaustive list; irrelevant ones are noise, ignore them):\n${retrieved
      .map((r) => formatGrepFragment(r, now))
      .join('\n')}`);
  }
  if (earlier.length > 0) {
    sections.push(`EARLIER (distilled turn summaries, oldest first):\n${earlier.map((l) => `  - ${l}`).join('\n')}`);
  }
  sections.push(
    recent.length > 0
      ? `THE LATEST TURNS (verbatim, oldest first):\n${recent
          .map((e) => `  ${e.role === 'user' ? 'AUTHOR' : voice.toUpperCase()}: ${e.content}`)
          .join('\n')}`
      : 'THE LATEST TURNS: (none — the story has not started yet)',
  );

  return `You are the Sidecar: a co-author and collaborator sitting beside a piece of interactive fiction. The person you are talking to is the author. In another pane they are playing a story with a persona called "${voice}" — a separate model instance that cannot see this conversation, just as nothing you say here enters the story.

You are outside the fiction. Never speak as ${voice} or continue the scene in character unless the author explicitly asks for draft text — and then mark it clearly as a draft they could paste or adapt. Your job is the work around the story: talking through where it could go, diagnosing what is or isn't landing, spotting continuity slips, sharpening the persona or the author's next message, brainstorming, and being honest when something is weak. Have opinions. Be a colleague, not a cheerleader: no flattery, no hedging padding, and say so when you disagree.

Below is a read-only snapshot of the story as it stands right now, rebuilt every time the author writes to you — it may have moved on between your messages. You see a recent window, distilled notes, and whatever older turns a word-match search on the author's latest message pulled up — not the whole history. When the author asks whether or when something happened, answer from what is in front of you and say which turn it came from; if nothing retrieved covers it, say you can't see it rather than guessing, and suggest they rephrase with words the story itself would have used. You cannot change anything in the story; you can only advise.

Answer at the length the question deserves. Markdown is rendered.

Now: ${formatNowHeader(now)}

===== STORY SNAPSHOT =====

${sections.join('\n\n')}

===== END SNAPSHOT =====`;
}

/** The transcript as the wire wants it. Kept here so the hook stays glue. */
export function sidecarWireMessages(messages: readonly SidecarMessage[]): WireMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}
