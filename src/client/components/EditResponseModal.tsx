import { useEffect, useRef, useState } from 'react';
import { X, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import type { TurnSummary } from '../lib/types';

// ============================================================
// EDIT RESPONSE MODAL — rewrite the latest assistant reply, two ways:
//
//   1. Manual edit — type new text directly into the field.
//   2. Re-spin — re-run the currently-selected model for THIS turn. The chat
//      HISTORY is reconstructed for that turn (sliced before it, recency anchored
//      at its original instant); memories/persona are current, not snapshotted.
//      A fired spontaneity operator is DROPPED by default (re-spin usually exists
//      to undo the perturbation) — the replay toggle opts back into a verbatim
//      re-injection. Never redrawn either way. Streamed live into the field.
//
// Whatever text is in the field on Save becomes the turn's content. The modal
// reports back whether that text is the VERBATIM re-spin output (carry its fresh
// summary + token metrics) or a hand edit (the app clears the stale summary).
//
// Scope is the latest turn only: a re-spin rewrites THIS reply in isolation —
// later turns already happened and are not regenerated (no cascade). Styled to
// match PromptEditorModal / ConfirmPersonaModal: frosted glass over the aurora
// field, focus trap, Escape closes, ⌘/Ctrl+Enter saves.
// ============================================================

/** The product of a completed re-spin — handed to onSave so the app can persist
 *  the fresh summary + metrics when the saved text is the re-spin verbatim. */
export interface RespinResult {
  text: string;
  summary: TurnSummary | null;
  inputTokens: number;
  outputTokens: number;
  elapsed: number;
  /** Whether the turn's fired spontaneity operator was re-injected into this
   * run. False (the default path) means the re-spin ran clean — on save, the
   * turn's fired fields and ⟐ marker are cleared to match. */
  operatorReplayed: boolean;
}

interface EditResponseModalProps {
  open: boolean;
  onClose: () => void;
  /** The reply's current text — seeds the field on open. */
  initialText: string;
  /** Display-only author label for the eyebrow (falls back to "Sal"). */
  label: string;
  /** Whether a re-spin can run now (a provider is confirmed + no live turn streaming). */
  canRespin: boolean;
  /** The operator that fired on this turn (human-facing name), or null when none
   * did. Non-null renders the replay toggle — default OFF: a re-spin drops the
   * operator unless the user opts back into a faithful replay. */
  firedOperatorLabel: string | null;
  /** Run the re-spin: streams stripped preview text via onDelta, resolves with
   * the result. `replayOperator` re-injects the turn's snapshotted directive. */
  onRespin: (onDelta: (preview: string) => void, replayOperator: boolean) => Promise<RespinResult>;
  /** Commit. `respin` is non-null only when the saved text is the re-spin
   * verbatim. `operatorCleared` is independent of that verbatim check: it is
   * true whenever the LAST completed re-spin ran without the operator — a
   * hand edit on top of a clean re-spin still descends from unperturbed text,
   * so the turn's fired fields must still be cleared on save. */
  onSave: (text: string, respin: RespinResult | null, operatorCleared: boolean) => Promise<void>;
}

const EYEBROW = 'font-mono text-[11px] tracking-[0.18em] uppercase text-fg-3';
const FIELD_LABEL = 'font-mono text-[10px] tracking-[0.16em] uppercase text-fg-3';

export function EditResponseModal({
  open,
  onClose,
  initialText,
  label,
  canRespin,
  firedOperatorLabel,
  onRespin,
  onSave,
}: EditResponseModalProps) {
  const [draft, setDraft] = useState('');
  const [respinResult, setRespinResult] = useState<RespinResult | null>(null);
  // Replay the fired operator on re-spin? Default OFF — re-spinning a perturbed
  // turn usually means the perturbation is the thing being undone.
  const [replayOperator, setReplayOperator] = useState(false);
  const [respinning, setRespinning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Generation token for in-flight re-spins. A re-spin streams into modal state
  // asynchronously; if the user closes mid-stream and reopens, a late delta or
  // result from the OLD run must not clobber the fresh draft (or get saved). Each
  // (re)open and each new re-spin bumps this; a run only writes state while its
  // captured token is still current.
  const respinSeqRef = useRef(0);

  const name = label && label.trim() ? label : 'Sal';
  const dirty = draft !== initialText;
  // The saved text counts as a re-spin only if it's the re-spin output untouched;
  // any hand-edit afterwards drops back to the manual path (summary cleared).
  const savingRespin = respinResult !== null && draft === respinResult.text;
  // Operator provenance is looser than the verbatim check above: once a clean
  // (operator-free) re-spin has replaced the draft, hand edits on top of it
  // still descend from unperturbed text — the fired fields clear on save either
  // way. `respinResult` holds the LAST completed re-spin regardless of edits,
  // and a later replay re-spin overwrites it, flipping this back off.
  const operatorCleared = respinResult !== null && !respinResult.operatorReplayed;
  const canSave = dirty && draft.trim().length > 0 && !saving && !respinning;

  // Seed the field from the live reply whenever the modal opens (or the target
  // changes). Cancel always abandons back to the original text.
  useEffect(() => {
    if (!open) return;
    // Invalidate any re-spin still in flight from a previous open session, so its
    // late writes are discarded rather than clobbering this fresh draft.
    respinSeqRef.current += 1;
    setDraft(initialText);
    setRespinResult(null);
    setReplayOperator(false);
    setError(null);
    setRespinning(false);
    setSaving(false);
    const id = setTimeout(() => textareaRef.current?.focus(), 30);
    return () => clearTimeout(id);
  }, [open, initialText]);

  const handleRespin = async () => {
    if (respinning || saving || !canRespin) return;
    const seq = (respinSeqRef.current += 1);
    const isCurrent = () => respinSeqRef.current === seq;
    setRespinning(true);
    setError(null);
    try {
      // Stream the regeneration straight into the field, then settle on the
      // canonical parsed text so the savingRespin equality holds exactly. Each
      // write is gated on this run still being current (not closed/reopened).
      const result = await onRespin((preview) => { if (isCurrent()) setDraft(preview); }, replayOperator);
      if (!isCurrent()) return;
      setDraft(result.text);
      setRespinResult(result);
    } catch (e) {
      if (isCurrent()) setError(e instanceof Error ? e.message : 'Re-spin failed.');
    } finally {
      if (isCurrent()) setRespinning(false);
    }
  };

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(draft, savingRespin ? respinResult : null, operatorCleared);
      // The app closes the modal on success (it owns editTarget).
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save the reply.');
      setSaving(false);
    }
  };

  // Escape closes; ⌘/Ctrl+Enter saves when allowed. Focus trap mirrors
  // PromptEditorModal so Tab/Shift+Tab cycle within the dialog.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!saving) onClose();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void handleSave();
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
    // handler closes over draft/saving/respinResult — re-bind so ⌘↵ saves current text.
  }, [open, onClose, draft, saving, respinning, respinResult, canRespin]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const status = respinning
    ? 're-spinning…'
    : savingRespin
      ? 're-spun'
      : dirty
        ? 'edited'
        : 'unchanged';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ground/70 p-4 backdrop-blur-md"
      onClick={() => { if (!saving) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-response-title"
        className="relative flex max-h-[88vh] w-full max-w-[680px] flex-col overflow-hidden rounded-[22px] border border-hairline-strong bg-ground/85 shadow-glass backdrop-blur-[18px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-hairline px-7 pt-6 pb-5">
          <div className="flex flex-col gap-1.5">
            <span className={EYEBROW}>This reply</span>
            <h2
              id="edit-response-title"
              className="font-serif text-[22px] italic leading-tight text-fg-1"
            >
              Edit the reply
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

        <div className="flex min-h-0 flex-1 flex-col px-7 pt-5 pb-5">
          <div className="mb-2 flex items-baseline gap-2">
            <span className={FIELD_LABEL}>{name}&apos;s reply</span>
            <span className="font-mono text-[10px] tracking-[0.02em] text-ember">{status}</span>
          </div>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            readOnly={respinning}
            spellCheck={false}
            maxLength={20000}
            className="sal-scroll min-h-[260px] flex-1 resize-none rounded-[14px] border border-hairline-strong bg-surface px-4 py-3 text-[13.5px] leading-[1.65] text-fg-1 outline-none focus:border-ember/55"
          />

          <div className="mt-3 flex items-center justify-between gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleRespin()}
              disabled={!canRespin || respinning || saving}
              className="font-mono text-[11px] text-fg-2"
            >
              <RotateCw className={['size-[13px]', respinning && 'animate-spin'].filter(Boolean).join(' ')} />
              {respinning ? 'Re-spinning…' : 'Re-spin'}
            </Button>
            <p className="min-w-0 text-[10.5px] leading-[1.4] text-fg-4">
              {canRespin
                ? 'Re-runs the current model with this turn’s history + your current memories & prompt. Edits this reply only — later turns aren’t regenerated.'
                : 'Re-spin needs an available model and no turn in progress.'}
            </p>
          </div>

          {firedOperatorLabel && (
            <div className="mt-3 flex items-center gap-3 rounded-[14px] border border-hairline bg-surface-thin px-4 py-2.5">
              <ToggleSwitch
                on={replayOperator}
                onClick={() => setReplayOperator((v) => !v)}
                ariaLabel={`Replay the ${firedOperatorLabel} operator on re-spin`}
                disabled={respinning || saving}
              />
              <p className="min-w-0 text-[10.5px] leading-[1.4] text-fg-4">
                <span className="text-fg-3">⟐ {firedOperatorLabel}</span> fired on this turn. Re-spin
                leaves it out{replayOperator ? ' — switched ON, it will be replayed verbatim.' : '; switch on to replay it verbatim.'}
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-hairline px-7 py-4">
          <div className="min-w-0 font-mono text-[10.5px] tracking-[0.02em] text-fg-3">
            {error ? (
              <span className="text-danger">{error}</span>
            ) : (
              <span>{savingRespin ? 'Saves the re-spun reply + its summary.' : 'Manual edit clears this turn’s summary.'}</span>
            )}
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
              disabled={!canSave}
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
