import { useCallback, useState } from 'react';

// Context-rail collapse state — persisted so the layout choice survives a reload.
const RAIL_LS_KEY = 'sgc.railCollapsed';

// --- Context rail (right sidebar) collapse. Desktop-only affordance: there the
// rail is a fixed-width column competing for horizontal space; on mobile it's a
// bottom drawer that caps its own height, so the toggle is hidden below lg. ---
export function useRailCollapse(): { railCollapsed: boolean; toggleRail: () => void } {
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(RAIL_LS_KEY) === '1';
    } catch {
      /* localStorage unavailable (private mode) — default to expanded */
      return false;
    }
  });

  const toggleRail = useCallback(() => {
    setRailCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(RAIL_LS_KEY, next ? '1' : '0');
      } catch {
        /* localStorage unavailable — collapse still applies in-session */
      }
      return next;
    });
  }, []);

  return { railCollapsed, toggleRail };
}
