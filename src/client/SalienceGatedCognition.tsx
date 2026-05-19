import { useState, useRef, useEffect, useCallback } from 'react';
import { ArrowUp, Plus } from 'lucide-react';
import type { Memory, ChatEntry } from './lib/types';
import { cosineSearch } from './lib/tfidf';
import { buildPrompt, parseTurnResponse, stripStreamingMeta } from './lib/prompt';
import { runTurn } from './lib/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

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
}

interface TokenHistoryEntry {
  turn: number;
  inputTokens: number;
}

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

function AuroraBackground({ gate, active, pulseKey }: { gate: number; active: boolean; pulseKey: number }) {
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
      {/* Re-keyed per keystroke so React remounts it and the animation restarts. */}
      <div className="sal-aurora-pulse" key={pulseKey} />
    </div>
  );
}

// ============================================================
// PHASE BAR — title, phase badge, run-mode metadata, begin-again.
// ============================================================

function PhaseBar({ processing, onReset }: { processing: boolean; onReset: () => void }) {
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
        <span className="rounded-full border border-ember/35 bg-ember/[0.08] px-2.5 py-1 font-mono text-[11px] font-medium tracking-[0.08em] text-ember">
          PHASE 1.5
        </span>
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
}

// ============================================================
// MEMORY PANEL — Constitutional Memories.
// ============================================================

interface MemoryPanelProps {
  memories: Memory[];
  onUpdate: (id: string, newText: string) => void;
  onAdd: (text: string) => void;
  onRemove: (id: string) => void;
}

function MemoryPanel({ memories, onUpdate, onAdd, onRemove }: MemoryPanelProps) {
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
}

// ============================================================
// TURN INSPECTOR — Architecture Trace, status, citations, deltas.
// ============================================================

function TurnInspector({ turnData }: { turnData: TurnData | null }) {
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

      <Card className="gap-0 rounded-xl border px-[14px] py-3 shadow-none">
        <div className={RAIL_SUB}>API Calls This Turn</div>
        <div className="mt-1.5 font-mono text-[22px] font-semibold text-ember">1</div>
        <div className="mt-0.5 text-[10.5px] text-fg-3">Sal only. Grep is TF-IDF (0 ms).</div>
      </Card>

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
}

// ============================================================
// TOKEN CHART — payload size per turn.
// ============================================================

function TokenChart({ tokenHistory }: { tokenHistory: TokenHistoryEntry[] }) {
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
}

// ============================================================
// MESSAGE BLOCKS — Sal's reply, the user's centred pills.
// ============================================================

