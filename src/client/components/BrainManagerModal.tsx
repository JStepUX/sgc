import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { deleteBrain, importBrain, listBrains } from '../lib/persistence';
import type { BrainManifest, BrainPack } from '../lib/types';

// ============================================================
// BRAIN MANAGER MODAL — the whole knowledge-pack lifecycle (import, mount,
// delete) in one place, replacing the sidebar's old inline picker.
//
// Doctrine, unchanged from the sidebar section this replaces: brains are the
// KNOWLEDGE axis, not a memory tier — packs are read-only reference material
// compiled offline by Atlantis, retrieval over them stays client-side
// deterministic TF-IDF (lib/brains.ts, the same tokenizer/cosine primitives as
// Grepory), and this modal is pure curation — same class as chat-memory turn
// gating (spec D6). No model is ever in this loop.
//
// Mount/unmount here targets the ACTIVE chat only (persist-first — the toggle
// awaits the server PUT before the UI commits; see useBrainMounts.
// setMountedBrainIds). Delete is server-wide and destructive (it drops the
// pack file and cascades its mount bindings across every chat), so it sits
// behind an inline two-step confirm on the card.
// ============================================================

interface BrainManagerModalProps {
  open: boolean;
  onClose: () => void;
  /** Ids currently mounted on the active chat. */
  mountedBrainIds: string[];
  /** Replace the active chat's mount set — persist-first (rejects on server
   * failure; the caller's state only updates once the PUT lands). refreshIds
   * force a refetch of packs that were overwritten in place (re-import). */
  onSetMounted: (brainIds: string[], refreshIds?: string[]) => Promise<void>;
}

const RAIL_LABEL = 'font-mono text-[11px] tracking-[0.18em] uppercase text-fg-3';

