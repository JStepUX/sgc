import { useCallback, useRef, useState } from 'react';

// --- Aurora gating: drift while active, pulse on keystrokes (throttled) ---
// The composer signals into these via `handleKeystroke`. Critically, the
// composer owns its own input state — so typing alone does NOT re-render the
// app root; only the throttled aurora updates below do. That keeps the heavy
// children (memory panel, turn inspector, message list with ReactMarkdown)
// off the per-keystroke render path.
export function useAuroraPulse(): {
  gate: number;
  typing: boolean;
  pulseKey: number;
  handleKeystroke: (nextGate: number) => void;
} {
  const [gate, setGate] = useState(0.25);
  const [typing, setTyping] = useState(false);
  const [pulseKey, setPulseKey] = useState(0);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Wall-clock of the last pulse we emitted, so we can rate-limit. A 28px
  // blur layer re-mounting on every keystroke is the most expensive single
  // thing in the UI — capping it at ~6-8 Hz keeps the visual rhythm without
  // thrashing the compositor.
  const lastPulseAt = useRef(0);

  // Stable handler passed to <Composer/>. Rate-limited so the aurora doesn't
  // remount its blurred pulse layer at keypress rate. The 600ms CSS
  // transition on `.sal-aurora`'s filter (see index.css) means dropping the
  // intermediate gate values is invisible — only the latest one matters.
  const handleKeystroke = useCallback((nextGate: number) => {
    setGate((prev) => (prev !== nextGate ? nextGate : prev));
    setTyping(true);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => setTyping(false), 1600);
    const now = performance.now();
    if (now - lastPulseAt.current >= 140) {
      lastPulseAt.current = now;
      setPulseKey((k) => k + 1);
    }
  }, []);

  return { gate, typing, pulseKey, handleKeystroke };
}
