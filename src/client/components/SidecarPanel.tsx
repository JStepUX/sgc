import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AssistantMessage } from './AssistantMessage';
import { UserPill } from './UserPill';
import { RAIL_LABEL } from './rail-styles';
import type { SidecarState } from '../hooks/useSidecar';

// ============================================================
// SIDECAR PANEL — the rail's co-author tab: a second, smaller thread beside
// the story. Same bubbles as the reading column (UserPill / AssistantMessage,
// so markdown, quotes and mermaid render identically), its own input, and one
// control: the refresh button, which drops the transcript. Nothing here is
// saved anywhere — see hooks/useSidecar.ts.
//
// The input is local for the same reason Composer's is (keystrokes must not
// re-render the root). It is NOT the Composer: that one carries the history
// and tangent buttons and drives the aurora, none of which belong out here.
// ============================================================

export const SidecarPanel = memo(function SidecarPanel({ sidecar }: { sidecar: SidecarState }) {
  const { messages, streamingText, isProcessing, error, failed, submit, retry, clear } = sidecar;
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = inputRef.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
  }, [input]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages, streamingText]);

  // A failed send: its text goes back into the box ONLY if the box is empty.
  // The input stays live while a reply streams, so the author may already be
  // typing the next message when the failure lands — that draft wins, and the
  // failed message waits behind the error line's Retry instead. The DOM value
  // is read (not the `input` closure) so a keystroke that raced this effect
  // still counts as a draft. `restoredNonce` records which failure went back
  // into the box, i.e. which one does NOT need a Retry button.
  const [restoredNonce, setRestoredNonce] = useState<number | null>(null);
  useEffect(() => {
    if (!failed) return;
    if ((inputRef.current?.value ?? '').trim()) return;
    setInput(failed.text);
    setRestoredNonce(failed.nonce);
    inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failed?.nonce]);
  const restored = failed !== null && failed.nonce === restoredNonce;

  const send = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || isProcessing) return;
    submit(trimmed);
    setInput('');
  }, [input, isProcessing, submit]);

  const empty = messages.length === 0 && !isProcessing;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2.5 px-6 pb-3">
        <span className={RAIL_LABEL}>Co-author</span>
        <button
          type="button"
          onClick={clear}
          disabled={empty}
          aria-label="Clear the sidecar conversation"
          title="Start over — this conversation isn't saved anywhere"
          className="flex size-[26px] items-center justify-center rounded-full border border-hairline-strong bg-surface-thin text-fg-3 transition-colors hover:border-ember hover:text-ember disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-hairline-strong disabled:hover:text-fg-3"
        >
          <RotateCcw className="size-[12.5px]" />
        </button>
      </div>

      <div className="sal-scroll min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-6">
        <div className="flex flex-col gap-[18px] pb-3">
          {empty && (
            <p className="mt-6 text-pretty text-[13px] leading-[1.6] text-fg-3">
              A collaborator outside the story. It can read the persona, the
              continuity sheet and the latest turns; the story never hears it.
              Nothing said here is kept.
            </p>
          )}
          {messages.map((m, i) =>
            m.role === 'user'
              ? <UserPill key={i} text={m.content} />
              : <AssistantMessage key={i} text={m.content} label="Sidecar" />,
          )}
          {streamingText !== null && (
            <AssistantMessage text={streamingText || ' '} streaming label="Sidecar" />
          )}
          {isProcessing && streamingText === null && (
            <div className="flex gap-[5px] py-1">
              {[0, 1, 2].map((d) => (
                <span
                  key={d}
                  className="size-1.5 rounded-full bg-fg-3 animate-loader-dot"
                  style={{ animationDelay: `${d * 0.2}s` }}
                />
              ))}
            </div>
          )}
          {error && (
            <div role="alert" className="flex flex-col items-start gap-1.5 text-[12px] leading-[1.5] text-ember">
              {restored || !failed ? (
                <p>That didn't go through — your message is back in the box. ({error})</p>
              ) : (
                <>
                  <p>That didn't go through. ({error})</p>
                  <p className="line-clamp-2 text-fg-3">“{failed.text}”</p>
                  <button
                    type="button"
                    onClick={retry}
                    className="rounded-full border border-ember/50 px-3 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.12em] transition-colors hover:bg-ember hover:text-bone"
                  >
                    Retry
                  </button>
                </>
              )}
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      <div className="px-6 pt-2.5 pb-5">
        <div className="flex items-end gap-2 rounded-[22px] border border-hairline-strong bg-surface-thin py-1.5 pr-1.5 pl-4 shadow-glass backdrop-blur-[10px]">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Talk it through."
            aria-label="Message the sidecar"
            spellCheck
            rows={1}
            className="sal-scroll max-h-[160px] min-h-[22px] flex-1 resize-none border-0 bg-transparent py-1.5 text-[14px] leading-[1.55] text-fg-1 outline-none placeholder:text-fg-4"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={send}
            disabled={isProcessing || !input.trim()}
            aria-label="Send to the sidecar"
            className="size-[30px] rounded-full text-fg-2 hover:border-ember hover:bg-ember hover:text-bone"
          ><ArrowUp className="size-[15px]" /></Button>
        </div>
      </div>
    </div>
  );
});
