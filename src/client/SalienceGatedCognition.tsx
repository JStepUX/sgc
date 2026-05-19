import { useState, useRef, useEffect, useCallback } from 'react';
import type { Memory, ChatEntry } from './lib/types';
import { cosineSearch } from './lib/tfidf';
import { buildPrompt, parseTurnResponse, stripStreamingMeta } from './lib/prompt';
import { runTurn } from './lib/api';

// ============================================================
// SALIENCE-GATED COGNITION — Phase 1.5
// Ephemeral Sal + TF-IDF Cosine Grep + 2-Turn Local Buffer
// No model-based retrieval. One reasoning component. One API call.
//
// The pure logic (TF-IDF engine, prompt builder, transport) lives in ./lib.
// This file is the React surface only.
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

// ============================================================
// COMPONENTS
// ============================================================

interface MemoryPanelProps {
  memories: Memory[];
  onUpdate: (id: string, newText: string) => void;
  onAdd: (text: string) => void;
  onRemove: (id: string) => void;
}

function MemoryPanel({ memories, onUpdate, onAdd, onRemove }: MemoryPanelProps) {
  const [newMemText, setNewMemText] = useState('');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{
        fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
        fontSize: '10px',
        textTransform: 'uppercase',
        letterSpacing: '2px',
        color: 'var(--text-dim)',
        marginBottom: '2px',
      }}>Constitutional Memories</div>

      {memories.map((mem, i) => (
        <div key={mem.id} style={{
          background: 'var(--surface-raised)',
          borderRadius: '6px',
          padding: '10px 12px',
          border: `1px solid ${mem.confidence > 70 ? 'var(--accent-green)' : mem.confidence < 30 ? 'var(--accent-red)' : 'var(--border)'}`,
          transition: 'border-color 0.3s ease',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', color: 'var(--text-dim)' }}>M{i + 1}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '60px', height: '4px', background: 'var(--surface-deep)', borderRadius: '2px', overflow: 'hidden' }}>
                <div style={{
                  width: `${mem.confidence}%`,
                  height: '100%',
                  background: mem.confidence > 70 ? 'var(--accent-green)' : mem.confidence < 30 ? 'var(--accent-red)' : 'var(--accent-amber)',
                  transition: 'width 0.5s ease, background 0.5s ease',
                  borderRadius: '2px',
                }} />
              </div>
              <span style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '11px',
                color: mem.confidence > 70 ? 'var(--accent-green)' : mem.confidence < 30 ? 'var(--accent-red)' : 'var(--accent-amber)',
                minWidth: '32px',
                textAlign: 'right',
              }}>{mem.confidence}%</span>
              <button
                onClick={() => onRemove(mem.id)}
                style={{
                  background: 'none', border: 'none', color: 'var(--text-dim)',
                  cursor: 'pointer', fontSize: '14px', padding: '0 2px', lineHeight: 1, opacity: 0.5,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.color = 'var(--accent-red)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.5'; e.currentTarget.style.color = 'var(--text-dim)'; }}
              >×</button>
            </div>
          </div>
          <div
            contentEditable
            suppressContentEditableWarning
            onBlur={(e) => onUpdate(mem.id, e.currentTarget.textContent ?? '')}
            style={{
              fontSize: '12.5px', lineHeight: '1.5', color: 'var(--text-primary)',
              outline: 'none', cursor: 'text', minHeight: '18px',
            }}
          >{mem.text}</div>
          {mem.history.length > 0 && (
            <div style={{ marginTop: '6px', display: 'flex', gap: '2px', alignItems: 'center' }}>
              {mem.history.slice(-20).map((h, j) => (
                <div key={j} style={{
                  width: '3px', height: '12px', borderRadius: '1px',
                  background: h.delta > 0 ? 'var(--accent-green)' : h.delta < 0 ? 'var(--accent-red)' : 'var(--border)',
                  opacity: h.delta === 0 ? 0.3 : 0.7,
                }} />
              ))}
            </div>
          )}
        </div>
      ))}

      <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
        <input
          value={newMemText}
          onChange={(e) => setNewMemText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newMemText.trim()) {
              onAdd(newMemText.trim());
              setNewMemText('');
            }
          }}
          placeholder="Add memory..."
          style={{
            flex: 1, background: 'var(--surface-deep)', border: '1px solid var(--border)',
            borderRadius: '4px', padding: '6px 10px', color: 'var(--text-primary)',
            fontSize: '12px', fontFamily: 'inherit', outline: 'none',
          }}
        />
        <button
          onClick={() => { if (newMemText.trim()) { onAdd(newMemText.trim()); setNewMemText(''); } }}
          style={{
            background: 'var(--accent-blue)', color: '#fff', border: 'none',
            borderRadius: '4px', padding: '6px 12px', fontSize: '11px',
            cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace",
          }}
        >+</button>
      </div>
    </div>
  );
}

