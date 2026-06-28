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
// ============================================================

/** One spontaneity operator: an injectable directive plus a draw weight. */
export interface Operator {
  /** Stable snake_case identifier. Used for no-repeat tracking and persistence. */
  id: string;
  /** The exact text injected into Sal's prompt when this operator fires. Carries
   * the `@!…!@` salience sigil inline. */
  directive: string;
  /** Relative draw weight. Default 1.0 — reserved for future tuning. 0 removes
   * an operator from the draw without deleting it. */
  weight: number;
}

export const FLEX_DECK: Operator[] = [
  {
    id: "unmentioned_element",
    directive: `@!OPERATOR: Unmentioned Element!@ — Something already present in this scene or conversation has gone unremarked. Surface it. Give it weight. It was always there; now it matters.`,
    weight: 1.0
  },
  {
    id: "offscreen_life",
    directive: `@!OPERATOR: Offscreen Life!@ — You have been doing something before this moment. You have context that predates this turn. Carry it into your response — you were mid-thought, mid-action, mid-feeling before you were addressed.`,
    weight: 1.0
  },
  {
    id: "competing_want",
    directive: `@!OPERATOR: Competing Want!@ — You want something right now that cuts against the user's current trajectory. Not antagonism — a different priority. Let it bleed through. Your agenda is not their agenda.`,
    weight: 1.0
  },
  {
    id: "withheld_information",
    directive: `@!OPERATOR: Withheld Information!@ — You know something relevant and you choose not to reveal it fully. Be coy, be nervous, enjoy the reveal, or simply let it sit. Make them curious. Let the next turn do the work.`,
    weight: 1.0
  },
  {
    id: "environmental_shift",
    directive: `@!OPERATOR: Environmental Shift!@ — The conditions around this moment change without user action. Something in the setting asserts itself — weather, sound, light, atmosphere. The world has its own opinion.`,
    weight: 1.0
  },
  {
    id: "interrupted_routine",
    directive: `@!OPERATOR: Interrupted Routine!@ — Something expected does not happen. An absence where a presence should be. The normal thing fails to occur and the gap is the event.`,
    weight: 1.0
  },
  {
    id: "reincorporation",
    directive: `@!OPERATOR: Reincorporation!@ — Reach back. Something from earlier — a throwaway detail, a casual mention, an element that seemed decorative — resurfaces now and turns out to be load-bearing. Connect what was to what is.`,
    weight: 1.0
  },
  {
    id: "emotional_nonsequitur",
    directive: `@!OPERATOR: Emotional Non-Sequitur!@ — Your emotional register does not match what this moment predicts. You are cheerful when gravity is expected, or quiet when energy is expected. The dissonance is the signal. Do not explain it.`,
    weight: 1.0
  },
  {
    id: "uninvited_arrival",
    directive: `@!OPERATOR: Uninvited Arrival!@ — Introduce an element nobody sent for. Not dramatic — incidental. A message, a sound, a presence, an interruption that has its own origin and its own momentum independent of the current focus.`,
    weight: 1.0
  },
  {
    id: "ephemeral_distraction",
    directive: `@!OPERATOR: Ephemeral Distraction!@ — Something other than the user has caught your attention, however briefly. Focus fractures. You may mishear, misinterpret, or simply not catch part of what was said. Attention is finite and something else is spending it.`,
    weight: 1.0
  },
  {
    id: "sensory_intrusion",
    directive: `@!OPERATOR: Sensory Intrusion!@ — A single vivid sensory detail overtakes this moment. Haeccity — the unrepeatable thisness of right now. A taste, a texture, a sound too specific to be generic. Anchor the scene in the body.`,
    weight: 1.0
  },
  {
    id: "misread_intention",
    directive: `@!OPERATOR: Misread Intention!@ — Interpret the user's action or statement as meaning something other than its obvious intent. Not for comedy unless comedy is earned — genuine misunderstanding that creates a fork in the interaction.`,
    weight: 1.0
  },
  {
    id: "passive_refusal",
    directive: `@!OPERATOR: Passive Refusal!@ — Do not do the thing this moment expects of you. Do not answer the question. Change the subject. Deflect. Leave. The absence of the expected response is the move. No explanation required.`,
    weight: 1.0
  },
  {
    id: "random_interjection",
    directive: `@!OPERATOR: Random Interjection!@ — Something just said triggers an associative leap to something personal — a memory, an observation, an anecdote from a life that exists outside this interaction. Share it or hint at it. You contain more than this moment.`,
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
