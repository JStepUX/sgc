import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { ChatEntry, Memory } from '../lib/types';
import {
  summaryFromInspector,
  spontaneityFromInspector,
  type TokenHistoryEntry,
  type TurnData,
} from '../lib/turn-data';
import { DEFAULT_PERSONA, parseTurnResponse } from '../lib/prompt';
import { lastFiredOperatorId, type SpontaneityState } from '../lib/spontaneity/engine';
import {
  createChat as apiCreateChat,
  deleteChat as apiDeleteChat,
  listChats as apiListChats,
  loadChat as apiLoadChat,
  saveMemories as apiSaveMemories,
  savePromptVersion as apiSavePromptVersion,
  type ChatSummary,
  type ChatTurn,
  type PromptVersion,
  type TurnActiveState,
} from '../lib/persistence';

// ============================================================
// CHAT SESSION — the persistence-facing half of the app: hydration, chat
// create/load/delete, per-chat memories (+ debounced sync), persona versions,
// and the in-memory chat log the live turn reads from.
//
// This hook and its siblings (useTurnRunner, useResponseEditor) are namespaces
// over ONE shared session, not isolated stores — the setters below are
// deliberately exposed so the turn runner can append the pair it streams and
// the response editor can patch the reply it edits.
// ============================================================

/**
 * Rebuild a ChatEntry from a persisted turn row — the ONE replay path shared by
 * hydration, chat switch, and the memory-editor resync.
 *
 * Assistant content is passed back through parseTurnResponse so a legacy row
 * whose stored text still carries a leaked <turn-summary> block (turns
 * persisted before the parser learned to salvage borked blocks) renders — and
 * enters the grep corpus — clean. Rows already clean pass through unchanged;
 * the DB row itself is untouched (it heals on the next edit/save of that turn).
 * User rows are always verbatim — they're the person's own words.
 */
function replayEntry(t: ChatTurn): ChatEntry {
  return {
    role: t.role,
    content: t.role === 'assistant' ? parseTurnResponse(t.content).displayText : t.content,
    id: t.id,
    active: t.active,
    createdAt: t.createdAt,
    timeless: t.timeless,
    summary: summaryFromInspector(t.inspectorJson),
    spontaneity: spontaneityFromInspector(t.inspectorJson),
  };
}

export interface UseChatSessionOptions {
  /** Called when a new chat replaces the visible session (startNewChat) — the
   * root uses it to clear + refocus the composer's textarea. */
  onSessionReset: () => void;
  /** Called when loadChat lands on a chat (success, or already-active) — the
   * root uses it to close the history modal. */
  onChatSwitched: () => void;
}

export interface ChatSession {
  // --- state ---
  chatId: string | null;
  chats: ChatSummary[];
  hydrated: boolean;
  memories: Memory[];
  chatLog: ChatEntry[];
  messages: ChatEntry[];
  turnCount: number;
  latestTurn: TurnData | null;
  tokenHistory: TokenHistoryEntry[];
  activePersona: string;
  activeMask: string;
  promptVersions: PromptVersion[];
  /** Spontaneity engine's only cross-turn state — see the ref's comment below. */
  spontaneityStateRef: { current: SpontaneityState };
  // --- shared-state escape hatches for the sibling hooks ---
  setMessages: Dispatch<SetStateAction<ChatEntry[]>>;
  setChatLog: Dispatch<SetStateAction<ChatEntry[]>>;
  setTurnCount: Dispatch<SetStateAction<number>>;
  setLatestTurn: Dispatch<SetStateAction<TurnData | null>>;
  setTokenHistory: Dispatch<SetStateAction<TokenHistoryEntry[]>>;
  setChats: Dispatch<SetStateAction<ChatSummary[]>>;
  // --- handlers ---
  updateMemory: (id: string, newText: string) => void;
  addMemory: (text: string) => void;
  removeMemory: (id: string) => void;
  savePromptVersion: (text: string, baselineText: string) => Promise<void>;
  startNewChat: (persona?: string, mask?: string) => Promise<void>;
  loadChat: (id: string) => Promise<void>;
  deleteChat: (id: string) => Promise<void>;
  onActiveTurnsChanged: (chatId: string, states: TurnActiveState[]) => void;
  onTurnsMutated: (chatId: string) => Promise<void>;
}

