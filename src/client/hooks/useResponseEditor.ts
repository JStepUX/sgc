import { useCallback, useState } from 'react';
import type { FetchedDoc } from '../lib/types';
import type { TurnData } from '../lib/turn-data';
import { assembleTurnContext } from '../lib/turn-context';
import { parseTurnResponse, stripStreamingMeta } from '../lib/prompt';
import { runTurn, extractUrls, fetchUrl } from '../lib/api';
import { updateTurn as apiUpdateTurn, listChats as apiListChats } from '../lib/persistence';
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
  respin: (onDelta: (preview: string) => void) => Promise<RespinResult>;
  saveEdit: (text: string, respin: RespinResult | null) => Promise<void>;
} {
  const {
    messages, chatLog, constitutional, activePersona, latestTurn, chatId, brainIndex,
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
        constitutional,
        persona: activePersona,
        now: targetUser.createdAt,
        fetchedDocs,
        failedUrls,
        // REPLAY, don't redraw: re-spin reproduces the turn faithfully, so it
        // re-injects the operator that originally fired (snapshotted on the turn's
        // inspector) rather than rolling a fresh one. The pencil is latest-turn
        // only, so latestTurn is this turn's diagnostics. null → none fired.
        spontaneityDirective: latestTurn?.spontaneityDirective ?? null,
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
    async (text: string, respinResult: RespinResult | null) => {
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
      const nextInspector: TurnData = respinResult
        ? {
            ...base,
            inputTokens: respinResult.inputTokens,
            outputTokens: respinResult.outputTokens,
            totalLatency: respinResult.elapsed,
            summary: respinResult.summary,
          }
        : { ...base, summary: null };

      await apiUpdateTurn(chatId, turnId, {
        content: text,
        inspectorJson: JSON.stringify(nextInspector),
      });

      // Persisted — commit to the live logs (by id, so render + retrieval stay
      // in sync). Re-indexing for cosine grep is automatic (tfidf is uncached).
      const patch = (e: (typeof chatLog)[number]): (typeof chatLog)[number] =>
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
    [editTarget, chatId, latestTurn, chatLog, setMessages, setChatLog, setLatestTurn, setChats],
  );

  return { editTarget, openLatestEditor, closeEditor, respin, saveEdit };
}
