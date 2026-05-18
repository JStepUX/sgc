import { useState, useRef, useEffect, useCallback } from "react";

// ============================================================
// SALIENCE-GATED COGNITION — Phase 1.5
// Ephemeral Synth + TF-IDF Cosine Grep + 2-Turn Local Buffer
// No model-based retrieval. One reasoning component. One API call.
// ============================================================

const DEFAULT_MEMORIES = [
  { id: crypto.randomUUID(), text: "User processes ideas by writing and talking through them, not by internal visualization.", confidence: 50, history: [] },
  { id: crypto.randomUUID(), text: "User prefers direct communication without hedging or performative helpfulness.", confidence: 50, history: [] },
  { id: crypto.randomUUID(), text: "User values being corrected when wrong — wants to do right, not be right.", confidence: 50, history: [] },
];

// ============================================================
// TF-IDF COSINE SIMILARITY ENGINE (Grepory)
// Pure math. No model. No reasoning. No drift surface.
// ============================================================

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2)
    .filter((t) => !STOP_WORDS.has(t));
}

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "has", "have", "been", "from",
  "they", "will", "with", "this", "that", "what", "when", "where",
  "which", "their", "there", "these", "those", "then", "than", "them",
  "were", "would", "could", "should", "about", "into", "just", "also",
  "some", "more", "very", "like", "been", "being", "does", "doing",
  "did", "how", "who", "its", "let", "may", "say", "she", "him",
  "his", "here", "way", "each", "make", "well", "back", "only",
  "come", "made", "after", "use", "two", "other", "know", "take",
  "because", "good", "give", "most", "think", "over", "such", "much",
]);

function buildTFVector(tokens) {
  const tf = {};
  for (const t of tokens) {
    tf[t] = (tf[t] || 0) + 1;
  }
  // Normalize by document length
  const len = tokens.length || 1;
  for (const t in tf) {
    tf[t] /= len;
  }
  return tf;
}

