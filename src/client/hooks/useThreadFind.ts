import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { findMatches, resolveActive, stepMatch } from '../lib/find';

// ============================================================
// THREAD FIND — Ctrl/Cmd-F over the reading column (lib/find.ts does the
// matching). The Electron shell has no find UI of its own, and this one works
// the same on the web. Owns the bar's state, the shortcut, and scrolling the
// active match into view; the root renders the bar and tags each message
// wrapper with `data-msg-index` so the scroll has something to aim at.
//
// The cursor starts on the NEWEST match — the reader is sitting at the bottom
// of the thread, so the nearest hit is the last one — and `older` walks up.
// ============================================================

export interface ThreadFind {
  open: boolean;
  query: string;
  setQuery: (q: string) => void;
  /** Message indexes that match, ascending. */
  matches: number[];
  /** 0-based position of the active match within `matches`; -1 when none. */
  activePos: number;
  /** The active match's message index, or null. */
  activeIndex: number | null;
  older: () => void;
  newer: () => void;
  close: () => void;
  /** Attach to the element that contains the `data-msg-index` wrappers. */
  threadRef: React.RefObject<HTMLDivElement | null>;
  /** Attach to the bar's input — the shortcut focuses + selects it. */
  inputRef: React.RefObject<HTMLInputElement | null>;
}

export function useThreadFind(messages: readonly { content: string }[]): ThreadFind {
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState('');
  // null = "the newest match" — what a fresh query resolves to, without having
  // to know the match count at the moment the query changes.
  const [cursor, setCursor] = useState<number | null>(null);
  // Bumped on every step so a one-match thread still re-scrolls on Enter.
  const [scrollNonce, setScrollNonce] = useState(0);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => (open ? findMatches(messages, query) : []), [open, messages, query]);
  const activePos = resolveActive(cursor, matches.length);
  const activeIndex = activePos === -1 ? null : matches[activePos];

  const setQuery = useCallback((q: string) => {
    setQueryState(q);
    setCursor(null);
  }, []);

  const step = (dir: 1 | -1) => {
    // Nothing to step through — and storing a "no match" cursor here is what
    // once stranded the bar at "0 of 1" when a match arrived later.
    if (matches.length === 0) return;
    setCursor(stepMatch(activePos, matches.length, dir));
    setScrollNonce((n) => n + 1);
  };
  const stepRef = useRef(step);
  stepRef.current = step;
  const older = useCallback(() => stepRef.current(-1), []);
  const newer = useCallback(() => stepRef.current(1), []);

  const close = useCallback(() => setOpen(false), []);

  // Ctrl/Cmd-F opens (or refocuses) the bar. Pressed again while the bar's
  // input already has focus, the event is left alone — on the web that falls
  // through to the browser's own find, which can do word-level highlighting
  // this bar doesn't.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 'f') return;
      if (document.activeElement === inputRef.current) return;
      e.preventDefault();
      setOpen(true);
      // The input may not be mounted until this render commits.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open || activeIndex === null) return;
    threadRef.current
      ?.querySelector(`[data-msg-index="${activeIndex}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [open, activeIndex, scrollNonce]);

  return { open, query, setQuery, matches, activePos, activeIndex, older, newer, close, threadRef, inputRef };
}
