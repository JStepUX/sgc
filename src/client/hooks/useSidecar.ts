import { useCallback, useMemo, useRef, useState } from 'react';
import { runTurn } from '../lib/api';
import { buildSidecarPrompt, sidecarWireMessages, type SidecarMessage } from '../lib/sidecar';
import type { ChatSession } from './useChatSession';
import type { ProviderState } from './useProvider';

// ============================================================
// SIDECAR — the co-author conversation in the rail (see lib/sidecar.ts for
// what it is and is not). This hook is the whole of its memory: the
// transcript lives in React state and NOWHERE else — no DB rows, no
// localStorage — so it ends with the app session, and `clear` (the rail's
// refresh button) ends it sooner. It deliberately survives chat switches and
// Begin again: drafting the next persona with the sidecar and then starting
// that chat is a real workflow, and the story snapshot is rebuilt from the
// live session on every message anyway.
//
// Reads the session, never writes it. One runTurn per message on the SAME
// provider token the turn runner would use; no tools, no pacing ceiling.
// ============================================================

export interface SidecarState {
  messages: SidecarMessage[];
  /** The reply as it streams; null when nothing is in flight or no token yet. */
  streamingText: string | null;
  isProcessing: boolean;
  /** The last failure, cleared by the next submit or a clear. */
  error: string | null;
  /** The message that failed to send, until the next submit or a clear (the
   *  nonce tells two failures of the same text apart). The PANEL decides what
   *  to do with it: back into an empty input, or — when the author has
   *  already started typing something else — left here behind a Retry, so a
   *  failure never overwrites a draft. */
  failed: { text: string; nonce: number } | null;
  submit: (text: string) => void;
  /** Re-send the failed message as it was; the input is not involved. */
  retry: () => void;
  /** Drop the transcript and abort any in-flight reply. */
  clear: () => void;
}

export function useSidecar(
  session: Pick<ChatSession, 'chatLog' | 'constitutional' | 'activePersona' | 'activeMask'>,
  providerState: Pick<ProviderState, 'provider' | 'health'>,
): SidecarState {
  const [messages, setMessages] = useState<SidecarMessage[]>([]);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ text: string; nonce: number } | null>(null);
  const failureCount = useRef(0);

  // The in-flight call's abort handle. `clear` aborts it AND nulls the ref;
  // a call that finds the ref no longer pointing at its own controller knows
  // it was cleared out from under and must not touch state.
  const inFlight = useRef<AbortController | null>(null);

  const processInput = async (text: string) => {
    const userInput = text.trim();
    if (!userInput || isProcessing) return;

    const { provider, health } = providerState;
    // Same rule as the turn runner: assert the token only once /api/health
    // confirmed it, else let the server route to its boot default.
    const confirmedProvider = health?.providers[provider]?.available ? provider : undefined;

    const transcript: SidecarMessage[] = [...messages, { role: 'user', content: userInput }];
    setMessages(transcript);
    setError(null);
    setFailed(null);
    setIsProcessing(true);

    const controller = new AbortController();
    inFlight.current = controller;
    try {
      const systemPrompt = buildSidecarPrompt({
        persona: session.activePersona,
        mask: session.activeMask,
        constitutional: session.constitutional,
        chatLog: session.chatLog,
        now: Date.now(),
        query: userInput,
      });
      const result = await runTurn(
        systemPrompt,
        sidecarWireMessages(transcript),
        (rawSoFar) => {
          if (inFlight.current === controller) setStreamingText(rawSoFar);
        },
        confirmedProvider,
        undefined,
        { signal: controller.signal },
      );
      if (inFlight.current !== controller) return;
      setMessages([...transcript, { role: 'assistant', content: result.text }]);
    } catch (err) {
      if (inFlight.current !== controller) return; // cleared — the abort is ours
      console.error('Sidecar error:', err);
      // Roll the unanswered message back out (a transcript must not end on a
      // dangling user line — the next send would put two in a row on the
      // wire) and hold its text for the panel to restore or retry.
      setMessages(messages);
      failureCount.current += 1;
      setFailed({ text: userInput, nonce: failureCount.current });
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null;
        setStreamingText(null);
        setIsProcessing(false);
      }
    }
  };

  // Stable wrapper — same ref pattern as useTurnRunner's submitTurn, so the
  // memoized panel doesn't re-render on every root render.
  const processInputRef = useRef(processInput);
  processInputRef.current = processInput;
  const submit = useCallback((text: string) => {
    void processInputRef.current(text);
  }, []);

  const failedRef = useRef(failed);
  failedRef.current = failed;
  const retry = useCallback(() => {
    if (failedRef.current) void processInputRef.current(failedRef.current.text);
  }, []);

  const clear = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
    setMessages([]);
    setStreamingText(null);
    setIsProcessing(false);
    setError(null);
    setFailed(null);
  }, []);

  // One stable object per state change, so the memoized SidecarPanel skips the
  // root's re-renders (every streamed story token, every aurora pulse).
  return useMemo(
    () => ({ messages, streamingText, isProcessing, error, failed, submit, retry, clear }),
    [messages, streamingText, isProcessing, error, failed, submit, retry, clear],
  );
}
