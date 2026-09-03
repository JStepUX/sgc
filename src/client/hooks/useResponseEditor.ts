import { useCallback, useMemo, useState } from 'react';
import type { ChatEntry, DynamicState, FetchedDoc } from '../lib/types';
import type { TurnData } from '../lib/turn-data';
import { assembleTurnContext } from '../lib/turn-context';
import { parseTurnResponse, stripStreamingMeta } from '../lib/prompt';
import { STATE_CONTEXT_SIZE, newestDynamicState } from '../lib/dynamic-state';
import { bumpWriteEpoch, runStateTurn, saveDynamicState as persistDynamicState, type StateTurnTarget } from '../lib/state-turn';
import { runTurn, extractUrls, fetchUrl } from '../lib/api';
import { operatorLabel } from '../lib/spontaneity/flexDeck';
import { lastFiredOperatorId } from '../lib/spontaneity/engine';
import { pacingOutcomeFor } from '../lib/pacing';
import { updateTurn as apiUpdateTurn, listChats as apiListChats, loadChat as apiLoadChat } from '../lib/persistence';
import type { RespinResult } from '../components/EditResponseModal';
import type { ChatSession } from './useChatSession';
import type { ProviderState } from './useProvider';
import type { StateCallTracker } from './useStateCalls';

// ============================================================
// RESPONSE EDITOR — edit the latest assistant reply (manual or re-spin).
// Operates on the shared session (see useChatSession — the hooks are
// namespaces, not stores).
// ============================================================