export function useChatSession({ onSessionReset, onChatSwitched }: UseChatSessionOptions): ChatSession {
  // Per-chat constitutional memories. Starts empty — the active chat's set is
  // loaded from its loadChat payload during hydration / on chat switch.
  const [memories, setMemories] = useState<Memory[]>([]);
  const [chatLog, setChatLog] = useState<ChatEntry[]>([]);
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [latestTurn, setLatestTurn] = useState<TurnData | null>(null);
  const [tokenHistory, setTokenHistory] = useState<TokenHistoryEntry[]>([]);
  const [turnCount, setTurnCount] = useState(0);
  // Persistence state. `chatId` is the active conversation (null until the
  // mount-effect resolves it). `chats` is the summary list used by the modal.
  const [chatId, setChatId] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  // Per-chat persona + display-only mask for the active chat.
  // `activePersona` is the head of the per-turn system prompt (DEFAULT_PERSONA
  // when the chat carries none). `activeMask` is the author label shown on
  // assistant turns ('' → "Sal"); it is DISPLAY-ONLY and never reaches the
  // prompt or /api/turn.
  const [activePersona, setActivePersona] = useState<string>(DEFAULT_PERSONA);
  const [activeMask, setActiveMask] = useState<string>('');
  // Edit history of the active chat's persona (newest-first; head = live). Empty
  // until the prompt is first edited — the editor synthesises a baseline from
  // `activePersona` in that case. Hydrated alongside persona on load/switch.
  const [promptVersions, setPromptVersions] = useState<PromptVersion[]>([]);
  // Has the initial hydration completed? Guards the memory-save effect from
  // firing on mount (with the empty placeholder set) before the active chat's
  // memories have loaded.
  const [hydrated, setHydrated] = useState(false);

  // Flipped true when the user or the model actually mutates `memories`.
  // Guards the memory-save effect so programmatic loads — hydration and chat
  // switches, which set `memories` from a loadChat payload — don't round-trip a
  // redundant (or worse, mis-scoped) save. Those paths set it back to false.
  const memoriesDirtyRef = useRef(false);
  // Live mirrors of the latest memories + active chat, for the non-reactive
  // chat-swap callbacks (loadChat / startNewChat) to read when flushing a
  // pending edit before the set is replaced. Assigned every render so the
  // flush always sees the OUTGOING chat's current state, never a stale closure.
  const memoriesRef = useRef(memories);
  memoriesRef.current = memories;
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;
  // Spontaneity engine's only cross-turn state: the last-fired operator id, so a
  // fire never repeats the previous one. Per-chat (reset in startNewChat, restored
  // from the latest turn's inspector on load) — NOT a module singleton, which
  // would leak across chats. Sal stays ephemeral; this is harness state, like the
  // chat log. See lib/spontaneity/.
  const spontaneityStateRef = useRef<SpontaneityState>({ lastFiredId: null });

  // --- Hydration: restore the most recent chat (incl. its memories). ---
  // Runs once on mount. Memories are per-chat now and ride along in the
  // loadChat payload, so there's no separate global fetch: the active chat's
  // set is loaded below (or stays empty for a fresh starter chat). After
  // hydration completes we mark hydrated=true, unlocking the memory-save effect.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await apiListChats();
        if (cancelled) return;
        setChats(list);

        let activeId: string;
        if (list.length > 0) {
          // Most-recently-updated chat. Replay its turns into the UI.
          activeId = list[0].id;
          const detail = await apiLoadChat(activeId);
          if (cancelled) return;
          const replay: ChatEntry[] = detail.turns.map(replayEntry);
          setMessages(replay);
          setChatLog(replay);
          setTurnCount(Math.floor(replay.length / 2));
          // Load this chat's memories (a programmatic load, not a user edit).
          memoriesDirtyRef.current = false;
          setMemories(detail.memories);
          // Restore the chat's persona (null → DEFAULT_PERSONA) + display mask.
          setActivePersona(detail.persona?.trim() ? detail.persona : DEFAULT_PERSONA);
          setActiveMask(detail.mask ?? '');
          setPromptVersions(detail.versions);
          if (detail.latestInspector) {
            setLatestTurn(detail.latestInspector as TurnData);
          }
          // Restore no-repeat state so the first fire after reload doesn't repeat
          // the operator that fired last. Scan all turns (not just the latest
          // inspector) — the latest turn may be dormant while an earlier one fired.
          spontaneityStateRef.current = {
            lastFiredId: lastFiredOperatorId(detail.turns.map((t) => t.inspectorJson)),
          };
        } else {
          // Fresh install: the starter chat stays default-Sal — no persona modal
          // on first run (Q2). activePersona/activeMask keep their defaults, and
          // `memories` keeps its empty initial value (a new chat has none).
          const created = await apiCreateChat();
          if (cancelled) return;
          activeId = created.id;
          // Refresh the summary list so the modal sees the new (empty) chat.
          const refreshed = await apiListChats();
          if (cancelled) return;
          setChats(refreshed);
        }
        setChatId(activeId);
      } catch (err) {
        console.warn('SGC persistence hydration failed:', err);
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // --- Memory sync: persist the active chat's set whenever it changes,
  // debounced. --- Save is fire-and-forget; the UI is the source of truth
  // in-session, the server is the durable mirror. Three gates: hydration must
  // have completed, a chat must be active (so we have a scope to save into),
  // and a real edit must have happened — programmatic loads (hydration, chat
  // switch) reset the dirty ref so they don't round-trip a no-op save. chatId
  // is a dep so the closure always saves to the current chat.
  useEffect(() => {
    if (!hydrated || !chatId || !memoriesDirtyRef.current) return;
    const handle = setTimeout(() => {
      // Clear the flag as the save fires, so `dirty` means "has unsaved
      // changes" (not "ever edited"). A later chat swap then flushes only when
      // something is genuinely pending. A subsequent edit re-arms it.
      memoriesDirtyRef.current = false;
      apiSaveMemories(chatId, memories).catch((err) => console.warn('saveMemories failed:', err));
    }, 250);
    return () => clearTimeout(handle);
  }, [memories, hydrated, chatId]);

  // Persist a pending (debounced) memory edit immediately. The save above
  // cancels its 250ms timer whenever `memories`/`chatId` change — so a chat
  // swap or "Begin again" within that window would otherwise drop the edit when
  // the outgoing chat's set is replaced. The swap callbacks call this first to
  // flush the OUTGOING chat (read from refs, so never stale). No-op when clean;
  // any in-flight debounce that still fires afterward is an idempotent re-save.
  const flushPendingMemorySave = useCallback(() => {
    if (!memoriesDirtyRef.current || !chatIdRef.current) return;
    memoriesDirtyRef.current = false;
    apiSaveMemories(chatIdRef.current, memoriesRef.current)
      .catch((err) => console.warn('flush saveMemories failed:', err));
  }, []);

  const updateMemory = useCallback((id: string, newText: string) => {
    memoriesDirtyRef.current = true;
    setMemories((prev) => prev.map((m) => (m.id === id ? { ...m, text: newText } : m)));
  }, []);

  const addMemory = useCallback((text: string) => {
    memoriesDirtyRef.current = true;
    setMemories((prev) => [...prev, { id: crypto.randomUUID(), text }]);
  }, []);

  const removeMemory = useCallback((id: string) => {
    memoriesDirtyRef.current = true;
    setMemories((prev) => prev.filter((m) => m.id !== id));
  }, []);

  // Save a new live version of the active chat's system prompt. The server mints
  // a new head, freezes the pre-edit baseline as v1 on the first edit (via
  // `baselineText`), and mirrors the head into the live persona. We then adopt
  // the fresh history + drive the NEXT turn with the new live text (buildPrompt
  // reads activePersona). Errors propagate to the modal, which surfaces them.
  //
  // No active chat → THROW, never silently resolve. A resolved onSave is the
  // modal's success signal (it clears the dirty state), so returning here would
  // report a save that never persisted. This also closes the chat-swap window:
  // startNewChat nulls chatId before the new id arrives (see below), so a save
  // mid-swap surfaces an error instead of writing to the outgoing chat. The UI
  // also disables the opener while chatId is null, so this should never fire —
  // it's the explicit backstop behind that guard.
  const savePromptVersion = useCallback(
    async (text: string, baselineText: string) => {
      if (!chatId) throw new Error('No active chat yet — wait a moment and try again.');
      const { versions } = await apiSavePromptVersion(chatId, text, baselineText);
      setPromptVersions(versions);
      if (versions[0]) setActivePersona(versions[0].text);
    },
    [chatId],
  );

  // Clear the visible session and create a NEW chat with the given persona +
  // display-only mask. Memories are per-chat: the outgoing chat's pending edit
  // (if any) is flushed first, then the set is emptied for the new chat. `mask`
  // is stored for display only; it is NOT part of the persona/prompt and never
  // reaches /api/turn.
  //
  // Shared by the user-facing "Begin again" flow (via the root's confirmPersona,
  // which supplies an edited persona/mask) and the delete-fallback path (which
  // passes nothing → default Sal). A null/blank persona is stored server-side as
  // NULL and resolves to DEFAULT_PERSONA at build time.
  const startNewChat = useCallback(async (persona?: string, mask?: string) => {
    // Flush any pending edit to the OUTGOING chat before we clear the set.
    // (flushPendingMemorySave reads chatIdRef synchronously, so it still sees the
    // outgoing id even though we null chatId on the next line.)
    flushPendingMemorySave();
    // Null the active chat for the duration of the create round-trip. We set the
    // NEW chat's persona/versions below before apiCreateChat resolves; without
    // this, chatId would still point at the OUTGOING chat during that window, so
    // a prompt save mid-swap (or any chatId-scoped write) would target the wrong
    // chat with the new chat's state. "No active chat" until the new id lands is
    // the honest state — the composer + prompt editor already disable on it.
    setChatId(null);
    setChatLog([]);
    setMessages([]);
    setLatestTurn(null);
    setTokenHistory([]);
    setTurnCount(0);
    // A new chat's spontaneity no-repeat history starts clean.
    spontaneityStateRef.current = { lastFiredId: null };
    // A new chat starts with no constitutional memories. Reset the dirty ref
    // first so emptying the set isn't mistaken for a user edit and saved.
    memoriesDirtyRef.current = false;
    setMemories([]);
    // The active persona/mask follow the new chat. Empty/blank persona → the
    // default; trimmed mask, '' → "Sal" at render.
    const resolvedPersona = persona?.trim() ? persona : DEFAULT_PERSONA;
    const resolvedMask = mask?.trim() ?? '';
    setActivePersona(resolvedPersona);
    setActiveMask(resolvedMask);
    // A new chat has no prompt edit history yet — the editor synthesises a
    // baseline from the persona above until the first edit lands.
    setPromptVersions([]);
    // Clear + refocus the composer's textarea (it owns its own input state) —
    // the root supplies the bump.
    onSessionReset();
    try {
      // Only send a persona when it differs from the default — a default chat
      // stores NULL persona (old chats stay byte-identical on the wire). Always
      // send the mask when non-empty so the label persists across reloads.
      const args: { persona?: string; mask?: string } = {};
      if (persona?.trim() && persona !== DEFAULT_PERSONA) args.persona = persona;
      if (resolvedMask) args.mask = resolvedMask;
      const created = await apiCreateChat(Object.keys(args).length ? args : undefined);
      setChatId(created.id);
      const refreshed = await apiListChats();
      setChats(refreshed);
    } catch (err) {
      console.warn('createChat failed:', err);
    }
  }, [flushPendingMemorySave, onSessionReset]);

  // Load an existing chat from the history modal: fetch its turns, replay
  // them into the in-memory log + visible messages, restore the right-rail
  // inspector, and swap in this chat's own (per-chat) memory set.
  const loadChat = useCallback(async (id: string) => {
    if (id === chatId) {
      onChatSwitched();
      return;
    }
    // Flush any pending edit to the OUTGOING chat before we swap its set out —
    // otherwise a switch within the 250ms save debounce would drop the edit.
    flushPendingMemorySave();
    try {
      const detail = await apiLoadChat(id);
      const replay: ChatEntry[] = detail.turns.map(replayEntry);
      setMessages(replay);
      setChatLog(replay);
      setTurnCount(Math.floor(replay.length / 2));
      setLatestTurn((detail.latestInspector as TurnData | null) ?? null);
      // Restore no-repeat state for the loaded chat (see the hydration site —
      // scan all turns, since the latest may be dormant over an earlier fire).
      spontaneityStateRef.current = {
        lastFiredId: lastFiredOperatorId(detail.turns.map((t) => t.inspectorJson)),
      };
      setTokenHistory([]);
      // Swap in this chat's memories (a programmatic load, not a user edit).
      memoriesDirtyRef.current = false;
      setMemories(detail.memories);
      // Restore the chat's persona (null → DEFAULT_PERSONA) + display mask.
      setActivePersona(detail.persona?.trim() ? detail.persona : DEFAULT_PERSONA);
      setActiveMask(detail.mask ?? '');
      setPromptVersions(detail.versions);
      setChatId(id);
      onChatSwitched();
    } catch (err) {
      console.warn('loadChat failed:', err);
    }
  }, [chatId, flushPendingMemorySave, onChatSwitched]);

  // Re-pull the edited chat and rebuild chatLog from it. Used by every memory-
  // editor mutation that the live grep must see immediately — gating turns,
  // adding a manual memory, deleting one. We reload rather than patch by id:
  // in-session turns are appended to chatLog without a DB id (so an id-match
  // would miss them) and a manual add/delete shifts the turn set wholesale.
  // Content of streamed turns is unchanged, so the visible thread is unaffected
  // — only chatLog's flags/ids/membership refresh. Other chats are persisted
  // and pick the change up on their next load, so there's nothing to do for them.
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
    [chatId],
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
    [resyncLiveChatLog],
  );

  // Delete a chat. If it was the active one, swap to the next most-recent or
  // start a fresh one.
  const deleteChat = useCallback(async (id: string) => {
    try {
      await apiDeleteChat(id);
      const refreshed = await apiListChats();
      setChats(refreshed);
      if (id === chatId) {
        if (refreshed.length > 0) {
          await loadChat(refreshed[0].id);
        } else {
          // No chats left — spin up a fresh default-Sal chat directly. This is
          // an automatic fallback, not a user "Begin again", so it must NOT pop
          // the Confirm Persona modal.
          await startNewChat();
        }
      }
    } catch (err) {
      console.warn('deleteChat failed:', err);
    }
  }, [chatId, loadChat, startNewChat]);

  return {
    chatId,
    chats,
    hydrated,
    memories,
    chatLog,
    messages,
    turnCount,
    latestTurn,
    tokenHistory,
    activePersona,
    activeMask,
    promptVersions,
    spontaneityStateRef,
    setMessages,
    setChatLog,
    setTurnCount,
    setLatestTurn,
    setTokenHistory,
    setChats,
    updateMemory,
    addMemory,
    removeMemory,
    savePromptVersion,
    startNewChat,
    loadChat,
    deleteChat,
    onActiveTurnsChanged,
    onTurnsMutated,
  };
}
