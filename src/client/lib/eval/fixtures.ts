// ============================================================
// RETRIEVAL EVAL — FIXTURE CORPUS
//
// Synthetic chat logs with planted facts for use by the probe
// suite in retrieval-eval.test.ts.  Every timestamp is an
// offset from FIXED_NOW so the suite is fully deterministic.
//
// Design constraints:
//   • Planted-fact turns sit OLDER than the last LOCAL_BUFFER_SIZE
//     entries so searchScored (with its excludeLastN default) can
//     actually reach them.
//   • Term vocabulary is chosen to survive tokenize():
//       - length > 2
//       - not in STOP_WORDS
//     Distinctive low-frequency nouns carry facts; filler turns
//     use vocabulary that is topically disjoint from planted facts
//     so cross-contamination in IDF cannot accidentally inflate a
//     wrong match.
//   • Each user + assistant entry in a pair shares the same
//     createdAt, matching production stamping behaviour.
// ============================================================

import type { ChatEntry } from '../types';

// ---- Pinned reference instant -------------------------------------

/**
 * A fixed epoch-ms value used as "now" throughout every probe.
 * 2026-06-09 00:00:00 UTC — matches spec date; deliberately not
 * Date.now() so the suite is time-invariant.
 */
export const FIXED_NOW: number = 1749427200000; // 2026-06-09T00:00:00.000Z

// ---- Time helpers -------------------------------------------------

/** Epoch-ms for a moment `d` whole days before FIXED_NOW. */
export function daysAgo(d: number): number {
  return FIXED_NOW - d * 24 * 60 * 60 * 1000;
}

/** Epoch-ms for a moment `h` whole hours before FIXED_NOW. */
export function hoursAgo(h: number): number {
  return FIXED_NOW - h * 60 * 60 * 1000;
}

// ---- Fixture shape ------------------------------------------------

export interface Fixture {
  name: string;
  log: ChatEntry[];
}

// ---- Helper: build a turn pair -----------------------------------

function pair(
  userContent: string,
  assistContent: string,
  createdAt: number,
  extra?: Partial<ChatEntry>,
): ChatEntry[] {
  return [
    { role: 'user', content: userContent, createdAt, ...extra },
    { role: 'assistant', content: assistContent, createdAt, ...extra },
  ];
}

// ============================================================
// FIXTURE 1: topical
//
// ~20 turns across 4–5 distinct topics.  Planted fact:
//   "my sister Maren teaches glassblowing in Tacoma"
// at turnIndex 3 (0-based pair index 2, entries [4,5]).
//
// Buffer tail (last 4 entries = turns 9 + 10) carries filler
// so the planted-fact turns are searchable by searchScored.
//
// Topics:
//   A – gardening / composting        (filler, disjoint)
//   B – glassblowing / Maren / Tacoma (planted fact)
//   C – chess / knights / pawns       (filler, disjoint)
//   D – baking / sourdough            (filler, disjoint)
//   E – telescope / astronomy         (filler, disjoint)
// ============================================================

const topicalLog: ChatEntry[] = [
  // turn 1 – gardening (filler A)
  ...pair(
    'How often should I turn my compost heap for good decomposition?',
    'Turning the compost every two weeks speeds decomposition and prevents odour.',
    daysAgo(40),
  ),
  // turn 2 – gardening continued (filler A)
  ...pair(
    'What ratio of browns to greens works best in a compost pile?',
    'Aim for three parts carbon-rich browns to one part nitrogen-rich greens.',
    daysAgo(38),
  ),
  // turn 3 — PLANTED FACT: sister Maren, glassblowing, Tacoma
  ...pair(
    'My sister Maren teaches glassblowing classes in Tacoma every Saturday.',
    'That sounds wonderful! Glassblowing is a remarkable craft — Maren must enjoy sharing it with students in Tacoma.',
    daysAgo(35),
  ),
  // turn 4 – chess (filler C)
  ...pair(
    'Can a knight jump over pawns in the opening moves?',
    'Yes, knights are the only chess pieces that can leap over other pieces.',
    daysAgo(30),
  ),
  // turn 5 – chess continued (filler C)
  ...pair(
    'What is the best opening for white in chess against the Sicilian defence?',
    'The Open Sicilian with 2.Nf3 followed by 3.d4 is the sharpest reply.',
    daysAgo(28),
  ),
  // turn 6 – baking (filler D)
  ...pair(
    'My sourdough starter smells like acetone instead of tangy vinegar.',
    'An acetone smell usually means the starter is over-fermented or under-fed.',
    daysAgo(25),
  ),
  // turn 7 – baking continued (filler D)
  ...pair(
    'How long should I bulk-ferment sourdough at room temperature?',
    'Typically four to twelve hours depending on ambient temperature and starter activity.',
    daysAgo(22),
  ),
  // turn 8 – astronomy (filler E) — SECOND planted detail: "refractor telescope"
  ...pair(
    'I bought a refractor telescope for stargazing last month.',
    'Refractor telescopes are excellent for lunar and planetary viewing.',
    daysAgo(18),
  ),
  // Tail: last 4 entries = turns 9 + 10 (buffer, excluded by searchScored)
  // turn 9 – astronomy filler (buffer)
  ...pair(
    'What eyepiece magnification is good for viewing Saturn?',
    'A 150x to 200x magnification usually shows Saturn rings clearly.',
    daysAgo(2),
  ),
  // turn 10 – astronomy filler (buffer)
  ...pair(
    'Does atmospheric turbulence affect refractor telescopes more than reflectors?',
    'Seeing conditions affect all telescope types but refractors tend to be more forgiving.',
    daysAgo(1),
  ),
];

