import { useCallback, useMemo, useState } from 'react';
import type { BrainPack } from '../lib/types';
import { buildBrainIndex, type BrainIndex } from '../lib/brains';
import { getBrain as apiGetBrain, setChatBrains as apiSetChatBrains } from '../lib/persistence';

// ============================================================
// BRAIN MOUNTS — the knowledge axis of the shared session: which packs the
// active chat has mounted, and the ONE union index the turn path searches.
// Composed by useChatSession (its load paths call adopt/clear/bind below);
// split into its own per-axis hook by the anti-god-object ratchet, matching
// the hooks/ convention. Packs are fetched at mount time, never per turn.
// ============================================================

/**
 * Fetch the packs for a chat's mounted brain ids. A pack that fails to load
 * (deleted file, corrupt JSON) is skipped with a warning rather than sinking
 * the whole mount set — the surviving brains still mount.
 */
async function loadBrainPacks(brainIds: string[]): Promise<BrainPack[]> {
  const settled = await Promise.allSettled(brainIds.map(apiGetBrain));
  const packs: BrainPack[] = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') packs.push(s.value);
    else console.warn(`mounted brain ${brainIds[i]} failed to load:`, s.reason);
  });
  return packs;
}

export interface BrainMounts {
  /** The active chat's mounted knowledge packs. */
  mountedBrains: BrainPack[];
  /** ONE union index over the mounted packs (null when none) — rebuilt
   * deterministically whenever the mount set changes (spec D3). */
  brainIndex: BrainIndex | null;
  /** Load the packs for a chat's persisted mount ids (hydration / chat switch). */
  adoptBrains: (brainIds: string[]) => Promise<void>;
  /** Reset to nothing mounted (session reset). */
  clearBrains: () => void;
  /** Bind the persona-modal's picks to a freshly-created chat, then load them
   * so the FIRST turn already carries the knowledge tier (spec D6). */
  bindBrainsToNewChat: (newChatId: string, brainIds: string[]) => Promise<void>;
  /** Replace the ACTIVE chat's mount set (mid-chat mount/unmount — spec D6:
   * deterministic curation, same class as turn gating). Persist-first, so the
   * UI never shows a mount the server doesn't hold. */
  setMountedBrainIds: (brainIds: string[]) => Promise<void>;
}

export function useBrainMounts(chatId: string | null): BrainMounts {
  const [mountedBrains, setMountedBrains] = useState<BrainPack[]>([]);

  // useMemo IS the "rebuilt on any mount-set change" rule: the union index is
  // a pure function of the packs, recomputed exactly when they change.
  const brainIndex = useMemo(
    () => (mountedBrains.length > 0 ? buildBrainIndex(mountedBrains) : null),
    [mountedBrains],
  );

  const adoptBrains = useCallback(async (brainIds: string[]) => {
    setMountedBrains(brainIds.length > 0 ? await loadBrainPacks(brainIds) : []);
  }, []);

  const clearBrains = useCallback(() => setMountedBrains([]), []);

  const bindBrainsToNewChat = useCallback(async (newChatId: string, brainIds: string[]) => {
    if (brainIds.length === 0) return;
    await apiSetChatBrains(newChatId, brainIds);
    setMountedBrains(await loadBrainPacks(brainIds));
  }, []);

  // Packs already loaded are reused; only new ids fetch. Errors propagate to
  // the caller (the MemoryPanel surfaces them via the root's catch).
  const setMountedBrainIds = useCallback(
    async (brainIds: string[]) => {
      if (!chatId) throw new Error('No active chat yet — wait a moment and try again.');
      await apiSetChatBrains(chatId, brainIds);
      const have = new Map(mountedBrains.map((p) => [p.id, p]));
      const kept = brainIds.filter((id) => have.has(id)).map((id) => have.get(id)!);
      const missing = brainIds.filter((id) => !have.has(id));
      const fetched = missing.length > 0 ? await loadBrainPacks(missing) : [];
      setMountedBrains([...kept, ...fetched]);
    },
    [chatId, mountedBrains],
  );

  return { mountedBrains, brainIndex, adoptBrains, clearBrains, bindBrainsToNewChat, setMountedBrainIds };
}
