import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { importBrain, listBrains } from '../lib/persistence';
import type { BrainManifest, BrainPack } from '../lib/types';

// ============================================================
// CONFIRM PERSONA MODAL — set the per-chat persona (the system-prompt head),
// an optional display-only mask, and the knowledge packs ("brains") to mount,
// before a new chat begins. Styled to match ChatHistoryModal: frosted glass
// over the aurora field, focus trap, Escape cancels.
//
// INVARIANT: the mask is DISPLAY-ONLY. This modal hands it back via onConfirm
// for the UI label; it must never reach the prompt or the model. The persona,
// by contrast, becomes the head of the per-turn system prompt — but the
// architectural tail (TASK / TURN SUMMARY / <turn-summary>) always appends
// downstream in buildPrompt, so a persona can't drop the summary contract.
// Brains are the knowledge axis: mounting here binds packs to the NEW chat
// (chat_brains) — retrieval over them stays client-side deterministic math.
// ============================================================

interface ConfirmPersonaModalProps {
  open: boolean;
  /** The default persona text, prefilled into the textarea (DEFAULT_PERSONA). */
  defaultPersona: string;
  /** Confirm with the (possibly edited) persona, mask ('' = none), and the
   * ids of the brains to mount on the new chat ([] = none). */
  onConfirm: (persona: string, mask: string, brainIds: string[]) => void;
  /** Cancel — no chat is created. */
  onCancel: () => void;
}

const RAIL_LABEL = 'font-mono text-[11px] tracking-[0.18em] uppercase text-fg-3';