export function useResponseEditor(
  session: ChatSession,
  providerState: Pick<ProviderState, 'provider' | 'health'>,
  /** The shared per-chat reflecting registry — the post-save state chain (D9)
   *  counts here exactly like the live turn's, so the rail's hint covers both
   *  producers. */
  stateCalls: StateCallTracker,
): {
  /** The assistant reply being edited (latest turn only). A snapshot of its id +
   * content + instant; null when the response editor is closed. The re-spin/save
   * handlers resolve the live entry from chatLog by this id. */
  editTarget: { id: number; content: string; createdAt: number } | null;
  openLatestEditor: () => void;
  closeEditor: () => void;
  /** The human-facing name of the operator that fired on the latest turn, or
   * null when none did — drives the modal's replay toggle (hidden when null). */
  firedOperatorLabel: string | null;
  /** The paragraph ceiling the latest turn ran under (null for a pre-pacing
   * turn) — the modal's default for the ceiling picker. */
  turnCeiling: number | null;
  respin: (
    onDelta: (preview: string) => void,
    replayOperator: boolean,
    ceiling: number | null,
  ) => Promise<RespinResult>;
  saveEdit: (text: string, respin: RespinResult | null, operatorCleared: boolean) => Promise<void>;
  /** Whether the Dynamic State editor has a persisted turn to write to. */
  canEditDynamicState: boolean;
  /** Commit a hand-edited inner state onto the latest assistant turn (D11). */
  saveDynamicState: (state: DynamicState) => Promise<void>;
} {
  const {
    messages, chatLog, constitutional, activePersona, latestTurn, chatId, brainIndex,
    spontaneityStateRef,
    setMessages, setChatLog, setLatestTurn, setChats,
  } = session;
  const { provider, health } = providerState;

  const [editTarget, setEditTarget] = useState<{ id: number; content: string; createdAt: number } | null>(null);

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

  const closeEditor = useCallback(() => setEditTarget(null), []);

  // The modal's replay toggle only renders when the latest turn actually carries
  // a fired operator (the pencil is latest-turn only, so latestTurn IS this
  // turn's diagnostics). Label derived from the snapshotted directive, so it
  // stays correct even if the deck has since changed.
  const firedOperatorLabel = latestTurn?.spontaneityDirective
    ? operatorLabel(latestTurn.spontaneityDirective)
    : null;
  // The latest turn's paragraph ceiling (lib/pacing.ts) — what the modal's
  // picker starts on. A pre-pacing turn has none, and re-spins un-paced unless
  // the picker says otherwise.
  const turnCeiling = latestTurn?.pacingCeiling ?? null;

  // Re-spin: re-run the currently-selected model for the target turn. The chat
  // HISTORY tier is reconstructed faithfully — sliced to before this turn, recency
  // anchored at its original instant, so no later turn can leak in. The
  // constitutional document and persona are CURRENT, not snapshotted (they have
  // no per-turn binding anywhere; the modal copy says so). Streams stripped
  // preview text via onDelta.
  // This is the feature's one extra model call: an explicit user action that
  // reuses the deterministic context-assembly path (assembleTurnContext) and
  // keeps Sal ephemeral + memory retrieval pure math — inside the Phase 1.5
  // contract (the "one API call per turn" line is a guardrail, not the law).
  const respin = useCallback(
    async (
      onDelta: (preview: string) => void,
      replayOperator: boolean,
      ceiling: number | null,
    ): Promise<RespinResult> => {
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

      // Replay or DROP, never redraw. By default the fired operator is dropped —
      // the usual reason to re-spin a perturbed turn is to undo the perturbation.
      // The modal's toggle opts back into a faithful replay, re-injecting the
      // snapshotted directive byte-for-byte rather than rolling a fresh one.
      const directive = replayOperator ? (latestTurn?.spontaneityDirective ?? null) : null;
      // The paragraph ceiling is never REDRAWN on a re-spin: the modal passes
      // it in, defaulting to the turn's own snapshot (a faithful replay) and
      // letting the person raise, lower, or lift it — the usual reason to
      // re-spin a cut reply is that the draw was too small for the beat. Null
      // is an un-paced call (what a pre-pacing turn originally ran).

      const { systemPrompt } = assembleTurnContext({
        query: targetUser.content,
        priorLog: chatLog.slice(0, userIdx),
        constitutional,
        persona: activePersona,
        now: targetUser.createdAt,
        fetchedDocs,
        failedUrls,
        spontaneityDirective: directive,
        // CURRENT mounts, not a per-turn snapshot (spec D8) — same convention
        // as the constitutional document/persona above; the modal copy says so.
        brainIndex,
        maxParagraphs: ceiling,
      });

      const confirmedProvider = health?.providers[provider]?.available ? provider : undefined;
      const result = await runTurn(
        systemPrompt,
        [{ role: 'user', content: targetUser.content }],
        (raw) => onDelta(stripStreamingMeta(raw)),
        confirmedProvider,
        undefined,
        ceiling ? { maxParagraphs: ceiling } : undefined,
      );
      // Scrubber only — the re-spun text carries no summary contract; its
      // summary and state come from the state turn fired after the save (D9).
      const { displayText } = parseTurnResponse(result.text);
      return {
        text: displayText,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        elapsed: result.elapsed,
        // True only when a directive was actually injected into THIS run —
        // saveEdit uses it to keep or clear the turn's fired fields.
        operatorReplayed: directive !== null,
        stopReason: result.stopReason,
        pacingTrimmed: result.pacingTrimmed,
        usageEstimated: result.usageEstimated,
        ceiling,
      };
    },
    [editTarget, chatLog, constitutional, activePersona, health, provider, latestTurn, brainIndex],
  );

  // Save the edited reply. Persist FIRST, then commit to state on success (a
  // failure leaves the chat untouched and the modal open with the error). Both
  // branches clear the turn's stale summary AND inner state — the saved text is
  // not the text they described — and both then fire the SAME background state
  // turn for the new text (D9): a hand-crafted reply deserves a real summary and
  // state as much as a streamed one. inspector_json is rebuilt from the latest
  // turn's TurnData (this IS the latest turn) so the right-rail diagnostics
  // survive a reload.
  const saveEdit = useCallback(
    async (text: string, respinResult: RespinResult | null, operatorCleared: boolean) => {
      if (!editTarget || !chatId) return;
      const turnId = editTarget.id;

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
          knowledgeDetails: null,
          summary: null,
          spontaneityFired: false,
          spontaneityOperatorId: null,
          spontaneityDirective: null,
          spontaneitySimilarity: 0,
        };
      // `operatorCleared` (modal-supplied) — the saved text descends from an
      // operator-free re-spin, even if hand-edited since (so it can be true on
      // the manual path too). Clear the fired fields so the ⟐ marker and
      // inspector don't claim an injection this text never saw. The similarity
      // reading stays: it's the detector's measurement of the PRIOR log,
      // independent of injection. A plain manual edit (no clean re-spin behind
      // it) keeps the fields — the injected reply was hand-amended, not
      // regenerated.
      const clearedFields = operatorCleared
        ? { spontaneityFired: false, spontaneityOperatorId: null as string | null, spontaneityDirective: null as string | null }
        : {};
      // Stale summary/state are cleared on BOTH branches — the state turn fired
      // below replaces them, and clearing first keeps the persist-first failure
      // semantics clean (a failed write never leaves the old summary describing
      // new text).
      //
      // Call accounting restarts honestly too: a re-spin's reply came from
      // exactly ONE fresh call — no recall rounds, whatever the original turn
      // did — so apiCalls resets to 1 and the recall trace drops (else a
      // recall-free re-spin keeps reading "paused to remember"). A manual edit
      // spends no call, so it keeps the original REPLY count only — the
      // replaced state call is subtracted here and the replacement chain
      // re-adds its own, otherwise every repeated edit inflates the count by
      // one.
      const replyCallsOnly = Math.max(1, (base.apiCalls ?? 1) - (base.stateTokens ? 1 : 0));
      const nextInspector: TurnData = respinResult
        ? {
            ...base,
            inputTokens: respinResult.inputTokens,
            outputTokens: respinResult.outputTokens,
            usageEstimated: respinResult.usageEstimated,
            totalLatency: respinResult.elapsed,
            apiCalls: 1,
            recalls: undefined,
            summary: null,
            dynamicState: null,
            stateTokens: undefined,
            // The ceiling this run actually used (the modal may have changed
            // it) and this run's outcome — the snapshot describes the saved
            // text's own run, and the next draw's no-repeat rule reads it.
            pacingCeiling: respinResult.ceiling,
            pacingOutcome: pacingOutcomeFor(respinResult.stopReason),
            pacingTrimmed: respinResult.pacingTrimmed,
            ...clearedFields,
          }
        : {
            ...base,
            apiCalls: replyCallsOnly,
            summary: null,
            dynamicState: null,
            stateTokens: undefined,
            // Hand-edited text has no pacing outcome — the model didn't end it.
            // The ceiling stays as the snapshot a later re-spin replays.
            pacingOutcome: null,
            pacingTrimmed: undefined,
            ...clearedFields,
          };

      // Bump BEFORE the write: any state chain still in flight for this row
      // (the live turn's, or a previous edit's) describes text this save is
      // about to replace, and must abandon rather than revert it.
      const writeEpoch = bumpWriteEpoch(turnId);
      await apiUpdateTurn(chatId, turnId, {
        content: text,
        inspectorJson: JSON.stringify(nextInspector),
      });

      // Persisted — commit to the live logs (by id, so render + retrieval stay
      // in sync). Re-indexing for cosine grep is automatic (tfidf is uncached).
      const patch = (e: (typeof chatLog)[number]): (typeof chatLog)[number] =>
        e.id !== turnId
          ? e
          : {
              ...e,
              content: text,
              summary: undefined,
              dynamicState: undefined,
              // Mirror the inspector: an operator-free re-spin also drops the
              // live "⟐ Name" marker (rehydration would drop it on reload anyway).
              ...(operatorCleared ? { spontaneity: undefined } : {}),
            };
      setMessages((prev) => prev.map(patch));
      setChatLog((prev) => prev.map(patch));
      setLatestTurn(nextInspector);
      setEditTarget(null);

      // ---- POST-SAVE STATE TURN (D9, background) ----
      // The same chain the live turn runs, over the text that was just saved.
      // Built from the log as the patch left it: the edited reply in place, the
      // previous state read from BEFORE this turn (its own is now cleared).
      // Fired, not awaited — the modal has already closed.
      const editedIdx = chatLog.findIndex((e) => e.id === turnId);
      if (editedIdx >= 0) {
        const patched = chatLog.map(patch);
        const recentEntries = patched.slice(0, editedIdx + 1).slice(-STATE_CONTEXT_SIZE);
        const target: StateTurnTarget = {
          chatId,
          assistantTurnId: turnId,
          content: text,
          expectedEpoch: writeEpoch,
          baseTurnData: nextInspector,
          matches: (e) => e.id === turnId,
          setMessages,
          setChatLog,
          setLatestTurn,
        };
        const endStateCall = stateCalls.begin(chatId);
        void runStateTurn(target, {
          persona: activePersona,
          constitutional,
          recentEntries,
          prevState: newestDynamicState(patched.slice(0, editedIdx)),
          // Only a replayed operator actually perturbed the saved text.
          spontaneityDirective:
            respinResult && respinResult.operatorReplayed
              ? (latestTurn?.spontaneityDirective ?? null)
              : null,
          provider: health?.providers[provider]?.available ? provider : undefined,
        }).finally(endStateCall);
      }

      // The live no-repeat cursor may still point at the operator we just
      // cleared — the truth is now "the most recent fire among EARLIER turns",
      // and their inspector blobs live in the DB, not in any in-memory log. A
      // re-pull is the only honest refresh (same scan load/undo use). Awaited
      // so a turn submitted right after the save draws against the fresh
      // cursor; non-fatal on failure — the save landed, and a reload runs the
      // identical scan anyway.
      if (operatorCleared) {
        try {
          const detail = await apiLoadChat(chatId);
          spontaneityStateRef.current = {
            lastFiredId: lastFiredOperatorId(detail.turns.map((t) => t.inspectorJson)),
          };
        } catch (err) {
          console.warn('no-repeat cursor rescan failed (reload reconciles):', err);
        }
      }

      // Refresh the history list so its snippet (the latest assistant content)
      // reflects the edit. updateTurnContent doesn't bump updated_at, so this
      // refreshes the snippet without reordering the list.
      apiListChats().then(setChats).catch((err) => console.warn('listChats refresh failed:', err));
    },
    [
      editTarget, chatId, latestTurn, chatLog, activePersona, constitutional, health, provider,
      spontaneityStateRef, stateCalls, setMessages, setChatLog, setLatestTurn, setChats,
    ],
  );

  // ---- DYNAMIC STATE EDITOR (D11) ----
  // The rail's [ Edit ] writes to the latest PERSISTED assistant turn — the same
  // target the pencil uses, for the same reason: it's the only turn whose state
  // the next prompt will read. Timeless manual memories are skipped (they are
  // curated in the chat memory editor and carry no state).
  const latestAssistant: ChatEntry | null = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'assistant' && !m.timeless && typeof m.id === 'number') return m;
    }
    return null;
  }, [messages]);

  // A TurnData to merge into is as necessary as a row to write to — without one
  // there is no inspector blob to rebuild, so the button stays disabled.
  const canEditDynamicState = Boolean(chatId && latestAssistant && latestTurn);

  const saveDynamicState = useCallback(
    async (state: DynamicState) => {
      const turnId = latestAssistant?.id;
      if (!chatId || !latestAssistant || typeof turnId !== 'number' || !latestTurn) {
        throw new Error('No saved reply to attach a state to yet.');
      }
      await persistDynamicState(
        {
          chatId,
          assistantTurnId: turnId,
          // Content unchanged — this edits the state, not the reply.
          content: latestAssistant.content,
          // Hand curation outranks the machine: bumping kills any state chain
          // still reflecting on this turn, so the model's own result can't land
          // afterwards and overwrite what the user just wrote (D11 > D5). The
          // cost when that happens is a summary-less turn, not wrong data.
          expectedEpoch: bumpWriteEpoch(turnId),
          baseTurnData: latestTurn,
          matches: (e) => e.id === turnId,
          setMessages,
          setChatLog,
          setLatestTurn,
        },
        state,
      );
    },
    [chatId, latestAssistant, latestTurn, setMessages, setChatLog, setLatestTurn],
  );

  return {
    editTarget, openLatestEditor, closeEditor, firedOperatorLabel, turnCeiling, respin, saveEdit,
    canEditDynamicState, saveDynamicState,
  };
}