function cosineSimilarity(vecA, vecB) {
  const allTerms = new Set([...Object.keys(vecA), ...Object.keys(vecB)]);
  let dot = 0, magA = 0, magB = 0;
  for (const term of allTerms) {
    const a = vecA[term] || 0;
    const b = vecB[term] || 0;
    dot += a * b;
    magA += a * a;
    magB += b * b;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// IDF computed across all turns in the log
function computeIDF(turnDocs) {
  const df = {};
  const N = turnDocs.length || 1;
  for (const doc of turnDocs) {
    const seen = new Set(doc.tokens);
    for (const term of seen) {
      df[term] = (df[term] || 0) + 1;
    }
  }
  const idf = {};
  for (const term in df) {
    idf[term] = Math.log(N / df[term]) + 1;
  }
  return idf;
}

function applyIDF(tf, idf) {
  const tfidf = {};
  for (const term in tf) {
    tfidf[term] = tf[term] * (idf[term] || 1);
  }
  return tfidf;
}

// Search the chat log, returning top matches above threshold
// excludeLastN: skip the last N entries (the local buffer handles those)
function cosineSearch(query, chatLog, excludeLastN = 4, topK = 3, threshold = 0.08) {
  if (chatLog.length <= excludeLastN) return [];

  const searchable = chatLog.slice(0, chatLog.length - excludeLastN);
  if (searchable.length === 0) return [];

  // Build turn-pair documents (user + assistant grouped)
  const turnDocs = [];
  for (let i = 0; i < searchable.length; i += 2) {
    const userMsg = searchable[i]?.content || "";
    const assistMsg = searchable[i + 1]?.content || "";
    const combined = `${userMsg} ${assistMsg}`;
    const tokens = tokenize(combined);
    turnDocs.push({
      tokens,
      tf: buildTFVector(tokens),
      turnIndex: Math.floor(i / 2) + 1,
      userContent: searchable[i]?.content || "",
      assistContent: searchable[i + 1]?.content || "",
    });
  }

  if (turnDocs.length === 0) return [];

  const idf = computeIDF(turnDocs);
  const queryTokens = tokenize(query);
  const queryTF = buildTFVector(queryTokens);
  const queryVec = applyIDF(queryTF, idf);

  const scored = turnDocs.map((doc) => ({
    ...doc,
    score: cosineSimilarity(queryVec, applyIDF(doc.tf, idf)),
  }));

  return scored
    .filter((d) => d.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ============================================================
// SYNTH PROMPT BUILDERS
// ============================================================

function buildSynthPrompt(memories, localBuffer, grepResults) {
  const memBlock = memories
    .map((m, i) => `  [M${i + 1}] (confidence: ${m.confidence}%) ${m.text}`)
    .join("\n");

  let localBlock = "";
  if (localBuffer.length > 0) {
    localBlock = `\nRECENT CONTEXT (last exchange):\n${localBuffer.map((e) => `  ${e.role}: ${e.content}`).join("\n")}`;
  }

  let grepBlock = "";
  if (grepResults && grepResults.length > 0) {
    const fragments = grepResults.map((r) =>
      `  [Turn ${r.turnIndex}] User: ${r.userContent}\n  [Turn ${r.turnIndex}] Assistant: ${r.assistContent}`
    ).join("\n\n");
    grepBlock = `\nRETRIEVED HISTORY (cosine similarity match):\n${fragments}`;
  }

  return `You are Sal — an ephemeral reasoning instance. You exist for exactly one turn, then you are retired. You have no memory of prior conversations. You will never exist again.

You know the user through constitutional memories — distilled, curated knowledge about who they are. These memories have confidence scores reflecting how consistently they've held across prior exchanges.

CONSTITUTIONAL MEMORIES:
${memBlock}
${localBlock}
${grepBlock}

YOUR TASK:
1. Respond to the user's input naturally and helpfully, informed by the memories${localBuffer.length > 0 ? ", recent context" : ""}${grepResults?.length > 0 ? ", and retrieved history" : ""}.
2. After your response, output a JSON metadata block.

CONFIDENCE SCORING:
- For each memory, assess: did this exchange provide evidence for or against it?
- If irrelevant to a memory, return its current score unchanged.
- If reinforced, nudge upward (max +5 per turn).
- If contradicted, nudge downward (max -5 per turn).
- Scores clamp between 0 and 100. Be conservative. Most turns leave most scores unchanged.

OUTPUT FORMAT — you MUST end your response with a fenced JSON block:

\`\`\`json
{
  "confidence_scores": {
    "M1": 50,
    "M2": 55,
    "M3": 48
  }
}
\`\`\`

IMPORTANT: The JSON block must be the very last thing in your response. Natural language first, then the JSON block.`;
}

// ============================================================
// API + PARSING
// ============================================================

async function callClaude(systemPrompt, userMessage, maxTokens = 1500) {
  const startTime = Date.now();
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  const data = await response.json();
  const elapsed = Date.now() - startTime;
  const text = data.content?.map((b) => b.text || "").join("") || "";
  const inputTokens = data.usage?.input_tokens || 0;
  const outputTokens = data.usage?.output_tokens || 0;
  return { text, inputTokens, outputTokens, elapsed };
}

function parseSynthResponse(raw) {
  const jsonMatch = raw.match(/```json\s*([\s\S]*?)\s*```/);
  let metadata = null;
  let displayText = raw;

  if (jsonMatch) {
    try {
      metadata = JSON.parse(jsonMatch[1]);
    } catch (e) {
      console.warn("Failed to parse Synth metadata:", e);
    }
    displayText = raw.slice(0, jsonMatch.index).trim();
  }
  return { displayText, metadata };
}

// ============================================================
// COMPONENTS
// ============================================================

function MemoryPanel({ memories, onUpdate, onAdd, onRemove }) {
  const [newMemText, setNewMemText] = useState("");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div style={{
        fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
        fontSize: "10px",
        textTransform: "uppercase",
        letterSpacing: "2px",
        color: "var(--text-dim)",
        marginBottom: "2px",
      }}>Constitutional Memories</div>

      {memories.map((mem, i) => (
        <div key={mem.id} style={{
          background: "var(--surface-raised)",
          borderRadius: "6px",
          padding: "10px 12px",
          border: `1px solid ${mem.confidence > 70 ? "var(--accent-green)" : mem.confidence < 30 ? "var(--accent-red)" : "var(--border)"}`,
          transition: "border-color 0.3s ease",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "10px", color: "var(--text-dim)" }}>M{i + 1}</span>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div style={{ width: "60px", height: "4px", background: "var(--surface-deep)", borderRadius: "2px", overflow: "hidden" }}>
                <div style={{
                  width: `${mem.confidence}%`,
                  height: "100%",
                  background: mem.confidence > 70 ? "var(--accent-green)" : mem.confidence < 30 ? "var(--accent-red)" : "var(--accent-amber)",
                  transition: "width 0.5s ease, background 0.5s ease",
                  borderRadius: "2px",
                }} />
              </div>
              <span style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "11px",
                color: mem.confidence > 70 ? "var(--accent-green)" : mem.confidence < 30 ? "var(--accent-red)" : "var(--accent-amber)",
                minWidth: "32px",
                textAlign: "right",
              }}>{mem.confidence}%</span>
              <button
                onClick={() => onRemove(mem.id)}
                style={{
                  background: "none", border: "none", color: "var(--text-dim)",
                  cursor: "pointer", fontSize: "14px", padding: "0 2px", lineHeight: 1, opacity: 0.5,
                }}
                onMouseEnter={(e) => { e.target.style.opacity = 1; e.target.style.color = "var(--accent-red)"; }}
                onMouseLeave={(e) => { e.target.style.opacity = 0.5; e.target.style.color = "var(--text-dim)"; }}
              >×</button>
            </div>
          </div>
          <div
            contentEditable
            suppressContentEditableWarning
            onBlur={(e) => onUpdate(mem.id, e.target.textContent)}
            style={{
              fontSize: "12.5px", lineHeight: "1.5", color: "var(--text-primary)",
              outline: "none", cursor: "text", minHeight: "18px",
            }}
          >{mem.text}</div>
          {mem.history.length > 0 && (
            <div style={{ marginTop: "6px", display: "flex", gap: "2px", alignItems: "center" }}>
              {mem.history.slice(-20).map((h, j) => (
                <div key={j} style={{
                  width: "3px", height: "12px", borderRadius: "1px",
                  background: h.delta > 0 ? "var(--accent-green)" : h.delta < 0 ? "var(--accent-red)" : "var(--border)",
                  opacity: h.delta === 0 ? 0.3 : 0.7,
                }} />
              ))}
            </div>
          )}
        </div>
      ))}

      <div style={{ display: "flex", gap: "6px", marginTop: "4px" }}>
        <input
          value={newMemText}
          onChange={(e) => setNewMemText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && newMemText.trim()) {
              onAdd(newMemText.trim());
              setNewMemText("");
            }
          }}
          placeholder="Add memory..."
          style={{
            flex: 1, background: "var(--surface-deep)", border: "1px solid var(--border)",
            borderRadius: "4px", padding: "6px 10px", color: "var(--text-primary)",
            fontSize: "12px", fontFamily: "inherit", outline: "none",
          }}
        />
        <button
          onClick={() => { if (newMemText.trim()) { onAdd(newMemText.trim()); setNewMemText(""); } }}
          style={{
            background: "var(--accent-blue)", color: "#fff", border: "none",
            borderRadius: "4px", padding: "6px 12px", fontSize: "11px",
            cursor: "pointer", fontFamily: "'JetBrains Mono', monospace",
          }}
        >+</button>
      </div>
    </div>
  );
}

