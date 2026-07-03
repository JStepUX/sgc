import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// ============================================================
// COMPOSER — owns the input state locally.
//
// Why this is its own component: the input value is the highest-frequency
// state in the app — it changes on every keystroke. If it lived on the root,
// every keystroke would re-render the entire SGC tree (memory panel, turn
// inspector, token chart, every assistant message running ReactMarkdown).
// Lifting it down here means typing only re-renders the composer itself; the
// aurora drift/pulse is signalled to the root via throttled callbacks.
//
// The root drives `resetSignal` to clear + focus the textarea after a turn
// submits or a new chat is created.
// ============================================================

interface ComposerProps {
  // Called when the user hits Enter or clicks send. The root resolves the
  // text into a turn; the composer doesn't care what happens next.
  onSubmit: (text: string) => void;
  // Called on each keystroke with the current "salience gate" (0..1). The
  // root rate-limits aurora updates via this — see hooks/useAuroraPulse.
  onKeystroke: (gate: number) => void;
  // Toggles the submit button + Enter handler. The root knows when it's
  // mid-turn or pre-hydration; the composer just reflects.
  submitDisabled: boolean;
  // Bumped by the root after a successful turn / chat reset, to clear and
  // refocus the textarea. A monotonic counter is the dependency-array
  // friendly shape — flipping it triggers the effect.
  resetSignal: number;
  // History-toggle button — kept here so the composer row stays atomic.
  historyOpen: boolean;
  onToggleHistory: () => void;
  historyButtonRef: React.RefObject<HTMLButtonElement | null>;
}

export const Composer = memo(function Composer({
  onSubmit,
  onKeystroke,
  submitDisabled,
  resetSignal,
  historyOpen,
  onToggleHistory,
  historyButtonRef,
}: ComposerProps) {
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the composer to fit its content.
  useEffect(() => {
    const t = inputRef.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = `${Math.min(t.scrollHeight, 220)}px`;
  }, [input]);

  // Root-driven clear + refocus. Skips the initial mount so the textarea
  // doesn't steal focus on first paint.
  const firstResetMount = useRef(true);
  useEffect(() => {
    if (firstResetMount.current) {
      firstResetMount.current = false;
      return;
    }
    setInput('');
    inputRef.current?.focus();
  }, [resetSignal]);

  const submit = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || submitDisabled) return;
    onSubmit(trimmed);
    // We intentionally don't clear here — root will bump `resetSignal` when
    // it's ready, so the visible draft survives if the parent rejects (e.g.,
    // pre-hydration). In practice the disabled-guard above blocks that path.
  }, [input, submitDisabled, onSubmit]);

  return (
    <div className="mx-auto w-full max-w-[680px] px-8 pt-[14px] pb-[22px]">
      <div className="flex items-end gap-2.5">
        <button
          ref={historyButtonRef}
          type="button"
          onClick={onToggleHistory}
          aria-label="Chat history"
          aria-expanded={historyOpen}
          className={cn(
            'flex size-11 shrink-0 items-center justify-center rounded-full border bg-surface-thin shadow-glass backdrop-blur-[10px] transition-colors',
            historyOpen
              ? 'border-ember text-ember shadow-[0_0_18px_-4px_var(--color-ember)]'
              : 'border-hairline-strong text-fg-2 hover:border-ember hover:text-ember',
          )}
        >
          <Clock className="size-[17px]" />
        </button>
        <div className="flex flex-1 items-end gap-2.5 rounded-[24px] border border-hairline-strong bg-surface-thin py-2 pr-2 pl-[18px] shadow-glass backdrop-blur-[10px]">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => {
              const next = e.target.value;
              setInput(next);
              // Quantize the gate to integer word-count steps so we only
              // touch the aurora's filter when the count crosses a boundary,
              // not on every keystroke. The 600ms CSS transition smooths it.
              const wc = next.split(/\s+/).filter(Boolean).length;
              const gate = Math.min(0.9, 0.25 + wc * 0.06);
              onKeystroke(gate);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Say something."
            rows={1}
            className="sal-scroll max-h-[220px] min-h-[22px] flex-1 resize-none border-0 bg-transparent py-1.5 text-[14.5px] leading-[1.55] text-fg-1 outline-none placeholder:text-fg-4"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={submit}
            disabled={submitDisabled || !input.trim()}
            aria-label="Say it"
            className="size-[30px] rounded-full text-fg-2 hover:border-ember hover:bg-ember hover:text-bone"
          ><ArrowUp className="size-[15px]" /></Button>
        </div>
      </div>
    </div>
  );
});
