import { memo } from 'react';

// ============================================================
// AURORA — the warm field behind the glass. Drifts only while the
// user is active; each keystroke sends a synth-style pulse up from
// the bottom. The aurora is the thinking made visible. (See index.css.)
// ============================================================

// Memoized so cascading parent re-renders (from typing, scrolling, streaming
// tokens arriving) don't reapply the filter chain or remount the pulse layer.
// Only true changes to `gate`, `active`, or `pulseKey` should touch this tree.
export const AuroraBackground = memo(function AuroraBackground({
  gate,
  active,
  pulseKey,
}: {
  gate: number;
  active: boolean;
  pulseKey: number;
}) {
  const sat = 80 + gate * 30;
  const bright = 0.92 + gate * 0.08;
  return (
    <div
      className="sal-aurora"
      data-active={active}
      style={{ filter: `saturate(8%) brightness(0.34) saturate(${sat}%) brightness(${bright})` }}
      aria-hidden="true"
    >
      <div className="sal-aurora-base" />
      <div className="sal-aurora-grain" />
      {/* Re-keyed when a pulse fires so React remounts it and the animation restarts.
          Throttled upstream — see Composer — so we don't remount a 28px-blurred
          layer on every keystroke. */}
      <div className="sal-aurora-pulse" key={pulseKey} />
    </div>
  );
});
