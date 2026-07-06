import { useCallback, useEffect, useRef, useState } from 'react';
import { saveConstitutional as apiSaveConstitutional } from '../lib/persistence';

// ============================================================
// CONSTITUTIONAL DOCUMENT — the per-chat "who the user is" text (memory
// tier 1), extracted from useChatSession by the anti-god-object ratchet.
// Same composition pattern as useBrainMounts: a namespace over the ONE
// shared session, not an isolated store — useChatSession composes this hook
// and calls adopt/flush at the same swap sites where persona/brains swap.
// ============================================================

export interface ConstitutionalDoc {
  /** The active chat's document ('' = nothing curated yet). */
  constitutional: string;
  /** USER edit — marks dirty; the debounce effect persists it to the active
   * chat. */
  setConstitutional: (text: string) => void;
  /** PROGRAMMATIC load (hydration / chat switch / new-chat reset) — resets
   * the dirty flag FIRST so the swap isn't mistaken for an edit and saved
   * into the wrong scope. */
  adoptConstitutional: (text: string) => void;
  /** Persist a pending (debounced) edit immediately. The swap callbacks call
   * this for the OUTGOING chat before its value is replaced — otherwise a
   * swap within the 250ms window would drop the edit. */
  flushPendingConstitutionalSave: () => void;
}

export function useConstitutionalDoc(chatId: string | null, hydrated: boolean): ConstitutionalDoc {
  const [constitutional, setConstitutionalState] = useState('');
  // Flipped true only by a USER edit. Guards the save effect so programmatic
  // loads — hydration and chat switches, which set the value from a loadChat
  // payload — don't round-trip a redundant (or worse, mis-scoped) save.
  const dirtyRef = useRef(false);
  // Live mirrors of the latest document + active chat, for the non-reactive
  // chat-swap flush to read. Assigned every render so the flush always sees
  // the OUTGOING chat's current state, never a stale closure.
  const valueRef = useRef(constitutional);
  valueRef.current = constitutional;
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;

  // Persist the active chat's document whenever it changes, debounced. Save
  // is fire-and-forget; the UI is the source of truth in-session, the server
  // is the durable mirror. Three gates: hydration must have completed, a chat
  // must be active (a scope to save into), and a real edit must have
  // happened. chatId is a dep so the closure always saves to the current chat.
  useEffect(() => {
    if (!hydrated || !chatId || !dirtyRef.current) return;
    const handle = setTimeout(() => {
      // Clear the flag as the save fires, so `dirty` means "has unsaved
      // changes" (not "ever edited"). A later chat swap then flushes only
      // when something is genuinely pending. A subsequent edit re-arms it.
      dirtyRef.current = false;
      apiSaveConstitutional(chatId, constitutional).catch((err) =>
        console.warn('saveConstitutional failed:', err),
      );
    }, 250);
    return () => clearTimeout(handle);
  }, [constitutional, hydrated, chatId]);

  // The save above cancels its 250ms timer whenever `constitutional`/`chatId`
  // change — so a chat swap or "Begin again" within that window would
  // otherwise drop the edit when the outgoing chat's value is replaced.
  // No-op when clean; any in-flight debounce that still fires afterward is an
  // idempotent re-save.
  const flushPendingConstitutionalSave = useCallback(() => {
    if (!dirtyRef.current || !chatIdRef.current) return;
    dirtyRef.current = false;
    apiSaveConstitutional(chatIdRef.current, valueRef.current).catch((err) =>
      console.warn('flush saveConstitutional failed:', err),
    );
  }, []);

  const setConstitutional = useCallback((text: string) => {
    dirtyRef.current = true;
    setConstitutionalState(text);
  }, []);

  const adoptConstitutional = useCallback((text: string) => {
    dirtyRef.current = false;
    setConstitutionalState(text);
  }, []);

  return { constitutional, setConstitutional, adoptConstitutional, flushPendingConstitutionalSave };
}
