// Shared structural constants for the SGC memory tiers.

/**
 * The local-buffer window, in *messages* (not turns): the last 2 turns ×
 * (user + assistant) = 4 entries, passed verbatim every turn.
 *
 * This is load-bearing for the no-double-dip invariant. The buffer is the last
 * `LOCAL_BUFFER_SIZE` entries of the chat log; the cosine grep must exclude
 * exactly that same tail (`excludeLastN`) so a message lands in exactly one
 * tier — never both, never neither. Binding the buffer slice and the grep's
 * `excludeLastN` to this single constant is what keeps the two from drifting:
 * change the buffer size here and both sides move together.
 */
export const LOCAL_BUFFER_SIZE = 4;

/**
 * The summary-buffer window, in *messages* (same unit as LOCAL_BUFFER_SIZE): the
 * SUMMARY_BUFFER_SIZE entries sitting immediately BEHIND the verbatim local
 * buffer. Those turns have scrolled out of full-text recency, so rather than
 * dropping straight to the cosine grep they're carried forward DISTILLED — each
 * turn's own <turn-summary> in place of its raw text. 4 entries = 2 turns.
 *
 * This window does NOT overlap the local buffer (it ends exactly where the buffer
 * begins), so the distilled tail extends the awareness horizon — raw recent →
 * distilled near-past → cosine grep — instead of duplicating the verbatim block.
 * An independent knob from LOCAL_BUFFER_SIZE: widen it for a longer distilled
 * tail at near-zero token cost (a summary is a few lines; a raw turn is not).
 */
export const SUMMARY_BUFFER_SIZE = 4;
