import { memo, useState, useRef, useEffect, useCallback, isValidElement } from 'react';
import { ArrowUp, Clock, PanelRightClose, PanelRightOpen, Pencil, Plus, Settings } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeQuotes from './lib/rehype-quotes';
import { MermaidBlock } from './components/MermaidBlock';
import type { Memory, ChatEntry, FetchedDoc, TurnSummary } from './lib/types';
import { assembleTurnContext } from './lib/turn-context';
import {
  DEFAULT_PERSONA,
  estimateNaiveContextTokens,
  parseTurnResponse,
  stripStreamingMeta,
} from './lib/prompt';
import { runTurn, extractUrls, fetchUrl, type ProviderId } from './lib/api';
import {
  createChat as apiCreateChat,
  deleteChat as apiDeleteChat,
  listChats as apiListChats,
  loadChat as apiLoadChat,
  saveMemories as apiSaveMemories,
  savePromptVersion as apiSavePromptVersion,
  saveTurn as apiSaveTurn,
  updateTurn as apiUpdateTurn,
  type ChatSummary,
  type PromptVersion,
  type TurnActiveState,
} from './lib/persistence';
import { ChatHistoryModal } from './components/ChatHistoryModal';
import { ConfirmPersonaModal } from './components/ConfirmPersonaModal';
import { PromptEditorModal } from './components/PromptEditorModal';
import { ProviderConfigModal } from './components/ProviderConfigModal';
import { EditResponseModal, type RespinResult } from './components/EditResponseModal';
import { getDesktop, isDesktop, type DesktopConfigPatch, type DesktopConfigState } from './lib/desktop';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

// ============================================================
// SALIENCE-GATED COGNITION — Phase 1.5
// Ephemeral Sal + TF-IDF Cosine Grep + 2-Turn Local Buffer
// No model-based retrieval. One reasoning component. One API call.
//
// The pure logic (TF-IDF engine, prompt builder, transport) lives in ./lib.
// This file is the React surface only. Styling is Tailwind v4 utilities +
// shadcn/ui primitives; the design tokens and aurora CSS live in index.css.
// The architecture and the Phase 1.5 invariants above are untouched.
// ============================================================

// ============================================================
// TURN DIAGNOSTICS TYPES
// ============================================================

interface GrepDetail {
  turnIndex: number;
  score: number;
  preview: string;
}

interface TurnData {
  turnNumber: number;
  inputTokens: number;
  outputTokens: number;
  totalLatency: number;
  localBufferSize: number;
  grepFired: boolean;
  grepMatches: number;
  grepDetails: GrepDetail[] | null;
  /**
   * Sal's per-turn summary (persistent / volatile / established_patterns),
   * parsed from the `<turn-summary>` block. Persisted in this turn's
   * inspector_json so it survives reload and rehydrates onto the message.
   */
  summary: TurnSummary | null;
  /**
   * Estimated tokens the naive "send everything every turn" baseline would
   * have used (persona + memories + full chat history + user input). The
   * delta vs `inputTokens` is the SGC savings. Optional because turns
   * persisted before this field existed don't carry it.
   */
  naiveTokens?: number;
}

interface TokenHistoryEntry {
  turn: number;
  inputTokens: number;
}

/**
 * Pull a turn's summary back out of its persisted inspector_json blob (the
 * TurnData stored on save) so a reloaded assistant turn can rehydrate its dimmed
 * summary line. Tolerant: a null blob, a parse failure, or an old turn saved
 * before summaries existed all yield undefined (nothing renders).
 */
function summaryFromInspector(inspectorJson: string | null): TurnSummary | undefined {
  if (!inspectorJson) return undefined;
  try {
    return (JSON.parse(inspectorJson) as Partial<TurnData>).summary ?? undefined;
  } catch {
    return undefined;
  }
}

// ============================================================
// PROVIDER SWITCHER TYPES
// Mirrors GET /api/health. The client only ever holds a provider TOKEN; the
// server owns keys/URLs. A local model is just a different (still ephemeral)
// Sal — switching mid-chat is harmless (no state carried).
// ============================================================

interface ProviderInfo {
  available: boolean;
  model: string;
  label?: string;
}

interface HealthResponse {
  ok: boolean;
  default: ProviderId | null;
  providers: Record<ProviderId, ProviderInfo>;
}

// User-facing label: 'openai' is the dialect it speaks, but it runs LOCALly.
// This is the single mapping site (spec: api_choice.naming.mapping_location).
const PROVIDER_LABEL: Record<ProviderId, string> = {
  anthropic: 'ANTHROPIC',
  openai: 'LOCAL',
};

const PROVIDER_LS_KEY = 'sgc.provider';
const PROVIDER_ORDER: ProviderId[] = ['anthropic', 'openai'];

// Context-rail collapse state — persisted so the layout choice survives a reload.
const RAIL_LS_KEY = 'sgc.railCollapsed';

// Shared label style for the context rail's section headers.
const RAIL_LABEL = 'font-mono text-[11px] tracking-[0.18em] uppercase text-fg-3 mb-1';
const RAIL_SUB = 'font-mono text-[10.5px] tracking-[0.16em] uppercase text-fg-3 mt-1.5';

// ============================================================
// AURORA — the warm field behind the glass. Drifts only while the
// user is active; each keystroke sends a synth-style pulse up from
// the bottom. The aurora is the thinking made visible. (See index.css.)
// ============================================================

// Memoized so cascading parent re-renders (from typing, scrolling, streaming
// tokens arriving) don't reapply the filter chain or remount the pulse layer.
// Only true changes to `gate`, `active`, or `pulseKey` should touch this tree.
const AuroraBackground = memo(function AuroraBackground({
  gate,
  active,
  pulseKey,
}: {
  gate: number;
  active: boolean;
  pulseKey: number;
}) {
  const sat = 80 + gate * 30;
  const bright = 0.92 + gate * 0.08;
  return (
    <div
      className="sal-aurora"
      data-active={active}
      style={{ filter: `saturate(8%) brightness(0.34) saturate(${sat}%) brightness(${bright})` }}
      aria-hidden="true"
    >
      <div className="sal-aurora-base" />
      <div className="sal-aurora-grain" />
      {/* Re-keyed when a pulse fires so React remounts it and the animation restarts.
          Throttled upstream — see Composer — so we don't remount a 28px-blurred
          layer on every keystroke. */}
      <div className="sal-aurora-pulse" key={pulseKey} />
    </div>
  );
});

// ============================================================
// PROVIDER CHIP — clickable badge that opens an anchored popover to switch the
// model backing Sal. Replaces the old static PHASE 1.5 badge: the phase label
// was low-value signage, the switcher earns the spot. Hand-rolled popover (no
// new modal/Radix infra) — a positioned div with an outside-click + Escape
// dismiss. Selecting commits to state + localStorage and applies to the NEXT
// turn. Per provider, a status dot mirrors availability (success = configured,
// danger = not). Unconfigured rows stay clickable (dimmed) and open the
// ProviderConfigModal instead of switching (D5); configured rows reveal a gear
// on hover/focus that opens the same modal pre-filled without switching.
// ============================================================

