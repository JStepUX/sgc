import { useCallback, useRef, useState } from 'react';
import type { FetchedDoc } from '../lib/types';
import type { TurnData } from '../lib/turn-data';
import { assembleTurnContext } from '../lib/turn-context';
import { estimateNaiveContextTokens, parseTurnResponse, stripStreamingMeta } from '../lib/prompt';
import { runTurn, extractUrls, fetchUrl } from '../lib/api';
import { runSpontaneity } from '../lib/spontaneity/engine';
import { operatorLabel } from '../lib/spontaneity/flexDeck';
import { saveTurn as apiSaveTurn, listChats as apiListChats } from '../lib/persistence';
import type { ChatSession } from './useChatSession';
import type { ProviderState } from './useProvider';

// ============================================================
// TURN RUNNER — the live turn: assemble the three tiers, make the single
// model call (streamed), promote the reply, persist the pair. Operates on the
// shared session (see useChatSession — the hooks are namespaces, not stores).
// ============================================================

export function useTurnRunner(
  session: ChatSession,
  providerState: Pick<ProviderState, 'provider' | 'health'>,
  /** Bumps the composer's resetSignal (clear + refocus its textarea). */
  bumpComposerReset: () => void,
): {
  isProcessing: boolean;
  streamingText: string | null;
  submitTurn: (text: string) => void;
} {
  const [isProcessing, setIsProcessing] = useState(false);
  // Sal's reply as it streams in, with the trailing <turn-summary> block stripped.
  // null = no turn streaming (show the dot-pulse loader instead).
  const [streamingText, setStreamingText] = useState<string | null>(null);

  // `text` is the trimmed draft the composer passed up. The composer also
  // pre-checks `submitDisabled`, but we keep the guard here as a belt to
  // those suspenders — this is the only path that mutates chat state.
  const processInput = async (text: string) => {
    const {
      chatId, chatLog, memories, activePersona, hydrated, turnCount,
      spontaneityStateRef,
      setMessages, setChatLog, setTurnCount, setLatestTurn, setTokenHistory, setChats,
    } = session;
    const { provider, health } = providerState;

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
    // own input state — typing never re-renders the root — so we can't just
    // `setInput('')` here.
    bumpComposerReset();
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
      // Spontaneity defaults — overwritten by the draw below (the reading is
      // recorded every turn; the operator fields only on a fire).
      spontaneityFired: false,
      spontaneityOperatorId: null,
      spontaneityDirective: null,
      spontaneitySimilarity: 0,
      // Counterfactual baseline: what the naive "send the whole history every
      // turn" pipeline would have sent. Computed BEFORE the new pair is
      // appended to chatLog, so `chatLog` here is everything prior to this
      // turn — same baseline the local buffer and cosine grep see. `now` is
      // the turn instant so any relative-time prefixes in the grep block (when
      // present) compute against the same reference instant the real prompt does.
      naiveTokens: estimateNaiveContextTokens(memories, chatLog, userInput, fetchedDocs, failedUrls, activePersona, turnStartedAt),
    };

    try {
      // ---- SPONTANEITY DRAW (deterministic detector, random operator pick) ----
      // The non-deterministic half: measure conversational "slack" over the prior
      // log and, if it's circling, draw a creative directive to inject this turn.
      // Done HERE (the caller), not inside assembleTurnContext, so that assembler
      // stays pure — a re-spin reproduces a turn by replaying the snapshotted
      // directive instead of redrawing. The detector is pure TF-IDF math (no model,
      // no API call); only the operator pick uses Math.random. The no-repeat ref
      // is READ here but COMMITTED only after the reply is finalized (below), so a
      // failed model call never records a last-fired operator it never delivered —
      // keeping the ref consistent with persistence (delivered turns only). See
      // lib/spontaneity/.
      const spont = runSpontaneity(chatLog, spontaneityStateRef.current);
      turnData.spontaneitySimilarity = spont.reading.similarity;
      turnData.spontaneityFired = spont.operator !== null;
      turnData.spontaneityOperatorId = spont.operator?.id ?? null;
      turnData.spontaneityDirective = spont.directive;
      const spontDisplay = spont.operator
        ? { label: operatorLabel(spont.operator.directive) }
        : undefined;

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
        spontaneityDirective: spont.directive,
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
        { role: 'assistant' as const, content: displayText, createdAt: turnStartedAt, summary: summary ?? undefined, spontaneity: spontDisplay },
      ]);

      // ---- APPEND TO PERSISTENT CHAT LOG ----
      // The assistant entry carries its summary so a LATER turn's summary window
      // can slice it from chatLog in-session (matching the reload path, where
      // summaryFromInspector rehydrates it). The user entry has none.
      setChatLog((prev) => [
        ...prev,
        { role: 'user' as const, content: userInput, createdAt: turnStartedAt },
        { role: 'assistant' as const, content: displayText, createdAt: turnStartedAt, summary: summary ?? undefined, spontaneity: spontDisplay },
      ]);

      setTokenHistory((prev) => [...prev, { turn: newTurnNumber, inputTokens: turnData.inputTokens }]);
      setLatestTurn(turnData);
      // Commit the no-repeat cursor now that the turn is delivered — not at the
      // draw, so a failed model call (the catch below) doesn't exclude an operator
      // that never produced a reply. Unchanged from the prior value when dormant.
      spontaneityStateRef.current = spont.state;

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
            const stamp = (entry: (typeof chatLog)[number]): (typeof chatLog)[number] =>
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

  // Stable wrapper around `processInput` so the memoized <Composer/> sees
  // referential stability across the gate/typing/pulse re-renders triggered
  // by keystrokes. `processInput` itself closes over a lot of state and
  // would re-create every render; the ref lets us hand the composer a
  // never-changing callback.
  const processInputRef = useRef(processInput);
  processInputRef.current = processInput;
  const submitTurn = useCallback((text: string) => {
    void processInputRef.current(text);
  }, []);

  return { isProcessing, streamingText, submitTurn };
}
