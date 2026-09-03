import { useCallback, useRef, useState } from 'react';
import type { ChatEntry, FetchedDoc } from '../lib/types';
import type { TurnData } from '../lib/turn-data';
import { assembleTurnContext } from '../lib/turn-context';
import { estimateNaiveContextTokens, parseTurnResponse, stripStreamingMeta } from '../lib/prompt';
import { STATE_CONTEXT_SIZE, newestDynamicState } from '../lib/dynamic-state';
import { callStateTurn, commitStateTurn } from '../lib/state-turn';
import { extractUrls, fetchUrl } from '../lib/api';
import { executeRecall, RECALL_TOOL } from '../lib/recall';
import { runTurnWithRecall } from '../lib/recall-loop';
import { runSpontaneity } from '../lib/spontaneity/engine';
import { drawPacingCeiling, pacingOutcomeFor } from '../lib/pacing';
import { operatorLabel } from '../lib/spontaneity/flexDeck';
import { saveTurn as apiSaveTurn, listChats as apiListChats } from '../lib/persistence';
import type { ChatSession } from './useChatSession';
import type { ProviderState } from './useProvider';
import type { StateCallTracker } from './useStateCalls';

// ============================================================
// TURN RUNNER — the live turn: assemble the three tiers, run the model call
// (streamed; up to two extra rounds when Sal deliberately recalls), promote
// the reply, persist the pair, and fire the post-reply state turn. Operates on
// the shared session (see useChatSession — the hooks are namespaces, not
// stores).
// ============================================================