const ProviderChip = memo(function ProviderChip({
  provider,
  health,
  processing,
  onSelect,
  onConfigure,
}: {
  provider: ProviderId;
  health: HealthResponse | null;
  processing: boolean;
  onSelect: (p: ProviderId) => void;
  onConfigure: (p: ProviderId) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Dismiss on outside-click or Escape while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Unconfigured providers don't switch — they raise onConfigure so the
  // parent opens the ProviderConfigModal for that provider (D5).
  const choose = (p: ProviderId) => {
    const available = health?.providers[p]?.available ?? false;
    setOpen(false);
    if (!available) {
      onConfigure(p);
      return;
    }
    onSelect(p);
  };

  const currentAvailable = health?.providers[provider]?.available;

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        // Mirrors "Begin again": disabled while a turn is processing so the
        // backing model can't change mid-turn.
        disabled={processing}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-full border border-ember/35 bg-ember/[0.08] px-2.5 py-1 font-mono text-[11px] font-medium tracking-[0.08em] text-ember transition-colors hover:bg-ember/[0.14] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {/* Status dot for the CURRENT provider — rendered once health is known. */}
        {currentAvailable !== undefined && (
          <span
            aria-hidden="true"
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              currentAvailable
                ? 'bg-success shadow-[0_0_6px_var(--color-success)]'
                : 'bg-danger shadow-[0_0_6px_var(--color-danger)]',
            )}
          />
        )}
        {PROVIDER_LABEL[provider]}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-[calc(100%+8px)] z-40 w-60 rounded-lg border border-hairline bg-ground/95 p-1.5 shadow-xl backdrop-blur-md"
        >
          <div className="px-2 pb-1.5 pt-1 font-mono text-[10px] tracking-[0.18em] uppercase text-fg-3">
            Reasoning model
          </div>
          {PROVIDER_ORDER.map((p) => {
            const info = health?.providers[p];
            const available = info?.available ?? false;
            const selected = p === provider;
            // Rows are a relative wrapper with the select <button> plus an
            // absolutely-positioned SIBLING gear <button> — nested <button>s
            // are invalid HTML. stopPropagation keeps gear-click off choose().
            return (
              <div key={p} className="group relative">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => choose(p)}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 rounded-md py-1.5 pl-2 text-left transition-colors',
                    available ? 'pr-8 hover:bg-fg-1/[0.06]' : 'pr-2 opacity-40 hover:opacity-60',
                    selected && 'bg-ember/[0.1]',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'size-1.5 shrink-0 rounded-full',
                        available
                          ? 'bg-success shadow-[0_0_6px_var(--color-success)]'
                          : 'bg-danger shadow-[0_0_6px_var(--color-danger)]',
                      )}
                    />
                    <span className="flex flex-col">
                      <span className="font-mono text-[11px] tracking-[0.06em] text-fg-1">
                        {PROVIDER_LABEL[p]}
                      </span>
                      <span className="font-mono text-[10px] text-fg-3">
                        {info?.model ?? '—'}
                        {!available && ' · not configured — click to set up'}
                      </span>
                    </span>
                  </span>
                  {selected && available && (
                    <span className="size-1.5 shrink-0 rounded-full bg-ember shadow-[0_0_8px_var(--color-ember)]" />
                  )}
                </button>
                {available && (
                  <button
                    type="button"
                    aria-label={`Configure ${PROVIDER_LABEL[p]}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpen(false);
                      onConfigure(p);
                    }}
                    className="absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-fg-3 opacity-0 transition-opacity hover:bg-fg-1/[0.08] hover:text-fg-1 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
                  >
                    <Settings className="size-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

// ============================================================
// PHASE BAR — title, provider switcher chip, run-mode metadata, begin-again.
// ============================================================

const PhaseBar = memo(function PhaseBar({
  processing,
  onReset,
  provider,
  health,
  onSelectProvider,
  onConfigureProvider,
}: {
  processing: boolean;
  onReset: () => void;
  provider: ProviderId;
  health: HealthResponse | null;
  onSelectProvider: (p: ProviderId) => void;
  onConfigureProvider: (p: ProviderId) => void;
}) {
  // All three remain true on the local path (one request to one model; TF-IDF
  // grep and the 2-turn buffer are client-side and provider-agnostic).
  const meta = ['1 API call/turn', 'TF-IDF Grep', '2-turn buffer'];
  return (
    <header className="sal-topbar relative z-30 flex shrink-0 flex-wrap items-center justify-between gap-y-2 border-b border-hairline px-7 pt-[18px] pb-4 backdrop-blur-[8px]">
      <div className="flex items-center gap-[14px]">
        <span
          className="size-2 shrink-0 rounded-full bg-ember shadow-[0_0_10px_var(--color-ember)] animate-pulse-dot"
          aria-hidden="true"
        />
        <span className="text-base font-semibold tracking-[-0.005em] text-fg-1">
          Salience-Gated Cognition
        </span>
        <ProviderChip
          provider={provider}
          health={health}
          processing={processing}
          onSelect={onSelectProvider}
          onConfigure={onConfigureProvider}
        />
      </div>
      <div className="flex items-center gap-[14px]">
        {processing && (
          <span className="font-mono text-[11px] tracking-[0.04em] text-ember animate-considering">
            considering
          </span>
        )}
        <span className="hidden items-center gap-2 font-mono text-[11px] tracking-[0.04em] text-fg-3 md:flex">
          {meta.map((m, i) => (
            <span key={i} className="flex items-center gap-2">
              {i > 0 && <span className="text-fg-4">·</span>}
              <span>{m}</span>
            </span>
          ))}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={onReset}
          disabled={processing}
          className="font-mono text-[11px] text-fg-3"
        >
          Begin again
        </Button>
      </div>
    </header>
  );
});

// ============================================================
// MEMORY PANEL — Constitutional Memories.
// ============================================================

interface MemoryPanelProps {
  memories: Memory[];
  onUpdate: (id: string, newText: string) => void;
  onAdd: (text: string) => void;
  onRemove: (id: string) => void;
  // The live system-prompt version label + a handler to open the editor. Passed
  // as primitives (number + stable callback) rather than a ReactNode so this
  // memoized panel still skips re-renders during streaming / typing.
  promptVersionN: number;
  onOpenPromptEditor: () => void;
  // Disabled until the active chat id is ready (pre-hydration / mid chat-swap /
  // hydration failure) — there'd be no chat to scope the edit to.
  promptEditorDisabled: boolean;
}

const MemoryPanel = memo(function MemoryPanel({
  memories,
  onUpdate,
  onAdd,
  onRemove,
  promptVersionN,
  onOpenPromptEditor,
  promptEditorDisabled,
}: MemoryPanelProps) {
  const [newMemText, setNewMemText] = useState('');

  const submitNew = () => {
    if (newMemText.trim()) {
      onAdd(newMemText.trim());
      setNewMemText('');
    }
  };

  return (
    <section className="flex flex-col gap-2.5">
      {/* Header: section label + the System Prompt editor button (top-right). */}
      <div className="mb-1 flex items-center justify-between gap-2.5">
        <span className="font-mono text-[11px] tracking-[0.18em] uppercase text-fg-3">
          Constitutional Memories
        </span>
        <button
          type="button"
          onClick={onOpenPromptEditor}
          disabled={promptEditorDisabled}
          aria-label="Edit this chat's system prompt"
          className="shrink-0 whitespace-nowrap rounded-md border border-hairline-strong px-2.5 py-1.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-ember transition-colors hover:border-ember/60 hover:bg-ember/[0.08] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-hairline-strong disabled:hover:bg-transparent"
        >
          <span className="text-fg-4">[</span> System Prompt{' '}
          <span className="text-fg-2">v{promptVersionN}</span>{' '}
          <span className="text-fg-4">]</span>
        </button>
      </div>

      <div className="flex flex-col gap-2.5">
        {memories.map((mem, i) => (
          <Card
            key={mem.id}
            className="gap-0 rounded-[14px] border px-[14px] pt-[14px] pb-3 shadow-none transition-colors"
          >
            <div className="mb-2 flex items-baseline justify-between font-mono text-[10.5px] tracking-[0.08em] text-fg-3">
              <span className="text-fg-2">M{i + 1}</span>
              <button
                className="cursor-pointer px-0.5 text-sm leading-none text-fg-4 transition-colors hover:text-danger"
                onClick={() => onRemove(mem.id)}
                aria-label="Remove memory"
              >×</button>
            </div>
            <div
              className="min-h-[18px] cursor-text rounded-[3px] text-[13px] leading-[1.5] text-fg-1 outline-none focus:ring-2 focus:ring-ember/40"
              contentEditable
              suppressContentEditableWarning
              onBlur={(e) => onUpdate(mem.id, e.currentTarget.textContent ?? '')}
            >{mem.text}</div>
          </Card>
        ))}
      </div>

      <div className="mt-1 flex gap-1.5">
        <input
          value={newMemText}
          onChange={(e) => setNewMemText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submitNew(); }}
          placeholder="Add memory..."
          className="flex-1 rounded-[10px] border bg-surface px-3 py-2 text-[12.5px] text-fg-1 outline-none placeholder:text-fg-4 focus:border-ember/45"
        />
        <Button
          variant="outline"
          size="icon"
          onClick={submitNew}
          aria-label="Add memory"
          className="size-8 rounded-[10px] text-ember"
        ><Plus className="size-3.5" /></Button>
      </div>
    </section>
  );
});

// ============================================================
// TURN INSPECTOR — Architecture Trace, status, citations, deltas.
// ============================================================

const TurnInspector = memo(function TurnInspector({ turnData }: { turnData: TurnData | null }) {
  if (!turnData) {
    return <div className="py-2 text-[12.5px] italic text-fg-3">Nothing yet. Say something.</div>;
  }

  const metrics = [
    { value: turnData.inputTokens.toLocaleString(), label: 'Input tk' },
    { value: turnData.outputTokens.toLocaleString(), label: 'Output tk' },
    { value: `${(turnData.totalLatency / 1000).toFixed(1)}s`, label: 'Latency' },
  ];

  return (
    <section className="flex flex-col gap-2.5">
      <div className={RAIL_LABEL}>Turn {turnData.turnNumber} Diagnostics</div>

      <div className={RAIL_SUB}>Architecture Trace</div>
      <div className="grid grid-cols-3 gap-2">
        {metrics.map((m) => (
          <Card key={m.label} className="gap-0 rounded-xl border px-2 py-3 text-center shadow-none">
            <div className="font-mono text-lg font-medium tracking-[-0.01em] text-ember">{m.value}</div>
            <div className="mt-1 font-mono text-[9.5px] uppercase tracking-[0.16em] text-fg-3">{m.label}</div>
          </Card>
        ))}
      </div>

      <ul className="mt-2 mb-1 flex list-none flex-col gap-1.5 p-0">
        <li className="flex items-center gap-2 font-mono text-[11px] tracking-[0.02em] text-fg-2">
          <span className="size-[5px] shrink-0 rounded-full bg-ember" />
          Local buffer: {turnData.localBufferSize > 0 ? `${turnData.localBufferSize} msgs` : 'empty (turn 1)'}
        </li>
        <li className="flex items-center gap-2 font-mono text-[11px] tracking-[0.02em] text-fg-2">
          <span className="size-[5px] shrink-0 rounded-full bg-ember" />
          Cosine Grep: {turnData.grepFired
            ? `${turnData.grepMatches} match${turnData.grepMatches !== 1 ? 'es' : ''}`
            : 'no matches above threshold'}
        </li>
      </ul>

      {turnData.grepFired && turnData.grepDetails && (
        <div className="mt-1 flex flex-col gap-2">
          {turnData.grepDetails.map((g, i) => (
            <Card
              key={i}
              className="gap-0 rounded-[4px_10px_10px_4px] border border-l-2 border-l-ember px-3 py-2.5 shadow-none"
            >
              <div className="mb-1 flex items-baseline gap-3 font-mono text-[10.5px] text-fg-3">
                <span className="font-medium text-fg-1">Turn {g.turnIndex}</span>
                <span>score: {g.score.toFixed(3)}</span>
              </div>
              <div className="overflow-hidden text-ellipsis whitespace-nowrap text-xs leading-[1.5] text-fg-2">
                {g.preview}
              </div>
            </Card>
          ))}
        </div>
      )}

      {(() => {
        // Context-savings card — the thesis of Phase 1.5 made legible.
        //
        // Left: what we actually sent (real `usage.input_tokens` from the API).
        // Right: what a naive "send the whole history every turn" pipeline
        // would have sent (estimated client-side, see lib/tokens.ts). The
        // ratio is the savings SGC's tiered curation buys.
        //
        // `naiveTokens` is optional — turns persisted before this field
        // existed don't carry it. Fall back to a quieter, single-number
        // variant in that case so old chat replays still render cleanly.
        const sent = turnData.inputTokens;
        const naive = turnData.naiveTokens ?? 0;
        const hasNaive = naive > 0;
        const savedPct = hasNaive && naive > sent
          ? Math.round(((naive - sent) / naive) * 100)
          : 0;
        return (
          <Card className="gap-0 rounded-xl border px-[14px] py-3 shadow-none">
            <div className={RAIL_SUB}>Context Savings</div>
            {hasNaive ? (
              <>
                <div className="mt-1.5 grid grid-cols-2 gap-2">
                  <div>
                    <div className="font-mono text-[18px] font-semibold leading-none text-ember">
                      {sent.toLocaleString()}
                    </div>
                    <div className="mt-1 font-mono text-[9.5px] uppercase tracking-[0.16em] text-fg-3">
                      Sent
                    </div>
                  </div>
                  <div>
                    <div className="font-mono text-[18px] font-medium leading-none text-fg-2">
                      ~{naive.toLocaleString()}
                    </div>
                    <div className="mt-1 font-mono text-[9.5px] uppercase tracking-[0.16em] text-fg-3">
                      Naive
                    </div>
                  </div>
                </div>
                {savedPct > 0 && (
                  <div className="mt-2.5 flex items-baseline gap-2 border-t border-hairline pt-2">
                    <span className="font-mono text-[15px] font-medium text-success">
                      −{savedPct}%
                    </span>
                    <span className="text-[10.5px] text-fg-3">
                      vs naive “send everything” baseline
                    </span>
                  </div>
                )}
                <div className="mt-1.5 text-[10.5px] leading-[1.4] text-fg-3">
                  Naive is an estimate (~4 chars / token). 1 API call this turn — Sal only.
                </div>
              </>
            ) : (
              <>
                <div className="mt-1.5 font-mono text-[22px] font-semibold text-ember">1</div>
                <div className="mt-0.5 text-[10.5px] text-fg-3">
                  Sal only. Grep is TF-IDF (0 ms).
                </div>
              </>
            )}
          </Card>
        );
      })()}

      {turnData.summary &&
        (turnData.summary.persistent.length > 0 ||
          turnData.summary.volatile.length > 0 ||
          turnData.summary.established_patterns.length > 0) && (
          <Card className="gap-0 rounded-xl border px-[14px] py-3 shadow-none">
            {/* The structured view of Sal's per-turn summary. The inspector is
                the diagnostics surface, so labelled lists are fine here — the
                in-message render stays a flat dimmed line. Empty sections are
                omitted so the card only shows what this turn actually observed. */}
            <div className={RAIL_SUB}>Turn Summary</div>
            {(
              [
                ['persistent', turnData.summary.persistent],
                ['volatile', turnData.summary.volatile],
                ['patterns', turnData.summary.established_patterns],
              ] as const
            ).map(([label, items]) =>
              items.length > 0 ? (
                <div key={label} className="mt-2">
                  <div className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-fg-4">
                    {label}
                  </div>
                  <ul className="mt-0.5 space-y-0.5">
                    {items.map((it, i) => (
                      <li key={i} className="text-[11px] leading-[1.4] text-fg-2">
                        {it}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null,
            )}
          </Card>
        )}
    </section>
  );
});

// ============================================================
// TOKEN CHART — payload size per turn.
// ============================================================

const TokenChart = memo(function TokenChart({ tokenHistory }: { tokenHistory: TokenHistoryEntry[] }) {
  if (tokenHistory.length < 2) return null;

  const maxTokens = Math.max(...tokenHistory.map((t) => t.inputTokens), 1);
  const chartWidth = 280;
  const chartHeight = 60;
  const barWidth = Math.min(16, (chartWidth - tokenHistory.length * 2) / tokenHistory.length);
  const avg = tokenHistory.reduce((s, t) => s + t.inputTokens, 0) / tokenHistory.length;

  return (
    <section className="flex flex-col gap-2.5">
      <div className={RAIL_LABEL}>Payload Size per Turn</div>
      <svg width={chartWidth} height={chartHeight + 16} className="block">
        {tokenHistory.map((t, i) => {
          const h = (t.inputTokens / maxTokens) * chartHeight;
          const x = i * (barWidth + 2);
          return (
            <g key={i}>
              <rect x={x} y={chartHeight - h} width={barWidth} height={h} rx={2} fill="var(--color-ember-soft)" opacity={0.7} />
              <text x={x + barWidth / 2} y={chartHeight + 12} textAnchor="middle" fontSize="9" fill="var(--color-fg-3)" fontFamily="var(--font-mono)">{i + 1}</text>
            </g>
          );
        })}
        {tokenHistory.length > 2 && (
          <line
            x1={0} y1={chartHeight - (avg / maxTokens) * chartHeight}
            x2={chartWidth} y2={chartHeight - (avg / maxTokens) * chartHeight}
            stroke="var(--color-ember)" strokeDasharray="3,3" opacity={0.45}
          />
        )}
      </svg>
    </section>
  );
});

// ============================================================
// MESSAGE BLOCKS — Sal's reply, the user's centred pills.
// ============================================================

// Flatten a turn summary into one natural-language line ("a, b, and c"). All
// three sections are concatenated in order — the in-message render deliberately
// drops the section labels (those live in the inspector's structured card) to
// stay a single ultra-subtle line that respects the reading column's vertical
// space. Returns '' when the turn observed nothing, so nothing renders.
function flattenSummary(s: TurnSummary): string {
  const items = [...s.persistent, ...s.volatile, ...s.established_patterns];
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

// Memoized so finalized messages don't re-run ReactMarkdown on every parent
// re-render (typing, pulse-key bumps, streaming token arrival). Only the
// in-flight streaming bubble re-renders as its `text` grows.
const AssistantMessage = memo(function AssistantMessage({
  text,
  streaming = false,
  label,
  summary,
  onEdit,
  canEdit = false,
}: {
  text: string;
  streaming?: boolean;
  /** Display-only author label for this turn. Falls back to "Sal" when empty.
   * NEVER sourced from / sent to the model — this is the per-chat mask. */
  label?: string;
  /** Sal's per-turn summary, rendered as a dimmed one-line appendage beneath the
   * reply. Absent while streaming and on turns that observed nothing. */
  summary?: TurnSummary;
  /** Open the response editor for this turn. Present only on the latest reply. */
  onEdit?: () => void;
  /** Whether the pencil is actionable (turn persisted + no turn in progress). */
  canEdit?: boolean;
}) {
  const name = label && label.trim() ? label : 'Sal';
  const summaryLine = summary ? flattenSummary(summary) : '';
  return (
    <div
      className={cn(
        'group relative flex flex-col gap-2 text-pretty text-[15px] font-light leading-[1.7] text-fg-1',
        streaming && 'sal-streaming',
      )}
    >
      <span className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-fg-3">
        {name}
      </span>
      {!streaming && onEdit && (
        // Hover-revealed pencil on the latest reply — opens the response editor
        // (manual edit / re-spin). Disabled until the turn has a DB id and no
        // turn is in flight, so Save always has an addressable target.
        <button
          type="button"
          onClick={onEdit}
          disabled={!canEdit}
          aria-label="Edit this response"
          title="Edit this response"
          className="absolute right-0 top-0 flex size-[26px] items-center justify-center rounded-full border border-hairline-strong bg-surface-thin text-fg-3 opacity-0 transition-opacity hover:border-ember hover:text-ember group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-0"
        >
          <Pencil className="size-[12.5px]" />
        </button>
      )}
      <div className="flex flex-col gap-3.5">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeQuotes]}
        components={{
          p: ({ node: _node, ...props }) => (
            <p {...props} className="m-0 whitespace-pre-wrap" />
          ),
          a: ({ node: _node, ...props }) => (
            <a
              {...props}
              target="_blank"
              rel="noopener noreferrer"
              className="text-ember-soft underline decoration-ember/40 underline-offset-2 hover:decoration-ember"
            />
          ),
          ul: ({ node: _node, ...props }) => (
            <ul {...props} className="m-0 ml-5 list-disc space-y-1" />
          ),
          ol: ({ node: _node, ...props }) => (
            <ol {...props} className="m-0 ml-5 list-decimal space-y-1" />
          ),
          li: ({ node: _node, ...props }) => (
            <li {...props} className="leading-[1.55]" />
          ),
          strong: ({ node: _node, ...props }) => (
            <strong {...props} className="font-medium text-fg-1" />
          ),
          em: ({ node: _node, ...props }) => <em {...props} className="italic" />,
          code: ({ node: _node, className: cls, children, ...props }) => {
            // Finalized turns render a ```mermaid block as a diagram. While the
            // turn is still streaming the source is incomplete (mermaid would
            // throw), so we let it fall through to the normal code-block path
            // and only swap to the diagram once the turn closes.
            if (!streaming && /language-mermaid/.test(cls || '')) {
              return <MermaidBlock code={String(children).replace(/\n$/, '')} />;
            }
            const isBlock =
              /language-/.test(cls || '') || String(children).includes('\n');
            if (isBlock) {
              return (
                <code
                  {...props}
                  className={cn(cls, 'block font-mono text-[12.5px] leading-relaxed')}
                >
                  {children}
                </code>
              );
            }
            return (
              <code
                {...props}
                className="rounded bg-surface-strong px-1 py-0.5 font-mono text-[0.88em]"
              >
                {children}
              </code>
            );
          },
          pre: ({ node: _node, children, ...props }) => {
            // A finalized mermaid block becomes a diagram with its own
            // container — strip the code-box chrome so it isn't double-framed.
            const childClass = isValidElement(children)
              ? ((children.props as { className?: string }).className ?? '')
              : '';
            if (!streaming && /language-mermaid/.test(childClass)) {
              return <>{children}</>;
            }
            return (
              <pre
                {...props}
                className="m-0 overflow-x-auto rounded-md border border-hairline-strong bg-surface-strong p-3"
              >
                {children}
              </pre>
            );
          },
          blockquote: ({ node: _node, ...props }) => (
            <blockquote
              {...props}
              className="m-0 border-l-2 border-hairline-strong pl-3 italic text-fg-2"
            />
          ),
          h1: ({ node: _node, ...props }) => (
            <h1 {...props} className="m-0 text-[17px] font-medium tracking-[-0.005em] text-fg-1" />
          ),
          h2: ({ node: _node, ...props }) => (
            <h2 {...props} className="m-0 text-base font-medium tracking-[-0.005em] text-fg-1" />
          ),
          h3: ({ node: _node, ...props }) => (
            <h3 {...props} className="m-0 text-[15px] font-medium text-fg-1" />
          ),
          hr: ({ node: _node, ...props }) => (
            <hr {...props} className="m-0 border-hairline-strong" />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
      </div>
      {summaryLine && (
        // Ultra-subtle, always-on debug line: Sal's per-turn summary flattened
        // to one dimmed row. Recessive by design — present for inspection, not
        // chrome the reader has to engage with each turn.
        <div className="text-[11px] font-normal leading-[1.45] text-fg-4/70">
          {summaryLine}
        </div>
      )}
    </div>
  );
});

const UserPill = memo(function UserPill({ text }: { text: string }) {
  return (
    <div className="my-1.5 flex justify-center">
      <div className="w-fit max-w-[90%] whitespace-pre-wrap break-words rounded-[22px] border border-hairline-strong bg-surface-thin px-5 py-2.5 text-[14.5px] font-light leading-[1.5] text-fg-1 backdrop-blur-[6px]">
        {text}
      </div>
    </div>
  );
});

// ============================================================
// COMPOSER — owns the input state locally.
//
// Why this is its own component: the input value is the highest-frequency
// state in the app — it changes on every keystroke. If it lived on the root,
// every keystroke would re-render the entire SGC tree (memory panel, turn
// inspector, token chart, every assistant message running ReactMarkdown).
// Lifting it down here means typing only re-renders the composer itself; the
// aurora drift/pulse is signalled to the root via throttled callbacks.
//
// The root drives `resetSignal` to clear + focus the textarea after a turn
// submits or a new chat is created.
// ============================================================

interface ComposerProps {
  // Called when the user hits Enter or clicks send. The root resolves the
  // text into a turn; the composer doesn't care what happens next.
  onSubmit: (text: string) => void;
  // Called on each keystroke with the current "salience gate" (0..1). The
  // root rate-limits aurora updates via this — see SalienceGatedCognition.
  onKeystroke: (gate: number) => void;
  // Toggles the submit button + Enter handler. The root knows when it's
  // mid-turn or pre-hydration; the composer just reflects.
  submitDisabled: boolean;
  // Bumped by the root after a successful turn / chat reset, to clear and
  // refocus the textarea. A monotonic counter is the dependency-array
  // friendly shape — flipping it triggers the effect.
  resetSignal: number;
  // History-toggle button — kept here so the composer row stays atomic.
  historyOpen: boolean;
  onToggleHistory: () => void;
  historyButtonRef: React.RefObject<HTMLButtonElement | null>;
}

const Composer = memo(function Composer({
  onSubmit,
  onKeystroke,
  submitDisabled,
  resetSignal,
  historyOpen,
  onToggleHistory,
  historyButtonRef,
}: ComposerProps) {
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the composer to fit its content.
  useEffect(() => {
    const t = inputRef.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = `${Math.min(t.scrollHeight, 220)}px`;
  }, [input]);

  // Root-driven clear + refocus. Skips the initial mount so the textarea
  // doesn't steal focus on first paint.
  const firstResetMount = useRef(true);
  useEffect(() => {
    if (firstResetMount.current) {
      firstResetMount.current = false;
      return;
    }
    setInput('');
    inputRef.current?.focus();
  }, [resetSignal]);

  const submit = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || submitDisabled) return;
    onSubmit(trimmed);
    // We intentionally don't clear here — root will bump `resetSignal` when
    // it's ready, so the visible draft survives if the parent rejects (e.g.,
    // pre-hydration). In practice the disabled-guard above blocks that path.
  }, [input, submitDisabled, onSubmit]);

  return (
    <div className="mx-auto w-full max-w-[680px] px-8 pt-[14px] pb-[22px]">
      <div className="flex items-end gap-2.5">
        <button
          ref={historyButtonRef}
          type="button"
          onClick={onToggleHistory}
          aria-label="Chat history"
          aria-expanded={historyOpen}
          className={cn(
            'flex size-11 shrink-0 items-center justify-center rounded-full border bg-surface-thin shadow-glass backdrop-blur-[10px] transition-colors',
            historyOpen
              ? 'border-ember text-ember shadow-[0_0_18px_-4px_var(--color-ember)]'
              : 'border-hairline-strong text-fg-2 hover:border-ember hover:text-ember',
          )}
        >
          <Clock className="size-[17px]" />
        </button>
        <div className="flex flex-1 items-end gap-2.5 rounded-[24px] border border-hairline-strong bg-surface-thin py-2 pr-2 pl-[18px] shadow-glass backdrop-blur-[10px]">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => {
              const next = e.target.value;
              setInput(next);
              // Quantize the gate to integer word-count steps so we only
              // touch the aurora's filter when the count crosses a boundary,
              // not on every keystroke. The 600ms CSS transition smooths it.
              const wc = next.split(/\s+/).filter(Boolean).length;
              const gate = Math.min(0.9, 0.25 + wc * 0.06);
              onKeystroke(gate);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Say something."
            rows={1}
            className="sal-scroll max-h-[220px] min-h-[22px] flex-1 resize-none border-0 bg-transparent py-1.5 text-[14.5px] leading-[1.55] text-fg-1 outline-none placeholder:text-fg-4"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={submit}
            disabled={submitDisabled || !input.trim()}
            aria-label="Say it"
            className="size-[30px] rounded-full text-fg-2 hover:border-ember hover:bg-ember hover:text-bone"
          ><ArrowUp className="size-[15px]" /></Button>
        </div>
      </div>
    </div>
  );
});

