import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { DynamicState } from '../lib/types';

// ============================================================
// DYNAMIC STATE MODAL — edit Sal's inner state for the latest turn.
//
// The curation half of "recurrence with curation": the state feeds the next
// prompt, so it has to be visible AND editable — a drift surface you can't
// reach is just drift. ConstitutionalEditorModal's frame; one field per schema
// key, `noticed` as three single-line inputs (the schema caps it at 3).
//
// Unlike that modal, Save is a network write (it PATCHes the turn's persisted
// inspector blob), so this one has a saving state and an error surface.
// Clearing a field to empty is how you null it out.
// ============================================================

interface DynamicStateModalProps {
  open: boolean;
  /** The latest turn's state — the draft is (re)seeded from this on every open.
   *  null seeds a blank state (writing one by hand is legitimate). */
  state: DynamicState | null;
  /** Persist the edited state onto the latest assistant turn. Rejects on
   *  failure; the modal surfaces the message and stays open. */
  onSave: (state: DynamicState) => Promise<void>;
  onClose: () => void;
}

const RAIL_LABEL = 'font-mono text-[11px] tracking-[0.18em] uppercase text-fg-3';
const FIELD_LABEL = 'font-mono text-[10px] tracking-[0.16em] uppercase text-fg-3';
const FIELD =
  'w-full rounded-[10px] border border-hairline-strong bg-surface px-3 py-2 text-[12.5px] leading-[1.55] text-fg-1 outline-none focus:border-ember/55';

const EMPTY: DynamicState = {
  goal: '',
  appraisal: '',
  association: null,
  passing_thought: null,
  noticed: [],
  unexpressed_impulse: null,
};

/** The three `noticed` slots, padded/truncated so the form shape is stable. */
function noticedSlots(state: DynamicState): [string, string, string] {
  const n = state.noticed ?? [];
  return [n[0] ?? '', n[1] ?? '', n[2] ?? ''];
}

export function DynamicStateModal({ open, state, onSave, onClose }: DynamicStateModalProps) {
  const [draft, setDraft] = useState<DynamicState>(EMPTY);
  const [noticed, setNoticed] = useState<[string, string, string]>(['', '', '']);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLTextAreaElement>(null);

  // Re-seed from the live state every time the modal opens — the state changes
  // under it every turn, so a stale draft would silently revert a turn's work.
  useEffect(() => {
    if (!open) return;
    const seed = state ?? EMPTY;
    setDraft(seed);
    setNoticed(noticedSlots(seed));
    setSaving(false);
    setError(null);
    const id = setTimeout(() => firstFieldRef.current?.focus(), 30);
    return () => clearTimeout(id);
  }, [open, state]);

  // An emptied field is a null field — that IS how you clear one.
  const nullable = (v: string): string | null => (v.trim() ? v.trim() : null);

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        goal: draft.goal.trim(),
        appraisal: draft.appraisal.trim(),
        association: nullable(draft.association ?? ''),
        passing_thought: nullable(draft.passing_thought ?? ''),
        noticed: noticed.map((n) => n.trim()).filter((n) => n.length > 0),
        unexpressed_impulse: nullable(draft.unexpressed_impulse ?? ''),
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save the state.');
      setSaving(false);
    }
  };

  // Escape closes (discards); focus trap cycles within the dialog — same
  // pattern as ConstitutionalEditorModal.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!saving) onClose();
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
  }, [open, onClose, saving]);

  if (!open) return null;

  const areas: { key: keyof DynamicState; label: string; hint: string }[] = [
    { key: 'goal', label: 'Goal', hint: 'What Sal is trying to do right now.' },
    { key: 'appraisal', label: 'Feeling', hint: 'How this moment reads to Sal.' },
    { key: 'association', label: 'Association', hint: 'Something the turn stirred but didn’t say.' },
    { key: 'passing_thought', label: 'Passing thought', hint: 'A thought that crossed and moved on.' },
    { key: 'unexpressed_impulse', label: 'Impulse', hint: 'Something wanted, and not done.' },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ground/70 p-4 backdrop-blur-md"
      onClick={() => { if (!saving) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dynamic-state-title"
        className="relative flex max-h-[86vh] w-full max-w-[620px] flex-col overflow-hidden rounded-[22px] border border-hairline-strong bg-ground/85 shadow-glass backdrop-blur-[18px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-hairline px-7 pt-6 pb-5">
          <div className="flex flex-col gap-1.5">
            <span className={RAIL_LABEL}>This turn</span>
            <h2
              id="dynamic-state-title"
              className="font-serif text-[22px] italic leading-tight text-fg-1"
            >
              Dynamic State
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
            className="flex size-[30px] shrink-0 items-center justify-center rounded-full border border-hairline-strong bg-surface-thin text-fg-2 transition-colors hover:border-ember hover:bg-ember hover:text-bone disabled:opacity-40"
          >
            <X className="size-[15px]" />
          </button>
        </div>

        <div className="sal-scroll min-h-0 flex-1 overflow-y-auto px-7 pt-5 pb-2">
          <p className="mb-4 text-[13px] leading-[1.6] text-fg-3">
            Where Sal is, privately, after this turn — it colors the next reply but is
            never quoted back to you. Yours to edit; clear a field to empty it.
          </p>

          <div className="flex flex-col gap-4">
            {areas.map((a, i) => (
              <div key={a.key} className="flex flex-col gap-1.5">
                <label className={FIELD_LABEL} htmlFor={`dynamic-state-${a.key}`}>
                  {a.label}
                </label>
                <textarea
                  id={`dynamic-state-${a.key}`}
                  ref={i === 0 ? firstFieldRef : undefined}
                  value={(draft[a.key] as string | null) ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, [a.key]: e.target.value }))}
                  rows={2}
                  spellCheck
                  maxLength={400}
                  className={`${FIELD} resize-y`}
                />
                <span className="text-[10.5px] leading-[1.4] text-fg-4">{a.hint}</span>
              </div>
            ))}

            <div className="flex flex-col gap-1.5">
              <span className={FIELD_LABEL}>Noticed</span>
              {noticed.map((n, i) => (
                <input
                  key={i}
                  type="text"
                  value={n}
                  onChange={(e) =>
                    setNoticed((prev) => {
                      const next: [string, string, string] = [...prev];
                      next[i] = e.target.value;
                      return next;
                    })
                  }
                  spellCheck
                  maxLength={400}
                  aria-label={`Noticed ${i + 1}`}
                  className={FIELD}
                />
              ))}
              <span className="text-[10.5px] leading-[1.4] text-fg-4">
                Up to three things noticed and not remarked on.
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-hairline px-7 py-4">
          <div className="min-w-0 font-mono text-[10.5px] tracking-[0.02em] text-danger">
            {error}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={onClose}
              disabled={saving}
              className="font-mono text-[11px] text-fg-3"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void handleSave()}
              disabled={saving}
              className="font-mono text-[11px]"
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
