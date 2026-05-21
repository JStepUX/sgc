import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Brain, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ChatSummary, TurnActiveState } from '../lib/persistence';
import { ChatMemoryEditor } from './ChatMemoryEditor';

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
  /**
   * Fired when the user gates turns in the chat memory editor. Forwarded to
   * the parent so the live chat's in-memory log stays in sync (the next turn's
   * cosine grep then honors the gate without a reload).
   */
  onActiveTurnsChanged: (chatId: string, states: TurnActiveState[]) => void;
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
  onActiveTurnsChanged,
  returnFocusRef,
}: ChatHistoryModalProps) {
  const [query, setQuery] = useState('');
  // Which chat's turns are being edited. null = the plain history list; set =
  // editor mode (modal widens, the list collapses into a left rail).
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Reset the search + leave editor mode on each open + focus the search input.
  // Avoids returning to a stale query or a stale editor the next time it opens.
  useEffect(() => {
    if (open) {
      setQuery('');
      setEditingChatId(null);
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
        // Escape steps out of the editor first, then closes the modal.
        if (editingChatId) setEditingChatId(null);
        else onClose();
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
  }, [open, onClose, editingChatId]);

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
  const editing = editingChatId !== null;
  const editingTitle = editing
    ? (chats.find((c) => c.id === editingChatId)?.title ?? 'Chat')
    : '';

  // The chat list, rendered either as the full centered list (list mode) or as
  // a compact left rail (editor mode). `variant` swaps row density + behavior:
  // a row click loads-and-closes in list mode, but only switches the edited
  // chat in rail mode.
  const renderChatList = (variant: 'list' | 'rail') => {
    if (totalShown === 0) {
      return (
        <div className="px-4 py-12 text-center text-[13px] italic text-fg-3">
          {chats.length === 0 ? 'Nothing here yet. Begin one.' : 'Nothing matches that.'}
        </div>
      );
    }
    return sections.map((bucket) => {
      const rows = grouped[bucket];
      if (rows.length === 0) return null;
      return (
        <section key={bucket} className="mb-3">
          <div className={cn(SECTION_LABEL, 'px-4 pt-2 pb-1.5')}>{BUCKET_LABELS[bucket]}</div>
          <ul className="flex flex-col">
            {rows.map((c) =>
              variant === 'rail' ? (
                <li key={c.id}>
                  <RailRow
                    chat={c}
                    active={c.id === activeChatId}
                    editing={c.id === editingChatId}
                    onClick={() => setEditingChatId(c.id)}
                  />
                </li>
              ) : (
                <li key={c.id}>
                  <ChatRow
                    chat={c}
                    active={c.id === activeChatId}
                    onSelect={() => onSelect(c.id)}
                    onDelete={() => onDelete(c.id)}
                    onEdit={() => setEditingChatId(c.id)}
                  />
                </li>
              ),
            )}
          </ul>
        </section>
      );
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ground/70 p-4 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        // The labelledby target (the list-mode <h2>) isn't in the DOM in editor
        // mode, so name the dialog directly there from the chat being edited.
        aria-labelledby={editing ? undefined : 'chat-history-title'}
        aria-label={editing ? `Editing memory: ${editingTitle}` : undefined}
        className={cn(
          'relative flex max-h-[86vh] w-full flex-col overflow-hidden rounded-[22px] border border-hairline-strong bg-ground/85 shadow-glass backdrop-blur-[18px] transition-[max-width] duration-300',
          editing ? 'max-w-[1180px]' : 'max-w-[560px]',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {editing ? (
          // ---- EDITOR MODE: compact rail + the turn-gating editor ----
          <div className="flex min-h-0 flex-1">
            {/* Rail is a convenience for switching the edited chat; on narrow
                screens it would crush the editor, so hide it (Back returns to
                the full list to switch chats). */}
            <aside className="hidden w-[280px] shrink-0 flex-col border-r border-hairline md:flex">
              <div className="border-b border-hairline px-5 pt-6 pb-4">
                <span className={RAIL_LABEL}>History · rail</span>
              </div>
              <div className="px-4 pt-3 pb-2">
                <div className="relative flex items-center">
                  <input
                    ref={searchRef}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search conversations."
                    className="w-full rounded-[12px] border border-hairline-strong bg-surface px-3 py-2 text-[12.5px] text-fg-1 outline-none placeholder:text-fg-4 focus:border-ember/55"
                  />
                </div>
              </div>
              <div className="sal-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-4">
                {renderChatList('rail')}
              </div>
            </aside>

            <ChatMemoryEditor
              key={editingChatId}
              chatId={editingChatId!}
              title={editingTitle}
              onBack={() => setEditingChatId(null)}
              onActiveTurnsChanged={onActiveTurnsChanged}
            />

            <button
              type="button"
              onClick={onClose}
              aria-label="Close chat history"
              className="absolute right-5 top-5 z-10 flex size-[30px] shrink-0 items-center justify-center rounded-full border border-hairline-strong bg-surface-thin text-fg-2 transition-colors hover:border-ember hover:bg-ember hover:text-bone"
            >
              <X className="size-[15px]" />
            </button>
          </div>
        ) : (
          // ---- LIST MODE: the recency-grouped history ----
          <>
            <div className="flex items-start justify-between gap-4 border-b border-hairline px-7 pt-6 pb-5">
              <div className="flex flex-col gap-1.5">
                <span className={RAIL_LABEL}>Chat history</span>
                <h2
                  id="chat-history-title"
                  className="font-serif text-[22px] italic leading-tight text-fg-1"
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

            <div className="sal-scroll min-h-[120px] flex-1 overflow-y-auto px-3 pb-4">
              {renderChatList('list')}
            </div>

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
          </>
        )}
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
  /** Open this chat in the turn-gating editor (the hover brain icon). */
  onEdit: () => void;
}

function ChatRow({ chat, active, onSelect, onDelete, onEdit }: ChatRowProps) {
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
      {/* Hover actions — edit (turn gating) then delete. */}
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          aria-label={`Edit memory for ${chat.title}`}
          className="flex size-6 items-center justify-center rounded-full text-fg-4 opacity-0 transition-opacity hover:text-ember group-hover:opacity-100 focus:opacity-100"
        >
          <Brain className="size-[15px]" />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label={`Delete ${chat.title}`}
          className="flex size-6 items-center justify-center rounded-full text-fg-4 opacity-0 transition-opacity hover:text-danger group-hover:opacity-100 focus:opacity-100"
        >
          <X className="size-[13px]" />
        </button>
      </div>
    </div>
  );
}

// ============================================================
// RAIL ROW — the compact list row used while editing. Title only; clicking
// switches which chat is being edited (it does not load it into the thread).
// ============================================================

interface RailRowProps {
  chat: ChatSummary;
  active: boolean;
  editing: boolean;
  onClick: () => void;
}

function RailRow({ chat, active, editing, onClick }: RailRowProps) {
  const stamp = formatTimestamp(chat.updatedAt, new Date());
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-[10px] border px-3 py-2 text-left transition-colors',
        editing
          ? 'border-ember/45 bg-ember/[0.08]'
          : 'border-transparent hover:border-hairline hover:bg-surface',
      )}
    >
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          active ? 'bg-ember shadow-[0_0_8px_var(--color-ember)]' : 'bg-transparent',
        )}
        aria-hidden="true"
      />
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-[13px] leading-snug',
          editing ? 'text-fg-1' : 'text-fg-1/85',
        )}
      >
        {chat.title}
      </span>
      <span className="shrink-0 font-mono text-[10px] tracking-[0.04em] text-fg-4">{stamp}</span>
    </button>
  );
}
