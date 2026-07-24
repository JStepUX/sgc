import { useCallback, useState } from 'react';
import type { FetchedDoc } from '../lib/types';
import type { TurnData } from '../lib/turn-data';
import { assembleTurnContext } from '../lib/turn-context';
import { parseTurnResponse, stripStreamingMeta } from '../lib/prompt';
import { runTurn, extractUrls, fetchUrl } from '../lib/api';
import { operatorLabel } from '../lib/spontaneity/flexDeck';
import { lastFiredOperatorId } from '../lib/spontaneity/engine';
import { updateTurn as apiUpdateTurn, listChats as apiListChats, loadChat as apiLoadChat } from '../lib/persistence';
import type { RespinResult } from '../components/EditResponseModal';
import type { ChatSession } from './useChatSession';
import type { ProviderState } from './useProvider';

// ============================================================
// RESPONSE EDITOR — edit the latest assistant reply (manual or re-spin).
// Operates on the shared session (see useChatSession — the hooks are
// namespaces, not stores).
// ============================================================

export function useResponseEditor(
  session: ChatSession,
  providerState: Pick<ProviderState, 'provider' | 'health'>,
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
  respin: (onDelta: (preview: string) => void, replayOperator: boolean) => Promise<RespinResult>;
  saveEdit: (text: string, respin: RespinResult | null, operatorCleared: boolean) => Promise<void>;
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
    async (onDelta: (preview: string) => void, replayOperator: boolean): Promise<RespinResult> => {
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
      });

      const confirmedProvider = health?.providers[provider]?.available ? provider : undefined;
      const result = await runTurn(
        systemPrompt,
        [{ role: 'user', content: targetUser.content }],
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
        // True only when a directive was actually injected into THIS run —
        // saveEdit uses it to keep or clear the turn's fired fields.
        operatorReplayed: directive !== null,
      };
    },
    [editTarget, chatLog, constitutional, activePersona, health, provider, latestTurn, brainIndex],
  );

  // Save the edited reply. Persist FIRST, then commit to state on success (a
  // failure leaves the chat untouched and the modal open with the error). A
  // re-spin carries a fresh summary + metrics; a manual edit clears the stale
  // summary. inspector_json is rebuilt from the latest turn's TurnData (this IS
  // the latest turn) so the right-rail diagnostics survive a reload; only
  // `summary` is rehydrated onto the message, so that's the load-bearing field.
  const saveEdit = useCallback(
    async (text: string, respinResult: RespinResult | null, operatorCleared: boolean) => {
      if (!editTarget || !chatId) return;
      const turnId = editTarget.id;
      const newSummary = respinResult ? (respinResult.summary ?? undefined) : undefined;

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
      const nextInspector: TurnData = respinResult
        ? {
            ...base,
            inputTokens: respinResult.inputTokens,
            outputTokens: respinResult.outputTokens,
            totalLatency: respinResult.elapsed,
            summary: respinResult.summary,
            ...clearedFields,
          }
        : { ...base, summary: null, ...clearedFields };

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
              summary: newSummary,
              // Mirror the inspector: an operator-free re-spin also drops the
              // live "⟐ Name" marker (rehydration would drop it on reload anyway).
              ...(operatorCleared ? { spontaneity: undefined } : {}),
            };
      setMessages((prev) => prev.map(patch));
      setChatLog((prev) => prev.map(patch));
      setLatestTurn(nextInspector);
      setEditTarget(null);

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
    [editTarget, chatId, latestTurn, chatLog, spontaneityStateRef, setMessages, setChatLog, setLatestTurn, setChats],
  );

  return { editTarget, openLatestEditor, closeEditor, firedOperatorLabel, respin, saveEdit };
}