// ============================================================
// FIXTURE 2: temporal
//
// The SAME topic (home-renovation, specifically "ceramic tile")
// discussed at three ages:
//   daysAgo(1)  – most recent
//   daysAgo(7)  – one week ago
//   daysAgo(30) – thirty days ago
//
// Each occurrence has a distinguishing per-day keyword:
//   day-1  → "grout", "bathroom"
//   day-7  → "adhesive", "substrate"
//   day-30 → "kiln", "terracotta"
//
// Buffer tail: 2 filler turns at daysAgo(0) so the topic
// turns are all searchable.
// ============================================================

const temporalLog: ChatEntry[] = [
  // turn 1 – day-30 occurrence (old ceramic tile discussion)
  ...pair(
    'I am laying terracotta ceramic tile from a kiln in the workshop.',
    'Hand-made kiln tiles have beautiful variation; seal them well before grouting.',
    daysAgo(30),
  ),
  // turn 2 – filler (disjoint: marine navigation)
  ...pair(
    'How do sailors use celestial navigation without GPS?',
    'They use a sextant to measure the altitude of the sun or stars.',
    daysAgo(20),
  ),
  // turn 3 – day-7 occurrence (same topic, different details)
  ...pair(
    'Choosing between adhesive types for ceramic tile over a concrete substrate.',
    'For a concrete substrate, modified thin-set adhesive is the standard recommendation.',
    daysAgo(7),
  ),
  // turn 4 – filler (disjoint: knitting)
  ...pair(
    'What needle size should I use for chunky knitting yarn?',
    'Chunky yarn usually calls for 8mm to 12mm knitting needles.',
    daysAgo(5),
  ),
  // turn 5 – day-1 occurrence (same topic, different details)
  ...pair(
    'I finished tiling the bathroom floor with ceramic tile yesterday.',
    'Congratulations! Allow the grout in the bathroom to cure fully before using the shower.',
    daysAgo(1),
  ),
  // Buffer tail: 2 filler turns (disjoint: podcasting)
  ...pair(
    'What microphone is best for recording a podcast at home?',
    'A USB condenser microphone is a popular choice for home podcast recording.',
    hoursAgo(4),
  ),
  ...pair(
    'How do I reduce background noise when recording audio?',
    'Record in a soft-furnished room and use a pop filter to reduce plosives.',
    hoursAgo(1),
  ),
];

// ============================================================
// FIXTURE 3: gated
//
// A copy of the topical planted-fact turn, but BOTH halves have
// active: false.  The rest of the log is filler so the corpus
// is not empty.
//
// Probe: even a perfect-match query must return nothing for the
// gated turn.
// ============================================================

const gatedLog: ChatEntry[] = [
  // turn 1 – gated planted fact (active: false on both halves)
  { role: 'user',      content: 'My sister Maren teaches glassblowing classes in Tacoma every Saturday.', createdAt: daysAgo(35), active: false },
  { role: 'assistant', content: 'Glassblowing is a remarkable craft — Maren must enjoy sharing it with students in Tacoma.', createdAt: daysAgo(35), active: false },
  // turn 2 – filler (disjoint: plumbing)
  ...pair(
    'Why does my kitchen faucet drip when turned off completely?',
    'A dripping faucet usually means a worn washer or cartridge inside the valve.',
    daysAgo(25),
  ),
  // turn 3 – filler (disjoint: typography)
  ...pair(
    'What is the difference between serif and sans-serif typefaces?',
    'Serif typefaces have small strokes at the ends of letters; sans-serif do not.',
    daysAgo(20),
  ),
  // turn 4 – filler (disjoint: hiking)
  ...pair(
    'What gear do I need for a multi-day alpine hiking trip?',
    'Layered clothing, waterproof boots, navigation tools, and enough calories.',
    daysAgo(15),
  ),
  // Buffer tail (2 filler turns — excluded)
  ...pair(
    'How do I waterproof hiking boots at home?',
    'Apply a wax or spray-on waterproofing treatment and let them dry fully.',
    daysAgo(2),
  ),
  ...pair(
    'Is it better to use trekking poles on downhill sections?',
    'Yes, poles reduce knee stress significantly on steep downhill terrain.',
    daysAgo(1),
  ),
];