export function useTurnRunner(
  session: ChatSession,
  providerState: Pick<ProviderState, 'provider' | 'health'>,
  /** Bumps the composer's resetSignal (clear + refocus its textarea). */
  bumpComposerReset: () => void,
  /** The shared per-chat reflecting registry (see useStateCalls) — the rail
   *  reads it via the root; this hook only reports starts/ends into it. */
  stateCalls: StateCallTracker,
): {
  isProcessing: boolean;
  streamingText: string | null;
  turnStatus: 'streaming' | 'remembering' | null;
  submitTurn: (text: string) => void;
} {
  const [isProcessing, setIsProcessing] = useState(false);
  // Sal's reply as it streams in, with the trailing <turn-summary> block stripped.
  // null = no turn streaming (show the dot-pulse loader instead).
  const [streamingText, setStreamingText] = useState<string | null>(null);
  // What the in-flight turn is doing: 'remembering' while a recall round-trip
  // runs (the root shows the quiet "Remembering…" line under any streamed
  // text), 'streaming' once deltas arrive, null when nothing is in flight.
  const [turnStatus, setTurnStatus] = useState<'streaming' | 'remembering' | null>(null);

  // `text` is the trimmed draft the composer passed up. The composer also
  // pre-checks `submitDisabled`, but we keep the guard here as a belt to
  // those suspenders — this is the only path that mutates chat state.
  const processInput = async (text: string) => {
    const {
      chatId, chatLog, constitutional, activePersona, hydrated, turnCount,
      brainIndex, spontaneityStateRef, latestTurn,
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
      knowledgeDetails: null,
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
      naiveTokens: estimateNaiveContextTokens(constitutional, chatLog, userInput, fetchedDocs, failedUrls, activePersona, turnStartedAt),
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

      // ---- PACING DRAW (random ceiling, blind to the input) ----
      // How much of the scene this reply may cover: a paragraph ceiling from
      // the weighted deck, never the same as the previous reply's (read off
      // the latest turn's persisted diagnostics — restored on load/undo/tangent
      // like everything else in latestTurn, so it survives reloads without a
      // ref of its own). Rendered into the prompt below, enforced server-side
      // at the Nth paragraph break, snapshotted here for faithful re-spins.
      // See lib/pacing.ts for why the cap can't do this job.
      const pacingCeiling = drawPacingCeiling(latestTurn?.pacingCeiling ?? null);
      turnData.pacingCeiling = pacingCeiling;

      // ---- PROVIDER + RECALL GATE (decided BEFORE prompt assembly) ----
      // Assert the provider token only once /api/health has CONFIRMED it
      // available — an explicit-but-unavailable token 503s by design
      // (resolveTurnProvider never reroutes), and before health resolves (or
      // when the fetch failed) the stored/initial token is just a guess.
      // Omitting it lets the server route to its boot default instead. This
      // matters since the fresh-install default became LOCAL: a fast submit
      // on an Anthropic-only deploy must not 503 on an unconfigured 'openai'.
      const confirmedProvider = health?.providers[provider]?.available ? provider : undefined;
      // Deliberate recall is Anthropic-only in v1 (spec D2) — and the decision
      // is made HERE, before assembly, because the prompt's recall framing and
      // the tool attachment must toggle together from this one value. An
      // unconfirmed provider gets no tools (we can't know what will serve the
      // turn), so it also gets no framing — never tell Sal about a tool it
      // might not have.
      const recallEnabled = confirmedProvider === 'anthropic';

      // ---- ASSEMBLE THE THREE TIERS (deterministic, no model) ----
      // localBuffer (verbatim last 2 turns) + distilled summary window + cosine
      // grep + buildPrompt — all in assembleTurnContext, the shared path the
      // re-spin editor reuses. `chatLog` here is everything PRIOR to this turn
      // (the new pair is appended further down), `turnStartedAt` is the single
      // reference instant for both the time scorer and the relative-time tags.
      const { systemPrompt, grepResults, knowledge, localBufferSize } = assembleTurnContext({
        query: userInput,
        priorLog: chatLog,
        constitutional,
        persona: activePersona,
        now: turnStartedAt,
        fetchedDocs,
        failedUrls,
        spontaneityDirective: spont.directive,
        // The knowledge axis: the union index over this chat's mounted brains
        // (null when none). Searched inside the assembler — still 0 ms, 0
        // tokens, no model; the memory grep above it is untouched.
        brainIndex,
        recallEnabled,
        maxParagraphs: pacingCeiling,
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
          // The full served text + provenance, for the RetrievalDetailModal.
          // Persisted verbatim (not looked up at render) so the diagnostic
          // stays what Sal ACTUALLY read even after memory edits.
          userContent: r.userContent,
          assistContent: r.assistContent,
          matchedTerms: r.matchedTerms,
          conceptScore: r.conceptScore,
          timeScore: r.timeScore,
          createdAt: r.createdAt,
          timeless: r.timeless,
        }));
      }
      if (knowledge && knowledge.results.length > 0) {
        turnData.knowledgeDetails = knowledge.results.map((r) => ({
          brainName: r.brainName,
          chunkId: r.chunkId,
          title: r.title,
          score: r.score,
          preview: r.text.slice(0, 80),
          // Full fragment as served — survives a later unmount of the brain.
          text: r.text,
        }));
      }

      // ---- MODEL CALL(S), STREAMED ----
      // One call on the common path; up to 1 + MAX_RECALL_ROUNDS when Sal
      // reaches for the recall tool (the consciously-amended guardrail — see
      // CLAUDE.md Mission Brief). The loop is pure control flow; every recall
      // executes client-side through the SAME deterministic engine as ambient
      // retrieval, seeded with the ambient grep's turnIndexes so a recall
      // never re-fetches what the prompt already carries (D5).
      const turnResult = await runTurnWithRecall({
        systemPrompt,
        userMessage: userInput,
        tools: recallEnabled ? [RECALL_TOOL] : null,
        provider: confirmedProvider,
        onDelta: (rawSoFar) => {
          // Render Sal's reply as it arrives; hide the trailing <turn-summary> block.
          setStreamingText(stripStreamingMeta(rawSoFar));
        },
        onStatus: setTurnStatus,
        executeTool: (input, surfaced) => executeRecall(input, chatLog, turnStartedAt, surfaced),
        initialSurfaced: grepResults.map((r) => r.turnIndex),
        maxParagraphs: pacingCeiling,
      });
      // Sal's reply is prose only now — the summary contract moved to the state
      // turn below. parseTurnResponse stays as a SCRUBBER: a model that emits a
      // <turn-summary> block from habit must not leak it into the thread. Its
      // summary result is deliberately unused here.
      const { displayText } = parseTurnResponse(turnResult.text);

      turnData.inputTokens = turnResult.inputTokens;
      turnData.outputTokens = turnResult.outputTokens;
      turnData.usageEstimated = turnResult.usageEstimated;
      turnData.totalLatency = turnResult.elapsed;
      turnData.recalls = turnResult.recalls;
      turnData.apiCalls = turnResult.apiCalls;
      turnData.pacingOutcome = pacingOutcomeFor(turnResult.stopReason);
      turnData.pacingTrimmed = turnResult.pacingTrimmed;
      // turnData.summary stays null until the state turn lands and PATCHes it
      // in (below) — the same for turnData.dynamicState.

      // Promote the streamed reply to a finalized message. The transient
      // streaming bubble is cleared in `finally`, batched into this same render
      // — so the bubble swaps to a message with no flicker. Summary + state are
      // stamped on afterwards, when the state turn returns.
      const assistantEntry: ChatEntry = {
        role: 'assistant',
        content: displayText,
        createdAt: turnStartedAt,
        spontaneity: spontDisplay,
      };
      const userEntry: ChatEntry = { role: 'user', content: userInput, createdAt: turnStartedAt };
      setMessages((prev) => [...prev, assistantEntry]);

      // ---- APPEND TO PERSISTENT CHAT LOG ----
      setChatLog((prev) => [...prev, userEntry, assistantEntry]);

      setTokenHistory((prev) => [...prev, { turn: newTurnNumber, inputTokens: turnData.inputTokens }]);
      setLatestTurn(turnData);
      // Commit the no-repeat cursor now that the turn is delivered — not at the
      // draw, so a failed model call (the catch below) doesn't exclude an operator
      // that never produced a reply. Unchanged from the prior value when dormant.
      spontaneityStateRef.current = spont.state;

      // ---- PERSIST THE TURN + RUN THE STATE TURN (both non-blocking) ----
      // Fired after the UI has rendered the new turn so neither round-trip
      // stalls a streaming response. Failures log but do not surface — the
      // in-memory session continues; only durability is at risk.
      if (chatId) {
        const persistChatId = chatId;
        const savePromise = apiSaveTurn(persistChatId, {
          user: { content: userInput },
          assistant: {
            content: displayText,
            inspectorJson: JSON.stringify(turnData),
          },
        });

        savePromise
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

        // The STATE TURN (D5): one small second call that distils this exchange
        // into the turn summary + Sal's inner state. Started NOW, in parallel
        // with the save — it needs no id, only prompt inputs — and joined with
        // it because the PATCH that attaches the result needs the assistant row
        // id save returns. Never awaited by the composer; a race with the next
        // submission just means that turn reads a one-turn-stale state (D6).
        const recentEntries = [...chatLog, userEntry, assistantEntry].slice(-STATE_CONTEXT_SIZE);
        const endStateCall = stateCalls.begin(persistChatId);
        const statePromise = callStateTurn({
          persona: activePersona,
          constitutional,
          recentEntries,
          // The state this turn began from — the newest in the log BEFORE the
          // pair just appended (which carries none yet).
          prevState: newestDynamicState(chatLog),
          spontaneityDirective: spont.directive,
          provider: confirmedProvider,
        });

        void Promise.all([savePromise, statePromise])
          .then(([{ assistantId }, outcome]) => {
            if (!outcome) return;
            return commitStateTurn(
              {
                chatId: persistChatId,
                assistantTurnId: assistantId,
                content: displayText,
                // The row was born from this very save — nothing can have
                // rewritten it at an epoch this chain didn't see.
                expectedEpoch: 0,
                baseTurnData: turnData,
                // Assistant half only — the summary and the state belong to the
                // reply, not to the person's message (which shares the instant).
                matches: (entry) => entry.role === 'assistant' && entry.createdAt === turnStartedAt,
                setMessages,
                setChatLog,
                setLatestTurn,
              },
              outcome,
            );
          })
          .catch((err) => console.warn('state turn could not be attached:', err))
          .finally(endStateCall);
      }
    } catch (err) {
      console.error('SGC Error:', err);
      const detail = err instanceof Error ? err.message : String(err);
      setMessages((prev) => [...prev, { role: 'assistant' as const, content: `I lost my place. Try again? (${detail})`, createdAt: Date.now() }]);
    } finally {
      setStreamingText(null);
      setTurnStatus(null);
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

  return { isProcessing, streamingText, turnStatus, submitTurn };
}
