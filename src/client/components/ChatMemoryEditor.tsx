import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Search, Trash2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  addManualTurn as apiAddManualTurn,
  deleteManualTurn as apiDeleteManualTurn,
  loadChat as apiLoadChat,
  setTurnsActive as apiSetTurnsActive,
  type ChatTurn,
  type TurnActiveState,
} from '../lib/persistence';
import { formatRelative } from '../lib/format-time';

// ============================================================
// CHAT MEMORY EDITOR — parcel a chat into its turns and gate each one's
// participation in the cosine grep.
//
// One card per turn (one stored message). A turn switched off dims to 35% and
// drops out of the cosine-grep corpus — deterministic curation of the memory
// tier, no model in the loop (Phase 1.5 invariant intact; see lib/tfidf.ts).
// Gating affects retrieval over OLDER history only; the local 2-turn buffer
// still sends recent turns verbatim. Edits persist immediately and, when this
// chat is the live one, are mirrored into the session via onActiveTurnsChanged.
// ============================================================

interface ChatMemoryEditorProps {
  chatId: string;
  /** Title from the rail, shown immediately while turns load. */
  title: string;
  /** Whether the Add Memory form is open (owned by the parent so its trigger
   * button can sit beside the close X in the modal chrome). */
  addOpen: boolean;
  /** Request the Add Memory form be opened/closed. */
  onAddOpenChange: (open: boolean) => void;
  onBack: () => void;
  /**
   * Fired after each gate change with the turns that flipped. The parent uses
   * it to keep the live chat's in-memory log in sync, so the next turn's cosine
   * grep honors the gate without a reload.
   */
  onActiveTurnsChanged: (chatId: string, states: TurnActiveState[]) => void;
  /**
   * Fired after a manual memory is added or deleted. The parent rebuilds the
   * live chat's in-memory log (the turn set changed, not just a flag) so the
   * next cosine grep sees it.
   */
  onTurnsMutated: (chatId: string) => void;
}

const STAT_LABEL = 'font-mono text-[10px] tracking-[0.18em] uppercase text-fg-3';

/** Apply a set of gate flips to a turn list (pure — safe inside a setState updater). */
function applyFlips(list: ChatTurn[], changes: TurnActiveState[]): ChatTurn[] {
  const byId = new Map(changes.map((c) => [c.id, c.active]));
  return list.map((t) => (byId.has(t.id) ? { ...t, active: byId.get(t.id)! } : t));
}

