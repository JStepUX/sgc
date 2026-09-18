import { useCallback, useState, type ReactNode } from 'react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { cn } from '@/lib/utils';

// ============================================================
// CONTEXT RAIL — the right-hand column (a bottom drawer below lg), its
// collapse toggle, and its two tabs:
//   Sidecar — the co-author conversation (SidecarPanel)
//   Context — what the rail always held: identity, brains, the turn
//             inspector, the token chart
// Both tabs stay MOUNTED and the idle one is hidden, so a half-typed sidecar
// draft and the context tab's scroll position survive a switch. The root
// still composes what goes in each tab; this file owns only the frame.
// ============================================================

type RailTab = 'sidecar' | 'context';
const TABS: { id: RailTab; label: string }[] = [
  { id: 'sidecar', label: 'Sidecar' },
  { id: 'context', label: 'Context' },
];

// Persisted like the collapse choice (hooks/useRailCollapse.ts) — a layout
// preference, not state anything depends on.
const TAB_LS_KEY = 'sgc.railTab';

function useRailTab(): [RailTab, (t: RailTab) => void] {
  const [tab, setTab] = useState<RailTab>(() => {
    try {
      return localStorage.getItem(TAB_LS_KEY) === 'context' ? 'context' : 'sidecar';
    } catch {
      /* localStorage unavailable (private mode) — default to the first tab */
      return 'sidecar';
    }
  });
  const select = useCallback((t: RailTab) => {
    setTab(t);
    try {
      localStorage.setItem(TAB_LS_KEY, t);
    } catch {
      /* localStorage unavailable — the choice still applies in-session */
    }
  }, []);
  return [tab, select];
}

export function ContextRail({
  collapsed,
  onToggleCollapsed,
  sidecar,
  children,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** The Sidecar tab's content. */
  sidecar: ReactNode;
  /** The Context tab's content — the rail sections, stacked. */
  children: ReactNode;
}) {
  const [tab, selectTab] = useRailTab();

  return (
    <>
      {/* Collapse toggle — a small tab pinned to the chat/rail seam. Desktop
          only (hidden lg:flex); its `right` offset animates in lockstep with
          the rail's width so the tab rides the closing edge. */}
      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-label={collapsed ? 'Show context rail' : 'Hide context rail'}
        aria-expanded={!collapsed}
        className={`absolute top-1/2 z-30 hidden size-7 -translate-y-1/2 items-center justify-center rounded-full border border-hairline-strong bg-surface-thin text-fg-3 transition-[right,color,border-color] duration-300 ease-out hover:border-ember hover:text-ember lg:flex ${
          collapsed ? 'right-2' : 'right-[346px]'
        }`}
      >
        {collapsed ? <PanelRightOpen size={15} /> : <PanelRightClose size={15} />}
      </button>

      {/* Fixed height below lg (it was max-h there): the sidecar thread needs
          a definite box to scroll inside, and a drawer that resizes with the
          active tab would shove the reading column around. */}
      <aside
        className={`relative z-20 flex h-[45vh] w-full flex-col overflow-hidden border-t border-hairline lg:h-full lg:shrink-0 lg:border-t-0 lg:border-l lg:transition-[width,opacity] lg:duration-300 lg:ease-out ${
          collapsed
            ? 'lg:w-0 lg:border-l-0 lg:opacity-0 lg:pointer-events-none'
            : 'lg:w-[360px] lg:opacity-100'
        }`}
      >
        {/* min-w keeps the content from reflowing while the width animates shut. */}
        <div className="flex min-h-0 flex-1 flex-col lg:min-w-[360px]">
          <div role="tablist" aria-label="Rail" className="flex shrink-0 gap-5 border-b border-hairline px-6 pt-[18px]">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`rail-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`rail-panel-${t.id}`}
                onClick={() => selectTab(t.id)}
                className={cn(
                  '-mb-px border-b pb-2.5 font-mono text-[11px] uppercase tracking-[0.18em] transition-colors',
                  tab === t.id
                    ? 'border-ember text-ember'
                    : 'border-transparent text-fg-3 hover:text-fg-1',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div
            role="tabpanel"
            id="rail-panel-sidecar"
            aria-labelledby="rail-tab-sidecar"
            className={cn('min-h-0 flex-1 flex-col pt-4', tab === 'sidecar' ? 'flex' : 'hidden')}
          >
            {sidecar}
          </div>
          <div
            role="tabpanel"
            id="rail-panel-context"
            aria-labelledby="rail-tab-context"
            className={cn(
              'sal-scroll min-h-0 flex-1 flex-col gap-7 overflow-y-auto px-6 pt-[26px] pb-8',
              tab === 'context' ? 'flex' : 'hidden',
            )}
          >
            {children}
          </div>
        </div>
      </aside>
    </>
  );
}
