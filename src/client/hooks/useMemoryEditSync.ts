import { useCallback } from 'react';
import { replayEntry } from '../lib/turn-data';
import {
  listChats as apiListChats,
  loadChat as apiLoadChat,
  type TurnActiveState,
} from '../lib/persistence';
import type { ChatSession } from './useChatSession';

// ============================================================
// MEMORY-EDIT SYNC — keep the live session honest after a memory-editor
// mutation (gating turns, adding a manual memory, deleting one).
//
// Split from useChatSession by the anti-god-object ratchet (the tangent axis
// pushed it to the 500-line ceiling — spec 04's designated split). Same
// namespace-not-store contract as the sibling hooks: this operates on the ONE
// shared session via its exposed setters.
// ============================================================

export function useMemoryEditSync(session: ChatSession): {
  /** A gating change landed for `editedChatId` — rebuild the live grep log. */
  onActiveTurnsChanged: (editedChatId: string, states: TurnActiveState[]) => void;
  /** A manual memory was added/deleted — resync the log AND the summary list. */
  onTurnsMutated: (editedChatId: string) => Promise<void>;
} {
  const { chatId, setChatLog, setChats } = session;

  // Re-pull the edited chat and rebuild chatLog from it. Used by every memory-
  // editor mutation that the live grep must see immediately. We reload rather
  // than patch by id: in-session turns are appended to chatLog without a DB id
  // (so an id-match would miss them) and a manual add/delete shifts the turn
  // set wholesale. Content of streamed turns is unchanged, so the visible
  // thread is unaffected — only chatLog's flags/ids/membership refresh.
  // (Consequence: a just-added manual memory is retrievable immediately but
  // APPEARS in the thread only on the chat's next load — intentional, so a
  // memory isn't injected mid-scroll.) Other chats are persisted and pick the
  // change up on their next load, so there's nothing to do for them.
  const resyncLiveChatLog = useCallback(
    async (editedChatId: string) => {
      if (editedChatId !== chatId) return;
      try {
        const detail = await apiLoadChat(editedChatId);
        // replayEntry (not a slim flags-only rebuild) so the entries keep their
        // summaries — the distilled summary buffer slices chatLog, and a resync
        // that dropped them would silently starve it until fresh turns landed.
        setChatLog(detail.turns.map(replayEntry));
      } catch (err) {
        console.warn('active-chat grep resync failed:', err);
      }
    },
    [chatId, setChatLog],
  );

  // Gating fires with the turns that flipped; a manual add/delete fires with no
  // states. Both just need the live chatLog rebuilt, so they share one resync.
  const onActiveTurnsChanged = useCallback(
    (editedChatId: string, _states: TurnActiveState[]) => {
      void resyncLiveChatLog(editedChatId);
    },
    [resyncLiveChatLog],
  );

  // A manual memory was added or deleted. Beyond the live grep resync, the
  // history summaries (`chats`) can go stale: adding the first turn to an
  // empty chat derives its title + snippet, and every add/delete shifts the
  // turn count. The summary list/rail render from `chats`, so re-pull it. This
  // works for ANY edited chat, not just the active one (resync handles only the
  // active chat's grep log). updatedAt is intentionally NOT bumped server-side,
  // so the refreshed list keeps its order — no surprise reshuffle mid-edit.
  const onTurnsMutated = useCallback(
    async (editedChatId: string) => {
      await resyncLiveChatLog(editedChatId);
      try {
        setChats(await apiListChats());
      } catch (err) {
        console.warn('chat summary refresh after memory mutation failed:', err);
      }
    },
    [resyncLiveChatLog, setChats],
  );

  return { onActiveTurnsChanged, onTurnsMutated };
}