function AssistantMessage({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const paragraphs = text.split(/\n{2,}/);
  return (
    <div className="flex flex-col gap-3.5">
      {paragraphs.map((p, i) => (
        <p key={i} className="m-0 text-pretty whitespace-pre-wrap text-[15px] leading-[1.7] text-fg-1">
          {p}
          {streaming && i === paragraphs.length - 1 && (
            <span className="ml-0.5 inline-block h-[1.05em] w-0.5 align-text-bottom bg-ember animate-blink" />
          )}
        </p>
      ))}
    </div>
  );
}

function UserPill({ text }: { text: string }) {
  return (
    <div className="my-1.5 flex justify-center">
      <div className="w-fit max-w-[90%] whitespace-pre-wrap break-words rounded-[22px] border border-hairline-strong bg-surface-thin px-5 py-2.5 text-[14.5px] leading-[1.5] text-fg-1 backdrop-blur-[6px]">
        {text}
      </div>
    </div>
  );
}

// ============================================================
// MAIN APP
// ============================================================

export default function SalienceGatedCognition() {
  const [memories, setMemories] = useState<Memory[]>(DEFAULT_MEMORIES);
  const [chatLog, setChatLog] = useState<ChatEntry[]>([]);
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  // Sal's reply as it streams in, with the trailing <turn-meta> block stripped.
  // null = no turn streaming (show the dot-pulse loader instead).
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [latestTurn, setLatestTurn] = useState<TurnData | null>(null);
  const [tokenHistory, setTokenHistory] = useState<TokenHistoryEntry[]>([]);
  const [turnCount, setTurnCount] = useState(0);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // --- Aurora gating: drift while active, pulse on each keystroke ---
  const [typing, setTyping] = useState(false);
  const [pulseKey, setPulseKey] = useState(0);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Salience rises with how much the user has drafted. The aurora element
  // carries a 600ms CSS transition on `filter` (see index.css), so each
  // input change just sets a new target and the browser eases to it. No
  // per-frame RAF, no 60fps re-render of the app tree.
  const wordCount = input.split(/\s+/).filter(Boolean).length;
  const gate = Math.min(0.9, 0.25 + wordCount * 0.06);

  const handleKeystroke = useCallback(() => {
    setPulseKey((k) => k + 1);
    setTyping(true);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => setTyping(false), 1600);
  }, []);

  // Auto-grow the composer to fit its content.
  useEffect(() => {
    const t = inputRef.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = `${Math.min(t.scrollHeight, 220)}px`;
  }, [input]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText]);

  const handleMemoryUpdate = useCallback((id: string, newText: string) => {
    setMemories((prev) => prev.map((m) => (m.id === id ? { ...m, text: newText } : m)));
  }, []);

  const handleMemoryAdd = useCallback((text: string) => {
    setMemories((prev) => [...prev, { id: crypto.randomUUID(), text, confidence: 50, history: [] }]);
  }, []);

  const handleMemoryRemove = useCallback((id: string) => {
    setMemories((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const processInput = async () => {
    const userInput = input.trim();
    if (!userInput || isProcessing) return;

    const newTurnNumber = turnCount + 1;
    setTurnCount(newTurnNumber);
    setInput('');
    setIsProcessing(true);
    setMessages((prev) => [...prev, { role: 'user' as const, content: userInput }]);

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
    };

    try {
      // ---- LOCAL BUFFER: last 2 turns (4 entries: user+assistant pairs) ----
      const localBuffer = chatLog.slice(-4);
      turnData.localBufferSize = localBuffer.length;

      // ---- COSINE GREP: search older history ----
      const grepResults = cosineSearch(userInput, chatLog, 4, 3, 0.08);
      if (grepResults.length > 0) {
        turnData.grepFired = true;
        turnData.grepMatches = grepResults.length;
        turnData.grepDetails = grepResults.map((r) => ({
          turnIndex: r.turnIndex,
          score: r.score,
          preview: r.userContent.slice(0, 80),
        }));
      }

      // ---- SINGLE MODEL CALL (streamed) ----
      const systemPrompt = buildPrompt(memories, localBuffer, grepResults.length > 0 ? grepResults : null);
      const turnResult = await runTurn(systemPrompt, userInput, (rawSoFar) => {
        // Render Sal's reply as it arrives; hide the trailing <turn-meta> block.
        setStreamingText(stripStreamingMeta(rawSoFar));
      });
      const { displayText, metadata } = parseTurnResponse(turnResult.text);

      turnData.inputTokens = turnResult.inputTokens;
      turnData.outputTokens = turnResult.outputTokens;
      turnData.totalLatency = turnResult.elapsed;

      // Promote the streamed reply to a finalized message. The transient
      // streaming bubble is cleared in `finally`, batched into this same
      // render — so the bubble swaps to a message with no flicker.
      setMessages((prev) => [...prev, { role: 'assistant' as const, content: displayText }]);

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
        { role: 'user' as const, content: userInput },
        { role: 'assistant' as const, content: displayText },
      ]);

      setTokenHistory((prev) => [...prev, { turn: newTurnNumber, inputTokens: turnData.inputTokens }]);
      setLatestTurn(turnData);
    } catch (err) {
      console.error('SGC Error:', err);
      const detail = err instanceof Error ? err.message : String(err);
      setMessages((prev) => [...prev, { role: 'assistant' as const, content: `I lost my place. Try again? (${detail})` }]);
    } finally {
      setStreamingText(null);
      setIsProcessing(false);
      inputRef.current?.focus();
    }
  };

  const handleReset = () => {
    setChatLog([]);
    setMessages([]);
    setLatestTurn(null);
    setTokenHistory([]);
    setTurnCount(0);
    setInput('');
  };

  return (
    <div className="relative h-screen w-full overflow-hidden bg-ground font-sans text-fg-1">
      <AuroraBackground gate={gate} active={typing || isProcessing} pulseKey={pulseKey} />

      <div className="relative z-10 flex h-full w-full flex-col">
        <PhaseBar processing={isProcessing} onReset={handleReset} />

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
                    : <AssistantMessage key={i} text={msg.content} />,
                )}

                {streamingText !== null && (
                  <AssistantMessage text={streamingText || ' '} streaming />
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

            {/* Composer */}
            <div className="mx-auto w-full max-w-[680px] px-8 pt-[14px] pb-[22px]">
              <div className="flex items-end gap-2.5 rounded-[24px] border border-hairline-strong bg-surface-thin py-2 pr-2 pl-[18px] shadow-glass backdrop-blur-[10px]">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void processInput();
                      return;
                    }
                    if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter') {
                      handleKeystroke();
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
                  onClick={() => void processInput()}
                  disabled={isProcessing || !input.trim()}
                  aria-label="Say it"
                  className="size-[30px] rounded-full text-fg-2 hover:border-ember hover:bg-ember hover:text-bone"
                ><ArrowUp className="size-[15px]" /></Button>
              </div>
            </div>
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
    </div>
  );
}
