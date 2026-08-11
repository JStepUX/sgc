import { useCallback } from 'react';
import { replayEntry, type TurnData } from '../lib/turn-data';
import { lastFiredOperatorId } from '../lib/spontaneity/engine';
import {
  deleteLatestTurn as apiDeleteLatestTurn,
  listChats as apiListChats,
  loadChat as apiLoadChat,
} from '../lib/persistence';
import { tangentFrom, type ChatSession } from './useChatSession';

// ============================================================
// TURN UNDO — take back the latest streamed turn pair.
//
// The thread's undo control: delete the latest user+assistant pair (both
// halves — the cosine engine and every buffer assume strict alternation, so a
// lone half is not a representable state) and hand the user's text back to
// the caller, who seeds it into the composer for editing + resubmission.
// Deterministic curation of the memory tier, same family as the chat memory
// editor — no model in the loop.
//
// Operates on the shared session (see useChatSession — the hooks are
// namespaces, not stores). Persist-first like the response editor's saveEdit:
// the server delete lands before any local state moves, so a failure leaves
// the thread untouched.
// ============================================================

export function useTurnUndo(session: ChatSession): {
  /** Undo the latest streamed turn. Resolves to the removed USER text (for
   * the composer seed) on success, null when there was nothing to undo or the
   * delete failed — the caller seeds the composer only on a string. */
  undoLatestTurn: () => Promise<string | null>;
} {
  const {
    chatId, chatIdRef, chatLog, turnCount, spontaneityStateRef,
    setMessages, setChatLog, setTurnCount, setLatestTurn, setTokenHistory, setChats, setTangent,
  } = session;

  const undoLatestTurn = useCallback(async (): Promise<string | null> => {
    if (!chatId) return null;
    // Resolve the latest STREAMED pair (same walk as the response editor's
    // openLatestEditor — timeless manual memories are curated elsewhere).
    let idx = -1;
    for (let i = chatLog.length - 1; i >= 0; i--) {
      if (chatLog[i].role === 'assistant' && !chatLog[i].timeless) { idx = i; break; }
    }
    const assistant = idx >= 0 ? chatLog[idx] : null;
    const user = idx >= 1 ? chatLog[idx - 1] : null;
    // Both halves need their DB ids (stamped together after the pair persists
    // — the UI disables the control until then, this is the backstop).
    if (!assistant || !user || user.role !== 'user'
      || typeof assistant.id !== 'number' || typeof user.id !== 'number') return null;
    const userText = user.content;
    const undoneTurnNumber = turnCount;

    try {
      await apiDeleteLatestTurn(chatId, assistant.id);
    } catch (err) {
      console.warn('undoLatestTurn failed:', err);
      return null;
    }

    // Persisted — resync the session from the server (the same source a reload
    // reads) rather than patching by hand: the new latest turn's inspector
    // blob and the spontaneity no-repeat cursor live in the DB, not in any
    // in-memory log, so a re-pull is the only honest restore for them. The
    // visible thread just loses its last pair; everything else is identical.
    try {
      const detail = await apiLoadChat(chatId);
      // A chat switch may have landed while the fetch was in flight — applying
      // this chat's state (or seeding its text) into the NEW chat would
      // clobber it. The delete stands; the outgoing chat re-adopts on load.
      if (chatIdRef.current !== chatId) return null;
      const replay = detail.turns.map(replayEntry);
      setMessages(replay);
      setChatLog(replay);
      setTurnCount(Math.floor(replay.length / 2));
      setLatestTurn((detail.latestInspector as TurnData | null) ?? null);
      spontaneityStateRef.current = {
        lastFiredId: lastFiredOperatorId(detail.turns.map((t) => t.inspectorJson)),
      };
      // Tangent state moves WITH the messages it indexes: this resync can fold
      // manual prepends into the visible log, which shifts the boundary's
      // entry-index projection — recompute it from ordinals or the divider and
      // the undo guard drift (and a drifted guard can reach across the
      // boundary into canon).
      setTangent(tangentFrom(detail));
    } catch (err) {
      // The delete DID land; degrade to local surgery so the UI matches the DB
      // (a reload reconciles the inspector/spontaneity extras this path skips).
      console.warn('post-undo resync failed, patching locally:', err);
      if (chatIdRef.current !== chatId) return null; // switched away — same clobber guard as above
      const assistantId = assistant.id;
      const userId = user.id;
      const drop = (e: (typeof chatLog)[number]) => e.id !== assistantId && e.id !== userId;
      setMessages((prev) => prev.filter(drop));
      setChatLog((prev) => prev.filter(drop));
      setTurnCount((c) => Math.max(0, c - 1));
      setLatestTurn(null);
    }
    // The undone turn's token-chart bar goes either way (the resync path keeps
    // tokenHistory — it's live-session-only state the reload path also clears).
    setTokenHistory((prev) => prev.filter((t) => t.turn !== undoneTurnNumber));
    // Refresh the history rail: the chat's snippet (latest assistant content)
    // and turn count both changed. Order is stable — updated_at isn't bumped.
    apiListChats().then(setChats).catch((err) => console.warn('listChats refresh failed:', err));

    return userText;
  }, [chatId, chatIdRef, chatLog, turnCount, spontaneityStateRef,
    setMessages, setChatLog, setTurnCount, setLatestTurn, setTokenHistory, setChats, setTangent]);

  return { undoLatestTurn };
}
