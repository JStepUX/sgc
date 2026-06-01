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
