import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { ChatEntry } from '../lib/types';
import { useBrainMounts, type BrainMounts } from './useBrainMounts';
import {
  canonEntryCount,
  replayEntry,
  type TokenHistoryEntry,
  type TurnData,
} from '../lib/turn-data';
import { DEFAULT_PERSONA } from '../lib/prompt';
import { lastFiredOperatorId, type SpontaneityState } from '../lib/spontaneity/engine';
import { useConstitutionalDoc } from './useConstitutionalDoc';
import {
  createChat as apiCreateChat,
  deleteChat as apiDeleteChat,
  listChats as apiListChats,
  loadChat as apiLoadChat,
  savePromptVersion as apiSavePromptVersion,
  type ChatDetail,
  type ChatSummary,
  type PromptVersion,
} from '../lib/persistence';

// ============================================================
// CHAT SESSION — the persistence-facing half of the app: hydration, chat
// create/load/delete, the per-chat constitutional document (+ debounced
// sync), persona versions, and the in-memory chat log the live turn reads from.
//
// This hook and its siblings (useTurnRunner, useResponseEditor) are namespaces
// over ONE shared session, not isolated stores — the setters below are
// deliberately exposed so the turn runner can append the pair it streams and
// the response editor can patch the reply it edits.
// ============================================================

export interface UseChatSessionOptions {
  /** Called when a new chat replaces the visible session (startNewChat) — the
   * root uses it to clear + refocus the composer's textarea. */
  onSessionReset: () => void;
  /** Called when loadChat lands on a chat (success, or already-active) — the
   * root uses it to close the history modal. */
  onChatSwitched: () => void;
}

/** An open ephemeral tangent (spec 04): the server-truth boundary (ordinal)
 *  plus its projection onto the visible log (how many entries are canon).
 *  Lifecycle handlers live in hooks/useTangent.ts; this is just the state. */
export interface TangentState {
  startOrdinal: number;
  canonEntries: number;
}

// Derive the session's tangent state from a fetched detail — shared by
// hydration, adoptChatDetail, and every sibling-hook resync (useTurnUndo,
// useTangent). Exported because canonEntries is an ENTRY-INDEX-SPACE count:
// any resync that rebuilds `messages` from the server can change that space's
// membership (manual prepends fold in), so tangent state must be recomputed
// from ordinals in the same breath — adopting one without the other misplaces
// the divider and the undo guard.
export const tangentFrom = (detail: ChatDetail): TangentState | null =>
  detail.tangentStart === null
    ? null
    : {
        startOrdinal: detail.tangentStart,
        canonEntries: canonEntryCount(detail.turns, detail.tangentStart) ?? 0,
      };

// The brains-axis surface (mountedBrains, brainIndex, setMountedBrainIds, and
// the adopt/clear/bind plumbing the load paths use) rides in via BrainMounts —
// see hooks/useBrainMounts.ts.
export interface ChatSession extends BrainMounts {
  // --- state ---
  chatId: string | null;
  chats: ChatSummary[];
  hydrated: boolean;
  /** This chat's constitutional document — freeform prose, edited in the
   *  ConstitutionalEditorModal, rendered verbatim into the prompt. */
  constitutional: string;
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
  /** Open ephemeral tangent, null when none — see TangentState above. */
  tangent: TangentState | null;
  /** Live mirror of chatId, for post-await guards in the sibling hooks: state
   * fetched for one chat must never be applied after a switch to another. */
  chatIdRef: { current: string | null };
  // --- shared-state escape hatches for the sibling hooks ---
  setTangent: Dispatch<SetStateAction<TangentState | null>>;
  setMessages: Dispatch<SetStateAction<ChatEntry[]>>;
  setChatLog: Dispatch<SetStateAction<ChatEntry[]>>;
  setTurnCount: Dispatch<SetStateAction<number>>;
  setLatestTurn: Dispatch<SetStateAction<TurnData | null>>;
  setTokenHistory: Dispatch<SetStateAction<TokenHistoryEntry[]>>;
  setChats: Dispatch<SetStateAction<ChatSummary[]>>;
  // --- handlers ---
  setConstitutional: (text: string) => void;
  savePromptVersion: (text: string, baselineText: string) => Promise<void>;
  startNewChat: (persona?: string, mask?: string, brainIds?: string[], constitutional?: string) => Promise<void>;
  loadChat: (id: string) => Promise<void>;
  deleteChat: (id: string) => Promise<void>;
}

