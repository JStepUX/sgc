import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatRelative } from '../lib/format-time';
import type { PromptVersion } from '../lib/persistence';

// ============================================================
// PROMPT EDITOR MODAL — edit THIS chat's system prompt (persona) mid-chat, with
// its own edit history. Deliberately minimal: one chat, one prompt, its own
// forward-only version history.
//
//   - Save mints a new version at the head and makes it live. Old versions are
//     frozen (forward-only) — selecting one loads it into the editor as a draft;
//     saving makes a NEW head (no rewind), matching the relay.
//   - Save is enabled only when the text differs from what's loaded.
//
// The prompt is NOT stored in the chat history — the buffer holds turns and only
// turns. The live persona is supplied fresh from current state at call time, so
// an edit is simply used by the NEXT turn; there's no stored prompt to reconcile.
//
// A chat whose prompt has never been edited has zero persisted versions: the
// editor then shows a single SYNTHETIC baseline (the resolved live persona).
// The first save freezes that baseline as a real v1 (via `baselineText`, resolved
// up in the app since DEFAULT_PERSONA lives client-side) and lands the edit as v2.
//
// Styled to match ConfirmPersonaModal / ChatHistoryModal: frosted glass over the
// aurora field, focus trap, Escape closes, ⌘/Ctrl+Enter saves.
// ============================================================

interface PromptEditorModalProps {
  open: boolean;
  onClose: () => void;
  /** The resolved live persona text — the baseline shown when no versions exist
   *  yet, and the `baselineText` frozen as v1 on the chat's first edit. */
  livePersona: string;
  /** Persisted versions, newest-first (head = live). Empty until the first edit. */
  versions: PromptVersion[];
  /** Append a new live version. The app persists it and updates its own state;
   *  this modal re-syncs to the new head via the open/props effect below. */
  onSave: (text: string, baselineText: string) => Promise<void>;
}

const EYEBROW = 'font-mono text-[11px] tracking-[0.18em] uppercase text-fg-3';
const FIELD_LABEL = 'font-mono text-[10px] tracking-[0.16em] uppercase text-fg-3';

// First non-empty line, capped — the history preview. Mirrors the prototype.
function firstLine(t: string): string {
  return t.split('\n').find((l) => l.trim())?.slice(0, 72) || 'Empty prompt.';
}

interface DisplayVersion extends PromptVersion {
  /** True for the in-memory baseline shown when no versions are persisted yet. */
  synthetic?: boolean;
}

