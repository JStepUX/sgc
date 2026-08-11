import { useCallback, useState } from 'react';
import { replayEntry, type TurnData } from '../lib/turn-data';
import { lastFiredOperatorId } from '../lib/spontaneity/engine';
import {
  beginTangent as apiBeginTangent,
  resolveTangent as apiResolveTangent,
  listChats as apiListChats,
  loadChat as apiLoadChat,
  type ChatDetail,
} from '../lib/persistence';
import { tangentFrom, type ChatSession } from './useChatSession';

// ============================================================
// EPHEMERAL TANGENT — the tangent axis (docs/04_ephemeral-tangent-spec.yaml).
//
// Begin stamps a boundary; conversation then continues through the ordinary
// loop (a tangent turn IS an ordinary turn — Sal is never told, spec D5).
// Make-canon clears the boundary and touches nothing else. Wipe is the turn
// undo generalized from "latest pair" to "everything past the boundary":
// persist-first delete, then a full resync from the server — the same honest
// restore useTurnUndo uses, because inspector blobs (Dynamic State, summaries)
// and the spontaneity no-repeat cursor live per-turn in the DB, so deleting
// the tangent rows IS the state rollback. Deterministic curation of the memory
// tier — no model in the loop.
//
// Concurrency discipline (hardening pass, 2026-08-11 review):
// - Tangent state stays OPEN (and `resolving` keeps the composer + strip
//   disabled) until a wipe's resync settles — clearing it first would open a
//   window where a submit builds a prompt from already-deleted history.
// - Nothing fetched for one chat is ever applied after a switch to another
//   (chatIdRef guard) — the switch's own adoption is the truth for the
//   destination chat.
// - A lifecycle 409 (another window moved the tangent) triggers a WHOLE-detail
//   adoption, never a boundary-only one: messages and tangent state index the
//   same entry space, and adopting one against a stale other misplaces the
//   divider and the undo guard.
//
// Operates on the shared session (the hooks are namespaces, not stores). The
// tangent STATE lives on the session (it's restored by every chat-load path);
// this hook owns only the lifecycle handlers.
// ============================================================