// ============================================================
// FIXTURE 4: timeless
//
// A manually-inserted memory (timeless: true, placed at index 0,
// oldest position) holding a planted fact:
//   "My cat Persimmon has hyperthyroidism"
//
// Followed by ~10 turns of unrelated recent chatter so the
// timeless entry sits very far in the past relative to the buffer
// but should still surface on concept because timeScore is forced
// to 1.0 for timeless entries.
// ============================================================

const timelessLog: ChatEntry[] = [
  // turn 1 – TIMELESS planted fact (manual memory, oldest)
  { role: 'user',      content: 'Note: my cat Persimmon has hyperthyroidism and takes methimazole daily.', createdAt: daysAgo(365), timeless: true },
  { role: 'assistant', content: 'Noted. Persimmon takes methimazole for hyperthyroidism — I will keep that in mind.', createdAt: daysAgo(365), timeless: true },
  // turn 2 – recent filler (disjoint: cycling)
  ...pair(
    'How do I adjust the derailleur on my road bike?',
    'Loosen the cable anchor bolt, pull the cable taut, and fine-tune with the barrel adjuster.',
    daysAgo(10),
  ),
  // turn 3 – recent filler (disjoint: painting)
  ...pair(
    'What primer should I use before painting over glossy surfaces?',
    'Use a bonding primer designed for slick surfaces to ensure good adhesion.',
    daysAgo(8),
  ),
  // turn 4 – recent filler (disjoint: fermentation)
  ...pair(
    'How long does kimchi need to ferment before eating?',
    'Kimchi is ready after one to three days at room temperature, then refrigerate.',
    daysAgo(6),
  ),
  // turn 5 – recent filler (disjoint: photography)
  ...pair(
    'What shutter speed stops motion blur when photographing birds in flight?',
    'At least 1/1000s is usually needed to freeze fast-moving birds.',
    daysAgo(4),
  ),
  // Buffer tail (2 filler turns — excluded by searchScored)
  ...pair(
    'How do I clean a camera lens without scratching it?',
    'Use a microfibre cloth with lens-cleaning fluid in gentle circular strokes.',
    daysAgo(1),
  ),
  ...pair(
    'Is it worth buying a mirrorless camera over a DSLR?',
    'Mirrorless cameras are lighter and benefit from newer autofocus technology.',
    hoursAgo(3),
  ),
];

// ============================================================
// FIXTURE 5: synonymy
//
// Facts planted using one vocabulary, probed using synonyms.
// These are the known-gap entries — TF-IDF has no vocabulary
// bridge.
//
// Planted facts:
//   "bistro" → probed as "restaurant"
//   "manager" → probed as "boss"
//   "Subaru" → probed as "car"
// ============================================================

const synonymyLog: ChatEntry[] = [
  // turn 1 – PLANTED: bistro (synonym target: restaurant)
  ...pair(
    'I had lunch at a charming bistro near the office today.',
    'A bistro lunch sounds delightful — small French-style bistros often have excellent fixed menus.',
    daysAgo(40),
  ),
  // turn 2 – filler (disjoint: origami)
  ...pair(
    'What paper weight works best for folding complex origami models?',
    'Thin but sturdy paper around 60–80 gsm is ideal for intricate origami folds.',
    daysAgo(35),
  ),
  // turn 3 – PLANTED: manager (synonym target: boss)
  ...pair(
    'My manager approved the budget proposal I submitted last week.',
    'That is great news — having your manager on board early makes execution much smoother.',
    daysAgo(30),
  ),
  // turn 4 – filler (disjoint: aquarium)
  ...pair(
    'How often should I change the water in a freshwater aquarium?',
    'Change about 25 percent of the water weekly to keep nitrate levels low.',
    daysAgo(25),
  ),
  // turn 5 – PLANTED: Subaru (synonym target: car)
  ...pair(
    'The Subaru needs an oil change; it has been 8000 kilometres since the last one.',
    'Most modern Subaru engines are fine with oil changes every 8000 to 10000 km.',
    daysAgo(20),
  ),
  // turn 6 – filler (disjoint: yoga)
  ...pair(
    'Which yoga pose is best for relieving lower back tension?',
    'Child pose and supine twist are both excellent for lower back relief.',
    daysAgo(15),
  ),
  // Buffer tail (2 filler turns — excluded)
  ...pair(
    'How do I make a traditional Japanese miso soup?',
    'Dissolve miso paste in dashi stock and add tofu and wakame seaweed.',
    daysAgo(2),
  ),
  ...pair(
    'What is the difference between white and red miso paste?',
    'White miso is milder and sweeter; red miso is stronger and saltier.',
    daysAgo(1),
  ),
];

// ============================================================
// EXPORT
// ============================================================

export const FIXTURES: Record<string, Fixture> = {
  topical:  { name: 'topical',  log: topicalLog  },
  temporal: { name: 'temporal', log: temporalLog  },
  gated:    { name: 'gated',    log: gatedLog     },
  timeless: { name: 'timeless', log: timelessLog  },
  synonymy: { name: 'synonymy', log: synonymyLog  },
};