export function PromptEditorModal({
  open,
  onClose,
  livePersona,
  versions,
  onSave,
}: PromptEditorModalProps) {
  const [draft, setDraft] = useState('');
  const [loadedN, setLoadedN] = useState(1);
  const [loadedText, setLoadedText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // The list the editor renders: persisted versions, or a single synthetic
  // baseline (the live persona) when the prompt has never been edited. The head
  // (index 0 — max n) is always the live version.
  const displayList: DisplayVersion[] =
    versions.length > 0
      ? versions
      : [{ id: -1, n: 1, text: livePersona, createdAt: 0, synthetic: true }];
  const live = displayList[0];
  const liveN = live.n;

  const dirty = draft !== loadedText;
  const now = Date.now();

  // Sync the editor to the LIVE head whenever the modal opens — and whenever the
  // live head changes (i.e. after a save, when the app updates `versions` /
  // `livePersona`). Loading an OLD version into the editor is internal state and
  // does NOT change these props, so it never gets clobbered. Front-loading the
  // live text means "Cancel" always abandons back to live, never a stale draft.
  useEffect(() => {
    if (!open) return;
    const head =
      versions.length > 0 ? versions[0] : { n: 1, text: livePersona };
    setLoadedN(head.n);
    setLoadedText(head.text);
    setDraft(head.text);
    setError(null);
    const id = setTimeout(() => textareaRef.current?.focus(), 30);
    return () => clearTimeout(id);
  }, [open, versions, livePersona]);

  const loadVersion = (v: DisplayVersion) => {
    setLoadedN(v.n);
    setLoadedText(v.text);
    setDraft(v.text);
  };

  const handleSave = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      // baselineText is the current live persona — the server freezes it as v1
      // only when this is the chat's first edit (otherwise it's ignored).
      await onSave(draft, livePersona);
      // Close the brief dirty window before the props-effect re-syncs loadedN.
      setLoadedText(draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save the prompt.');
    } finally {
      setSaving(false);
    }
  };

  // Escape closes; ⌘/Ctrl+Enter saves when dirty. Focus trap: Tab/Shift+Tab
  // cycle within the dialog (same pattern as ConfirmPersonaModal).
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
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
    // handleSave closes over draft/dirty/saving; re-bind so ⌘↵ saves current text.
  }, [open, onClose, draft, dirty, saving, livePersona]); // eslint-disable-line react-hooks/exhaustive-deps

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
        aria-labelledby="prompt-editor-title"
        className="relative flex max-h-[88vh] w-full max-w-[860px] flex-col overflow-hidden rounded-[22px] border border-hairline-strong bg-ground/85 shadow-glass backdrop-blur-[18px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-hairline px-7 pt-6 pb-5">
          <div className="flex flex-col gap-1.5">
            <span className={EYEBROW}>This chat&apos;s prompt</span>
            <h2
              id="prompt-editor-title"
              className="font-serif text-[22px] italic leading-tight text-fg-1"
            >
              Adjust the runner
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

        <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[1fr_232px]">
          {/* Editor */}
          <div className="flex min-h-0 flex-col px-7 pt-5 pb-5">
            <div className="mb-2 flex items-baseline gap-2">
              <span className={FIELD_LABEL}>System prompt</span>
              <span className="font-mono text-[10px] tracking-[0.02em] text-ember">
                {loadedN === liveN ? `editing v${loadedN} (live)` : `editing from v${loadedN}`}
                {dirty && <span className="text-fg-3"> • unsaved</span>}
              </span>
            </div>
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              maxLength={20000}
              className="sal-scroll min-h-[260px] flex-1 resize-none rounded-[14px] border border-hairline-strong bg-surface px-4 py-3 font-mono text-[12.5px] leading-[1.65] text-fg-1 outline-none focus:border-ember/55"
            />
          </div>

          {/* Edit history */}
          <div className="flex min-h-0 flex-col border-t border-hairline bg-black/[0.14] px-5 pt-5 pb-5 sm:border-t-0 sm:border-l">
            <div className={`${FIELD_LABEL} mb-3`}>Edit history</div>
            <div className="sal-scroll -mx-1 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-1">
              {displayList.map((v) => {
                const isLoaded = v.n === loadedN;
                const isLive = v.n === liveN;
                return (
                  <button
                    key={v.synthetic ? 'baseline' : v.id}
                    type="button"
                    onClick={() => loadVersion(v)}
                    className={[
                      'group rounded-lg border px-3 py-2.5 text-left transition-colors',
                      isLoaded
                        ? 'border-ember/55 bg-ember/[0.08]'
                        : 'border-hairline-strong bg-surface-thin hover:border-hairline',
                    ].join(' ')}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-mono text-[11px] tracking-[0.02em] text-fg-1">
                        v{v.n}
                      </span>
                      {isLive && (
                        <span className="rounded border border-ember/55 px-1.5 py-px font-mono text-[8.5px] uppercase tracking-[0.1em] text-ember">
                          live
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 font-mono text-[9.5px] text-fg-4">
                      {v.synthetic ? 'current' : formatRelative(v.createdAt, now)}
                    </div>
                    <div className="mt-1.5 line-clamp-2 text-[10.5px] leading-[1.45] text-fg-3">
                      {firstLine(v.text)}
                    </div>
                    {!isLoaded && (
                      <div className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.08em] text-ember opacity-0 transition-opacity group-hover:opacity-100">
                        Load into editor →
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-hairline px-7 py-4">
          <div className="min-w-0 font-mono text-[10.5px] tracking-[0.02em] text-fg-3">
            {error ? (
              <span className="text-danger">{error}</span>
            ) : (
              <span>
                {displayList.length} version{displayList.length === 1 ? '' : 's'} · live is v{liveN}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-3">
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
              onClick={() => void handleSave()}
              disabled={!dirty || saving}
              className="font-mono text-[11px]"
            >
              {saving ? 'Saving…' : 'Save as new version'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
