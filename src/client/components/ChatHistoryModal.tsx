import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ChatSummary } from '../lib/persistence';

// ============================================================
// CHAT HISTORY MODAL — frosted glass over the aurora field, grouped by
// recency. Search is plain client-side string match against title + snippet
// (Phase 1.5: no model-based retrieval, anywhere).
// ============================================================

interface ChatHistoryModalProps {
  open: boolean;
  onClose: () => void;
  chats: ChatSummary[];
  activeChatId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onBeginAgain: () => void;
  /** Focus is restored to this element when the modal closes. */
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}

const RAIL_LABEL = 'font-mono text-[11px] tracking-[0.18em] uppercase text-fg-3';
const SECTION_LABEL = 'font-mono text-[10.5px] tracking-[0.18em] uppercase text-fg-3';

type Bucket = 'today' | 'yesterday' | 'week' | 'earlier';

const BUCKET_LABELS: Record<Bucket, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'This week',
  earlier: 'Earlier',
};

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function bucketFor(ts: number, now: Date): Bucket {
  const today = startOfDay(now);
  const yesterday = today - 24 * 60 * 60 * 1000;
  const weekStart = today - 6 * 24 * 60 * 60 * 1000;
  if (ts >= today) return 'today';
  if (ts >= yesterday) return 'yesterday';
  if (ts >= weekStart) return 'week';
  return 'earlier';
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatTimestamp(ts: number, now: Date): string {
  const d = new Date(ts);
  const today = startOfDay(now);
  if (ts >= today) {
    const h = d.getHours();
    const m = d.getMinutes();
    const meridiem = h >= 12 ? 'PM' : 'AM';
    const h12 = ((h + 11) % 12) + 1;
    return `${h12}:${m.toString().padStart(2, '0')} ${meridiem}`;
  }
  if (ts >= today - 24 * 60 * 60 * 1000) return 'Yesterday';
  if (ts >= today - 6 * 24 * 60 * 60 * 1000) return WEEKDAY[d.getDay()];
  // Older: short date, no year unless not-this-year.
  const sameYear = d.getFullYear() === now.getFullYear();
  return sameYear
    ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function ChatHistoryModal({
  open,
  onClose,
  chats,
  activeChatId,
  onSelect,
  onDelete,
  onBeginAgain,
  returnFocusRef,
}: ChatHistoryModalProps) {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Reset the search on each open + focus the search input. Avoids the
  // surprise of returning to a stale query the next time the user opens it.
  useEffect(() => {
    if (open) {
      setQuery('');
      const id = setTimeout(() => searchRef.current?.focus(), 30);
      return () => clearTimeout(id);
    }
  }, [open]);

  // Escape → close. Focus trap: Tab/Shift+Tab cycle within the dialog.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // Restore focus to the clock button when closing.
  useEffect(() => {
    if (!open) {
      returnFocusRef.current?.focus();
    }
  }, [open, returnFocusRef]);

  const filtered = useMemo(() => {
    if (!query.trim()) return chats;
    const needle = query.toLowerCase();
    return chats.filter(
      (c) => c.title.toLowerCase().includes(needle) || c.snippet.toLowerCase().includes(needle),
    );
  }, [chats, query]);

  // Group by recency bucket. Order within each bucket is already
  // updatedAt-descending from the server.
  const grouped = useMemo(() => {
    const now = new Date();
    const map: Record<Bucket, ChatSummary[]> = {
      today: [],
      yesterday: [],
      week: [],
      earlier: [],
    };
    for (const c of filtered) {
      map[bucketFor(c.updatedAt, now)].push(c);
    }
    return map;
  }, [filtered]);

  const handleBeginAgain = useCallback(() => {
    onBeginAgain();
    onClose();
  }, [onBeginAgain, onClose]);

  if (!open) return null;

  const sections: Bucket[] = ['today', 'yesterday', 'week', 'earlier'];
  const totalShown = filtered.length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ground/70 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-history-title"
        className="relative flex max-h-[80vh] w-full max-w-[560px] flex-col overflow-hidden rounded-[22px] border border-hairline-strong bg-ground/85 shadow-glass backdrop-blur-[18px]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-hairline px-7 pt-6 pb-5">
          <div className="flex flex-col gap-1.5">
            <span className={RAIL_LABEL}>Chat history</span>
            <h2
              id="chat-history-title"
              className="font-serif text-[22px] italic leading-tight text-fg-1"
              style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}
            >
              Where you've been
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close chat history"
            className="flex size-[30px] shrink-0 items-center justify-center rounded-full border border-hairline-strong bg-surface-thin text-fg-2 transition-colors hover:border-ember hover:bg-ember hover:text-bone"
          >
            <X className="size-[15px]" />
          </button>
        </div>

        {/* Search */}
        <div className="px-7 pt-4 pb-3">
          <div className="relative flex items-center">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search what you've said."
              className="w-full rounded-[14px] border border-hairline-strong bg-surface px-4 py-2.5 text-[13.5px] text-fg-1 outline-none placeholder:text-fg-4 focus:border-ember/55"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="absolute right-2.5 flex size-6 items-center justify-center rounded-full text-fg-3 transition-colors hover:bg-surface-strong hover:text-fg-1"
              >
                <X className="size-[13px]" />
              </button>
            )}
          </div>
        </div>

        {/* Rows */}
        <div className="sal-scroll min-h-[120px] flex-1 overflow-y-auto px-3 pb-4">
          {totalShown === 0 ? (
            <div className="px-4 py-12 text-center text-[13px] italic text-fg-3">
              {chats.length === 0
                ? 'Nothing here yet. Begin one.'
                : 'Nothing matches that.'}
            </div>
          ) : (
            sections.map((bucket) => {
              const rows = grouped[bucket];
              if (rows.length === 0) return null;
              return (
                <section key={bucket} className="mb-3">
                  <div className={cn(SECTION_LABEL, 'px-4 pt-2 pb-1.5')}>
                    {BUCKET_LABELS[bucket]}
                  </div>
                  <ul className="flex flex-col">
                    {rows.map((c) => {
                      const active = c.id === activeChatId;
                      return (
                        <li key={c.id}>
                          <ChatRow
                            chat={c}
                            active={active}
                            onSelect={() => onSelect(c.id)}
                            onDelete={() => onDelete(c.id)}
                          />
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-4 border-t border-hairline px-7 py-4">
          <span className="font-mono text-[11px] tracking-[0.04em] text-fg-3">
            {chats.length} conversation{chats.length === 1 ? '' : 's'}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={handleBeginAgain}
            className="font-mono text-[11px] text-fg-3"
          >
            Begin again
          </Button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// CHAT ROW — title, snippet, time, active dot, hover-revealed delete.
// ============================================================

interface ChatRowProps {
  chat: ChatSummary;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

function ChatRow({ chat, active, onSelect, onDelete }: ChatRowProps) {
  const now = new Date();
  const stamp = formatTimestamp(chat.updatedAt, now);
  return (
    <div
      className={cn(
        'group relative flex cursor-pointer items-start gap-3 rounded-[12px] border border-transparent px-4 py-2.5 transition-colors',
        active
          ? 'bg-surface-strong'
          : 'hover:border-hairline hover:bg-surface',
      )}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      {/* Active dot — ember-glow on the currently-loaded chat. */}
      <span
        className={cn(
          'mt-2 size-2 shrink-0 rounded-full',
          active
            ? 'bg-ember shadow-[0_0_8px_var(--color-ember)]'
            : 'bg-transparent',
        )}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span
            className={cn(
              'truncate text-[14px] font-medium leading-snug',
              active ? 'text-fg-1' : 'text-fg-1/90',
            )}
          >
            {chat.title}
          </span>
          <span className="shrink-0 font-mono text-[10.5px] tracking-[0.04em] text-fg-3">
            {stamp}
          </span>
        </div>
        {chat.snippet && (
          <div className="mt-1 truncate text-[12.5px] leading-snug text-fg-3">
            {chat.snippet}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        aria-label={`Delete ${chat.title}`}
        className="ml-1 flex size-6 shrink-0 items-center justify-center rounded-full text-fg-4 opacity-0 transition-opacity hover:text-danger group-hover:opacity-100 focus:opacity-100"
      >
        <X className="size-[13px]" />
      </button>
    </div>
  );
}
