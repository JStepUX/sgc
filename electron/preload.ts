// Preload — the ONLY bridge between the renderer and main. Ships as
// dist/electron/preload.cjs (CJS by requirement: sandbox:true preloads must be
// CJS, and the root package.json is "type":"module" so a .js emit would load
// as ESM and fail with "contextBridge is not defined").
//
// The surface is deliberately tiny: redacted config state out, whitelisted
// config patches in. Key material never crosses into the renderer — the
// browser layer holds presence booleans only (D2's "key not in the browser
// layer", preserved). The patch whitelist itself is enforced in MAIN
// (config.whitelistPatch), not here — this file is typing + transport.

import { contextBridge, ipcRenderer } from 'electron';
import type { ConfigPatch, ConfigState } from './config';

const sgcDesktop = {
  isDesktop: true as const,
  getConfigState: (): Promise<ConfigState> => ipcRenderer.invoke('sgc:getConfigState'),
  setConfig: (patch: ConfigPatch): Promise<ConfigState> =>
    ipcRenderer.invoke('sgc:setConfig', patch),
};

export type SgcDesktopApi = typeof sgcDesktop;

contextBridge.exposeInMainWorld('sgcDesktop', sgcDesktop);
