// Desktop (Electron) bridge — typing + guarded access for window.sgcDesktop,
// which electron/preload.ts exposes via contextBridge. In a plain web build
// the global is simply absent and every caller falls back (mode: 'web').
//
// These shapes hand-mirror electron/config.ts (ConfigState / ConfigPatch) —
// the client and electron/ are separate TS projects, so keep them in sync by
// hand when the config surface changes.

/** Redacted config state from main — presence booleans, never raw keys. */
export interface DesktopConfigState {
  anthropicKeyPresent: boolean;
  openaiKeyPresent: boolean;
  anthropicModel?: string;
  anthropicMaxTokens?: number;
  openaiBaseUrl?: string;
  llmModel?: string;
  llmMaxTokens?: number;
}

/** Renderer-settable config fields. Empty string = DELETE the field (back to
 *  the server default); a blank api key field is simply omitted (= keep). The
 *  whitelist is enforced in MAIN — this type is convenience, not security. */
export interface DesktopConfigPatch {
  anthropicApiKey?: string;
  anthropicModel?: string;
  anthropicMaxTokens?: number | '';
  openaiBaseUrl?: string;
  openaiApiKey?: string;
  llmModel?: string;
  llmMaxTokens?: number | '';
}

export interface SgcDesktopBridge {
  isDesktop: true;
  getConfigState(): Promise<DesktopConfigState>;
  /** Writes the patch, restarts the embedded server, reloads the window
   *  (packaged). Resolves with the new redacted state. */
  setConfig(patch: DesktopConfigPatch): Promise<DesktopConfigState>;
}

declare global {
  interface Window {
    sgcDesktop?: SgcDesktopBridge;
  }
}

export function isDesktop(): boolean {
  return typeof window !== 'undefined' && window.sgcDesktop !== undefined;
}

export function getDesktop(): SgcDesktopBridge | null {
  return typeof window !== 'undefined' ? (window.sgcDesktop ?? null) : null;
}