export function ConfirmPersonaModal({
  open,
  defaultPersona,
  onConfirm,
  onCancel,
}: ConfirmPersonaModalProps) {
  const [persona, setPersona] = useState(defaultPersona);
  const [mask, setMask] = useState('');
  // The importable pack list + this modal's mount selection. null = still
  // loading (or load failed — the section then shows its empty state).
  const [brains, setBrains] = useState<BrainManifest[] | null>(null);
  const [selectedBrainIds, setSelectedBrainIds] = useState<Set<string>>(new Set());
  const [importError, setImportError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const personaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset to a clean default-persona / empty-mask / nothing-mounted state each
  // time the modal opens, and focus the persona textarea. Avoids carrying a
  // stale edit from a cancelled previous open into the next one. The pack list
  // is (re)fetched per open so a pack imported elsewhere shows up.
  useEffect(() => {
    if (open) {
      setPersona(defaultPersona);
      setMask('');
      setSelectedBrainIds(new Set());
      setImportError(null);
      listBrains()
        .then(setBrains)
        .catch((err) => {
          console.warn('listBrains failed:', err);
          setBrains([]);
        });
      const id = setTimeout(() => personaRef.current?.focus(), 30);
      return () => clearTimeout(id);
    }
  }, [open, defaultPersona]);

  // Escape → cancel. Focus trap: Tab/Shift+Tab cycle within the dialog.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
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
  }, [open, onCancel]);

  if (!open) return null;

  const toggleBrain = (id: string) => {
    setSelectedBrainIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Import a pack file: parse locally, POST to the server (which validates the
  // contract and stores it), refresh the list, and auto-select the new pack.
  const handleImportFile = async (file: File) => {
    setImportError(null);
    try {
      const pack = JSON.parse(await file.text()) as BrainPack;
      const manifest = await importBrain(pack);
      setBrains(await listBrains());
      setSelectedBrainIds((prev) => new Set(prev).add(manifest.id));
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed.');
    }
  };

  const handleBegin = () => {
    // Pass the raw persona through — buildPrompt falls back to DEFAULT_PERSONA
    // for a blank/whitespace persona, so no special-casing here. Trim the mask
    // so a stray space doesn't become a "non-empty" label.
    onConfirm(persona, mask.trim(), [...selectedBrainIds]);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ground/70 p-4 backdrop-blur-md"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-persona-title"
        className="relative flex max-h-[86vh] w-full max-w-[620px] flex-col overflow-hidden rounded-[22px] border border-hairline-strong bg-ground/85 shadow-glass backdrop-blur-[18px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-hairline px-7 pt-6 pb-5">
          <div className="flex flex-col gap-1.5">
            <span className={RAIL_LABEL}>New chat</span>
            <h2
              id="confirm-persona-title"
              className="font-serif text-[22px] italic leading-tight text-fg-1"
            >
              Confirm Persona
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            className="flex size-[30px] shrink-0 items-center justify-center rounded-full border border-hairline-strong bg-surface-thin text-fg-2 transition-colors hover:border-ember hover:bg-ember hover:text-bone"
          >
            <X className="size-[15px]" />
          </button>
        </div>

        <div className="sal-scroll min-h-0 flex-1 overflow-y-auto px-7 pt-5 pb-2">
          <p className="mb-4 text-[13px] leading-[1.6] text-fg-3">
            This persona is the system prompt for the new chat.
          </p>

          <label htmlFor="persona-text" className={`${RAIL_LABEL} mb-2 block`}>
            Persona
          </label>
          <textarea
            id="persona-text"
            ref={personaRef}
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            spellCheck={false}
            className="sal-scroll min-h-[220px] w-full resize-y rounded-[14px] border border-hairline-strong bg-surface px-4 py-3 font-mono text-[12.5px] leading-[1.6] text-fg-1 outline-none focus:border-ember/55"
          />

          <label htmlFor="persona-mask" className={`${RAIL_LABEL} mb-2 mt-5 block`}>
            Call this instance (optional)
          </label>
          <input
            id="persona-mask"
            value={mask}
            onChange={(e) => setMask(e.target.value)}
            maxLength={80}
            placeholder="Sal"
            className="w-full rounded-[14px] border border-hairline-strong bg-surface px-4 py-2.5 text-[13.5px] text-fg-1 outline-none placeholder:text-fg-4 focus:border-ember/55"
          />

          {/* Mount brains — knowledge packs bound to the new chat. */}
          <div className="mb-2 mt-5 flex items-center justify-between gap-3">
            <span className={RAIL_LABEL}>Mount brains (optional)</span>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="shrink-0 whitespace-nowrap rounded-md border border-hairline-strong px-2.5 py-1.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-ember transition-colors hover:border-ember/60 hover:bg-ember/[0.08]"
            >
              Import pack…
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
          </div>
          {importError && (
            <p className="mb-2 text-[12px] leading-[1.5] text-danger">{importError}</p>
          )}
          {brains !== null && brains.length === 0 && !importError && (
            <p className="mb-1 text-[12px] leading-[1.5] text-fg-4">
              No knowledge packs imported yet. Export one from Atlantis, then import it here.
            </p>
          )}
          {brains !== null && brains.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {brains.map((b) => (
                <li key={b.id}>
                  <label className="flex cursor-pointer items-start gap-2.5 rounded-[10px] border border-hairline bg-surface px-3 py-2 transition-colors hover:border-ember/40">
                    <input
                      type="checkbox"
                      checked={selectedBrainIds.has(b.id)}
                      onChange={() => toggleBrain(b.id)}
                      className="mt-0.5 accent-[var(--color-ember)]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="text-[13px] font-medium text-fg-1">{b.name}</span>
                        <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-fg-4">
                          {b.chunkCount} chunk{b.chunkCount !== 1 ? 's' : ''}
                        </span>
                        {b.stub && (
                          <span className="rounded border border-hairline px-1 py-px font-mono text-[8.5px] uppercase tracking-[0.1em] text-fg-3">
                            model-free build
                          </span>
                        )}
                      </span>
                      {b.description && (
                        <span className="mt-0.5 block overflow-hidden text-ellipsis whitespace-nowrap text-[11.5px] leading-[1.5] text-fg-3">
                          {b.description}
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-hairline px-7 py-4">
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            className="font-mono text-[11px] text-fg-3"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleBegin}
            className="font-mono text-[11px]"
          >
            Begin
          </Button>
        </div>
      </div>
    </div>
  );
}