export function BrainManagerModal({ open, onClose, mountedBrainIds, onSetMounted }: BrainManagerModalProps) {
  // null = still loading (or the fetch hasn't started this open yet).
  const [packs, setPacks] = useState<BrainManifest[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  // Per-pack transient state, keyed by pack id — a card mid-toggle/mid-delete
  // disables its own controls without freezing the rest of the list.
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());
  const [toggleErrors, setToggleErrors] = useState<Map<string, string>>(new Map());
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [deleteErrors, setDeleteErrors] = useState<Map<string, string>>(new Map());
  const [importing, setImporting] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // ONE mount mutation at a time. Every mutation (toggle, delete, import)
  // composes its whole-set PUT from the current mountedBrainIds — two in
  // flight at once would build from the same stale base and the later
  // response would silently drop the earlier change. The state above disables
  // the controls; this ref is the race-proof guard at handler entry (state
  // reads in a closure can lag a very fast second click).
  const mutationRef = useRef(false);
  const mutationBusy = importing || togglingIds.size > 0 || deletingIds.size > 0;

  // Reset all transient state and refetch on each open, so a pack imported or
  // deleted elsewhere (the Begin-again dialog, another window) shows up fresh.
  useEffect(() => {
    if (!open) return;
    setPacks(null);
    setListError(null);
    setImportError(null);
    setTogglingIds(new Set());
    setToggleErrors(new Map());
    setConfirmingId(null);
    setDeletingIds(new Set());
    setDeleteErrors(new Map());
    setImporting(false);
    mutationRef.current = false;
    listBrains()
      .then(setPacks)
      .catch((err) => {
        console.warn('listBrains failed:', err);
        setPacks([]);
        setListError('Could not load knowledge packs.');
      });
  }, [open]);

  // Focus handoff: the trap below can only cycle focus that is already inside
  // the dialog, so move it there on open (the close button) and hand it back
  // to the opener (the sidebar's Manage button) on close.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const id = setTimeout(() => closeButtonRef.current?.focus(), 30);
    return () => {
      clearTimeout(id);
      opener?.focus();
    };
  }, [open]);

  // Escape → close. Focus trap: Tab/Shift+Tab cycle within the dialog (one
  // layer — this modal has no nested overlay, unlike the chat-memory editor's
  // Add Memory sheet).
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([type="file"]), textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  // Toggle semantics: persist-first. Compute the next mount set, await the
  // server PUT (via the caller's onSetMounted), and only then is the mounted
  // state true — a rejection surfaces inline and leaves the toggle as it was.
  const handleToggle = async (pack: BrainManifest) => {
    if (mutationRef.current) return;
    mutationRef.current = true;
    const isMounted = mountedBrainIds.includes(pack.id);
    const next = isMounted
      ? mountedBrainIds.filter((id) => id !== pack.id)
      : [...mountedBrainIds, pack.id];
    // Moving on to a new action retires a lingering import error.
    setImportError(null);
    setTogglingIds((prev) => new Set(prev).add(pack.id));
    setToggleErrors((prev) => {
      const copy = new Map(prev);
      copy.delete(pack.id);
      return copy;
    });
    try {
      await onSetMounted(next);
    } catch (err) {
      setToggleErrors((prev) =>
        new Map(prev).set(pack.id, err instanceof Error ? err.message : 'Failed to update mount.'),
      );
    } finally {
      mutationRef.current = false;
      setTogglingIds((prev) => {
        const copy = new Set(prev);
        copy.delete(pack.id);
        return copy;
      });
    }
  };

  // Delete is destructive server-wide (cascades across every chat's mount
  // bindings), so this only runs from the card's confirm step. After success,
  // refresh the list and — if the deleted pack was mounted here — drop it from
  // the active chat's mount set too (the server PUT is idempotent and every
  // remaining id still exists, so this can't fail on a stale id).
  const handleConfirmDelete = async (pack: BrainManifest) => {
    if (mutationRef.current) return;
    mutationRef.current = true;
    // Moving on to a new action retires a lingering import error.
    setImportError(null);
    setDeletingIds((prev) => new Set(prev).add(pack.id));
    setDeleteErrors((prev) => {
      const copy = new Map(prev);
      copy.delete(pack.id);
      return copy;
    });
    try {
      await deleteBrain(pack.id);
      setPacks(await listBrains());
      if (mountedBrainIds.includes(pack.id)) {
        await onSetMounted(mountedBrainIds.filter((id) => id !== pack.id));
      }
      setConfirmingId(null);
    } catch (err) {
      setDeleteErrors((prev) =>
        new Map(prev).set(pack.id, err instanceof Error ? err.message : 'Delete failed.'),
      );
    } finally {
      mutationRef.current = false;
      setDeletingIds((prev) => {
        const copy = new Set(prev);
        copy.delete(pack.id);
        return copy;
      });
    }
  };

  // Import a pack file: parse locally, POST it (server validates the sgc-brain/1
  // contract), refresh the list, then auto-mount the new pack on the active
  // chat. Same-id re-import overwrites the file in place (the hand-edit-
  // aliases-and-re-export flow), so the id is deduped out of the mount set and
  // named in refreshIds — an already-mounted pack must refetch, not keep
  // serving its stale chunks. Mount failure is reported separately — the
  // import itself succeeded.
  const handleImportFile = async (file: File) => {
    if (mutationRef.current) return;
    mutationRef.current = true;
    setImporting(true);
    setImportError(null);
    let manifest: BrainManifest;
    try {
      const pack = JSON.parse(await file.text()) as BrainPack;
      manifest = await importBrain(pack);
      setPacks(await listBrains());
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed.');
      mutationRef.current = false;
      setImporting(false);
      return;
    }
    try {
      const next = mountedBrainIds.includes(manifest.id)
        ? mountedBrainIds
        : [...mountedBrainIds, manifest.id];
      await onSetMounted(next, [manifest.id]);
    } catch (err) {
      setImportError(
        `Imported, but mounting on this chat failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    } finally {
      mutationRef.current = false;
      setImporting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ground/70 p-4 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="brain-manager-title"
        className="relative flex max-h-[86vh] w-full max-w-[620px] flex-col overflow-hidden rounded-[22px] border border-hairline-strong bg-ground/85 shadow-glass backdrop-blur-[18px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-hairline px-7 pt-6 pb-5">
          <div className="flex flex-col gap-1.5">
            <span className={RAIL_LABEL}>Knowledge</span>
            <h2 id="brain-manager-title" className="font-serif text-[22px] italic leading-tight text-fg-1">
              Brain Manager
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={mutationBusy}
              className="whitespace-nowrap rounded-md border border-hairline-strong px-2.5 py-1.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-ember transition-colors hover:border-ember/60 hover:bg-ember/[0.08] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-hairline-strong disabled:hover:bg-transparent"
            >
              {importing ? 'Importing…' : 'Import pack…'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                // Allow re-importing the same filename later (re-export flow).
                e.target.value = '';
                if (file) void handleImportFile(file);
              }}
            />
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              aria-label="Close Brain Manager"
              className="flex size-[30px] shrink-0 items-center justify-center rounded-full border border-hairline-strong bg-surface-thin text-fg-2 transition-colors hover:border-ember hover:bg-ember hover:text-bone"
            >
              <X className="size-[15px]" />
            </button>
          </div>
        </div>

        <div className="sal-scroll min-h-0 flex-1 overflow-y-auto px-7 pt-5 pb-7">
          <p className="mb-4 text-[12.5px] leading-[1.6] text-fg-3">
            Packs are reference material about the world, not memory of you — read-only at
            runtime, searched by the same deterministic TF-IDF engine as the cosine grep.
            Mounting, unmounting, and deleting here is pure curation; no model is involved.
          </p>

          {importError && (
            <p className="mb-3 rounded-[10px] border border-danger/40 bg-danger/[0.08] px-3.5 py-2.5 text-[12px] leading-[1.5] text-danger">
              {importError}
            </p>
          )}
          {listError && (
            <p className="mb-3 text-[12px] leading-[1.5] text-danger">{listError}</p>
          )}

          {packs === null ? (
            <p className="px-1 py-8 text-center text-[13px] italic text-fg-3">Loading knowledge packs…</p>
          ) : packs.length === 0 ? (
            <p className="px-1 py-8 text-center text-[13px] italic text-fg-3">
              No knowledge packs imported yet. Export one from Atlantis, then import it here.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {packs.map((p) => (
                <PackCard
                  key={p.id}
                  pack={p}
                  mounted={mountedBrainIds.includes(p.id)}
                  busy={mutationBusy}
                  toggleError={toggleErrors.get(p.id) ?? null}
                  onToggle={() => void handleToggle(p)}
                  confirming={confirmingId === p.id}
                  deleting={deletingIds.has(p.id)}
                  deleteError={deleteErrors.get(p.id) ?? null}
                  onDeleteClick={() => setConfirmingId(p.id)}
                  onConfirmDelete={() => void handleConfirmDelete(p)}
                  onCancelDelete={() => setConfirmingId(null)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// PACK CARD — one mountable pack: name, size, stub badge, description, the
// mount toggle, and the delete control (behind an inline two-step confirm).
// ============================================================

interface PackCardProps {
  pack: BrainManifest;
  mounted: boolean;
  /** True while ANY mount mutation is in flight — every card's controls
   * disable together, because each mutation composes a whole-set PUT and
   * concurrent ones would erase each other. */
  busy: boolean;
  toggleError: string | null;
  onToggle: () => void;
  confirming: boolean;
  deleting: boolean;
  deleteError: string | null;
  onDeleteClick: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}

function PackCard({
  pack,
  mounted,
  busy,
  toggleError,
  onToggle,
  confirming,
  deleting,
  deleteError,
  onDeleteClick,
  onConfirmDelete,
  onCancelDelete,
}: PackCardProps) {
  return (
    <li
      className={cn(
        'rounded-[14px] border bg-surface px-4 py-3 transition-colors',
        mounted ? 'border-hairline-strong' : 'border-hairline',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-[13.5px] font-medium text-fg-1">{pack.name}</span>
            <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-fg-4">
              {pack.chunkCount} chunk{pack.chunkCount !== 1 ? 's' : ''}
            </span>
            {pack.stub && (
              <span className="rounded border border-hairline px-1 py-px font-mono text-[8.5px] uppercase tracking-[0.1em] text-fg-3">
                model-free build
              </span>
            )}
          </div>
          {pack.description && (
            <p className="mt-1 overflow-hidden text-ellipsis whitespace-nowrap text-[11.5px] leading-[1.5] text-fg-3">
              {pack.description}
            </p>
          )}
          {toggleError && <p className="mt-1.5 text-[11px] leading-[1.4] text-danger">{toggleError}</p>}
          {deleteError && <p className="mt-1.5 text-[11px] leading-[1.4] text-danger">{deleteError}</p>}
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <ToggleSwitch
            on={mounted}
            onClick={onToggle}
            ariaLabel={mounted ? `Unmount ${pack.name}` : `Mount ${pack.name}`}
            disabled={busy}
          />
          {confirming ? (
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="font-mono text-[9.5px] text-fg-3">Delete for all chats?</span>
              <button
                type="button"
                onClick={onConfirmDelete}
                disabled={busy}
                className="rounded-full border border-danger/50 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em] text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {deleting ? '…' : 'Confirm'}
              </button>
              <button
                type="button"
                onClick={onCancelDelete}
                disabled={busy}
                className="rounded-full border border-hairline-strong px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em] text-fg-3 transition-colors hover:border-ember/60 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={onDeleteClick}
              disabled={busy}
              aria-label={`Delete ${pack.name}`}
              className="cursor-pointer px-0.5 text-sm leading-none text-fg-4 transition-colors hover:text-danger disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-fg-4"
            >
              ×
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
