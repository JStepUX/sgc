# Architecture

How one turn of SGC works, in depth. The `README.md` is the short version;
this is the full present-tense description of the memory architecture. File
header comments are the per-file truth where the two disagree.

## The turn

A turn is one user input → one model call → one response. Every turn, the
client assembles a context from curated tiers and hands it to **Sal**, a
reasoning instance that exists for exactly one turn and is then retired.
Nothing carries over except what the tiers rebuild. Sal's reply is prose
only: no output format, no metadata block.

| Tier | What it is | Cost |
|------|-----------|------|
| **Constitutional document** | One freeform per-chat document about the user, in prose, edited in a modal and carried forward at "Begin again" on request. Not model-scored | in-prompt |
| **Continuity sheet** | A fixed-schema scene record (story, location, one record per named character), folded from per-turn deltas and rendered as labelled lines | in-prompt |
| **Distilled buffer** | The two turns behind the local buffer, each carried as its own summary rather than its raw text | in-prompt |
| **Local buffer** | The last two turns, verbatim | in-prompt |
| **Cosine grep ("Grepory")** | Deterministic retrieval over older history. Pure math, no model | 0 ms, 0 tokens |
| **Knowledge packs** | Mounted read-only reference material, searched by the same math | 0 ms, 0 tokens |

The base loop is two API calls per turn: the reply, then a small post-reply
**state turn**. Deliberate recall (below) can add up to two more.

## Grepory: the retrieval engine

Retrieval over the person's own history is deterministic: TF-IDF cosine
similarity multiplied by a squashed BM25 score. Tokens are Porter-stemmed, so
"needle" finds "needles". BM25's inverse document frequency vetoes words that
appear in every turn, so scene furniture cannot carry a pull on its own.

Two corpora are indexed:

- **Raw turns.** The verbatim text of every stored turn outside the local
  buffer.
- **Turn summaries and retrieval cues.** The state turn's per-turn summary
  lines, plus a few retrieval cues per turn (other words a person might use
  later to ask about it). Cues are indexed and never shown to Sal.

Raw matches fill the slots first; summary matches fill whatever the raw text
leaves empty and are rendered as pointers to the turn. That way a label the
prose never restated ("the orchard visit") still retrieves. Individual turns
can be gated out of retrieval in the chat memory editor.

Retrieved fragments carry term provenance, `[Turn 6 · 4 min ago · via
"sister"]`, and when older history exists but nothing surfaced, the prompt
says so rather than staying silent. That honesty is the cue that makes
deliberate recall worth reaching for.

**Deliberate recall.** Sal carries a `recall` tool. When it senses there is
more to remember, it pauses mid-turn (the UI shows a quiet *Remembering…*)
and re-queries the same deterministic engine with a query it authors, or
pulls the immediate neighbours of a turn it has already seen. At most two
recall rounds per turn, so the worst case is three reply calls plus the
state turn. Results are deduplicated against what the prompt already
carries. The model proposes a query; what matches is still pure math.

## The state turn

Once the reply has streamed, a second small call reads the exchange back and
returns three things. It retrieves nothing.

**Turn summary.** A per-turn distillation: attributed statements the person
made about themselves or their world, volatile facts, established patterns,
and the retrieval cues above. The last two turns' summaries form the
distilled buffer, so a turn that scrolls out of full-text recency survives as
its summary rather than dropping straight to grep.

**Dynamic State.** Sal's inner state as a small, schema-capped snapshot: goal,
feeling, association, passing thought, what it noticed, what it wanted to say
and didn't. It is rendered into the next turn's prompt as a private block in
labelled prose, with an instruction never to narrate or quote it. It colours
the reply instead of being reported in it.

This is a deliberate recurrence: the state prompt consumes the previous
state, which is what makes slow-burn continuity possible and what could
drift. It is bounded three ways. The schema caps it, it is regenerated every
turn from live context rather than accreting, and it is yours to edit from
the rail's *Dynamic State* card. The drift surface is also the control
surface. Sal is still rebuilt fresh every turn; the state is data in a
prompt, not a model carrying its own memory.

**Continuity deltas.** Salience gating has a structural blind spot: facts that
are durable but low-salience. A character's shirt is never the topic, so the
grep never scores it, and it is rarely restated, so the buffers drop it. The
continuity sheet holds those facts. The state turn returns only *deltas*
against a fixed schema: story (genre, time), location (name, type, one
established environment line), and one record per named character (present
or not and why, where they are, stance, apparel, items, physical state,
standing disposition toward you, what they don't yet know, and, since spec
11, what they want and what they live by).

The last two are the character's *drives*, and they are what makes a named
character a separate person rather than an echo of your move. The state turn
writes them under a rule that makes a want a will: it changes when the story
satisfies, defeats or replaces it, never because you asked, and it is never
written for your own character. When any drive is recorded, the prompt's
continuity header says whose reasons they are and that a character's
tolerance for you follows their standing toward you, and the task line asks
each present character to answer from their own wants rather than from what
the input asks of them. With no drive recorded the prompt is byte-identical
to before. Dynamic State was the wrong home for this: it is Sal's own, one
slot each, regenerated every turn, and a want has to outlast ten turns of you
leaning on it.