export function useChatSession({ onSessionReset, onChatSwitched }: UseChatSessionOptions): ChatSession {
  const [chatLog, setChatLog] = useState<ChatEntry[]>([]);
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [latestTurn, setLatestTurn] = useState<TurnData | null>(null);
  const [tokenHistory, setTokenHistory] = useState<TokenHistoryEntry[]>([]);
  const [turnCount, setTurnCount] = useState(0);
  // Persistence state. `chatId` is the active conversation (null until the
  // mount-effect resolves it). `chats` is the summary list used by the modal.
  const [chatId, setChatId] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  // The brains axis (mounted packs + union index) — its own per-axis hook;
  // the load paths below call its adopt/clear/bind at the same sites where
  // the constitutional document/persona swap.
  const brainMounts = useBrainMounts(chatId);
  const { adoptBrains, clearBrains, bindBrainsToNewChat } = brainMounts;
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
  // Has the initial hydration completed? Guards the constitutional-save effect
  // from firing on mount (with the empty placeholder string) before the active
  // chat's document has loaded.
  const [hydrated, setHydrated] = useState(false);
  // Open ephemeral tangent (spec 04) — restored from the detail payload on
  // every load path, so a crash mid-tangent re-enters the mode.
  const [tangent, setTangent] = useState<TangentState | null>(null);

  // The constitutional document (memory tier 1) — its own per-axis hook, like
  // useBrainMounts: state, the user-edit dirty flag, the 250ms debounced save,
  // and the swap-safety flush all live there. The load paths below call
  // adoptConstitutional/flush at the same sites where persona/brains swap.
  const {
    constitutional,
    setConstitutional,
    adoptConstitutional,
    flushPendingConstitutionalSave,
  } = useConstitutionalDoc(chatId, hydrated);
  // Live mirror of the active chat id, for non-reactive callbacks (the
  // startNewChat failure recovery reads the OUTGOING id after nulling state).
  // Assigned every render so it's never a stale closure.
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;
  // Spontaneity engine's only cross-turn state: the last-fired operator id, so a
  // fire never repeats the previous one. Per-chat (reset in startNewChat, restored
  // from the latest turn's inspector on load) — NOT a module singleton, which
  // would leak across chats. Sal stays ephemeral; this is harness state, like the
  // chat log. See lib/spontaneity/.
  const spontaneityStateRef = useRef<SpontaneityState>({ lastFiredId: null });

  // --- Hydration: restore the most recent chat (incl. its constitutional
  // document). --- Runs once on mount. The document is per-chat and rides
  // along in the loadChat payload, so there's no separate global fetch: the
  // active chat's text is loaded below (or stays '' for a fresh starter chat).
  // After hydration completes we mark hydrated=true, unlocking the save effect.
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
          // Load this chat's constitutional document (a programmatic load,
          // not a user edit).
          adoptConstitutional(detail.constitutional);
          // Restore the chat's persona (null → DEFAULT_PERSONA) + display mask.
          setActivePersona(detail.persona?.trim() ? detail.persona : DEFAULT_PERSONA);
          setActiveMask(detail.mask ?? '');
          setPromptVersions(detail.versions);
          // Restore the chat's mounted brains (packs fetched once, at load).
          await adoptBrains(detail.brainIds);
          if (cancelled) return;
          if (detail.latestInspector) {
            setLatestTurn(detail.latestInspector as TurnData);
          }
          // Restore no-repeat state so the first fire after reload doesn't repeat
          // the operator that fired last. Scan all turns (not just the latest
          // inspector) — the latest turn may be dormant while an earlier one fired.
          spontaneityStateRef.current = {
            lastFiredId: lastFiredOperatorId(detail.turns.map((t) => t.inspectorJson)),
          };
          setTangent(tangentFrom(detail));
        } else {
          // Fresh install: the starter chat stays default-Sal — no persona modal
          // on first run (Q2). activePersona/activeMask keep their defaults, and
          // `constitutional` keeps its empty initial value (a new chat has none).
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
    // adoptBrains is a stable callback from useBrainMounts (no deps of its own).
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // display-only mask + (optionally carried-forward) constitutional document.
  // The outgoing chat's pending edit (if any) is flushed first, then the
  // document is reset to the INCOMING value for the new chat. `mask` is stored
  // for display only; it is NOT part of the persona/prompt and never reaches
  // /api/turn.
  //
  // Shared by the user-facing "Begin again" flow (via the root's confirmPersona,
  // which supplies an edited persona/mask/constitutional) and the delete-
  // fallback path (which passes nothing → default Sal, blank document). A
  // null/blank persona is stored server-side as NULL and resolves to
  // DEFAULT_PERSONA at build time.
  // Adopt a fetched chat's full detail into the visible session — the shared
  // restore body of loadChat (the normal path) and startNewChat's failure
  // recovery (re-adopting the OUTGOING chat when the create round-trip fails).
  // Callers own chatId: it stays null for the whole adoption window ("no
  // active chat" is the honest state) and is set only after this resolves.
  const adoptChatDetail = useCallback(async (detail: ChatDetail) => {
    const replay: ChatEntry[] = detail.turns.map(replayEntry);
    setMessages(replay);
    setChatLog(replay);
    setTurnCount(Math.floor(replay.length / 2));
    setLatestTurn((detail.latestInspector as TurnData | null) ?? null);
    // Restore no-repeat state for the adopted chat (see the hydration site —
    // scan all turns, since the latest may be dormant over an earlier fire).
    spontaneityStateRef.current = {
      lastFiredId: lastFiredOperatorId(detail.turns.map((t) => t.inspectorJson)),
    };
    setTangent(tangentFrom(detail));
    setTokenHistory([]);
    // Swap in this chat's constitutional document (a programmatic load, not
    // a user edit).
    adoptConstitutional(detail.constitutional);
    // Restore the chat's persona (null → DEFAULT_PERSONA) + display mask.
    setActivePersona(detail.persona?.trim() ? detail.persona : DEFAULT_PERSONA);
    setActiveMask(detail.mask ?? '');
    setPromptVersions(detail.versions);
    // Swap in this chat's mounted brains (packs fetched once, at adoption).
    await adoptBrains(detail.brainIds);
  }, [adoptBrains, adoptConstitutional]);

  const startNewChat = useCallback(async (persona?: string, mask?: string, brainIds?: string[], incomingConstitutional?: string) => {
    // Flush any pending edit to the OUTGOING chat before we swap the document.
    // (flushPendingConstitutionalSave reads chatIdRef synchronously, so it
    // still sees the outgoing id even though we null chatId on the next line.)
    flushPendingConstitutionalSave();
    // Remembered for the failure path below — the ref still holds the outgoing
    // id after setChatId(null) (it re-mirrors state on the NEXT render).
    const outgoingId = chatIdRef.current;
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
    setTangent(null);
    // The new chat starts with the INCOMING constitutional value ('' when
    // absent — the delete-fallback path). adoptConstitutional resets the
    // dirty flag first, so this programmatic reset isn't saved as an edit.
    const resolvedConstitutional = incomingConstitutional ?? '';
    adoptConstitutional(resolvedConstitutional);
    // The active persona/mask follow the new chat. Empty/blank persona → the
    // default; trimmed mask, '' → "Sal" at render.
    const resolvedPersona = persona?.trim() ? persona : DEFAULT_PERSONA;
    const resolvedMask = mask?.trim() ?? '';
    setActivePersona(resolvedPersona);
    setActiveMask(resolvedMask);
    // A new chat has no prompt edit history yet — the editor synthesises a
    // baseline from the persona above until the first edit lands.
    setPromptVersions([]);
    // Mounted brains reset with the session; the picker's choice (if any) is
    // bound + loaded after the create resolves below.
    clearBrains();
    // Clear + refocus the composer's textarea (it owns its own input state) —
    // the root supplies the bump.
    onSessionReset();
    try {
      // Only send a persona when it differs from the default — a default chat
      // stores NULL persona (old chats stay byte-identical on the wire). Always
      // send the mask when non-empty so the label persists across reloads.
      // Same non-empty gate for the carried-forward constitutional document.
      const args: { persona?: string; mask?: string; constitutional?: string } = {};
      if (persona?.trim() && persona !== DEFAULT_PERSONA) args.persona = persona;
      if (resolvedMask) args.mask = resolvedMask;
      if (resolvedConstitutional) args.constitutional = resolvedConstitutional;
      const created = await apiCreateChat(Object.keys(args).length ? args : undefined);
      // Bind the picker's mount choice to the new chat, then load the packs so
      // the FIRST turn already carries the knowledge tier (spec D6).
      await bindBrainsToNewChat(created.id, brainIds ?? []);
      setChatId(created.id);
      const refreshed = await apiListChats();
      setChats(refreshed);
    } catch (err) {
      console.warn('createChat failed:', err);
      // A failed create must not strand the session — everything above only
      // touched LOCAL state, so the outgoing chat is intact server-side;
      // re-adopt it instead of leaving a cleared, chatId-less UI until reload.
      // (Reachable deterministically: the server 400s an over-cap carry-forward
      // document, e.g. a pre-clamp migrated legacy set.) The delete-fallback
      // path has no outgoing chat to return to (it was just deleted) — the
      // nested catch leaves the honest "no active chat" state, as before.
      if (outgoingId) {
        try {
          await adoptChatDetail(await apiLoadChat(outgoingId));
          setChatId(outgoingId);
        } catch (recoveryErr) {
          console.warn('session recovery after createChat failure failed:', recoveryErr);
        }
      }
    }
  }, [flushPendingConstitutionalSave, adoptConstitutional, onSessionReset, clearBrains, bindBrainsToNewChat, adoptChatDetail]);

  // Load an existing chat from the history modal: fetch its turns, replay
  // them into the in-memory log + visible messages, restore the right-rail
  // inspector, and swap in this chat's own (per-chat) constitutional document.
  const loadChat = useCallback(async (id: string) => {
    if (id === chatId) {
      onChatSwitched();
      return;
    }
    // Flush any pending edit to the OUTGOING chat before we swap its document
    // out — otherwise a switch within the 250ms save debounce would drop the edit.
    flushPendingConstitutionalSave();
    // Null the active chat for the duration of the switch — same guard as
    // startNewChat. The awaits below (chat detail, then brain packs) leave
    // windows where the DESTINATION chat's state is already rendered; if
    // chatId still pointed at the OUTGOING chat, a submit would persist a
    // turn to it and the debounced save would reconcile the NEW chat's
    // document into the OLD chat's scope (overwriting it).
    // "No active chat" until everything lands is the honest state — the
    // composer and every chatId-scoped write already disable/throw on it.
    // Restored on failure so a dropped fetch doesn't strand the session.
    const outgoingId = chatId;
    setChatId(null);
    try {
      await adoptChatDetail(await apiLoadChat(id));
      setChatId(id);
      onChatSwitched();
    } catch (err) {
      // The failure path is apiLoadChat (adoptBrains never rejects — pack
      // failures degrade per-pack). No destination state landed, so pointing
      // chatId back at the outgoing chat restores a coherent session.
      setChatId(outgoingId);
      console.warn('loadChat failed:', err);
    }
  }, [chatId, flushPendingConstitutionalSave, onChatSwitched, adoptChatDetail]);

  // (The memory-editor resync trio — resyncLiveChatLog and its two public
  // handlers — moved to hooks/useMemoryEditSync.ts: spec 04's designated
  // anti-god-object split when the tangent axis pushed this file to the
  // 500-line ceiling.)

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
    ...brainMounts,
    chatId,
    chats,
    hydrated,
    constitutional,
    chatLog,
    messages,
    turnCount,
    latestTurn,
    tokenHistory,
    activePersona,
    activeMask,
    promptVersions,
    spontaneityStateRef,
    tangent,
    chatIdRef,
    setTangent,
    setMessages,
    setChatLog,
    setTurnCount,
    setLatestTurn,
    setTokenHistory,
    setChats,
    setConstitutional,
    savePromptVersion,
    startNewChat,
    loadChat,
    deleteChat,
  };
}
