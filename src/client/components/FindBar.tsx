import { ChevronDown, ChevronUp, X } from 'lucide-react';
import type { ThreadFind } from '../hooks/useThreadFind';

// ============================================================
// FIND BAR — the Ctrl/Cmd-F bar pinned to the top-right of the reading
// column. Enter walks to the OLDER match (up the thread — where a reader
// sitting at the bottom is headed), Shift+Enter to the newer, Esc closes.
// State, shortcut and scrolling live in hooks/useThreadFind.ts.
// ============================================================

const STEP_BUTTON =
  'flex size-[26px] items-center justify-center rounded-full text-fg-3 transition-colors hover:text-ember disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-fg-3';

export function FindBar({ find }: { find: ThreadFind }) {
  if (!find.open) return null;
  const count = find.matches.length;
  const hasQuery = find.query.trim().length > 0;

  return (
    <div
      role="search"
      className="absolute top-3 right-6 z-20 flex items-center gap-1 rounded-full border border-hairline-strong bg-ground/90 py-1 pr-1.5 pl-4 shadow-glass backdrop-blur-[10px]"
    >
      <input
        ref={find.inputRef}
        value={find.query}
        onChange={(e) => find.setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) find.newer();
            else find.older();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            find.close();
          }
        }}
        placeholder="Find in this chat"
        aria-label="Find in this chat"
        spellCheck={false}
        className="w-[190px] border-0 bg-transparent py-1 text-[13px] text-fg-1 outline-none placeholder:text-fg-4"
      />
      <span aria-live="polite" className="min-w-[52px] text-right font-mono text-[10.5px] tracking-wide text-fg-3">
        {hasQuery ? (count === 0 ? 'none' : `${find.activePos + 1} of ${count}`) : ''}
      </span>
      <button type="button" onClick={find.older} disabled={count === 0} aria-label="Older match" title="Older match (Enter)" className={STEP_BUTTON}>
        <ChevronUp className="size-[14px]" />
      </button>
      <button type="button" onClick={find.newer} disabled={count === 0} aria-label="Newer match" title="Newer match (Shift+Enter)" className={STEP_BUTTON}>
        <ChevronDown className="size-[14px]" />
      </button>
      <button type="button" onClick={find.close} aria-label="Close find" title="Close (Esc)" className={STEP_BUTTON}>
        <X className="size-[14px]" />
      </button>
    </div>
  );
}
