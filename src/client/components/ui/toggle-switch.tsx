import { cn } from '@/lib/utils';

// ============================================================
// TOGGLE SWITCH — the small pill switch shared by any per-item gate control.
// Extracted from ChatMemoryEditor's per-turn TurnToggle (grep gating) so the
// Brain Manager's per-pack mount toggle can reuse the exact same visual
// vocabulary. Ember when on; a disabled switch greys out and no-ops (used
// while a mount PUT is in flight).
// ============================================================

interface ToggleSwitchProps {
  on: boolean;
  onClick: () => void;
  /** Caller-supplied — the on/off semantics differ per use site (turn gating
   * vs. brain mounting), so there's no one generic label to default to. */
  ariaLabel: string;
  disabled?: boolean;
}

export function ToggleSwitch({ on, onClick, ariaLabel, disabled }: ToggleSwitchProps) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (disabled) return;
        onClick();
      }}
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      disabled={disabled}
      className={cn(
        'relative h-[18px] w-[32px] shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        on ? 'border-ember bg-ember/80' : 'border-hairline-strong bg-surface-strong',
      )}
    >
      <span
        className={cn(
          'absolute top-1/2 size-[12px] -translate-y-1/2 rounded-full transition-all',
          on ? 'left-[16px] bg-bone' : 'left-[2px] bg-fg-3',
        )}
      />
    </button>
  );
}
