import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';

// ============================================================
// CONSTITUTIONAL EDITOR MODAL — edit THIS chat's constitutional document: one
// freeform prose "about me" biography, rendered verbatim (trimmed) into the
// CONSTITUTIONAL MEMORIES prompt tier. PromptEditorModal's frame, minus the
// version history (D2) — facts about the user don't need an audit trail
// until friction says otherwise; the chip list was the format nobody used.
//
// Save is state-level, not a network call: onSave is session.setConstitutional,
// which marks the value dirty and lets the hook's existing 250ms debounce
// persist it. So there's no await, no saving spinner, no error surface here —
// same contract the old memory chips had.
// ============================================================

interface ConstitutionalEditorModalProps {
  open: boolean;
  /** The active chat's current document — the draft is (re)initialized from
   *  this every time the modal opens. */
  text: string;
  /** Commit the edited text (session.setConstitutional) and close. */
  onSave: (text: string) => void;
  /** Cancel — discards the draft, no save. */
  onClose: () => void;
}

const RAIL_LABEL = 'font-mono text-[11px] tracking-[0.18em] uppercase text-fg-3';

export function ConstitutionalEditorModal({ open, text, onSave, onClose }: ConstitutionalEditorModalProps) {
  const [draft, setDraft] = useState(text);
  const dialogRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Re-seed the draft from the current document every time the modal opens —
  // mirrors PromptEditorModal's live-head sync, minus the version history.
  useEffect(() => {
    if (!open) return;
    setDraft(text);
    const id = setTimeout(() => textareaRef.current?.focus(), 30);
    return () => clearTimeout(id);
  }, [open, text]);

  // Unchanged text is a no-op save — just close.
  const handleSave = () => {
    onSave(draft);
    onClose();
  };

  // Escape closes (discards, same as backdrop click); focus trap: Tab/Shift+Tab
  // cycle within the dialog (same pattern as PromptEditorModal).
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
          'button:not([disabled]), [href], input, textarea, [tabindex]:not([tabindex="-1"])',
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ground/70 p-4 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="constitutional-editor-title"
        className="relative flex max-h-[86vh] w-full max-w-[620px] flex-col overflow-hidden rounded-[22px] border border-hairline-strong bg-ground/85 shadow-glass backdrop-blur-[18px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-hairline px-7 pt-6 pb-5">
          <div className="flex flex-col gap-1.5">
            <span className={RAIL_LABEL}>Memory</span>
            <h2
              id="constitutional-editor-title"
              className="font-serif text-[22px] italic leading-tight text-fg-1"
            >
              Constitutional Memories
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-[30px] shrink-0 items-center justify-center rounded-full border border-hairline-strong bg-surface-thin text-fg-2 transition-colors hover:border-ember hover:bg-ember hover:text-bone"
          >
            <X className="size-[15px]" />
          </button>
        </div>

        <div className="min-h-0 flex-1 px-7 pt-5 pb-2">
          <p className="mb-4 text-[13px] leading-[1.6] text-fg-3">
            What Sal knows about you in this chat — plain prose, yours to edit.
          </p>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck
            maxLength={20000}
            className="sal-scroll min-h-[300px] w-full resize-y rounded-[14px] border border-hairline-strong bg-surface px-4 py-3 font-mono text-[12.5px] leading-[1.6] text-fg-1 outline-none focus:border-ember/55"
          />
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-hairline px-7 py-4">
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            className="font-mono text-[11px] text-fg-3"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            className="font-mono text-[11px]"
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
