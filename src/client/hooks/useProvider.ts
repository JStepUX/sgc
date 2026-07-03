import { useCallback, useEffect, useState } from 'react';
import type { ProviderId } from '../lib/api';
import { PROVIDER_LS_KEY, PROVIDER_ORDER, type HealthResponse } from '../lib/provider';
import {
  getDesktop,
  type DesktopConfigPatch,
  type DesktopConfigState,
} from '../lib/desktop';

// --- Provider switcher: which model backs Sal. Persisted to localStorage,
// reconciled with /api/health on mount (coerced to an available provider). The
// client only ever holds the TOKEN; the server owns keys/URLs. Also owns the
// ProviderConfigModal's state (D5): which provider is being configured, and the
// redacted desktop config used to pre-fill it. ---

export interface ProviderState {
  health: HealthResponse | null;
  provider: ProviderId;
  selectProvider: (p: ProviderId) => void;
  configureProvider: (p: ProviderId) => void;
  saveProviderConfig: (patch: DesktopConfigPatch) => Promise<void>;
  providerConfig: { provider: ProviderId; fromUnconfigured: boolean } | null;
  closeProviderConfig: () => void;
  desktopConfigState: DesktopConfigState | null;
}

export function useProvider(): ProviderState {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [provider, setProvider] = useState<ProviderId>(() => {
    try {
      const stored = localStorage.getItem(PROVIDER_LS_KEY);
      if (stored === 'anthropic' || stored === 'openai') return stored;
    } catch {
      /* localStorage unavailable (private mode) — fall through to default */
    }
    // LOCAL by default: a truly-empty fresh install (no key, no base URL)
    // should not land on a provider that needs a paid key. The health
    // reconcile below still coerces to whatever IS available, so existing
    // web deploys with only Anthropic configured are unaffected.
    return 'openai';
  });

  // --- Provider config modal (D5): which provider is being configured, and
  // whether the modal was opened from an UNCONFIGURED row (the intercept) —
  // in that case a successful save pre-sets the stored provider so the
  // post-restart reload lands on it. ---
  const [providerConfig, setProviderConfig] = useState<{
    provider: ProviderId;
    fromUnconfigured: boolean;
  } | null>(null);
  // Redacted desktop config (presence booleans, models, token caps) for
  // pre-filling the modal. Stays null on web — the modal renders .env
  // guidance instead of a save path.
  const [desktopConfigState, setDesktopConfigState] = useState<DesktopConfigState | null>(null);
  useEffect(() => {
    getDesktop()
      ?.getConfigState()
      .then(setDesktopConfigState)
      .catch((err) => console.warn('desktop config state fetch failed:', err));
  }, []);

  // --- Provider health: fetch /api/health once on mount to learn which
  // providers are configured + the boot default, then coerce the active
  // provider to one that is actually available. If the stored/initial provider
  // is unavailable (e.g. LOCAL selected on an Anthropic-only deploy), fall back
  // to the server default, else the first available provider. Best-effort: if
  // health fails the chip simply shows what we have and the server still
  // resolves a default per turn. ---
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/health');
        if (!res.ok) return;
        const data = (await res.json()) as HealthResponse;
        if (cancelled || !data?.providers) return;
        setHealth(data);
        setProvider((current) => {
          if (data.providers[current]?.available) return current;
          if (data.default && data.providers[data.default]?.available) return data.default;
          const firstAvailable = PROVIDER_ORDER.find((p) => data.providers[p]?.available);
          return firstAvailable ?? current;
        });
      } catch {
        /* health unreachable — keep the localStorage/initial provider */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Commit a provider selection: update state + persist. Applies to the NEXT
  // turn (the turn runner reads `provider` at call time). Guarded against
  // picking an unavailable provider at the call site (chip disables them).
  const selectProvider = useCallback((p: ProviderId) => {
    setProvider(p);
    try {
      localStorage.setItem(PROVIDER_LS_KEY, p);
    } catch {
      /* localStorage unavailable — selection still applies in-session */
    }
  }, []);

  const configureProvider = useCallback(
    (p: ProviderId) => {
      setProviderConfig({
        provider: p,
        fromUnconfigured: !(health?.providers[p]?.available ?? false),
      });
    },
    [health],
  );

  const saveProviderConfig = useCallback(
    async (patch: DesktopConfigPatch) => {
      const bridge = getDesktop();
      if (!bridge || !providerConfig) return;
      if (providerConfig.fromUnconfigured) {
        // The save below reloads the window (packaged) — persist the intent
        // first so the reload's provider init lands on the newly configured
        // provider. The health reconcile still corrects it if the save left
        // the provider unavailable.
        try {
          localStorage.setItem(PROVIDER_LS_KEY, providerConfig.provider);
        } catch {
          /* localStorage unavailable — reload falls back to defaults */
        }
      }
      // Packaged: main writes config → restarts the fork → reloads the window;
      // execution usually ends with the reload. Dev-mode Electron: the write
      // lands for the next packaged run and we just refresh local state.
      const next = await bridge.setConfig(patch);
      setDesktopConfigState(next);
      setProviderConfig(null);
    },
    [providerConfig],
  );

  const closeProviderConfig = useCallback(() => setProviderConfig(null), []);

  return {
    health,
    provider,
    selectProvider,
    configureProvider,
    saveProviderConfig,
    providerConfig,
    closeProviderConfig,
    desktopConfigState,
  };
}