export function useTangent(session: ChatSession): {
  /** Streamed tangent pairs so far (entries past the boundary, in pairs). */
  tangentTurns: number;
  /** Begin is allowed: a chat is active, no tangent is open, and the latest
   * streamed pair has persisted (same walk as the undo control). The root
   * additionally gates on runner.isProcessing — a mid-stream begin would race
   * the pair's save. */
  canBegin: boolean;
  /** A resolve is in flight — the root disables the composer and the strip
   * (a submit during a wipe would ride on already-deleted history). */
  resolving: boolean;
  begin: () => Promise<void>;
  makeCanon: () => Promise<void>;
  wipe: () => Promise<void>;
} {
  const {
    chatId, chatIdRef, chatLog, messages, tangent, spontaneityStateRef,
    setTangent, setMessages, setChatLog, setTurnCount, setLatestTurn, setTokenHistory, setChats,
  } = session;
  const [resolving, setResolving] = useState(false);

  const tangentTurns = tangent === null
    ? 0
    : Math.max(0, Math.floor((messages.length - tangent.canonEntries) / 2));

  // Latest streamed assistant turn must exist AND carry its DB id (ids are
  // stamped after the pair persists) — otherwise a wipe later couldn't address
  // what begin promised to scope. Same walk as useTurnUndo's.
  let hasPersistedPair = false;
  for (let i = chatLog.length - 1; i >= 0; i--) {
    if (chatLog[i].role === 'assistant' && !chatLog[i].timeless) {
      hasPersistedPair = typeof chatLog[i].id === 'number';
      break;
    }
  }
  const canBegin = chatId !== null && tangent === null && !resolving && hasPersistedPair;

  // Apply a freshly-fetched detail to the live session — the same honest
  // restore useTurnUndo performs, PLUS tangent state recomputed from ordinals
  // so the entry-index bookkeeping realigns with whatever the server holds.
  // Callers verify the session still shows the chat the fetch was for BEFORE
  // calling this.
  const adoptDetail = useCallback((detail: ChatDetail) => {
    const replay = detail.turns.map(replayEntry);
    const pairs = Math.floor(replay.length / 2);
    setMessages(replay);
    setChatLog(replay);
    setTurnCount(pairs);
    setLatestTurn((detail.latestInspector as TurnData | null) ?? null);
    spontaneityStateRef.current = {
      lastFiredId: lastFiredOperatorId(detail.turns.map((t) => t.inspectorJson)),
    };
    // Trailing token-chart bars belong to turns that no longer exist (a wipe);
    // canon bars keep their live-session numbering (tokenHistory is live-only
    // state a reload clears anyway).
    setTokenHistory((prev) => prev.filter((t) => t.turn <= pairs));
    setTangent(tangentFrom(detail));
  }, [setMessages, setChatLog, setTurnCount, setLatestTurn, spontaneityStateRef, setTokenHistory, setTangent]);

  // A lifecycle POST refused — most plausibly a 409 because another window
  // moved the tangent (opened it, resolved it, wiped it). Our picture is
  // stale; re-pull server truth and adopt it wholesale so this window renders
  // the tangent that actually exists (or its absence) instead of staying
  // silently wrong about what "canon" currently means.
  const adoptServerTruth = useCallback(async (forChatId: string) => {
    try {
      const detail = await apiLoadChat(forChatId);
      if (chatIdRef.current !== forChatId) return;
      adoptDetail(detail);
    } catch (err) {
      console.warn('tangent truth resync failed:', err);
    }
  }, [chatIdRef, adoptDetail]);

  // Persist-first, like every curation move: the boundary lands server-side
  // before any local state flips, so a failed POST leaves no phantom mode.
  // canonEntries = the visible log's current length (every rendered entry is
  // canon at begin time — the reload path recomputes the same number from
  // ordinals via canonEntryCount, and every later resync keeps them aligned).
  const begin = useCallback(async () => {
    if (!chatId || tangent !== null || resolving) return;
    try {
      const resp = await apiBeginTangent(chatId);
      if (chatIdRef.current !== chatId) return; // switched mid-POST; the chat re-adopts its boundary on load
      setTangent({ startOrdinal: resp.tangentStart, canonEntries: messages.length });
    } catch (err) {
      console.warn('beginTangent failed:', err);
      void adoptServerTruth(chatId);
    }
  }, [chatId, chatIdRef, tangent, resolving, messages.length, setTangent, adoptServerTruth]);

  // Canonize: the turns were stored canon-shaped all along, so the server just
  // clears the boundary — nothing local needs rebuilding.
  const makeCanon = useCallback(async () => {
    if (!chatId || tangent === null || resolving) return;
    setResolving(true);
    try {
      await apiResolveTangent(chatId, 'canon');
      if (chatIdRef.current === chatId) setTangent(null);
    } catch (err) {
      console.warn('makeCanon failed:', err);
      void adoptServerTruth(chatId);
    } finally {
      setResolving(false);
    }
  }, [chatId, chatIdRef, tangent, resolving, setTangent, adoptServerTruth]);

  const wipe = useCallback(async () => {
    if (!chatId || tangent === null || resolving) return;
    const tangentEntries = Math.max(0, messages.length - tangent.canonEntries);
    setResolving(true);
    try {
      try {
        await apiResolveTangent(chatId, 'discard');
      } catch (err) {
        console.warn('wipeTangent failed:', err);
        void adoptServerTruth(chatId);
        return;
      }
      // The wipe landed. Tangent state deliberately stays OPEN until the
      // resync below settles (adoptDetail clears it — the server just nulled
      // the boundary); `resolving` holds the composer shut for the duration.
      try {
        const detail = await apiLoadChat(chatId);
        if (chatIdRef.current !== chatId) return; // switched away — the switch adopted its own truth
        adoptDetail(detail);
      } catch (err) {
        // The wipe DID land; degrade to local surgery so the UI matches the
        // DB. Tangent entries are always the visible tail, so trimming by
        // count is exact (a reload reconciles the inspector/spontaneity
        // extras this path skips).
        console.warn('post-wipe resync failed, patching locally:', err);
        if (chatIdRef.current !== chatId) return;
        setMessages((prev) => prev.slice(0, Math.max(0, prev.length - tangentEntries)));
        setChatLog((prev) => prev.slice(0, Math.max(0, prev.length - tangentEntries)));
        setTurnCount((c) => Math.max(0, c - Math.floor(tangentEntries / 2)));
        setLatestTurn(null);
        setTangent(null);
      }
      // Refresh the history rail: snippet + turn count changed; order is
      // stable (updated_at isn't bumped — same as undo).
      apiListChats().then(setChats).catch((err) => console.warn('listChats refresh failed:', err));
    } finally {
      setResolving(false);
    }
  }, [chatId, chatIdRef, tangent, resolving, messages.length, adoptDetail, adoptServerTruth,
    setMessages, setChatLog, setTurnCount, setLatestTurn, setTangent, setChats]);

  return { tangentTurns, canBegin, resolving, begin, makeCanon, wipe };
}