function TurnInspector({ turnData }: { turnData: TurnData | null }) {
  if (!turnData) return (
    <div style={{ color: 'var(--text-dim)', fontSize: '12px', fontStyle: 'italic', padding: '12px 0' }}>
      Send a message to see turn diagnostics.
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace", fontSize: '10px',
        textTransform: 'uppercase', letterSpacing: '2px', color: 'var(--text-dim)',
      }}>Turn {turnData.turnNumber} Diagnostics</div>

      {/* Payload stats */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px' }}>
        {[
          { label: 'Input Tk', value: turnData.inputTokens, color: 'var(--accent-blue)' },
          { label: 'Output Tk', value: turnData.outputTokens, color: 'var(--accent-green)' },
          { label: 'Latency', value: `${(turnData.totalLatency / 1000).toFixed(1)}s`, color: 'var(--accent-amber)' },
        ].map((stat) => (
          <div key={stat.label} style={{
            background: 'var(--surface-raised)', borderRadius: '4px', padding: '8px', textAlign: 'center',
          }}>
            <div style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: '16px',
              color: stat.color, fontWeight: 600,
            }}>{stat.value}</div>
            <div style={{
              fontSize: '9px', textTransform: 'uppercase', letterSpacing: '1px',
              color: 'var(--text-dim)', marginTop: '2px',
            }}>{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Architecture trace */}
      <div style={{
        background: 'var(--surface-raised)', borderRadius: '4px', padding: '8px 10px',
      }}>
        <div style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: '10px',
          textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--text-dim)', marginBottom: '6px',
        }}>Architecture Trace</div>

        {/* Local buffer */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
          <div style={{
            width: '6px', height: '6px', borderRadius: '50%',
            background: turnData.localBufferSize > 0 ? 'var(--accent-green)' : 'var(--border)',
          }} />
          <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
            Local buffer: {turnData.localBufferSize > 0 ? `${turnData.localBufferSize} msgs` : 'empty (turn 1)'}
          </span>
        </div>

        {/* Cosine search */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: turnData.grepFired ? '6px' : 0 }}>
          <div style={{
            width: '6px', height: '6px', borderRadius: '50%',
            background: turnData.grepFired ? 'var(--accent-amber)' : 'var(--border)',
          }} />
          <span style={{ fontSize: '11px', color: turnData.grepFired ? 'var(--accent-amber)' : 'var(--text-secondary)' }}>
            Cosine Grep: {turnData.grepFired ? `${turnData.grepMatches} match${turnData.grepMatches !== 1 ? 'es' : ''}` : 'no matches above threshold'}
          </span>
        </div>

        {turnData.grepFired && turnData.grepDetails && (
          <div style={{
            marginLeft: '12px', borderLeft: '2px solid var(--accent-amber)', paddingLeft: '8px',
          }}>
            {turnData.grepDetails.map((g, i) => (
              <div key={i} style={{
                fontSize: '10px', fontFamily: "'JetBrains Mono', monospace",
                color: 'var(--text-dim)', lineHeight: 1.5, marginBottom: '4px',
              }}>
                <span style={{ color: 'var(--accent-amber)' }}>Turn {g.turnIndex}</span>
                <span style={{ color: 'var(--text-dim)' }}> — score: {g.score.toFixed(3)}</span>
                <div style={{
                  color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap', maxWidth: '240px', marginTop: '1px',
                }}>{g.preview}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* API calls this turn */}
      <div style={{
        background: 'var(--surface-raised)', borderRadius: '4px', padding: '8px 10px',
        border: '1px solid var(--border)',
      }}>
        <div style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: '10px',
          textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--text-dim)', marginBottom: '4px',
        }}>API Calls This Turn</div>
        <div style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: '22px',
          color: 'var(--accent-blue)', fontWeight: 700,
        }}>1</div>
        <div style={{ fontSize: '10px', color: 'var(--text-dim)' }}>
          Sal only. Grep is TF-IDF (0ms).
        </div>
      </div>

      {/* Confidence deltas */}
      {turnData.confidenceDeltas && (
        <div style={{ background: 'var(--surface-raised)', borderRadius: '4px', padding: '8px 10px' }}>
          <div style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: '10px',
            textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--text-dim)', marginBottom: '6px',
          }}>Confidence Deltas</div>
          {turnData.confidenceDeltas.map((d, i) => (
            <div key={i} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '2px 0', fontSize: '11px',
            }}>
              <span style={{ color: 'var(--text-secondary)' }}>M{i + 1}</span>
              <span style={{
                fontFamily: "'JetBrains Mono', monospace",
                color: d.delta > 0 ? 'var(--accent-green)' : d.delta < 0 ? 'var(--accent-red)' : 'var(--text-dim)',
                fontWeight: d.delta !== 0 ? 600 : 400,
              }}>
                {d.delta > 0 ? '+' : ''}{d.delta} → {d.newScore}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TokenChart({ tokenHistory }: { tokenHistory: TokenHistoryEntry[] }) {
  if (tokenHistory.length < 2) return null;

  const maxTokens = Math.max(...tokenHistory.map((t) => t.inputTokens), 1);
  const chartWidth = 240;
  const chartHeight = 60;
  const barWidth = Math.min(16, (chartWidth - tokenHistory.length * 2) / tokenHistory.length);

  return (
    <div style={{ marginTop: '6px' }}>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace", fontSize: '10px',
        textTransform: 'uppercase', letterSpacing: '2px', color: 'var(--text-dim)', marginBottom: '8px',
      }}>Payload Size per Turn</div>
      <svg width={chartWidth} height={chartHeight + 16} style={{ display: 'block' }}>
        {tokenHistory.map((t, i) => {
          const h = (t.inputTokens / maxTokens) * chartHeight;
          const x = i * (barWidth + 2);
          return (
            <g key={i}>
              <rect x={x} y={chartHeight - h} width={barWidth} height={h} rx={1} fill="var(--accent-blue)" opacity={0.7} />
              <text x={x + barWidth / 2} y={chartHeight + 12} textAnchor="middle" fontSize="8" fill="var(--text-dim)" fontFamily="'JetBrains Mono', monospace">{i + 1}</text>
            </g>
          );
        })}
        {tokenHistory.length > 2 && (() => {
          const avg = tokenHistory.reduce((s, t) => s + t.inputTokens, 0) / tokenHistory.length;
          const y = chartHeight - (avg / maxTokens) * chartHeight;
          return <line x1={0} y1={y} x2={chartWidth} y2={y} stroke="var(--accent-amber)" strokeDasharray="3,3" opacity={0.4} />;
        })()}
      </svg>
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
        // Render Sal's prose as it arrives; hide the trailing <turn-meta> block.
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
        const deltas: ConfidenceDelta[] = [];
        setMemories((prev) =>
          prev.map((mem, i) => {
            const key = `M${i + 1}`;
            const newScore = scores[key] != null
              ? Math.max(0, Math.min(100, scores[key]))
              : mem.confidence;
            const delta = newScore - mem.confidence;
            deltas.push({ delta, newScore });
            return {
              ...mem,
              confidence: newScore,
              history: [...mem.history, { delta, score: newScore, turn: newTurnNumber }],
            };
          }),
        );
        turnData.confidenceDeltas = deltas;
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
      setMessages((prev) => [...prev, { role: 'assistant' as const, content: `[System error: ${detail}]` }]);
    } finally {
      setStreamingText(null);
      setIsProcessing(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div style={{
      '--bg-deep': '#0d1117',
      '--bg-surface': '#161b22',
      '--surface-raised': '#1c2129',
      '--surface-deep': '#0a0e13',
      '--border': '#2a3140',
      '--text-primary': '#e2e8f0',
      '--text-secondary': '#94a3b8',
      '--text-dim': '#4a5568',
      '--accent-blue': '#3b82f6',
      '--accent-green': '#22c55e',
      '--accent-red': '#ef4444',
      '--accent-amber': '#f59e0b',
      fontFamily: "'IBM Plex Sans', 'SF Pro Text', -apple-system, sans-serif",
      background: 'var(--bg-deep)',
      color: 'var(--text-primary)',
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    } as React.CSSProperties}>
      {/* Header */}
      <div style={{
        padding: '12px 20px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: '8px', height: '8px', borderRadius: '50%',
            background: isProcessing ? 'var(--accent-amber)' : 'var(--accent-green)',
            boxShadow: isProcessing ? '0 0 8px var(--accent-amber)' : '0 0 8px var(--accent-green)',
            transition: 'all 0.3s ease',
          }} />
          <span style={{
            fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
            fontSize: '13px', fontWeight: 600, letterSpacing: '0.5px',
          }}>Salience-Gated Cognition</span>
          <span style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: '10px',
            color: 'var(--accent-green)', background: 'var(--surface-raised)',
            padding: '2px 8px', borderRadius: '3px',
          }}>Phase 1.5</span>
          <span style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: '9px',
            color: 'var(--text-dim)',
          }}>1 API call/turn · TF-IDF Grep · 2-turn buffer</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {isProcessing && (
            <div style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: '11px',
              color: 'var(--accent-amber)', animation: 'pulse 1.5s ease-in-out infinite',
            }}>Sal reasoning...</div>
          )}
          <button
            onClick={() => {
              setChatLog([]);
              setMessages([]);
              setLatestTurn(null);
              setTokenHistory([]);
              setTurnCount(0);
              setInput('');
            }}
            disabled={isProcessing}
            style={{
              background: 'none', border: '1px solid var(--border)', borderRadius: '4px',
              padding: '4px 10px', color: 'var(--text-secondary)', fontSize: '11px',
              fontFamily: "'JetBrains Mono', monospace", cursor: isProcessing ? 'not-allowed' : 'pointer',
              opacity: isProcessing ? 0.3 : 0.7, transition: 'all 0.2s ease',
            }}
            onMouseEnter={(e) => { if (!isProcessing) { e.currentTarget.style.opacity = '1'; e.currentTarget.style.borderColor = 'var(--text-secondary)'; } }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = isProcessing ? '0.3' : '0.7'; e.currentTarget.style.borderColor = 'var(--border)'; }}
          >New Chat</button>
        </div>
      </div>

      {/* Main layout */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Chat panel */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)' }}>
          <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
            {messages.length === 0 && (
              <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                justifyContent: 'center', height: '100%', gap: '12px', opacity: 0.5,
              }}>
                <div style={{
                  fontFamily: "'JetBrains Mono', monospace", fontSize: '11px',
                  color: 'var(--text-dim)', textAlign: 'center', lineHeight: 1.6, maxWidth: '360px',
                }}>
                  Phase 1.5 — One API call per turn. Local buffer for immediate context.
                  TF-IDF cosine similarity for everything else. No model-based retrieval.
                  The only reasoning component is Sal, and Sal dies every turn.
                </div>
              </div>
            )}
            {messages.map((msg, i) => (
              <div key={i} style={{
                marginBottom: '14px', display: 'flex', flexDirection: 'column',
                alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start',
              }}>
                <div style={{
                  fontFamily: "'JetBrains Mono', monospace", fontSize: '9px',
                  textTransform: 'uppercase', letterSpacing: '1.5px',
                  color: 'var(--text-dim)', marginBottom: '4px',
                }}>{msg.role === 'user' ? 'You' : 'Sal'}</div>
                <div style={{
                  maxWidth: '80%', padding: '10px 14px',
                  borderRadius: msg.role === 'user' ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
                  background: msg.role === 'user' ? 'var(--accent-blue)' : 'var(--surface-raised)',
                  color: msg.role === 'user' ? '#fff' : 'var(--text-primary)',
                  fontSize: '13.5px', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>{msg.content}</div>
              </div>
            ))}
            {streamingText !== null && (
              <div style={{ marginBottom: '14px', display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                <div style={{
                  fontFamily: "'JetBrains Mono', monospace", fontSize: '9px',
                  textTransform: 'uppercase', letterSpacing: '1.5px',
                  color: 'var(--text-dim)', marginBottom: '4px',
                }}>Sal</div>
                <div style={{
                  maxWidth: '80%', padding: '10px 14px',
                  borderRadius: '12px 12px 12px 2px',
                  background: 'var(--surface-raised)', color: 'var(--text-primary)',
                  fontSize: '13.5px', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>
                  {streamingText}
                  <span style={{
                    display: 'inline-block', width: '7px', height: '14px',
                    marginLeft: '1px', verticalAlign: 'text-bottom',
                    background: 'var(--accent-green)',
                    animation: 'blink 1s step-end infinite',
                  }} />
                </div>
              </div>
            )}
            {/* Dot-pulse loader: shown only before the first streamed token —
                once text is streaming the live bubble above replaces it. */}
            {isProcessing && streamingText === null && (
              <div style={{ marginBottom: '14px', display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                <div style={{
                  fontFamily: "'JetBrains Mono', monospace", fontSize: '9px',
                  textTransform: 'uppercase', letterSpacing: '1.5px',
                  color: 'var(--text-dim)', marginBottom: '4px',
                }}>Sal</div>
                <div style={{ padding: '10px 14px', borderRadius: '12px 12px 12px 2px', background: 'var(--surface-raised)' }}>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    {[0, 1, 2].map((d) => (
                      <div key={d} style={{
                        width: '6px', height: '6px', borderRadius: '50%',
                        background: 'var(--text-dim)',
                        animation: `dotPulse 1.2s ease-in-out ${d * 0.2}s infinite`,
                      }} />
                    ))}
                  </div>
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Input */}
          <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void processInput();
                  }
                }}
                placeholder="Message..."
                rows={1}
                style={{
                  flex: 1, background: 'var(--surface-raised)', border: '1px solid var(--border)',
                  borderRadius: '8px', padding: '10px 14px', color: 'var(--text-primary)',
                  fontSize: '13.5px', fontFamily: 'inherit', outline: 'none',
                  resize: 'none', lineHeight: 1.5, maxHeight: '120px',
                }}
              />
              <button
                onClick={() => void processInput()}
                disabled={isProcessing || !input.trim()}
                style={{
                  background: isProcessing ? 'var(--border)' : 'var(--accent-blue)',
                  color: '#fff', border: 'none', borderRadius: '8px',
                  padding: '10px 18px', fontSize: '13px', fontWeight: 600,
                  cursor: isProcessing ? 'not-allowed' : 'pointer',
                  opacity: isProcessing || !input.trim() ? 0.5 : 1,
                  transition: 'all 0.2s ease', flexShrink: 0,
                }}
              >Send</button>
            </div>
          </div>
        </div>

        {/* Architecture panel */}
        <div style={{
          width: '320px', flexShrink: 0, overflow: 'auto', padding: '16px',
          display: 'flex', flexDirection: 'column', gap: '20px', background: 'var(--bg-surface)',
        }}>
          <MemoryPanel
            memories={memories}
            onUpdate={handleMemoryUpdate}
            onAdd={handleMemoryAdd}
            onRemove={handleMemoryRemove}
          />
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '16px' }}>
            <TurnInspector turnData={latestTurn} />
          </div>
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '16px' }}>
            <TokenChart tokenHistory={tokenHistory} />
          </div>
        </div>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap');
        @keyframes dotPulse {
          0%, 100% { opacity: 0.3; transform: scale(0.8); }
          50% { opacity: 1; transform: scale(1); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 0.6; }
          50% { opacity: 1; }
        }
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: var(--text-dim); }
        textarea::placeholder { color: var(--text-dim); }
        input::placeholder { color: var(--text-dim); }
        [contenteditable]:focus {
          outline: 1px solid var(--accent-blue);
          outline-offset: 2px;
          border-radius: 2px;
        }
      `}</style>
    </div>
  );
}