// ============================================================
// MAIN APP
// ============================================================

export default function SalienceGatedCognition() {
  // Per-chat constitutional memories. Starts empty — the active chat's set is
  // loaded from its loadChat payload during hydration / on chat switch.
  const [memories, setMemories] = useState<Memory[]>([]);
  const [chatLog, setChatLog] = useState<ChatEntry[]>([]);
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  // Sal's reply as it streams in, with the trailing <turn-summary> block stripped.
  // null = no turn streaming (show the dot-pulse loader instead).
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [latestTurn, setLatestTurn] = useState<TurnData | null>(null);
  const [tokenHistory, setTokenHistory] = useState<TokenHistoryEntry[]>([]);
  const [turnCount, setTurnCount] = useState(0);
  // Persistence state. `chatId` is the active conversation (null until the
  // mount-effect resolves it). `chats` is the summary list used by the modal.
  const [chatId, setChatId] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Per-chat persona + display-only mask for the active chat.
  // `activePersona` is the head of the per-turn system prompt (DEFAULT_PERSONA
  // when the chat carries none). `activeMask` is the author label shown on
  // assistant turns ('' → "Sal"); it is DISPLAY-ONLY and never reaches the
  // prompt or /api/turn. `personaModalOpen` gates the Confirm Persona step that
  // now precedes a "Begin again".
  const [activePersona, setActivePersona] = useState<string>(DEFAULT_PERSONA);
  const [activeMask, setActiveMask] = useState<string>('');
  const [personaModalOpen, setPersonaModalOpen] = useState(false);
  // Edit history of the active chat's persona (newest-first; head = live). Empty
  // until the prompt is first edited — the editor synthesises a baseline from
  // `activePersona` in that case. Hydrated alongside persona on load/switch.
  const [promptVersions, setPromptVersions] = useState<PromptVersion[]>([]);
  const [promptEditorOpen, setPromptEditorOpen] = useState(false);
  // The assistant reply being edited (latest turn only). A snapshot of its id +
  // content + instant; null when the response editor is closed. The re-spin/save
  // handlers resolve the live entry from chatLog by this id.
  const [editTarget, setEditTarget] = useState<{ id: number; content: string; createdAt: number } | null>(null);
  // Has the initial hydration completed? Guards the memory-save effect from
  // firing on mount (with the empty placeholder set) before the active chat's
  // memories have loaded.
  const [hydrated, setHydrated] = useState(false);
  // --- Provider switcher: which model backs Sal. Persisted to localStorage,
  // reconciled with /api/health on mount (coerced to an available provider). The
  // client only ever holds the TOKEN; the server owns keys/URLs. ---
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [provider, setProvider] = useState<ProviderId>(() => {
    try {
      const stored = localStorage.getItem(PROVIDER_LS_KEY);
      if (stored === 'anthropic' || stored === 'openai') return stored;
    } catch {
      /* localStorage unavailable (private mode) — fall through to default */
    }
    // LOCAL by default: a truly-empty fresh install (no key, no base URL)
    // should not land on a provider that needs a paid key. The health
    // reconcile below still coerces to whatever IS available, so existing
    // web deploys with only Anthropic configured are unaffected.
    return 'openai';
  });

  // --- Context rail (right sidebar) collapse. Desktop-only affordance: there the
  // rail is a fixed-width column competing for horizontal space; on mobile it's a
  // bottom drawer that caps its own height, so the toggle is hidden below lg. ---
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(RAIL_LS_KEY) === '1';
    } catch {
      /* localStorage unavailable (private mode) — default to expanded */
      return false;
    }
  });
  const toggleRail = useCallback(() => {
    setRailCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(RAIL_LS_KEY, next ? '1' : '0');
      } catch {
        /* localStorage unavailable — collapse still applies in-session */
      }
      return next;
    });
  }, []);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  // Flipped true when the user or the model actually mutates `memories`.
  // Guards the memory-save effect so programmatic loads — hydration and chat
  // switches, which set `memories` from a loadChat payload — don't round-trip a
  // redundant (or worse, mis-scoped) save. Those paths set it back to false.
  const memoriesDirtyRef = useRef(false);
  // Live mirrors of the latest memories + active chat, for the non-reactive
  // chat-swap callbacks (handleLoadChat / startNewChat) to read when flushing a
  // pending edit before the set is replaced. Assigned every render so the
  // flush always sees the OUTGOING chat's current state, never a stale closure.
  const memoriesRef = useRef(memories);
  memoriesRef.current = memories;
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;

  // --- Aurora gating: drift while active, pulse on keystrokes (throttled) ---
  // The composer signals into these via `handleKeystroke`. Critically, the
  // composer owns its own input state — so typing alone does NOT cause this
  // root to re-render; only the throttled aurora updates below do. That keeps
  // the heavy children (memory panel, turn inspector, message list with
  // ReactMarkdown) off the per-keystroke render path.
  const [gate, setGate] = useState(0.25);
  const [typing, setTyping] = useState(false);
  const [pulseKey, setPulseKey] = useState(0);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Wall-clock of the last pulse we emitted, so we can rate-limit. A 28px
  // blur layer re-mounting on every keystroke is the most expensive single
  // thing in the UI — capping it at ~6-8 Hz keeps the visual rhythm without
  // thrashing the compositor.
  const lastPulseAt = useRef(0);

  // Composer reset signal: bumped after a successful submit (and after the
  // root resets the chat) to clear + refocus the textarea inside Composer.
  const [composerResetSignal, setComposerResetSignal] = useState(0);

  // Stable handler passed to <Composer/>. Rate-limited so the aurora doesn't
  // remount its blurred pulse layer at keypress rate. The 600ms CSS
  // transition on `.sal-aurora`'s filter (see index.css) means dropping the
  // intermediate gate values is invisible — only the latest one matters.
  const handleKeystroke = useCallback((nextGate: number) => {
    setGate((prev) => (prev !== nextGate ? nextGate : prev));
    setTyping(true);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => setTyping(false), 1600);
    const now = performance.now();
    if (now - lastPulseAt.current >= 140) {
      lastPulseAt.current = now;
      setPulseKey((k) => k + 1);
    }
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText]);

  // --- Hydration: restore the most recent chat (incl. its memories). ---
  // Runs once on mount. Memories are per-chat now and ride along in the
  // loadChat payload, so there's no separate global fetch: the active chat's
  // set is loaded below (or stays empty for a fresh starter chat). After
  // hydration completes we mark hydrated=true, unlocking the memory-save effect.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await apiListChats();
        if (cancelled) return;
        setChats(list);

        let activeId: string;
        if (list.length > 0) {
          // Most-recently-updated chat. Replay its turns into the UI.
          activeId = list[0].id;
          const detail = await apiLoadChat(activeId);
          if (cancelled) return;
          const replay: ChatEntry[] = detail.turns.map((t) => ({
            role: t.role,
            content: t.content,
            id: t.id,
            active: t.active,
            createdAt: t.createdAt,
            timeless: t.timeless,
            summary: summaryFromInspector(t.inspectorJson),
          }));
          setMessages(replay);
          setChatLog(replay);
          setTurnCount(Math.floor(replay.length / 2));
          // Load this chat's memories (a programmatic load, not a user edit).
          memoriesDirtyRef.current = false;
          setMemories(detail.memories);
          // Restore the chat's persona (null → DEFAULT_PERSONA) + display mask.
          setActivePersona(detail.persona?.trim() ? detail.persona : DEFAULT_PERSONA);
          setActiveMask(detail.mask ?? '');
          setPromptVersions(detail.versions);
          if (detail.latestInspector) {
            setLatestTurn(detail.latestInspector as TurnData);
          }
        } else {
          // Fresh install: the starter chat stays default-Sal — no persona modal
          // on first run (Q2). activePersona/activeMask keep their defaults, and
          // `memories` keeps its empty initial value (a new chat has none).
          const created = await apiCreateChat();
          if (cancelled) return;
          activeId = created.id;
          // Refresh the summary list so the modal sees the new (empty) chat.
          const refreshed = await apiListChats();
          if (cancelled) return;
          setChats(refreshed);
        }
        setChatId(activeId);
      } catch (err) {
        console.warn('SGC persistence hydration failed:', err);
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // --- Provider health: fetch /api/health once on mount to learn which
  // providers are configured + the boot default, then coerce the active
  // provider to one that is actually available. If the stored/initial provider
  // is unavailable (e.g. LOCAL selected on an Anthropic-only deploy), fall back
  // to the server default, else the first available provider. Best-effort: if
  // health fails the chip simply shows what we have and the server still
  // resolves a default per turn. ---
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/health');
        if (!res.ok) return;
        const data = (await res.json()) as HealthResponse;
        if (cancelled || !data?.providers) return;
        setHealth(data);
        setProvider((current) => {
          if (data.providers[current]?.available) return current;
          if (data.default && data.providers[data.default]?.available) return data.default;
          const firstAvailable = PROVIDER_ORDER.find((p) => data.providers[p]?.available);
          return firstAvailable ?? current;
        });
      } catch {
        /* health unreachable — keep the localStorage/initial provider */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Commit a provider selection: update state + persist. Applies to the NEXT
  // turn (processInput reads `provider` at call time). Guarded against picking
  // an unavailable provider at the call site (chip disables them).
  const handleSelectProvider = useCallback((p: ProviderId) => {
    setProvider(p);
    try {
      localStorage.setItem(PROVIDER_LS_KEY, p);
    } catch {
      /* localStorage unavailable — selection still applies in-session */
    }
  }, []);

  // ============================================================
  // RESPONSE EDITOR — edit the latest assistant reply (manual or re-spin).
  // ============================================================

  // Open the editor for the latest assistant turn. Snapshots its id/content so
  // the modal seeds cleanly; the re-spin/save handlers re-resolve the live entry
  // from chatLog by id (so a mid-edit state change can't mis-target).
  const openLatestEditor = useCallback(() => {
    let idx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      // Timeless manual memories are curated in the chat memory editor, not here.
      if (messages[i].role === 'assistant' && !messages[i].timeless) { idx = i; break; }
    }
    const a = idx >= 0 ? messages[idx] : null;
    if (!a || typeof a.id !== 'number') return;
    setEditTarget({ id: a.id, content: a.content, createdAt: a.createdAt });
  }, [messages]);

  // Re-spin: re-run the currently-selected model for the target turn. The chat
  // HISTORY tier is reconstructed faithfully — sliced to before this turn, recency
  // anchored at its original instant, so no later turn can leak in. Memories and
  // persona are CURRENT, not snapshotted (they have no per-turn binding anywhere;
  // the modal copy says so). Streams stripped preview text via onDelta.
  // This is the feature's one extra model call: an explicit user action that
  // reuses the deterministic context-assembly path (assembleTurnContext) and
  // keeps Sal ephemeral + memory retrieval pure math — inside the Phase 1.5
  // contract (the "one API call per turn" line is a guardrail, not the law).
  const handleRespin = useCallback(
    async (onDelta: (preview: string) => void): Promise<RespinResult> => {
      if (!editTarget) throw new Error('No reply selected.');
      const assistantIdx = chatLog.findIndex((e) => e.id === editTarget.id);
      const userIdx = assistantIdx - 1;
      if (assistantIdx < 0 || userIdx < 0) throw new Error('Could not locate this turn.');
      const targetUser = chatLog[userIdx];

      // Re-fetch any links in the original user message so the re-spin reads the
      // same page context (deterministic, no model — the live turn's helpers).
      const urls = extractUrls(targetUser.content);
      const fetched = await Promise.all(urls.map(fetchUrl));
      const fetchedDocs: FetchedDoc[] = [];
      const failedUrls: string[] = [];
      urls.forEach((u, i) => {
        const doc = fetched[i];
        if (doc) fetchedDocs.push(doc);
        else failedUrls.push(u);
      });

      const { systemPrompt } = assembleTurnContext({
        query: targetUser.content,
        priorLog: chatLog.slice(0, userIdx),
        memories,
        persona: activePersona,
        now: targetUser.createdAt,
        fetchedDocs,
        failedUrls,
      });

      const confirmedProvider = health?.providers[provider]?.available ? provider : undefined;
      const result = await runTurn(
        systemPrompt,
        targetUser.content,
        (raw) => onDelta(stripStreamingMeta(raw)),
        confirmedProvider,
      );
      const { displayText, summary } = parseTurnResponse(result.text);
      return {
        text: displayText,
        summary,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        elapsed: result.elapsed,
      };
    },
    [editTarget, chatLog, memories, activePersona, health, provider],
  );

  // Save the edited reply. Persist FIRST, then commit to state on success (a
  // failure leaves the chat untouched and the modal open with the error). A
  // re-spin carries a fresh summary + metrics; a manual edit clears the stale
  // summary. inspector_json is rebuilt from the latest turn's TurnData (this IS
  // the latest turn) so the right-rail diagnostics survive a reload; only
  // `summary` is rehydrated onto the message, so that's the load-bearing field.
  const handleSaveEdit = useCallback(
    async (text: string, respin: RespinResult | null) => {
      if (!editTarget || !chatId) return;
      const turnId = editTarget.id;
      const newSummary = respin ? (respin.summary ?? undefined) : undefined;

      const base: TurnData =
        latestTurn ?? {
          turnNumber: Math.floor(chatLog.length / 2),
          inputTokens: 0,
          outputTokens: 0,
          totalLatency: 0,
          localBufferSize: 0,
          grepFired: false,
          grepMatches: 0,
          grepDetails: null,
          summary: null,
        };
      const nextInspector: TurnData = respin
        ? {
            ...base,
            inputTokens: respin.inputTokens,
            outputTokens: respin.outputTokens,
            totalLatency: respin.elapsed,
            summary: respin.summary,
          }
        : { ...base, summary: null };

      await apiUpdateTurn(chatId, turnId, {
        content: text,
        inspectorJson: JSON.stringify(nextInspector),
      });

      // Persisted — commit to the live logs (by id, so render + retrieval stay
      // in sync). Re-indexing for cosine grep is automatic (tfidf is uncached).
      const patch = (e: ChatEntry): ChatEntry =>
        e.id !== turnId ? e : { ...e, content: text, summary: newSummary };
      setMessages((prev) => prev.map(patch));
      setChatLog((prev) => prev.map(patch));
      setLatestTurn(nextInspector);
      setEditTarget(null);

      // Refresh the history list so its snippet (the latest assistant content)
      // reflects the edit. updateTurnContent doesn't bump updated_at, so this
      // refreshes the snippet without reordering the list.
      apiListChats().then(setChats).catch((err) => console.warn('listChats refresh failed:', err));
    },
    [editTarget, chatId, latestTurn, chatLog],
  );

  // --- Provider config modal (D5): which provider is being configured, and
  // whether the modal was opened from an UNCONFIGURED row (the intercept) —
  // in that case a successful save pre-sets the stored provider so the
  // post-restart reload lands on it. ---
  const [providerConfig, setProviderConfig] = useState<{
    provider: ProviderId;
    fromUnconfigured: boolean;
  } | null>(null);
  // Redacted desktop config (presence booleans, models, token caps) for
  // pre-filling the modal. Stays null on web — the modal renders .env
  // guidance instead of a save path.
  const [desktopConfigState, setDesktopConfigState] = useState<DesktopConfigState | null>(null);
  useEffect(() => {
    getDesktop()
      ?.getConfigState()
      .then(setDesktopConfigState)
      .catch((err) => console.warn('desktop config state fetch failed:', err));
  }, []);

  const handleConfigureProvider = useCallback(
    (p: ProviderId) => {
      setProviderConfig({
        provider: p,
        fromUnconfigured: !(health?.providers[p]?.available ?? false),
      });
    },
    [health],
  );

  const handleSaveProviderConfig = useCallback(
    async (patch: DesktopConfigPatch) => {
      const bridge = getDesktop();
      if (!bridge || !providerConfig) return;
      if (providerConfig.fromUnconfigured) {
        // The save below reloads the window (packaged) — persist the intent
        // first so the reload's provider init lands on the newly configured
        // provider. The health reconcile still corrects it if the save left
        // the provider unavailable.
        try {
          localStorage.setItem(PROVIDER_LS_KEY, providerConfig.provider);
        } catch {
          /* localStorage unavailable — reload falls back to defaults */
        }
      }
      // Packaged: main writes config → restarts the fork → reloads the window;
      // execution usually ends with the reload. Dev-mode Electron: the write
      // lands for the next packaged run and we just refresh local state.
      const next = await bridge.setConfig(patch);
      setDesktopConfigState(next);
      setProviderConfig(null);
    },
    [providerConfig],
  );

  // --- Memory sync: persist the active chat's set whenever it changes,
  // debounced. --- Save is fire-and-forget; the UI is the source of truth
  // in-session, the server is the durable mirror. Three gates: hydration must
  // have completed, a chat must be active (so we have a scope to save into),
  // and a real edit must have happened — programmatic loads (hydration, chat
  // switch) reset the dirty ref so they don't round-trip a no-op save. chatId
  // is a dep so the closure always saves to the current chat.
  useEffect(() => {
    if (!hydrated || !chatId || !memoriesDirtyRef.current) return;
    const handle = setTimeout(() => {
      // Clear the flag as the save fires, so `dirty` means "has unsaved
      // changes" (not "ever edited"). A later chat swap then flushes only when
      // something is genuinely pending. A subsequent edit re-arms it.
      memoriesDirtyRef.current = false;
      apiSaveMemories(chatId, memories).catch((err) => console.warn('saveMemories failed:', err));
    }, 250);
    return () => clearTimeout(handle);
  }, [memories, hydrated, chatId]);

  // Persist a pending (debounced) memory edit immediately. The save above
  // cancels its 250ms timer whenever `memories`/`chatId` change — so a chat
  // swap or "Begin again" within that window would otherwise drop the edit when
  // the outgoing chat's set is replaced. The swap callbacks call this first to
  // flush the OUTGOING chat (read from refs, so never stale). No-op when clean;
  // any in-flight debounce that still fires afterward is an idempotent re-save.
  const flushPendingMemorySave = useCallback(() => {
    if (!memoriesDirtyRef.current || !chatIdRef.current) return;
    memoriesDirtyRef.current = false;
    apiSaveMemories(chatIdRef.current, memoriesRef.current)
      .catch((err) => console.warn('flush saveMemories failed:', err));
  }, []);

  const handleMemoryUpdate = useCallback((id: string, newText: string) => {
    memoriesDirtyRef.current = true;
    setMemories((prev) => prev.map((m) => (m.id === id ? { ...m, text: newText } : m)));
  }, []);

  const handleMemoryAdd = useCallback((text: string) => {
    memoriesDirtyRef.current = true;
    setMemories((prev) => [...prev, { id: crypto.randomUUID(), text }]);
  }, []);

  const handleMemoryRemove = useCallback((id: string) => {
    memoriesDirtyRef.current = true;
    setMemories((prev) => prev.filter((m) => m.id !== id));
  }, []);

  // Stable opener for the prompt editor (kept referentially stable so the
  // memoized MemoryPanel doesn't re-render on every parent tick).
  const handleOpenPromptEditor = useCallback(() => setPromptEditorOpen(true), []);

  // Save a new live version of the active chat's system prompt. The server mints
  // a new head, freezes the pre-edit baseline as v1 on the first edit (via
  // `baselineText`), and mirrors the head into the live persona. We then adopt
  // the fresh history + drive the NEXT turn with the new live text (buildPrompt
  // reads activePersona). Errors propagate to the modal, which surfaces them.
  //
  // No active chat → THROW, never silently resolve. A resolved onSave is the
  // modal's success signal (it clears the dirty state), so returning here would
  // report a save that never persisted. This also closes the chat-swap window:
  // startNewChat nulls chatId before the new id arrives (see below), so a save
  // mid-swap surfaces an error instead of writing to the outgoing chat. The UI
  // also disables the opener while chatId is null, so this should never fire —
  // it's the explicit backstop behind that guard.
  const handleSavePromptVersion = useCallback(
    async (text: string, baselineText: string) => {
      if (!chatId) throw new Error('No active chat yet — wait a moment and try again.');
      const { versions } = await apiSavePromptVersion(chatId, text, baselineText);
      setPromptVersions(versions);
      if (versions[0]) setActivePersona(versions[0].text);
    },
    [chatId],
  );

  // `text` is the trimmed draft the composer passed up. The composer also
  // pre-checks `submitDisabled`, but we keep the guard here as a belt to
  // those suspenders — this is the only path that mutates chat state.
  const processInput = async (text: string) => {
    const userInput = text.trim();
    // Don't accept input until hydration has resolved the active chatId.
    // Submitting before then races the hydration effect: it would replay the
    // loaded chat over the in-flight user message (setMessages clobber), and
    // this closure would capture chatId === null so the turn would never
    // persist.
    if (!userInput || isProcessing || !hydrated || !chatId) return;

    const newTurnNumber = turnCount + 1;
    setTurnCount(newTurnNumber);
    // Tell <Composer/> to clear + refocus its textarea. The composer owns its
    // own input state — typing never re-renders this root — so we can't just
    // `setInput('')` here.
    setComposerResetSignal((s) => s + 1);
    setIsProcessing(true);
    // Stamp the turn instant ONCE for the whole pair — matches saveTurnPair's
    // semantics (db.ts: a single Date.now() is reused for both rows) so the
    // user message + assistant reply share an instant in the cosine corpus.
    const turnStartedAt = Date.now();
    setMessages((prev) => [...prev, { role: 'user' as const, content: userInput, createdAt: turnStartedAt }]);

    // ---- URL PRE-FETCH (deterministic, no model) ----
    // If the person pasted link(s), pull clean article text now — before the
    // single model call — so Sal reads the page in-context and the tokens are
    // counted once. This is Sal's ONLY window onto the outside world: there are
    // no model web tools (removed for cost — see AGENTS.md). Successful fetches
    // are folded into BOTH the real prompt and the naive baseline below, so a
    // one-off fetch doesn't skew the Context Savings tile. URLs that fail to
    // pre-load are passed through separately so Sal is told it couldn't read
    // them and should ask the person for the contents (it cannot fetch them
    // itself).
    const urls = extractUrls(userInput);
    const fetched = await Promise.all(urls.map(fetchUrl));
    const fetchedDocs: FetchedDoc[] = [];
    const failedUrls: string[] = [];
    urls.forEach((u, i) => {
      const doc = fetched[i];
      if (doc) fetchedDocs.push(doc);
      else failedUrls.push(u);
    });

    const turnData: TurnData = {
      turnNumber: newTurnNumber,
      inputTokens: 0,
      outputTokens: 0,
      totalLatency: 0,
      localBufferSize: 0,
      grepFired: false,
      grepMatches: 0,
      grepDetails: null,
      summary: null,
      // Counterfactual baseline: what the naive "send the whole history every
      // turn" pipeline would have sent. Computed BEFORE the new pair is
      // appended to chatLog, so `chatLog` here is everything prior to this
      // turn — same baseline the local buffer and cosine grep see. `now` is
      // the turn instant so any relative-time prefixes in the grep block (when
      // present) compute against the same reference instant the real prompt does.
      naiveTokens: estimateNaiveContextTokens(memories, chatLog, userInput, fetchedDocs, failedUrls, activePersona, turnStartedAt),
    };

    try {
      // ---- ASSEMBLE THE THREE TIERS (deterministic, no model) ----
      // localBuffer (verbatim last 2 turns) + distilled summary window + cosine
      // grep + buildPrompt — all in assembleTurnContext, the shared path the
      // re-spin editor reuses. `chatLog` here is everything PRIOR to this turn
      // (the new pair is appended further down), `turnStartedAt` is the single
      // reference instant for both the time scorer and the relative-time tags.
      const { systemPrompt, grepResults, localBufferSize } = assembleTurnContext({
        query: userInput,
        priorLog: chatLog,
        memories,
        persona: activePersona,
        now: turnStartedAt,
        fetchedDocs,
        failedUrls,
      });
      turnData.localBufferSize = localBufferSize;
      if (grepResults.length > 0) {
        turnData.grepFired = true;
        turnData.grepMatches = grepResults.length;
        turnData.grepDetails = grepResults.map((r) => ({
          turnIndex: r.turnIndex,
          // Inspector tile reads `score` — surface the combined score so the
          // visible ranking matches what was actually used to retrieve.
          score: r.combinedScore,
          preview: r.userContent.slice(0, 80),
        }));
      }

      // ---- SINGLE MODEL CALL (streamed) ----
      // Assert the provider token only once /api/health has CONFIRMED it
      // available — an explicit-but-unavailable token 503s by design
      // (resolveTurnProvider never reroutes), and before health resolves (or
      // when the fetch failed) the stored/initial token is just a guess.
      // Omitting it lets the server route to its boot default instead. This
      // matters since the fresh-install default became LOCAL: a fast submit
      // on an Anthropic-only deploy must not 503 on an unconfigured 'openai'.
      const confirmedProvider = health?.providers[provider]?.available ? provider : undefined;
      const turnResult = await runTurn(
        systemPrompt,
        userInput,
        (rawSoFar) => {
          // Render Sal's reply as it arrives; hide the trailing <turn-summary> block.
          setStreamingText(stripStreamingMeta(rawSoFar));
        },
        confirmedProvider,
      );
      const { displayText, summary } = parseTurnResponse(turnResult.text);

      turnData.inputTokens = turnResult.inputTokens;
      turnData.outputTokens = turnResult.outputTokens;
      turnData.totalLatency = turnResult.elapsed;
      // Sal's fresh per-turn observation. Stored on turnData (→ inspector_json,
      // so it persists + rehydrates) and carried on the message below so it
      // renders as a dimmed one-line appendage beneath this reply. It is NOT
      // fed back into any later prompt — a snapshot of this turn only.
      turnData.summary = summary;

      // Promote the streamed reply to a finalized message, carrying its summary.
      // The transient streaming bubble is cleared in `finally`, batched into this
      // same render — so the bubble swaps to a message with no flicker.
      setMessages((prev) => [
        ...prev,
        { role: 'assistant' as const, content: displayText, createdAt: turnStartedAt, summary: summary ?? undefined },
      ]);

      // ---- APPEND TO PERSISTENT CHAT LOG ----
      // The assistant entry carries its summary so a LATER turn's summary window
      // can slice it from chatLog in-session (matching the reload path, where
      // summaryFromInspector rehydrates it). The user entry has none.
      setChatLog((prev) => [
        ...prev,
        { role: 'user' as const, content: userInput, createdAt: turnStartedAt },
        { role: 'assistant' as const, content: displayText, createdAt: turnStartedAt, summary: summary ?? undefined },
      ]);

      setTokenHistory((prev) => [...prev, { turn: newTurnNumber, inputTokens: turnData.inputTokens }]);
      setLatestTurn(turnData);

      // ---- PERSIST THE TURN (non-blocking) ----
      // Fired after the UI has rendered the new turn so the network round-trip
      // never stalls a streaming response. Failures log but do not surface —
      // the in-memory session continues; only durability is at risk.
      if (chatId) {
        const persistChatId = chatId;
        apiSaveTurn(persistChatId, {
          user: { content: userInput },
          assistant: {
            content: displayText,
            inspectorJson: JSON.stringify(turnData),
          },
        })
          .then(({ userId, assistantId }) => {
            // Stamp the freshly-streamed pair with its DB ids so the
            // assistant-response editor can address this turn by id WITHOUT a
            // reload. Both entries share `turnStartedAt` (a unique per-submission
            // stamp), so matching on it hits exactly this pair in each log.
            const stamp = (entry: ChatEntry): ChatEntry =>
              entry.createdAt !== turnStartedAt
                ? entry
                : { ...entry, id: entry.role === 'user' ? userId : assistantId };
            setMessages((prev) => prev.map(stamp));
            setChatLog((prev) => prev.map(stamp));
            return apiListChats();
          })
          .then(setChats)
          .catch((err) => console.warn('saveTurn failed:', err));
      }
    } catch (err) {
      console.error('SGC Error:', err);
      const detail = err instanceof Error ? err.message : String(err);
      setMessages((prev) => [...prev, { role: 'assistant' as const, content: `I lost my place. Try again? (${detail})`, createdAt: Date.now() }]);
    } finally {
      setStreamingText(null);
      setIsProcessing(false);
      // The composer focuses itself on its `resetSignal` effect (bumped above
      // when the turn started). No imperative focus call needed here.
    }
  };

  // Clear the visible session and create a NEW chat with the given persona +
  // display-only mask. Memories are per-chat: the outgoing chat's pending edit
  // (if any) is flushed first, then the set is emptied for the new chat. `mask`
  // is stored for display only; it is NOT part of the persona/prompt and never
  // reaches /api/turn.
  //
  // Shared by the user-facing "Begin again" flow (via confirmPersona, which
  // supplies an edited persona/mask) and the delete-fallback path (which passes
  // nothing → default Sal). A null/blank persona is stored server-side as NULL
  // and resolves to DEFAULT_PERSONA at build time.
  const startNewChat = useCallback(async (persona?: string, mask?: string) => {
    // Flush any pending edit to the OUTGOING chat before we clear the set.
    // (flushPendingMemorySave reads chatIdRef synchronously, so it still sees the
    // outgoing id even though we null chatId on the next line.)
    flushPendingMemorySave();
    // Null the active chat for the duration of the create round-trip. We set the
    // NEW chat's persona/versions below before apiCreateChat resolves; without
    // this, chatId would still point at the OUTGOING chat during that window, so
    // a prompt save mid-swap (or any chatId-scoped write) would target the wrong
    // chat with the new chat's state. "No active chat" until the new id lands is
    // the honest state — the composer + prompt editor already disable on it.
    setChatId(null);
    setChatLog([]);
    setMessages([]);
    setLatestTurn(null);
    setTokenHistory([]);
    setTurnCount(0);
    // A new chat starts with no constitutional memories. Reset the dirty ref
    // first so emptying the set isn't mistaken for a user edit and saved.
    memoriesDirtyRef.current = false;
    setMemories([]);
    // The active persona/mask follow the new chat. Empty/blank persona → the
    // default; trimmed mask, '' → "Sal" at render.
    const resolvedPersona = persona?.trim() ? persona : DEFAULT_PERSONA;
    const resolvedMask = mask?.trim() ?? '';
    setActivePersona(resolvedPersona);
    setActiveMask(resolvedMask);
    // A new chat has no prompt edit history yet — the editor synthesises a
    // baseline from the persona above until the first edit lands.
    setPromptVersions([]);
    // Clear + refocus the composer's textarea (it owns its own input state).
    setComposerResetSignal((s) => s + 1);
    try {
      // Only send a persona when it differs from the default — a default chat
      // stores NULL persona (old chats stay byte-identical on the wire). Always
      // send the mask when non-empty so the label persists across reloads.
      const args: { persona?: string; mask?: string } = {};
      if (persona?.trim() && persona !== DEFAULT_PERSONA) args.persona = persona;
      if (resolvedMask) args.mask = resolvedMask;
      const created = await apiCreateChat(Object.keys(args).length ? args : undefined);
      setChatId(created.id);
      const refreshed = await apiListChats();
      setChats(refreshed);
    } catch (err) {
      console.warn('createChat failed:', err);
    }
  }, [flushPendingMemorySave]);

  // "Begin again" no longer creates a chat immediately — it opens the Confirm
  // Persona modal first. Both existing entry points (PhaseBar onReset, the
  // history modal's Begin again) route here. Close the history modal if it's
  // open so the persona modal is the only thing on screen.
  const openPersonaModal = useCallback(() => {
    setHistoryOpen(false);
    setPersonaModalOpen(true);
  }, []);

  // Confirm from the persona modal: do the new-chat work with the chosen
  // persona + mask, then close the modal.
  const confirmPersona = useCallback(
    async (persona: string, mask: string) => {
      setPersonaModalOpen(false);
      await startNewChat(persona, mask);
    },
    [startNewChat],
  );

  // Load an existing chat from the history modal: fetch its turns, replay
  // them into the in-memory log + visible messages, restore the right-rail
  // inspector, and swap in this chat's own (per-chat) memory set.
  const handleLoadChat = useCallback(async (id: string) => {
    if (id === chatId) {
      setHistoryOpen(false);
      return;
    }
    // Flush any pending edit to the OUTGOING chat before we swap its set out —
    // otherwise a switch within the 250ms save debounce would drop the edit.
    flushPendingMemorySave();
    try {
      const detail = await apiLoadChat(id);
      const replay: ChatEntry[] = detail.turns.map((t) => ({
        role: t.role,
        content: t.content,
        id: t.id,
        active: t.active,
        createdAt: t.createdAt,
        timeless: t.timeless,
        summary: summaryFromInspector(t.inspectorJson),
      }));
      setMessages(replay);
      setChatLog(replay);
      setTurnCount(Math.floor(replay.length / 2));
      setLatestTurn((detail.latestInspector as TurnData | null) ?? null);
      setTokenHistory([]);
      // Swap in this chat's memories (a programmatic load, not a user edit).
      memoriesDirtyRef.current = false;
      setMemories(detail.memories);
      // Restore the chat's persona (null → DEFAULT_PERSONA) + display mask.
      setActivePersona(detail.persona?.trim() ? detail.persona : DEFAULT_PERSONA);
      setActiveMask(detail.mask ?? '');
      setPromptVersions(detail.versions);
      setChatId(id);
      setHistoryOpen(false);
    } catch (err) {
      console.warn('loadChat failed:', err);
    }
  }, [chatId, flushPendingMemorySave]);

  // Stable wrapper around `processInput` so the memoized <Composer/> sees
  // referential stability across the gate/typing/pulse re-renders triggered
  // by keystrokes. `processInput` itself closes over a lot of state and
  // would re-create every render; the ref lets us hand the composer a
  // never-changing callback.
  const processInputRef = useRef(processInput);
  processInputRef.current = processInput;
  const handleComposerSubmit = useCallback((text: string) => {
    void processInputRef.current(text);
  }, []);

  // Same shape for the history toggle so the composer's history button doesn't
  // get a new onClick on every parent render.
  const handleToggleHistory = useCallback(() => {
    setHistoryOpen((o) => !o);
  }, []);
  const handleCloseHistory = useCallback(() => {
    setHistoryOpen(false);
  }, []);

  // Re-pull the edited chat and rebuild chatLog from it. Used by every memory-
  // editor mutation that the live grep must see immediately — gating turns,
  // adding a manual memory, deleting one. We reload rather than patch by id:
  // in-session turns are appended to chatLog without a DB id (so an id-match
  // would miss them) and a manual add/delete shifts the turn set wholesale.
  // Content of streamed turns is unchanged, so the visible thread is unaffected
  // — only chatLog's flags/ids/membership refresh. Other chats are persisted
  // and pick the change up on their next load, so there's nothing to do for them.
  const resyncLiveChatLog = useCallback(
    async (editedChatId: string) => {
      if (editedChatId !== chatId) return;
      try {
        const detail = await apiLoadChat(editedChatId);
        setChatLog(
          detail.turns.map((t) => ({
            role: t.role,
            content: t.content,
            id: t.id,
            active: t.active,
            createdAt: t.createdAt,
            timeless: t.timeless,
          })),
        );
      } catch (err) {
        console.warn('active-chat grep resync failed:', err);
      }
    },
    [chatId],
  );

  // Gating fires with the turns that flipped; a manual add/delete fires with no
  // states. Both just need the live chatLog rebuilt, so they share one resync.
  const handleActiveTurnsChanged = useCallback(
    (editedChatId: string, _states: TurnActiveState[]) => {
      void resyncLiveChatLog(editedChatId);
    },
    [resyncLiveChatLog],
  );

  // A manual memory was added or deleted. Beyond the live grep resync, the
  // history summaries (`chats`) can go stale: adding the first turn to an
  // empty chat derives its title + snippet, and every add/delete shifts the
  // turn count. The summary list/rail render from `chats`, so re-pull it. This
  // works for ANY edited chat, not just the active one (resync handles only the
  // active chat's grep log). updatedAt is intentionally NOT bumped server-side,
  // so the refreshed list keeps its order — no surprise reshuffle mid-edit.
  const handleTurnsMutated = useCallback(
    async (editedChatId: string) => {
      await resyncLiveChatLog(editedChatId);
      try {
        setChats(await apiListChats());
      } catch (err) {
        console.warn('chat summary refresh after memory mutation failed:', err);
      }
    },
    [resyncLiveChatLog],
  );

  // Delete a chat. If it was the active one, swap to the next most-recent or
  // start a fresh one.
  const handleDeleteChat = useCallback(async (id: string) => {
    try {
      await apiDeleteChat(id);
      const refreshed = await apiListChats();
      setChats(refreshed);
      if (id === chatId) {
        if (refreshed.length > 0) {
          await handleLoadChat(refreshed[0].id);
        } else {
          // No chats left — spin up a fresh default-Sal chat directly. This is
          // an automatic fallback, not a user "Begin again", so it must NOT pop
          // the Confirm Persona modal.
          await startNewChat();
        }
      }
    } catch (err) {
      console.warn('deleteChat failed:', err);
    }
  }, [chatId, handleLoadChat, startNewChat]);

  return (
    <div className="relative h-screen w-full overflow-hidden bg-ground font-sans text-fg-1">
      <AuroraBackground gate={gate} active={typing || isProcessing} pulseKey={pulseKey} />

      <div className="relative z-10 flex h-full w-full flex-col">
        <PhaseBar
          processing={isProcessing}
          onReset={openPersonaModal}
          provider={provider}
          health={health}
          onSelectProvider={handleSelectProvider}
          onConfigureProvider={handleConfigureProvider}
        />

        <div className="relative flex min-h-0 flex-1 flex-col lg:flex-row">
          {/* Thread */}
          <div className="relative z-10 flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="sal-scroll flex-1 overflow-x-hidden overflow-y-auto pt-[30px] pb-3">
              <div className="mx-auto flex max-w-[680px] flex-col gap-[18px] px-8">
                {messages.length === 0 && (
                  <div className="mx-auto mt-[12vh] max-w-[440px] text-center text-pretty text-sm leading-[1.7] text-fg-3">
                    One API call per turn. A local buffer holds what's near; cosine
                    grep reaches for what's far. The only mind here is Sal — and Sal
                    begins again every turn.
                  </div>
                )}

                {(() => {
                  // The pencil lives only on the latest assistant reply (scope:
                  // latest turn only). canEdit gates on a persisted id + no turn
                  // in flight, so Save always has an addressable target.
                  let lastAssistantIdx = -1;
                  for (let i = messages.length - 1; i >= 0; i--) {
                    // Skip timeless manual memories — the pencil is for streamed replies.
                    if (messages[i].role === 'assistant' && !messages[i].timeless) { lastAssistantIdx = i; break; }
                  }
                  return messages.map((msg, i) =>
                    msg.role === 'user'
                      ? <UserPill key={i} text={msg.content} />
                      : <AssistantMessage
                          key={i}
                          text={msg.content}
                          label={activeMask}
                          summary={msg.summary}
                          onEdit={i === lastAssistantIdx ? openLatestEditor : undefined}
                          canEdit={i === lastAssistantIdx && !isProcessing && typeof msg.id === 'number'}
                        />,
                  );
                })()}

                {streamingText !== null && (
                  <AssistantMessage text={streamingText || ' '} streaming label={activeMask} />
                )}

                {/* Dot-pulse loader: shown only before the first streamed token. */}
                {isProcessing && streamingText === null && (
                  <div className="flex gap-[5px] py-1">
                    {[0, 1, 2].map((d) => (
                      <span
                        key={d}
                        className="size-1.5 rounded-full bg-fg-3 animate-loader-dot"
                        style={{ animationDelay: `${d * 0.2}s` }}
                      />
                    ))}
                  </div>
                )}

                <div ref={chatEndRef} />
              </div>
            </div>

            <Composer
              onSubmit={handleComposerSubmit}
              onKeystroke={handleKeystroke}
              submitDisabled={isProcessing || !hydrated || !chatId}
              resetSignal={composerResetSignal}
              historyOpen={historyOpen}
              onToggleHistory={handleToggleHistory}
              historyButtonRef={historyButtonRef}
            />
          </div>

          {/* Context-rail collapse toggle — a small tab pinned to the chat/rail
              seam. Desktop only (hidden lg:flex); its `right` offset animates in
              lockstep with the rail's width so the tab rides the closing edge. */}
          <button
            type="button"
            onClick={toggleRail}
            aria-label={railCollapsed ? 'Show context rail' : 'Hide context rail'}
            aria-expanded={!railCollapsed}
            className={`absolute top-1/2 z-30 hidden size-7 -translate-y-1/2 items-center justify-center rounded-full border border-hairline-strong bg-surface-thin text-fg-3 transition-[right,color,border-color] duration-300 ease-out hover:border-ember hover:text-ember lg:flex ${
              railCollapsed ? 'right-2' : 'right-[346px]'
            }`}
          >
            {railCollapsed ? <PanelRightOpen size={15} /> : <PanelRightClose size={15} />}
          </button>

          {/* Context rail */}
          <aside
            className={`sal-scroll relative z-20 flex max-h-[45vh] w-full flex-col gap-7 overflow-y-auto border-t border-hairline px-6 pt-[26px] pb-8 lg:h-full lg:max-h-none lg:shrink-0 lg:border-t-0 lg:border-l lg:transition-[width,opacity] lg:duration-300 lg:ease-out ${
              railCollapsed
                ? 'lg:w-0 lg:overflow-hidden lg:border-l-0 lg:px-0 lg:opacity-0 lg:pointer-events-none'
                : 'lg:w-[360px] lg:opacity-100'
            }`}
          >
            <MemoryPanel
              memories={memories}
              onUpdate={handleMemoryUpdate}
              onAdd={handleMemoryAdd}
              onRemove={handleMemoryRemove}
              promptVersionN={promptVersions.length > 0 ? promptVersions[0].n : 1}
              onOpenPromptEditor={handleOpenPromptEditor}
              promptEditorDisabled={!chatId}
            />
            <TurnInspector turnData={latestTurn} />
            <TokenChart tokenHistory={tokenHistory} />
          </aside>
        </div>
      </div>

      <ChatHistoryModal
        open={historyOpen}
        onClose={handleCloseHistory}
        chats={chats}
        activeChatId={chatId}
        onSelect={handleLoadChat}
        onDelete={handleDeleteChat}
        onBeginAgain={openPersonaModal}
        onActiveTurnsChanged={handleActiveTurnsChanged}
        onTurnsMutated={handleTurnsMutated}
        returnFocusRef={historyButtonRef}
      />

      <ConfirmPersonaModal
        open={personaModalOpen}
        defaultPersona={DEFAULT_PERSONA}
        onConfirm={confirmPersona}
        onCancel={() => setPersonaModalOpen(false)}
      />

      <PromptEditorModal
        open={promptEditorOpen}
        onClose={() => setPromptEditorOpen(false)}
        livePersona={activePersona}
        versions={promptVersions}
        onSave={handleSavePromptVersion}
      />

      <ProviderConfigModal
        open={providerConfig !== null}
        provider={providerConfig?.provider ?? 'anthropic'}
        label={PROVIDER_LABEL[providerConfig?.provider ?? 'anthropic']}
        configState={desktopConfigState}
        mode={isDesktop() ? 'desktop' : 'web'}
        onSave={handleSaveProviderConfig}
        onCancel={() => setProviderConfig(null)}
      />

      <EditResponseModal
        open={editTarget !== null}
        onClose={() => setEditTarget(null)}
        initialText={editTarget?.content ?? ''}
        label={activeMask}
        canRespin={Boolean(health?.providers[provider]?.available) && !isProcessing}
        onRespin={handleRespin}
        onSave={handleSaveEdit}
      />
    </div>
  );
}