function TurnInspector({ turnData }) {
  if (!turnData) return (
    <div style={{ color: "var(--text-dim)", fontSize: "12px", fontStyle: "italic", padding: "12px 0" }}>
      Send a message to see turn diagnostics.
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace", fontSize: "10px",
        textTransform: "uppercase", letterSpacing: "2px", color: "var(--text-dim)",
      }}>Turn {turnData.turnNumber} Diagnostics</div>

      {/* Payload stats */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "6px" }}>
        {[
          { label: "Input Tk", value: turnData.synthInputTokens, color: "var(--accent-blue)" },
          { label: "Output Tk", value: turnData.synthOutputTokens, color: "var(--accent-green)" },
          { label: "Latency", value: `${(turnData.totalLatency / 1000).toFixed(1)}s`, color: "var(--accent-amber)" },
        ].map((stat) => (
          <div key={stat.label} style={{
            background: "var(--surface-raised)", borderRadius: "4px", padding: "8px", textAlign: "center",
          }}>
            <div style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: "16px",
              color: stat.color, fontWeight: 600,
            }}>{stat.value}</div>
            <div style={{
              fontSize: "9px", textTransform: "uppercase", letterSpacing: "1px",
              color: "var(--text-dim)", marginTop: "2px",
            }}>{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Architecture trace */}
      <div style={{
        background: "var(--surface-raised)", borderRadius: "4px", padding: "8px 10px",
      }}>
        <div style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: "10px",
          textTransform: "uppercase", letterSpacing: "1.5px", color: "var(--text-dim)", marginBottom: "6px",
        }}>Architecture Trace</div>

        {/* Local buffer */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
          <div style={{
            width: "6px", height: "6px", borderRadius: "50%",
            background: turnData.localBufferSize > 0 ? "var(--accent-green)" : "var(--border)",
          }} />
          <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
            Local buffer: {turnData.localBufferSize > 0 ? `${turnData.localBufferSize} msgs` : "empty (turn 1)"}
          </span>
        </div>

        {/* Cosine search */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: turnData.grepFired ? "6px" : 0 }}>
          <div style={{
            width: "6px", height: "6px", borderRadius: "50%",
            background: turnData.grepFired ? "var(--accent-amber)" : "var(--border)",
          }} />
          <span style={{ fontSize: "11px", color: turnData.grepFired ? "var(--accent-amber)" : "var(--text-secondary)" }}>
            Cosine Grep: {turnData.grepFired ? `${turnData.grepMatches} match${turnData.grepMatches !== 1 ? "es" : ""}` : "no matches above threshold"}
          </span>
        </div>

        {turnData.grepFired && turnData.grepDetails && (
          <div style={{
            marginLeft: "12px", borderLeft: "2px solid var(--accent-amber)", paddingLeft: "8px",
          }}>
            {turnData.grepDetails.map((g, i) => (
              <div key={i} style={{
                fontSize: "10px", fontFamily: "'JetBrains Mono', monospace",
                color: "var(--text-dim)", lineHeight: 1.5, marginBottom: "4px",
              }}>
                <span style={{ color: "var(--accent-amber)" }}>Turn {g.turnIndex}</span>
                <span style={{ color: "var(--text-dim)" }}> — score: {g.score.toFixed(3)}</span>
                <div style={{
                  color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis",
                  whiteSpace: "nowrap", maxWidth: "240px", marginTop: "1px",
                }}>{g.preview}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* API calls this turn */}
      <div style={{
        background: "var(--surface-raised)", borderRadius: "4px", padding: "8px 10px",
        border: "1px solid var(--border)",
      }}>
        <div style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: "10px",
          textTransform: "uppercase", letterSpacing: "1.5px", color: "var(--text-dim)", marginBottom: "4px",
        }}>API Calls This Turn</div>
        <div style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: "22px",
          color: "var(--accent-blue)", fontWeight: 700,
        }}>1</div>
        <div style={{ fontSize: "10px", color: "var(--text-dim)" }}>
          Sal only. Grep is TF-IDF (0ms).
        </div>
      </div>

      {/* Confidence deltas */}
      {turnData.confidenceDeltas && (
        <div style={{ background: "var(--surface-raised)", borderRadius: "4px", padding: "8px 10px" }}>
          <div style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: "10px",
            textTransform: "uppercase", letterSpacing: "1.5px", color: "var(--text-dim)", marginBottom: "6px",
          }}>Confidence Deltas</div>
          {turnData.confidenceDeltas.map((d, i) => (
            <div key={i} style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "2px 0", fontSize: "11px",
            }}>
              <span style={{ color: "var(--text-secondary)" }}>M{i + 1}</span>
              <span style={{
                fontFamily: "'JetBrains Mono', monospace",
                color: d.delta > 0 ? "var(--accent-green)" : d.delta < 0 ? "var(--accent-red)" : "var(--text-dim)",
                fontWeight: d.delta !== 0 ? 600 : 400,
              }}>
                {d.delta > 0 ? "+" : ""}{d.delta} → {d.newScore}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TokenChart({ tokenHistory }) {
  if (tokenHistory.length < 2) return null;

  const maxTokens = Math.max(...tokenHistory.map((t) => t.inputTokens), 1);
  const chartWidth = 240;
  const chartHeight = 60;
  const barWidth = Math.min(16, (chartWidth - tokenHistory.length * 2) / tokenHistory.length);

  return (
    <div style={{ marginTop: "6px" }}>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace", fontSize: "10px",
        textTransform: "uppercase", letterSpacing: "2px", color: "var(--text-dim)", marginBottom: "8px",
      }}>Payload Size per Turn</div>
      <svg width={chartWidth} height={chartHeight + 16} style={{ display: "block" }}>
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
  const [memories, setMemories] = useState(DEFAULT_MEMORIES);
  const [chatLog, setChatLog] = useState([]);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentPhase, setCurrentPhase] = useState(null);
  const [latestTurn, setLatestTurn] = useState(null);
  const [tokenHistory, setTokenHistory] = useState([]);
  const [turnCount, setTurnCount] = useState(0);
  const chatEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleMemoryUpdate = useCallback((id, newText) => {
    setMemories((prev) => prev.map((m) => m.id === id ? { ...m, text: newText } : m));
  }, []);

  const handleMemoryAdd = useCallback((text) => {
    setMemories((prev) => [...prev, { id: crypto.randomUUID(), text, confidence: 50, history: [] }]);
  }, []);

  const handleMemoryRemove = useCallback((id) => {
    setMemories((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const processInput = async () => {
    const userInput = input.trim();
    if (!userInput || isProcessing) return;

    const newTurnNumber = turnCount + 1;
    setTurnCount(newTurnNumber);
    setInput("");
    setIsProcessing(true);
    setMessages((prev) => [...prev, { role: "user", content: userInput }]);

    let turnData = {
      turnNumber: newTurnNumber,
      synthInputTokens: 0,
      synthOutputTokens: 0,
      totalLatency: 0,
      localBufferSize: 0,
      grepFired: false,
      grepMatches: 0,
      grepDetails: null,
      confidenceDeltas: null,
    };

    try {
      setCurrentPhase("synth");

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

      // ---- SINGLE SYNTH CALL ----
      const synthSystem = buildSynthPrompt(memories, localBuffer, grepResults.length > 0 ? grepResults : null);
      const synthResult = await callClaude(synthSystem, userInput);
      const { displayText, metadata } = parseSynthResponse(synthResult.text);

      turnData.synthInputTokens = synthResult.inputTokens;
      turnData.synthOutputTokens = synthResult.outputTokens;
      turnData.totalLatency = synthResult.elapsed;

      setMessages((prev) => [...prev, { role: "assistant", content: displayText }]);

      // ---- CONFIDENCE SCORING ----
      if (metadata?.confidence_scores) {
        const deltas = [];
        setMemories((prev) =>
          prev.map((mem, i) => {
            const key = `M${i + 1}`;
            const newScore = metadata.confidence_scores[key] != null
              ? Math.max(0, Math.min(100, metadata.confidence_scores[key]))
              : mem.confidence;
            const delta = newScore - mem.confidence;
            deltas.push({ delta, newScore });
            return {
              ...mem,
              confidence: newScore,
              history: [...mem.history, { delta, score: newScore, turn: newTurnNumber }],
            };
          })
        );
        turnData.confidenceDeltas = deltas;
      }

      // ---- APPEND TO PERSISTENT CHAT LOG ----
      setChatLog((prev) => [
        ...prev,
        { role: "user", content: userInput },
        { role: "assistant", content: displayText },
      ]);

      setTokenHistory((prev) => [...prev, { turn: newTurnNumber, inputTokens: turnData.synthInputTokens }]);
      setLatestTurn(turnData);

    } catch (err) {
      console.error("SGC Error:", err);
      setMessages((prev) => [...prev, { role: "assistant", content: `[System error: ${err.message}]` }]);
    } finally {
      setIsProcessing(false);
      setCurrentPhase(null);
      inputRef.current?.focus();
    }
  };

  return (
    <div style={{
      "--bg-deep": "#0d1117",
      "--bg-surface": "#161b22",
      "--surface-raised": "#1c2129",
      "--surface-deep": "#0a0e13",
      "--border": "#2a3140",
      "--text-primary": "#e2e8f0",
      "--text-secondary": "#94a3b8",
      "--text-dim": "#4a5568",
      "--accent-blue": "#3b82f6",
      "--accent-green": "#22c55e",
      "--accent-red": "#ef4444",
      "--accent-amber": "#f59e0b",
      fontFamily: "'IBM Plex Sans', 'SF Pro Text', -apple-system, sans-serif",
      background: "var(--bg-deep)",
      color: "var(--text-primary)",
      height: "100vh",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        padding: "12px 20px",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{
            width: "8px", height: "8px", borderRadius: "50%",
            background: isProcessing ? "var(--accent-amber)" : "var(--accent-green)",
            boxShadow: isProcessing ? "0 0 8px var(--accent-amber)" : "0 0 8px var(--accent-green)",
            transition: "all 0.3s ease",
          }} />
          <span style={{
            fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
            fontSize: "13px", fontWeight: 600, letterSpacing: "0.5px",
          }}>Salience-Gated Cognition</span>
          <span style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: "10px",
            color: "var(--accent-green)", background: "var(--surface-raised)",
            padding: "2px 8px", borderRadius: "3px",
          }}>Phase 1.5</span>
          <span style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: "9px",
            color: "var(--text-dim)",
          }}>1 API call/turn · TF-IDF Grep · 2-turn buffer</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          {isProcessing && (
            <div style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: "11px",
              color: "var(--accent-amber)", animation: "pulse 1.5s ease-in-out infinite",
            }}>Sal reasoning...</div>
          )}
          <button
            onClick={() => {
              setChatLog([]);
              setMessages([]);
              setLatestTurn(null);
              setTokenHistory([]);
              setTurnCount(0);
              setInput("");
            }}
            disabled={isProcessing}
            style={{
              background: "none", border: "1px solid var(--border)", borderRadius: "4px",
              padding: "4px 10px", color: "var(--text-secondary)", fontSize: "11px",
              fontFamily: "'JetBrains Mono', monospace", cursor: isProcessing ? "not-allowed" : "pointer",
              opacity: isProcessing ? 0.3 : 0.7, transition: "all 0.2s ease",
            }}
            onMouseEnter={(e) => { if (!isProcessing) { e.target.style.opacity = 1; e.target.style.borderColor = "var(--text-secondary)"; } }}
            onMouseLeave={(e) => { e.target.style.opacity = isProcessing ? 0.3 : 0.7; e.target.style.borderColor = "var(--border)"; }}
          >New Chat</button>
        </div>
      </div>

      {/* Main layout */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Chat panel */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", borderRight: "1px solid var(--border)" }}>
          <div style={{ flex: 1, overflow: "auto", padding: "16px 20px" }}>
            {messages.length === 0 && (
              <div style={{
                display: "flex", flexDirection: "column", alignItems: "center",
                justifyContent: "center", height: "100%", gap: "12px", opacity: 0.5,
              }}>
                <div style={{
                  fontFamily: "'JetBrains Mono', monospace", fontSize: "11px",
                  color: "var(--text-dim)", textAlign: "center", lineHeight: 1.6, maxWidth: "360px",
                }}>
                  Phase 1.5 — One API call per turn. Local buffer for immediate context.
                  TF-IDF cosine similarity for everything else. No model-based retrieval.
                  The only reasoning component is Sal, and Sal dies every turn.
                </div>
              </div>
            )}
            {messages.map((msg, i) => (
              <div key={i} style={{
                marginBottom: "14px", display: "flex", flexDirection: "column",
                alignItems: msg.role === "user" ? "flex-end" : "flex-start",
              }}>
                <div style={{
                  fontFamily: "'JetBrains Mono', monospace", fontSize: "9px",
                  textTransform: "uppercase", letterSpacing: "1.5px",
                  color: "var(--text-dim)", marginBottom: "4px",
                }}>{msg.role === "user" ? "You" : "Sal"}</div>
                <div style={{
                  maxWidth: "80%", padding: "10px 14px",
                  borderRadius: msg.role === "user" ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
                  background: msg.role === "user" ? "var(--accent-blue)" : "var(--surface-raised)",
                  color: msg.role === "user" ? "#fff" : "var(--text-primary)",
                  fontSize: "13.5px", lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word",
                }}>{msg.content}</div>
              </div>
            ))}
            {isProcessing && (
              <div style={{ marginBottom: "14px", display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
                <div style={{
                  fontFamily: "'JetBrains Mono', monospace", fontSize: "9px",
                  textTransform: "uppercase", letterSpacing: "1.5px",
                  color: "var(--text-dim)", marginBottom: "4px",
                }}>Sal</div>
                <div style={{ padding: "10px 14px", borderRadius: "12px 12px 12px 2px", background: "var(--surface-raised)" }}>
                  <div style={{ display: "flex", gap: "4px" }}>
                    {[0, 1, 2].map((d) => (
                      <div key={d} style={{
                        width: "6px", height: "6px", borderRadius: "50%",
                        background: "var(--text-dim)",
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
          <div style={{ padding: "12px 20px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
            <div style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    processInput();
                  }
                }}
                placeholder="Message..."
                rows={1}
                style={{
                  flex: 1, background: "var(--surface-raised)", border: "1px solid var(--border)",
                  borderRadius: "8px", padding: "10px 14px", color: "var(--text-primary)",
                  fontSize: "13.5px", fontFamily: "inherit", outline: "none",
                  resize: "none", lineHeight: 1.5, maxHeight: "120px",
                }}
              />
              <button
                onClick={processInput}
                disabled={isProcessing || !input.trim()}
                style={{
                  background: isProcessing ? "var(--border)" : "var(--accent-blue)",
                  color: "#fff", border: "none", borderRadius: "8px",
                  padding: "10px 18px", fontSize: "13px", fontWeight: 600,
                  cursor: isProcessing ? "not-allowed" : "pointer",
                  opacity: isProcessing || !input.trim() ? 0.5 : 1,
                  transition: "all 0.2s ease", flexShrink: 0,
                }}
              >Send</button>
            </div>
          </div>
        </div>

        {/* Architecture panel */}
        <div style={{
          width: "320px", flexShrink: 0, overflow: "auto", padding: "16px",
          display: "flex", flexDirection: "column", gap: "20px", background: "var(--bg-surface)",
        }}>
          <MemoryPanel
            memories={memories}
            onUpdate={handleMemoryUpdate}
            onAdd={handleMemoryAdd}
            onRemove={handleMemoryRemove}
          />
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: "16px" }}>
            <TurnInspector turnData={latestTurn} />
          </div>
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: "16px" }}>
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
