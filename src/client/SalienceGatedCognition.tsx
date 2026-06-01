import { memo, useState, useRef, useEffect, useCallback } from 'react';
import { ArrowUp, Clock, Plus } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeQuotes from './lib/rehype-quotes';
import type { Memory, ChatEntry, FetchedDoc } from './lib/types';
import { LOCAL_BUFFER_SIZE } from './lib/constants';
import { searchScored } from './lib/time-score';
import {
  DEFAULT_PERSONA,
  buildPrompt,
  estimateNaiveContextTokens,
  parseTurnResponse,
  stripStreamingMeta,
} from './lib/prompt';
import { runTurn, extractUrls, fetchUrl, type ProviderId } from './lib/api';
import {
  createChat as apiCreateChat,
  deleteChat as apiDeleteChat,
  getMemories as apiGetMemories,
  listChats as apiListChats,
  loadChat as apiLoadChat,
  saveMemories as apiSaveMemories,
  saveTurn as apiSaveTurn,
  type ChatSummary,
  type TurnActiveState,
} from './lib/persistence';
import { ChatHistoryModal } from './components/ChatHistoryModal';
import { ConfirmPersonaModal } from './components/ConfirmPersonaModal';
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

const DEFAULT_MEMORIES: Memory[] = [
  { id: crypto.randomUUID(), text: 'User processes ideas by writing and talking through them, not by internal visualization.', confidence: 50, history: [] },
  { id: crypto.randomUUID(), text: 'User prefers direct communication without hedging or performative helpfulness.', confidence: 50, history: [] },
  { id: crypto.randomUUID(), text: 'User values being corrected when wrong — wants to do right, not be right.', confidence: 50, history: [] },
];

// ============================================================
// TURN DIAGNOSTICS TYPES
// ============================================================

interface GrepDetail {
  turnIndex: number;
  score: number;
  preview: string;
}

