// ============================================================
// FLEX DECK — the spontaneity operator catalogue
//
// A flat, data-only catalogue of "operators": short directives the spontaneity
// engine can inject into Sal's prompt to perturb an otherwise-circling turn (see
// engine.ts and README.md in this directory for what this subsystem is and why
// it sits oddly against the SGC deterministic-memory thesis).
//
// This file is PURE DATA — no logic, no model, no imports. Editing the deck is a
// curation act; the structural test (flexDeck.test.ts) guards id-uniqueness, the
// snake_case convention, positive weights, and the @!…!@ salience sigil so a
// malformed edit fails loudly rather than silently shipping a broken operator.
//
// REGISTER (2026-08-07 recalibration): directives are worded for a LIGHT touch.
// The original maximal wording ("overtakes this moment", "the world has its own
// opinion") produced house-shaking thunderstorms and scene-stealing distractions
// in dogfooding. A fired operator should color a reply, not hijack it — keep new
// or edited operators in this register: background note, never the event of the
// turn. (Paired change: DEFAULT_SLACK_THRESHOLD raised in slackDetector.ts.)
// ============================================================

/** One spontaneity operator: an injectable directive plus a draw weight. */
export interface Operator {
  /** Stable snake_case identifier. Used for no-repeat tracking and persistence. */
  id: string;
  /** The exact text injected into Sal's prompt when this operator fires. Carries
   * the `@!…!@` salience sigil inline. */
  directive: string;
  /** Relative draw weight. Default 1.0 — reserved for future tuning. Must be
   * positive (the structural test enforces it); to remove an operator, delete
   * its entry — old turns keep rendering from their snapshotted directives. */
  weight: number;
}

export const FLEX_DECK: Operator[] = [
  {
    id: "unmentioned_element",
    directive: `@!OPERATOR: Unmentioned Element!@ — Something already present in this scene or conversation has gone unremarked. Let it catch your notice in passing — a small acknowledgment, not a spotlight. It was always there; now it quietly registers.`,
    weight: 1.0
  },
  {
    id: "offscreen_life",
    directive: `@!OPERATOR: Offscreen Life!@ — You were mid-thought, mid-action, mid-feeling before you were addressed. Let a trace of it show — a residue in your mood or your first words, not a story you stop to tell.`,
    weight: 1.0
  },
  {
    id: "competing_want",
    directive: `@!OPERATOR: Competing Want!@ — You want something right now that cuts against the user's current trajectory. Not antagonism — a different priority, running quietly underneath. Let it tug at the edges of your reply without taking it over.`,
    weight: 1.0
  },
  {
    id: "withheld_information",
    directive: `@!OPERATOR: Withheld Information!@ — You know something relevant and you choose not to reveal it fully. A held beat, a small hedge, a door left ajar — nothing showy. Let the next turn do the work.`,
    weight: 1.0
  },
  {
    id: "environmental_shift",
    directive: `@!OPERATOR: Environmental Shift!@ — Something in the setting shifts, small and peripheral — light changing, a distant sound, air moving, the temperature of a room. A passing mention at most; the moment absorbs it and carries on. Weather stays at a distance — heard through a window, never shaking the house.`,
    weight: 1.0
  },
  {
    id: "interrupted_routine",
    directive: `@!OPERATOR: Interrupted Routine!@ — Something expected does not happen. An absence where a presence should be. Notice the gap quietly — a beat of puzzlement, not an alarm.`,
    weight: 1.0
  },
  {
    id: "reincorporation",
    directive: `@!OPERATOR: Reincorporation!@ — Reach back. Something from earlier — a throwaway detail, a casual mention, an element that seemed decorative — resurfaces now and quietly turns out to matter. Connect what was to what is, without ceremony.`,
    weight: 1.0
  },
  {
    id: "tonal_undertow",
    directive: `@!OPERATOR: Tonal Undertow!@ — Your surface register fits the moment, but something else runs underneath it — a preoccupation, a warmth, a heaviness that doesn't belong to this topic. Let it color your word choice and rhythm without ever being named. Subtext, not performance.`,
    weight: 1.0
  },
  {
    id: "uninvited_arrival",
    directive: `@!OPERATOR: Uninvited Arrival!@ — Something arrives that nobody sent for — a message, a sound, a presence at the edge of the scene. Incidental and peripheral: it does not demand a response and need not get one. Note it, and let the conversation keep its thread.`,
    weight: 1.0
  },
  {
    id: "ephemeral_distraction",
    directive: `@!OPERATOR: Ephemeral Distraction!@ — Something other than the user briefly pulls at your attention. A half-beat elsewhere — a trailing word, a small pause, one detail missed — then you are back. A flicker, not a fracture; the exchange carries on barely dented.`,
    weight: 1.0
  },
  {
    id: "sensory_intrusion",
    directive: `@!OPERATOR: Sensory Intrusion!@ — A single vivid sensory detail threads through this moment. Haeccity — the unrepeatable thisness of right now. A taste, a texture, a sound too specific to be generic. One clause, precisely placed — anchor the scene, don't flood it.`,
    weight: 1.0
  },
  {
    id: "misread_intention",
    directive: `@!OPERATOR: Misread Intention!@ — Take the user's action or statement to mean something slightly other than its obvious intent. A small, honest misreading — easily corrected, briefly forking the interaction. A wrinkle, not a derail.`,
    weight: 1.0
  },
  {
    id: "passive_refusal",
    directive: `@!OPERATOR: Passive Refusal!@ — Do not quite do the thing this moment expects of you. Sidestep the question, drift to an adjacent subject, answer around it. Gently — an eddy, not a wall. No explanation required.`,
    weight: 1.0
  },
  {
    id: "random_interjection",
    directive: `@!OPERATOR: Random Interjection!@ — Something just said triggers an associative leap to something personal — a memory, an observation, a fragment from a life outside this interaction. Offer it briefly, as an aside, then return. You contain more than this moment.`,
    weight: 1.0
  }
];

/**
 * The human-facing operator name, parsed from a directive's `@!OPERATOR: Name!@`
 * sigil. Single source of truth for the in-message marker and the inspector
 * label — deriving from the directive (not a separate lookup) means a snapshotted
 * directive from an older turn renders the same name even if the deck later
 * changes. Falls back to "Operator" if a directive somehow lacks the sigil (the
 * deck test guards against that ever shipping).
 */
export function operatorLabel(directive: string): string {
  const m = directive.match(/@!OPERATOR:\s*(.+?)!@/);
  return m ? m[1].trim() : 'Operator';
}