export function ChatMemoryEditor({
  chatId,
  title,
  addOpen,
  onAddOpenChange,
  onBack,
  onActiveTurnsChanged,
  onTurnsMutated,
}: ChatMemoryEditorProps) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [resolvedTitle, setResolvedTitle] = useState(title);
  const [query, setQuery] = useState('');
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // Load this chat's turns whenever the edited chat changes. The rail can swap
  // the target out from under us, so reset transient UI (search, selection) too.
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setQuery('');
    setSelectMode(false);
    setSelected(new Set());
    setResolvedTitle(title);
    (async () => {
      try {
        const detail = await apiLoadChat(chatId);
        if (cancelled) return;
        setTurns(detail.turns);
        setResolvedTitle(detail.title || title);
      } catch (err) {
        if (!cancelled) console.warn('chat memory editor load failed:', err);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [chatId, title]);

  // Re-pull this chat's turns after a mutation (add/delete) WITHOUT resetting
  // the transient UI the load effect clears — the user stays where they were.
  const refreshTurns = useCallback(async () => {
    try {
      const detail = await apiLoadChat(chatId);
      setTurns(detail.turns);
    } catch (err) {
      console.warn('chat memory editor refresh failed:', err);
    }
  }, [chatId]);

  // Add a manual memory: a full user+assistant pair the server inserts as the
  // oldest, timeless turns. Reload, close the form, and tell the parent so the
  // live grep corpus picks it up. Throws on failure so the form surfaces it.
  const handleAddMemory = useCallback(
    async (user: string, assistant: string) => {
      await apiAddManualTurn(chatId, { user: { content: user }, assistant: { content: assistant } });
      await refreshTurns();
      onAddOpenChange(false);
      onTurnsMutated(chatId);
    },
    [chatId, refreshTurns, onAddOpenChange, onTurnsMutated],
  );

  // Delete a manual memory (both halves of the pair, server-side). Only the
  // delete control on a timeless card calls this.
  const handleDeleteMemory = useCallback(
    async (turn: ChatTurn) => {
      try {
        await apiDeleteManualTurn(chatId, turn.id);
        await refreshTurns();
        onTurnsMutated(chatId);
      } catch (err) {
        console.warn('delete memory failed:', err);
      }
    },
    [chatId, refreshTurns, onTurnsMutated],
  );

  const total = turns.length;
  const activeCount = useMemo(() => turns.filter((t) => t.active).length, [turns]);
  const coverage = total > 0 ? Math.round((activeCount / total) * 100) : 0;

  // Persist a set of real flips: optimistic local update, then the network
  // write, then — only once it lands — notify the parent.
  //
  // Order matters. The parent's onActiveTurnsChanged re-pulls THIS chat from the
  // DB to refresh the live cosine-grep corpus (chatLog). If we notified before
  // the PUT, that GET could resolve while the write was still in flight and
  // re-cache stale, pre-gate flags — so the next grep would still retrieve a
  // turn the editor and DB both show as gated off. PUT → then notify guarantees
  // the reload reads post-write state. On failure we revert the editor's
  // optimistic flip (pure, idempotent) and do NOT sync the parent: the DB never
  // changed, so chatLog must stay as it was.
  //
  // Side effects stay OUT of the setTurns updater on purpose: StrictMode
  // double-invokes updaters in dev, which would otherwise fire the write twice.
  // The updater is pure; the PUT runs after it, below.
  const persist = useCallback(
    (changes: TurnActiveState[]) => {
      if (changes.length === 0) return;
      setTurns((prev) => applyFlips(prev, changes));
      apiSetTurnsActive(chatId, changes)
        .then(() => onActiveTurnsChanged(chatId, changes))
        .catch((err) => {
          console.warn('setTurnsActive failed:', err);
          const inverse = changes.map((c) => ({ id: c.id, active: !c.active }));
          setTurns((prev) => applyFlips(prev, inverse));
        });
    },
    [chatId, onActiveTurnsChanged],
  );

  const toggleOne = useCallback(
    (turn: ChatTurn) => persist([{ id: turn.id, active: !turn.active }]),
    [persist],
  );

  // Set every turn (or every currently-active/inactive turn) to `active`, sending
  // only the turns that actually change so the revert path stays precise.
  // Timeless (manual) turns are never gated — they have no toggle — so they're
  // excluded from mass actions; flipping their active flag would silently break
  // the "always retrievable" contract their card UI promises.
  const setAll = useCallback(
    (active: boolean) =>
      persist(turns.filter((t) => !t.timeless && t.active !== active).map((t) => ({ id: t.id, active }))),
    [persist, turns],
  );

  const applyToSelected = useCallback(
    (active: boolean) =>
      persist(
        turns
          .filter((t) => !t.timeless && selected.has(t.id) && t.active !== active)
          .map((t) => ({ id: t.id, active })),
      ),
    [persist, turns, selected],
  );

  const toggleSelectMode = useCallback(() => {
    setSelectMode((m) => !m);
    setSelected(new Set());
  }, []);

  const toggleSelection = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Filter for display while preserving each turn's original position, so the
  // T-NN tag reflects where the turn sits in the chat, not in the filtered view.
  const indexed = useMemo(
    () => turns.map((turn, i) => ({ turn, ordinal: i + 1 })),
    [turns],
  );
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return indexed;
    return indexed.filter(({ turn }) => turn.content.toLowerCase().includes(needle));
  }, [indexed, query]);

  return (
    // min-w-0 so this flex child can shrink below its content's intrinsic width
    // (the grid + stats strip) instead of overflowing the dialog on narrow screens.
    // `relative` anchors the Add Memory overlay to the editor panel.
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Header — back + title */}
      <div className="flex items-center gap-3 border-b border-hairline px-7 pt-6 pb-5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to history"
          className="flex size-9 shrink-0 items-center justify-center rounded-full border border-hairline-strong bg-surface-thin text-fg-2 transition-colors hover:border-ember hover:text-ember"
        >
          <ArrowLeft className="size-4" />
        </button>
        <div className="min-w-0">
          <div className={STAT_LABEL}>Editing · chat memory</div>
          <h2
            className="mt-1 truncate font-serif text-[22px] italic leading-tight text-fg-1"
          >
            {resolvedTitle}
          </h2>
        </div>
      </div>

      {/* Stats strip — active count · coverage bar · % */}
      <div className="flex items-center gap-6 border-b border-hairline px-7 py-4">
        <div className="shrink-0">
          <div className="font-serif text-[26px] italic leading-none text-fg-1">
            {activeCount}
            <span className="text-fg-3">/{total}</span>
          </div>
          <div className={cn(STAT_LABEL, 'mt-1.5')}>Turns active</div>
        </div>
        <div className="relative h-[3px] flex-1 overflow-hidden rounded-sm bg-hairline-strong">
          <span
            className="absolute left-0 top-0 h-full rounded-sm bg-linear-to-r from-ember-soft to-ember transition-[width] duration-500"
            style={{ width: `${coverage}%` }}
          />
        </div>
        <div className="shrink-0 text-right">
          <div className="font-serif text-[26px] italic leading-none text-fg-1">
            {coverage}<span className="text-[15px] text-fg-3">%</span>
          </div>
          <div className={cn(STAT_LABEL, 'mt-1.5')}>Cosine grep coverage</div>
        </div>
      </div>

      {/* Tools — turn search + mass actions */}
      <div className="flex flex-wrap items-center gap-3 px-7 pt-4 pb-3">
        <div className="relative flex min-w-[200px] flex-1 items-center">
          <Search className="pointer-events-none absolute left-3.5 size-[15px] text-fg-4" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search turns."
            className="w-full rounded-[14px] border border-hairline-strong bg-surface py-2.5 pl-10 pr-4 text-[13.5px] text-fg-1 outline-none placeholder:text-fg-4 focus:border-ember/55"
          />
        </div>

        {selectMode ? (
          <div className="flex items-center gap-2">
            <span className="mr-1 font-mono text-[11px] tracking-[0.04em] text-fg-3">
              {selected.size} selected
            </span>
            <ToolButton onClick={() => setSelected(new Set(turns.filter((t) => !t.timeless).map((t) => t.id)))}>All</ToolButton>
            <ToolButton onClick={() => setSelected(new Set())}>None</ToolButton>
            <span className="mx-0.5 h-4 w-px bg-hairline-strong" aria-hidden="true" />
            <ToolButton onClick={() => applyToSelected(true)} disabled={selected.size === 0}>On</ToolButton>
            <ToolButton onClick={() => applyToSelected(false)} disabled={selected.size === 0}>Off</ToolButton>
            <ToolButton onClick={toggleSelectMode} accent>Done</ToolButton>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <ToolButton onClick={toggleSelectMode}>Select</ToolButton>
            <span className="mx-0.5 h-4 w-px bg-hairline-strong" aria-hidden="true" />
            <ToolButton onClick={() => setAll(true)}>All on</ToolButton>
            <ToolButton onClick={() => setAll(false)}>All off</ToolButton>
          </div>
        )}
      </div>

      {/* Grid */}
      <div className="@container sal-scroll min-h-0 flex-1 overflow-y-auto px-7 pb-7 pt-1">
        {!loaded ? (
          <div className="px-2 py-12 text-center text-[13px] italic text-fg-3">Reading the chat…</div>
        ) : total === 0 ? (
          <div className="px-2 py-12 text-center text-[13px] italic text-fg-3">
            This chat has no turns yet.
          </div>
        ) : visible.length === 0 ? (
          <div className="px-2 py-12 text-center text-[13px] italic text-fg-3">
            Nothing in this chat matches that.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 @[480px]:grid-cols-2 @[720px]:grid-cols-3 @[960px]:grid-cols-4">
            {visible.map(({ turn, ordinal }) => (
              <TurnCard
                key={turn.id}
                turn={turn}
                ordinal={ordinal}
                selectMode={selectMode}
                selected={selected.has(turn.id)}
                onToggle={() => toggleOne(turn)}
                onSelect={() => toggleSelection(turn.id)}
                onDelete={() => handleDeleteMemory(turn)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Add Memory overlay — surgical insertion of a timeless turn-pair. */}
      {addOpen && (
        <AddMemoryForm onSubmit={handleAddMemory} onCancel={() => onAddOpenChange(false)} />
      )}
    </div>
  );
}

// ============================================================
// ADD MEMORY FORM — a modal sheet over the editor. Captures a full turn (a
// user line + an assistant line); on submit the pair is inserted as the chat's
// oldest, timeless turns. Owns its own draft + submit/error state so a failed
// write keeps the typed text on screen.
// ============================================================

function AddMemoryForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (user: string, assistant: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [user, setUser] = useState('');
  const [assistant, setAssistant] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = user.trim().length > 0 && assistant.trim().length > 0 && !submitting;

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(user, assistant);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add memory.');
      setSubmitting(false);
    }
    // On success the parent unmounts this form (addOpen → false); no need to
    // reset submitting — the component is gone.
  }, [canSubmit, onSubmit, user, assistant]);

  // Contain focus within the sheet. The modal's dialog-level trap cycles across
  // every focusable in the dialog — including the Add-memory / X chrome behind
  // this overlay — so without this a Tab from a textarea would land on a control
  // the user can't even see. We wrap first↔last within the sheet and stop the
  // event so the dialog trap doesn't also act on it (its document listener sits
  // above React's root, so stopPropagation on the synthetic event reaches it).
  const sheetRef = useRef<HTMLDivElement>(null);
  const onKeyDownTrap = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !sheetRef.current) return;
    const f = sheetRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input, textarea, select, [href], [tabindex]:not([tabindex="-1"])',
    );
    if (f.length === 0) return;
    e.stopPropagation();
    const first = f[0];
    const last = f[f.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  return (
    <div
      className="absolute inset-0 z-20 flex items-start justify-center overflow-y-auto bg-ground/70 p-6 backdrop-blur-[6px]"
      onKeyDown={onKeyDownTrap}
    >
      <div ref={sheetRef} className="mt-2 w-full max-w-[560px] rounded-2xl border border-hairline-strong bg-surface shadow-glass">
        <div className="flex items-start justify-between gap-3 border-b border-hairline px-6 pt-5 pb-4">
          <div>
            <div className={STAT_LABEL}>Add memory · timeless</div>
            <h3 className="mt-1 font-serif text-[20px] italic leading-tight text-fg-1">
              Insert a turn
            </h3>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel adding a memory"
            className="flex size-7 shrink-0 items-center justify-center rounded-full border border-hairline-strong bg-surface-thin text-fg-3 transition-colors hover:border-ember hover:text-ember"
          >
            <X className="size-[13px]" />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-6 py-5">
          <p className="text-[12.5px] leading-relaxed text-fg-3">
            This becomes the oldest turn in the chat and is flagged
            {' '}<span className="text-ember-soft">timeless</span> — retrievable by the
            cosine grep like any other turn, but immune to recency scoring.
          </p>
          <Field label="You said">
            <textarea
              autoFocus
              value={user}
              onChange={(e) => setUser(e.target.value)}
              rows={3}
              placeholder="The user half of the turn."
              className="w-full resize-y rounded-[12px] border border-hairline-strong bg-surface-thin px-3.5 py-2.5 font-serif text-[15px] italic leading-relaxed text-fg-1 outline-none placeholder:not-italic placeholder:font-sans placeholder:text-fg-4 focus:border-ember/55"
            />
          </Field>
          <Field label="Sal replied">
            <textarea
              value={assistant}
              onChange={(e) => setAssistant(e.target.value)}
              rows={4}
              placeholder="The assistant half of the turn."
              className="w-full resize-y rounded-[12px] border border-hairline-strong bg-surface-thin px-3.5 py-2.5 text-[13.5px] leading-relaxed text-fg-1 outline-none placeholder:text-fg-4 focus:border-ember/55"
            />
          </Field>
          {error && (
            <div className="rounded-[10px] border border-danger/40 bg-danger/[0.08] px-3.5 py-2.5 text-[12.5px] text-danger">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-hairline px-6 py-4">
          <ToolButton onClick={onCancel}>Cancel</ToolButton>
          <ToolButton onClick={submit} disabled={!canSubmit} accent>
            {submitting ? 'Adding…' : 'Add memory'}
          </ToolButton>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className={STAT_LABEL}>{label}</span>
      {children}
    </label>
  );
}

// ============================================================
// TOOL BUTTON — the small pill used across the tools row.
// ============================================================

function ToolButton({
  children,
  onClick,
  disabled,
  accent,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'rounded-full border px-3 py-1.5 font-mono text-[11px] tracking-[0.04em] transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        accent
          ? 'border-ember bg-ember/[0.12] text-ember hover:bg-ember/20'
          : 'border-hairline-strong bg-surface-thin text-fg-2 hover:border-ember hover:text-ember',
      )}
    >
      {children}
    </button>
  );
}

