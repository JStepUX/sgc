import { memo } from 'react';
import type { ProviderId } from '../lib/api';
import type { HealthResponse } from '../lib/provider';
import { ProviderChip } from './ProviderChip';
import { Button } from '@/components/ui/button';

// ============================================================
// PHASE BAR — title, provider switcher chip, run-mode metadata, begin-again.
// ============================================================

export const PhaseBar = memo(function PhaseBar({
  processing,
  onReset,
  provider,
  health,
  onSelectProvider,
  onConfigureProvider,
}: {
  processing: boolean;
  onReset: () => void;
  provider: ProviderId;
  health: HealthResponse | null;
  onSelectProvider: (p: ProviderId) => void;
  onConfigureProvider: (p: ProviderId) => void;
}) {
  // All three remain true on the local path (one request to one model; TF-IDF
  // grep and the 2-turn buffer are client-side and provider-agnostic).
  const meta = ['1 API call/turn', 'TF-IDF Grep', '2-turn buffer'];
  return (
    <header className="sal-topbar relative z-30 flex shrink-0 flex-wrap items-center justify-between gap-y-2 border-b border-hairline px-7 pt-[18px] pb-4 backdrop-blur-[8px]">
      <div className="flex items-center gap-[14px]">
        <span
          className="size-2 shrink-0 rounded-full bg-ember shadow-[0_0_10px_var(--color-ember)] animate-pulse-dot"
          aria-hidden="true"
        />
        <span className="text-base font-semibold tracking-[-0.005em] text-fg-1">
          Salience-Gated Cognition
        </span>
        <ProviderChip
          provider={provider}
          health={health}
          processing={processing}
          onSelect={onSelectProvider}
          onConfigure={onConfigureProvider}
        />
      </div>
      <div className="flex items-center gap-[14px]">
        {processing && (
          <span className="font-mono text-[11px] tracking-[0.04em] text-ember animate-considering">
            considering
          </span>
        )}
        <span className="hidden items-center gap-2 font-mono text-[11px] tracking-[0.04em] text-fg-3 md:flex">
          {meta.map((m, i) => (
            <span key={i} className="flex items-center gap-2">
              {i > 0 && <span className="text-fg-4">·</span>}
              <span>{m}</span>
            </span>
          ))}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={onReset}
          disabled={processing}
          className="font-mono text-[11px] text-fg-3"
        >
          Begin again
        </Button>
      </div>
    </header>
  );
});
