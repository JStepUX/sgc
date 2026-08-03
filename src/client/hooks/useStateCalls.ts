import { useCallback, useRef, useState } from 'react';

// ============================================================
// STATE-CALL TRACKER — who is reflecting, per chat.
//
// One shared registry for every post-reply state call, whichever hook fired
// it (the live turn or a saved edit), counted PER CHAT. The rail's
// "reflecting…" hint and the state editor's disable must describe the chat on
// screen: a global boolean would let a slow call in another chat mark this
// one as reflecting — and a boolean at all would let the first of two
// overlapping calls clear the hint while the second still runs.
//
// Composed by the root and passed to both producer hooks (the hooks are
// namespaces over one session, not stores).
// ============================================================

export interface StateCallTracker {
  /** A state call is starting for this chat. Call the returned end() exactly
   *  once when it settles (idempotent — a double call is ignored). */
  begin: (chatId: string) => () => void;
  /** Is any state call still in flight for this chat? */
  inFlightFor: (chatId: string | null) => boolean;
}

export function useStateCalls(): StateCallTracker {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const countsRef = useRef(counts);
  countsRef.current = counts;

  const begin = useCallback((chatId: string) => {
    setCounts((m) => ({ ...m, [chatId]: (m[chatId] ?? 0) + 1 }));
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      setCounts((m) => {
        const n = (m[chatId] ?? 0) - 1;
        if (n > 0) return { ...m, [chatId]: n };
        // Drop the key at zero so the map doesn't accrete dead chats.
        const { [chatId]: _gone, ...rest } = m;
        return rest;
      });
    };
  }, []);

  const inFlightFor = useCallback(
    (chatId: string | null) => (chatId ? (countsRef.current[chatId] ?? 0) > 0 : false),
    // counts in deps so consumers re-render when the registry moves; the ref
    // keeps the read current even mid-batch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [counts],
  );

  return { begin, inFlightFor };
}