// ============================================================
// TURN CARD — frosted glass, one per stored message.
// ============================================================

interface TurnCardProps {
  turn: ChatTurn;
  ordinal: number;
  selectMode: boolean;
  selected: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onDelete: () => void;
}

function TurnCard({ turn, ordinal, selectMode, selected, onToggle, onSelect, onDelete }: TurnCardProps) {
  const isUser = turn.role === 'user';
  const tag = `T-${String(ordinal).padStart(2, '0')}`;
  const timeless = turn.timeless;
  // Manual (timeless) cards opt out of gating entirely: no toggle, no select,
  // always retrievable. They get a delete control + a gradient fill instead.
  const selectable = selectMode && !timeless;

  return (
    <div
      className={cn(
        'group flex h-[176px] flex-col rounded-2xl border p-3.5 backdrop-blur-[6px] transition-all duration-200',
        timeless
          // Subtle ember gradient fill marks a hand-inserted, timeless memory.
          ? 'border-ember/30 bg-linear-to-br from-ember/[0.12] via-ember/[0.04] to-transparent'
          : cn('bg-surface-thin', turn.active ? 'border-hairline-strong' : 'border-hairline opacity-35'),
        selectable && 'cursor-pointer',
        selectable && selected
          ? 'border-ember shadow-[inset_0_0_0_1px_var(--color-ember),0_0_18px_-6px_var(--color-ember)]'
          : selectable && 'hover:border-ember/50',
      )}
      onClick={selectable ? onSelect : undefined}
      role={selectable ? 'button' : undefined}
      aria-pressed={selectable ? selected : undefined}
    >
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10.5px] tracking-[0.06em] text-fg-3">{tag}</span>
          <span
            className={cn(
              'rounded-full border px-2 py-0.5 font-mono text-[9.5px] font-medium tracking-[0.1em] uppercase',
              isUser
                ? 'border-ember/40 bg-ember/[0.08] text-ember'
                : 'border-hairline-strong text-fg-3',
            )}
          >
            {isUser ? 'You' : 'Sal'}
          </span>
          {/* Quiet meta: "timeless" for manual entries (recency negated), else
              the relative-time stamp — the time scorer's dimension made visible
              alongside the T-NN tag. */}
          {timeless ? (
            <span className="font-mono text-[9.5px] tracking-[0.1em] uppercase text-ember-soft">
              timeless
            </span>
          ) : (
            <span className="font-mono text-[9.5px] tracking-[0.04em] text-fg-4">
              {formatRelative(turn.createdAt, Date.now())}
            </span>
          )}
        </div>
        {timeless ? (
          <TurnDelete onClick={onDelete} />
        ) : selectMode ? (
          <span
            className={cn(
              'flex size-[18px] items-center justify-center rounded-full border text-[10px]',
              selected ? 'border-ember bg-ember text-bone' : 'border-hairline-strong text-transparent',
            )}
            aria-hidden="true"
          >
            ✓
          </span>
        ) : (
          <TurnToggle on={turn.active} onClick={onToggle} />
        )}
      </div>
      <div
        className={cn(
          'min-h-0 flex-1 overflow-hidden text-[13px] leading-[1.5] text-fg-1 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:5]',
          isUser && 'font-serif text-[15px] italic text-fg-1',
        )}
      >
        {turn.content}
      </div>
    </div>
  );
}

// ============================================================
// TURN DELETE — the per-card trash control shown on timeless (manual) cards in
// place of the gate toggle. Removes both halves of the inserted pair.
// ============================================================

function TurnDelete({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label="Delete this memory"
      className="flex size-[22px] shrink-0 items-center justify-center rounded-full border border-hairline-strong bg-surface-thin/60 text-fg-3 transition-colors hover:border-danger hover:text-danger"
    >
      <Trash2 className="size-[12px]" />
    </button>
  );
}

// ============================================================
// TURN TOGGLE — the per-card pill switch. Ember when on.
// ============================================================

function TurnToggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      role="switch"
      aria-checked={on}
      aria-label={on ? 'Retrievable — switch off' : 'Gated off — switch on'}
      className={cn(
        'relative h-[18px] w-[32px] shrink-0 rounded-full border transition-colors',
        on ? 'border-ember bg-ember/80' : 'border-hairline-strong bg-surface-strong',
      )}
    >
      <span
        className={cn(
          'absolute top-1/2 size-[12px] -translate-y-1/2 rounded-full transition-all',
          on ? 'left-[16px] bg-bone' : 'left-[2px] bg-fg-3',
        )}
      />
    </button>
  );
}
