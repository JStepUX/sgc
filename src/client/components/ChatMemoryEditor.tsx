import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
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
  onBack: () => void;
  /**
   * Fired after each gate change with the turns that flipped. The parent uses
   * it to keep the live chat's in-memory log in sync, so the next turn's cosine
   * grep honors the gate without a reload.
   */
  onActiveTurnsChanged: (chatId: string, states: TurnActiveState[]) => void;
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
  onBack,
  onActiveTurnsChanged,
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
  // The updater is pure. (Same trap the confidence-scoring path in
  // SalienceGatedCognition.tsx documents.)
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
  const setAll = useCallback(
    (active: boolean) =>
      persist(turns.filter((t) => t.active !== active).map((t) => ({ id: t.id, active }))),
    [persist, turns],
  );

  const applyToSelected = useCallback(
    (active: boolean) =>
      persist(
        turns
          .filter((t) => selected.has(t.id) && t.active !== active)
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
            <ToolButton onClick={() => setSelected(new Set(turns.map((t) => t.id)))}>All</ToolButton>
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
              />
            ))}
          </div>
        )}
      </div>
    </div>
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
}

function TurnCard({ turn, ordinal, selectMode, selected, onToggle, onSelect }: TurnCardProps) {
  const isUser = turn.role === 'user';
  const tag = `T-${String(ordinal).padStart(2, '0')}`;

  return (
    <div
      className={cn(
        'group flex h-[176px] flex-col rounded-2xl border bg-surface-thin p-3.5 backdrop-blur-[6px] transition-all duration-200',
        turn.active ? 'border-hairline-strong' : 'border-hairline opacity-35',
        selectMode && 'cursor-pointer',
        selectMode && selected
          ? 'border-ember shadow-[inset_0_0_0_1px_var(--color-ember),0_0_18px_-6px_var(--color-ember)]'
          : selectMode && 'hover:border-ember/50',
      )}
      onClick={selectMode ? onSelect : undefined}
      role={selectMode ? 'button' : undefined}
      aria-pressed={selectMode ? selected : undefined}
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
          {/* Quiet relative-time stamp — the time scorer's dimension made
              visible alongside the T-NN tag. Muted to match the existing meta
              row weight. */}
          <span className="font-mono text-[9.5px] tracking-[0.04em] text-fg-4">
            {formatRelative(turn.createdAt, Date.now())}
          </span>
        </div>
        {selectMode ? (
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
