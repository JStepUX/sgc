import { memo, useEffect, useRef, useState } from 'react';
import { Settings } from 'lucide-react';
import type { ProviderId } from '../lib/api';
import { PROVIDER_LABEL, PROVIDER_ORDER, type HealthResponse } from '../lib/provider';
import { cn } from '@/lib/utils';

// ============================================================
// PROVIDER CHIP — clickable badge that opens an anchored popover to switch the
// model backing Sal. Replaces the old static PHASE 1.5 badge: the phase label
// was low-value signage, the switcher earns the spot. Hand-rolled popover (no
// new modal/Radix infra) — a positioned div with an outside-click + Escape
// dismiss. Selecting commits to state + localStorage and applies to the NEXT
// turn. Per provider, a status dot mirrors availability (success = configured,
// danger = not). Unconfigured rows stay clickable (dimmed) and open the
// ProviderConfigModal instead of switching (D5); configured rows reveal a gear
// on hover/focus that opens the same modal pre-filled without switching.
// ============================================================

export const ProviderChip = memo(function ProviderChip({
  provider,
  health,
  processing,
  onSelect,
  onConfigure,
}: {
  provider: ProviderId;
  health: HealthResponse | null;
  processing: boolean;
  onSelect: (p: ProviderId) => void;
  onConfigure: (p: ProviderId) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Dismiss on outside-click or Escape while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Unconfigured providers don't switch — they raise onConfigure so the
  // parent opens the ProviderConfigModal for that provider (D5).
  const choose = (p: ProviderId) => {
    const available = health?.providers[p]?.available ?? false;
    setOpen(false);
    if (!available) {
      onConfigure(p);
      return;
    }
    onSelect(p);
  };

  const currentAvailable = health?.providers[provider]?.available;

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        // Mirrors "Begin again": disabled while a turn is processing so the
        // backing model can't change mid-turn.
        disabled={processing}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-full border border-ember/35 bg-ember/[0.08] px-2.5 py-1 font-mono text-[11px] font-medium tracking-[0.08em] text-ember transition-colors hover:bg-ember/[0.14] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {/* Status dot for the CURRENT provider — rendered once health is known. */}
        {currentAvailable !== undefined && (
          <span
            aria-hidden="true"
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              currentAvailable
                ? 'bg-success shadow-[0_0_6px_var(--color-success)]'
                : 'bg-danger shadow-[0_0_6px_var(--color-danger)]',
            )}
          />
        )}
        {PROVIDER_LABEL[provider]}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-[calc(100%+8px)] z-40 w-60 rounded-lg border border-hairline bg-ground/95 p-1.5 shadow-xl backdrop-blur-md"
        >
          <div className="px-2 pb-1.5 pt-1 font-mono text-[10px] tracking-[0.18em] uppercase text-fg-3">
            Reasoning model
          </div>
          {PROVIDER_ORDER.map((p) => {
            const info = health?.providers[p];
            const available = info?.available ?? false;
            const selected = p === provider;
            // Rows are a relative wrapper with the select <button> plus an
            // absolutely-positioned SIBLING gear <button> — nested <button>s
            // are invalid HTML. stopPropagation keeps gear-click off choose().
            return (
              <div key={p} className="group relative">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => choose(p)}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 rounded-md py-1.5 pl-2 text-left transition-colors',
                    available ? 'pr-8 hover:bg-fg-1/[0.06]' : 'pr-2 opacity-40 hover:opacity-60',
                    selected && 'bg-ember/[0.1]',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'size-1.5 shrink-0 rounded-full',
                        available
                          ? 'bg-success shadow-[0_0_6px_var(--color-success)]'
                          : 'bg-danger shadow-[0_0_6px_var(--color-danger)]',
                      )}
                    />
                    <span className="flex flex-col">
                      <span className="font-mono text-[11px] tracking-[0.06em] text-fg-1">
                        {PROVIDER_LABEL[p]}
                      </span>
                      <span className="font-mono text-[10px] text-fg-3">
                        {info?.model ?? '—'}
                        {!available && ' · not configured — click to set up'}
                      </span>
                    </span>
                  </span>
                  {selected && available && (
                    <span className="size-1.5 shrink-0 rounded-full bg-ember shadow-[0_0_8px_var(--color-ember)]" />
                  )}
                </button>
                {available && (
                  <button
                    type="button"
                    aria-label={`Configure ${PROVIDER_LABEL[p]}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpen(false);
                      onConfigure(p);
                    }}
                    className="absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-fg-3 opacity-0 transition-opacity hover:bg-fg-1/[0.08] hover:text-fg-1 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
                  >
                    <Settings className="size-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