Code merges the deltas. Omission never deletes, a departed character keeps
their record, a move replaces the location, and a truncated response can
never write a half-fact. Each turn stores only its own delta, and the sheet
is folded from the log whenever it is read, so two state calls landing in
either order cannot lose a fact, and re-spin, tangent rollback and undo roll
it back for free. There is no editor: the person is there to be in the
story, not to curate it. Correct the story and the next reflection applies
the correction. The rail shows the sheet read-only.

## Reply pacing

Reply length is not the token cap's job. Each reply draws a paragraph ceiling
from a weighted deck (one to five, weighted toward two and three, never the
same twice running). The prompt names the ceiling and the server enforces it
at the Nth blank line, the one editorial cut made server-side. See
`src/client/lib/pacing.ts`.

## Curation: editing the story without a model

All of these are pure curation. No model runs, and the retrieval invariant is
untouched.

- **Edit or re-spin the latest reply.** Rewrite the text by hand, or re-run
  the current model for that turn with its history reconstructed (the chat
  sliced to before the turn, recency anchored at its original instant) plus
  your current memories and persona. Whichever you keep becomes the turn and
  is re-indexed. The turn's summary, inner state and continuity delta are
  cleared and re-derived from the text you kept. The editor lets you raise,
  lower or lift the paragraph ceiling, and replay or drop a spontaneity
  operator, before re-spinning.
- **Undo.** Deletes the latest user+assistant pair from the thread, the
  database and therefore the grep corpus, and returns your message to the
  composer. Undo repeatedly to walk a chat back turn by turn.
- **Tangents.** A bookmark drops at the current turn, the thread takes on an
  ember wash, and the conversation continues: same loop, same retrieval,
  same state turn. Sal is never told. **Make canon** keeps everything (the
  turns were stored normally all along); **Wipe** deletes every turn past the
  boundary. Because inner state, summaries and continuity deltas are per-turn
  snapshots, wiping the rows *is* the rollback. The boundary persists
  per-chat, so a reload mid-tangent resumes it. Chat-scoped things (the
  constitutional document, persona, mounted packs) survive a wipe.
- **Persona.** The head of the per-turn system prompt is editable per chat at
  "Begin again" and mid-chat from the rail's **System Prompt** button, with a
  forward-only edit history. An optional display-only name (a "mask") labels
  the assistant's turns and never reaches the model.

## Beside the story

**The Sidecar.** The rail's Sidecar tab is a co-author chat with a
collaborator who is not Sal: same provider and transport, a different system
prompt, and none of the turn machinery. On every message it is handed a fresh
read-only snapshot of the story (persona, constitutional document, continuity
sheet, inner state, the last four turns verbatim, summaries of the eight
before that) plus whatever older turns the same deterministic grep pulls up
for your message. It writes nothing back and its transcript is never
persisted: it lives in memory until you reload or press its refresh button.
Each Sidecar message is one model call outside the turn loop.

**Find in thread.** Ctrl/Cmd-F opens a literal, case-insensitive substring
find over every loaded message: the exhaustive counterpart to the grep's
ranked few, with no model and no index.

**Knowledge packs.** A chat can mount `sgc-brain/1` JSON packs of document
chunks compiled offline by the sibling Atlantis repo (`python -m atlantis
export`; model-free `--stub` builds are first-class). Mounted packs are
searched each turn by the same TF-IDF cosine math, one union index across all
mounts, and the top chunks render as a PERSONA KNOWLEDGE tier behind an
always-present per-pack digest. Packs are read-only, carry no embeddings, and
never touch the memory tiers. Knowledge is reference material about the
world, not memory of the person. The rail's **Brain Manager** owns import,
mount toggles and delete.

**Linked pages.** Sal has no live web access. When the person pastes a link,
the server extracts its text (Readability) before the call, behind an SSRF
guard, and folds it into the prompt as a LINKED PAGE read in one pass. No
model, no search loop.

**Spontaneity (experimental).** When the recent conversation is circling,
measured as average pairwise TF-IDF cosine over the last few turns, a single
one-turn creative operator can fire into Sal's prompt to break the rut. It is
surfaced as a dimmed `⟐ <Operator>` marker beneath the reply. Pure-math
trigger, no extra call. See `src/client/lib/spontaneity/README.md`.

## The invariants

Two rules protect the thesis, stated once here and defended in `CLAUDE.md`:

1. **No model in the memory-retrieval path.** Retrieval over the person's own
   history is deterministic math. Embeddings or semantic search over memory
   would be a phase change, not a fix.
2. **Sal is ephemeral.** Every turn a fresh instance gets a context rebuilt
   from the curated tiers, then is retired. No growing transcript, no model
   carrying its own state. The per-turn call count is a tripwire for this,
   not the law.