interface ConfidenceDelta {
  delta: number;
  newScore: number;
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
  confidenceDeltas: ConfidenceDelta[] | null;
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

// Confidence drives a warm-shifted border/text colour: sage when trusted,
// brick when doubted, a quiet neutral in between.
function confidenceTone(c: number): string {
  if (c > 70) return 'var(--color-success)';
  if (c < 30) return 'var(--color-danger)';
  return 'var(--color-fg-1)';
}

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
// turn; unconfigured providers render disabled.
// ============================================================

const ProviderChip = memo(function ProviderChip({
  provider,
  health,
  processing,
  onSelect,
}: {
  provider: ProviderId;
  health: HealthResponse | null;
  processing: boolean;
  onSelect: (p: ProviderId) => void;
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

  const choose = (p: ProviderId) => {
    onSelect(p);
    setOpen(false);
  };

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
        className="rounded-full border border-ember/35 bg-ember/[0.08] px-2.5 py-1 font-mono text-[11px] font-medium tracking-[0.08em] text-ember transition-colors hover:bg-ember/[0.14] disabled:cursor-not-allowed disabled:opacity-50"
      >
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
            return (
              <button
                key={p}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                disabled={!available}
                onClick={() => choose(p)}
                className={cn(
                  'flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left transition-colors',
                  available ? 'hover:bg-fg-1/[0.06]' : 'cursor-not-allowed opacity-40',
                  selected && 'bg-ember/[0.1]',
                )}
              >
                <span className="flex flex-col">
                  <span className="font-mono text-[11px] tracking-[0.06em] text-fg-1">
                    {PROVIDER_LABEL[p]}
                  </span>
                  <span className="font-mono text-[10px] text-fg-3">
                    {info?.model ?? '—'}
                    {!available && ' · not configured'}
                  </span>
                </span>
                {selected && available && (
                  <span className="size-1.5 shrink-0 rounded-full bg-ember shadow-[0_0_8px_var(--color-ember)]" />
                )}
              </button>
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
}: {
  processing: boolean;
  onReset: () => void;
  provider: ProviderId;
  health: HealthResponse | null;
  onSelectProvider: (p: ProviderId) => void;
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
}

const MemoryPanel = memo(function MemoryPanel({ memories, onUpdate, onAdd, onRemove }: MemoryPanelProps) {
  const [newMemText, setNewMemText] = useState('');

  const submitNew = () => {
    if (newMemText.trim()) {
      onAdd(newMemText.trim());
      setNewMemText('');
    }
  };

  return (
    <section className="flex flex-col gap-2.5">
      <div className={RAIL_LABEL}>Constitutional Memories</div>

      <div className="flex flex-col gap-2.5">
        {memories.map((mem, i) => {
          const tone = confidenceTone(mem.confidence);
          const toned = mem.confidence > 70 || mem.confidence < 30;
          return (
            <Card
              key={mem.id}
              className="gap-0 rounded-[14px] border px-[14px] pt-[14px] pb-3 shadow-none transition-colors"
              style={{ borderColor: toned ? `color-mix(in srgb, ${tone} 45%, transparent)` : undefined }}
            >
              <div className="mb-2 flex items-baseline justify-between font-mono text-[10.5px] tracking-[0.08em] text-fg-3">
                <span className="text-fg-2">M{i + 1}</span>
                <div className="flex items-center gap-2">
                  <span className="font-medium" style={{ color: tone }}>{mem.confidence}%</span>
                  <button
                    className="cursor-pointer px-0.5 text-sm leading-none text-fg-4 transition-colors hover:text-danger"
                    onClick={() => onRemove(mem.id)}
                    aria-label="Remove memory"
                  >×</button>
                </div>
              </div>
              <div
                className="mb-3 min-h-[18px] cursor-text rounded-[3px] text-[13px] leading-[1.5] text-fg-1 outline-none focus:ring-2 focus:ring-ember/40"
                contentEditable
                suppressContentEditableWarning
                onBlur={(e) => onUpdate(mem.id, e.currentTarget.textContent ?? '')}
              >{mem.text}</div>
              <div className="relative h-[3px] overflow-hidden rounded-sm bg-hairline-strong">
                <span
                  className="absolute left-0 top-0 h-full rounded-sm bg-linear-to-r from-ember-soft to-ember transition-[width] duration-500"
                  style={{ width: `${mem.confidence}%` }}
                />
              </div>
              {mem.history.length > 0 && (
                <div className="mt-2 flex items-center gap-0.5">
                  {mem.history.slice(-20).map((h, j) => (
                    <span
                      key={j}
                      className="h-3 w-[3px] rounded-[1px]"
                      style={{
                        background: h.delta > 0 ? 'var(--color-success)' : h.delta < 0 ? 'var(--color-danger)' : 'var(--color-hairline-strong)',
                        opacity: h.delta === 0 ? 0.35 : 0.75,
                      }}
                    />
                  ))}
                </div>
              )}
            </Card>
          );
        })}
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

      {turnData.confidenceDeltas && (
        <Card className="gap-0 rounded-xl border px-[14px] py-3 shadow-none">
          <div className={RAIL_SUB}>Confidence Deltas</div>
          {turnData.confidenceDeltas.map((d, i) => (
            <div key={i} className="mt-1 flex items-center justify-between text-[11px]">
              <span className="font-mono text-fg-2">M{i + 1}</span>
              <span
                className="font-mono"
                style={{
                  color: d.delta > 0 ? 'var(--color-success)' : d.delta < 0 ? 'var(--color-danger)' : 'var(--color-fg-3)',
                  fontWeight: d.delta !== 0 ? 600 : 400,
                }}
              >{d.delta > 0 ? '+' : ''}{d.delta} → {d.newScore}%</span>
            </div>
          ))}
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

// Memoized so finalized messages don't re-run ReactMarkdown on every parent
// re-render (typing, pulse-key bumps, streaming token arrival). Only the
// in-flight streaming bubble re-renders as its `text` grows.
const AssistantMessage = memo(function AssistantMessage({
  text,
  streaming = false,
  label,
}: {
  text: string;
  streaming?: boolean;
  /** Display-only author label for this turn. Falls back to "Sal" when empty.
   * NEVER sourced from / sent to the model — this is the per-chat mask. */
  label?: string;
}) {
  const name = label && label.trim() ? label : 'Sal';
  return (
    <div
      className={cn(
        'flex flex-col gap-2 text-pretty text-[15px] font-light leading-[1.7] text-fg-1',
        streaming && 'sal-streaming',
      )}
    >
      <span className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-fg-3">
        {name}
      </span>
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
          pre: ({ node: _node, ...props }) => (
            <pre
              {...props}
              className="m-0 overflow-x-auto rounded-md border border-hairline-strong bg-surface-strong p-3"
            />
          ),
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
  const [memories, setMemories] = useState<Memory[]>(DEFAULT_MEMORIES);
  const [chatLog, setChatLog] = useState<ChatEntry[]>([]);
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  // Sal's reply as it streams in, with the trailing <turn-meta> block stripped.
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
  // Has the initial hydration completed? Guards the memory-save effect from
  // firing on mount with the DEFAULT_MEMORIES placeholder before the server
  // set has had a chance to load.
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
    return 'anthropic';
  });
  const chatEndRef = useRef<HTMLDivElement>(null);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  // Flipped true when the user or the model actually mutates `memories`.
  // Guards the memory-save effect so the post-hydration render — which sets
  // memories from the server payload — doesn't round-trip a redundant save.
  const memoriesDirtyRef = useRef(false);

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

  // --- Hydration: load global memories + restore the most recent chat. ---
  // Runs once on mount. The memory set is global across chats and overrides
  // the in-memory DEFAULT_MEMORIES placeholder *only if* the server returns
  // any rows — a fresh install (empty DB) keeps the defaults so the user has
  // something to push on. After hydration completes we mark hydrated=true,
  // unlocking the memory-save effect below.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [mem, list] = await Promise.all([apiGetMemories(), apiListChats()]);
        if (cancelled) return;
        if (mem.length > 0) setMemories(mem);
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
          }));
          setMessages(replay);
          setChatLog(replay);
          setTurnCount(Math.floor(replay.length / 2));
          // Restore the chat's persona (null → DEFAULT_PERSONA) + display mask.
          setActivePersona(detail.persona?.trim() ? detail.persona : DEFAULT_PERSONA);
          setActiveMask(detail.mask ?? '');
          if (detail.latestInspector) {
            setLatestTurn(detail.latestInspector as TurnData);
          }
        } else {
          // Fresh install: the starter chat stays default-Sal — no persona modal
          // on first run (Q2). activePersona/activeMask keep their defaults.
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

  // --- Memory sync: persist the global set whenever it changes, debounced. ---
  // Save is fire-and-forget; the UI is the source of truth in-session, the
  // server is the durable mirror. Two gates: hydration must have completed
  // (so we never overwrite real saved state with the mount-time placeholder),
  // and a real edit must have happened (so the post-hydration render — which
  // sets memories from the server payload — doesn't round-trip a no-op save).
  useEffect(() => {
    if (!hydrated || !memoriesDirtyRef.current) return;
    const handle = setTimeout(() => {
      apiSaveMemories(memories).catch((err) => console.warn('saveMemories failed:', err));
    }, 250);
    return () => clearTimeout(handle);
  }, [memories, hydrated]);

  const handleMemoryUpdate = useCallback((id: string, newText: string) => {
    memoriesDirtyRef.current = true;
    setMemories((prev) => prev.map((m) => (m.id === id ? { ...m, text: newText } : m)));
  }, []);

  const handleMemoryAdd = useCallback((text: string) => {
    memoriesDirtyRef.current = true;
    setMemories((prev) => [...prev, { id: crypto.randomUUID(), text, confidence: 50, history: [] }]);
  }, []);

  const handleMemoryRemove = useCallback((id: string) => {
    memoriesDirtyRef.current = true;
    setMemories((prev) => prev.filter((m) => m.id !== id));
  }, []);

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
      confidenceDeltas: null,
      // Counterfactual baseline: what the naive "send the whole history every
      // turn" pipeline would have sent. Computed BEFORE the new pair is
      // appended to chatLog, so `chatLog` here is everything prior to this
      // turn — same baseline the local buffer and cosine grep see. `now` is
      // the turn instant so any relative-time prefixes in the grep block (when
      // present) compute against the same reference instant the real prompt does.
      naiveTokens: estimateNaiveContextTokens(memories, chatLog, userInput, fetchedDocs, failedUrls, activePersona, turnStartedAt),
    };

    try {
      // ---- LOCAL BUFFER: last 2 turns (4 entries: user+assistant pairs) ----
      const localBuffer = chatLog.slice(-LOCAL_BUFFER_SIZE);
      turnData.localBufferSize = localBuffer.length;

      // ---- COSINE GREP + TIME SCORER: two-dimensional retrieval ----
      // searchScored runs the TF-IDF cosine engine (concept) and the time scorer
      // (recency / time-intent) and combines them multiplicatively. The cosine
      // engine (lib/tfidf.ts) stays pure and untouched — this is a sibling
      // orchestrator. Phase 1.5 invariant intact: no model in the retrieval path.
      const grepResults = searchScored(userInput, chatLog, turnStartedAt, {
        // Exclude exactly the buffer window so the two tiers never overlap —
        // same constant the buffer slice above uses (see lib/constants.ts).
        excludeLastN: LOCAL_BUFFER_SIZE,
        topK: 3,
        threshold: 0.08,
      });
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
      // Pass the turn instant into buildPrompt so retrieved turns get a
      // relative-time prefix ("3 hr ago" / "yesterday") computed against the
      // same reference the time scorer used.
      const systemPrompt = buildPrompt(memories, localBuffer, grepResults.length > 0 ? grepResults : null, fetchedDocs, failedUrls, activePersona, turnStartedAt);
      const turnResult = await runTurn(
        systemPrompt,
        userInput,
        (rawSoFar) => {
          // Render Sal's reply as it arrives; hide the trailing <turn-meta> block.
          setStreamingText(stripStreamingMeta(rawSoFar));
        },
        provider,
      );
      const { displayText, metadata } = parseTurnResponse(turnResult.text);

      turnData.inputTokens = turnResult.inputTokens;
      turnData.outputTokens = turnResult.outputTokens;
      turnData.totalLatency = turnResult.elapsed;

      // Promote the streamed reply to a finalized message. The transient
      // streaming bubble is cleared in `finally`, batched into this same
      // render — so the bubble swaps to a message with no flicker.
      setMessages((prev) => [...prev, { role: 'assistant' as const, content: displayText, createdAt: turnStartedAt }]);

      // ---- CONFIDENCE SCORING ----
      if (metadata?.confidence_scores) {
        const scores = metadata.confidence_scores;

        // Resolve each memory's new score up front, as a plain computation.
        // This must NOT happen inside the setMemories updater: StrictMode
        // double-invokes updaters in dev, so pushing deltas from within one
        // produced twice the entries (the diagnostics panel showed M1..M6 for
        // 3 memories). `memories` is a safe source here — confidence is only
        // ever changed by this block, so the closure value cannot be stale.
        const deltas: ConfidenceDelta[] = memories.map((mem, i) => {
          const raw = scores[`M${i + 1}`];
          const newScore = raw != null ? Math.max(0, Math.min(100, raw)) : mem.confidence;
          return { delta: newScore - mem.confidence, newScore };
        });
        turnData.confidenceDeltas = deltas;

        // The state update stays a functional updater — so a memory edited
        // mid-turn (present in `prev`) is preserved — but is now pure: it
        // only maps `prev` and returns, with no external side effect.
        memoriesDirtyRef.current = true;
        setMemories((prev) =>
          prev.map((mem, i) =>
            deltas[i]
              ? {
                  ...mem,
                  confidence: deltas[i].newScore,
                  history: [
                    ...mem.history,
                    { delta: deltas[i].delta, score: deltas[i].newScore, turn: newTurnNumber },
                  ],
                }
              : mem,
          ),
        );
      }

      // ---- APPEND TO PERSISTENT CHAT LOG ----
      setChatLog((prev) => [
        ...prev,
        { role: 'user' as const, content: userInput, createdAt: turnStartedAt },
        { role: 'assistant' as const, content: displayText, createdAt: turnStartedAt },
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
          .then(() => apiListChats())
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
  // display-only mask. Memories are global — they persist across chats and are
  // intentionally NOT reset. `mask` is stored for display only; it is NOT part
  // of the persona/prompt and never reaches /api/turn.
  //
  // Shared by the user-facing "Begin again" flow (via confirmPersona, which
  // supplies an edited persona/mask) and the delete-fallback path (which passes
  // nothing → default Sal). A null/blank persona is stored server-side as NULL
  // and resolves to DEFAULT_PERSONA at build time.
  const startNewChat = useCallback(async (persona?: string, mask?: string) => {
    setChatLog([]);
    setMessages([]);
    setLatestTurn(null);
    setTokenHistory([]);
    setTurnCount(0);
    // The active persona/mask follow the new chat. Empty/blank persona → the
    // default; trimmed mask, '' → "Sal" at render.
    const resolvedPersona = persona?.trim() ? persona : DEFAULT_PERSONA;
    const resolvedMask = mask?.trim() ?? '';
    setActivePersona(resolvedPersona);
    setActiveMask(resolvedMask);
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
  }, []);

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
  // inspector. Memories are global — they are NOT touched.
  const handleLoadChat = useCallback(async (id: string) => {
    if (id === chatId) {
      setHistoryOpen(false);
      return;
    }
    try {
      const detail = await apiLoadChat(id);
      const replay: ChatEntry[] = detail.turns.map((t) => ({
        role: t.role,
        content: t.content,
        id: t.id,
        active: t.active,
        createdAt: t.createdAt,
      }));
      setMessages(replay);
      setChatLog(replay);
      setTurnCount(Math.floor(replay.length / 2));
      setLatestTurn((detail.latestInspector as TurnData | null) ?? null);
      setTokenHistory([]);
      // Restore the chat's persona (null → DEFAULT_PERSONA) + display mask.
      setActivePersona(detail.persona?.trim() ? detail.persona : DEFAULT_PERSONA);
      setActiveMask(detail.mask ?? '');
      setChatId(id);
      setHistoryOpen(false);
    } catch (err) {
      console.warn('loadChat failed:', err);
    }
  }, [chatId]);

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

  // The chat memory editor gated some turns. If they belong to the chat that's
  // currently loaded in the thread, the in-memory log (which the next cosine
  // grep reads via cosineSearch) must reflect the new gates. We re-pull the
  // live chat rather than patch by id: in-session turns are appended to chatLog
  // without a DB id, so an id-match would miss them. The content is unchanged,
  // so the visible thread is unaffected — only chatLog's `active` flags + ids
  // refresh. Other chats are persisted server-side and pick the gate up on
  // their next load, so there's nothing to do for them.
  const handleActiveTurnsChanged = useCallback(
    async (editedChatId: string, _states: TurnActiveState[]) => {
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
          })),
        );
      } catch (err) {
        console.warn('active-chat grep resync failed:', err);
      }
    },
    [chatId],
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
        />

        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
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

                {messages.map((msg, i) =>
                  msg.role === 'user'
                    ? <UserPill key={i} text={msg.content} />
                    : <AssistantMessage key={i} text={msg.content} label={activeMask} />,
                )}

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

          {/* Context rail */}
          <aside className="sal-scroll relative z-20 flex max-h-[45vh] w-full flex-col gap-7 overflow-y-auto border-t border-hairline px-6 pt-[26px] pb-8 lg:h-full lg:max-h-none lg:w-[360px] lg:shrink-0 lg:border-t-0 lg:border-l">
            <MemoryPanel
              memories={memories}
              onUpdate={handleMemoryUpdate}
              onAdd={handleMemoryAdd}
              onRemove={handleMemoryRemove}
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
        returnFocusRef={historyButtonRef}
      />

      <ConfirmPersonaModal
        open={personaModalOpen}
        defaultPersona={DEFAULT_PERSONA}
        onConfirm={confirmPersona}
        onCancel={() => setPersonaModalOpen(false)}
      />
    </div>
  );
}
