// Electron main — process supervision only. No memory logic, no provider
// logic: all three memory tiers stay client-side and the server stays the
// dumb env-reading proxy it is in dev. Main's whole job is (1) fork the
// frozen server with env derived from sgc-config.json, (2) load the server's
// OWN origin so the renderer's relative /api fetches and static SPA serving
// work unchanged, (3) apply config changes by restart + reload (D3/D5).

import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { initConfig, readConfig, redactConfig, whitelistPatch, writeConfig } from './config';
import * as serverManager from './serverManager';

const DEV_URL = 'http://localhost:5555';

let win: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  // Vite copies public/ into dist/client/, so the icon ships inside the asar.
  const iconPath = path.join(__dirname, '../client/sal_logo.ico');
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 880,
    minHeight: 600,
    // --color-ground — avoids a white flash before index.css paints.
    backgroundColor: '#0a0907',
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.on('closed', () => {
    if (win === window) win = null;
  });
  return window;
}

function originFor(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function boot(): Promise<void> {
  win = createWindow();
  if (app.isPackaged) {
    try {
      const handle = await serverManager.start();
      await win.loadURL(originFor(handle.port));
    } catch (err) {
      dialog.showErrorBox('SGC failed to start', String(err));
      app.quit();
    }
  } else {
    // Dev: the existing `npm run dev` concurrently flow already runs the Vite
    // client (:5555) and the Express server (:3000) — spawn NOTHING here.
    await win.loadURL(DEV_URL);
    win.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  initConfig(path.join(app.getPath('userData'), 'sgc-config.json'));

  ipcMain.handle('sgc:getConfigState', () => redactConfig(readConfig()));

  // Save = write + restart + reload. The restart is the apply mechanism — the
  // server reads its env once at boot, exactly as in dev (D3 generalized to
  // all provider config by D5). The patch is whitelisted HERE in main, so the
  // renderer can never steer llmProvider/serverPort/process supervision.
  //
  // A failed restart must REJECT, not return state: the config write landed,
  // but the app would be running with no embedded server — returning success
  // would close the modal over a dead app. The rejection crosses the IPC
  // boundary to the modal, which stays open and shows the error; retrying is
  // safe because the bridge is IPC, not HTTP, and restart() starts clean.
  // (boot() keeps its dialog — there's no renderer UI yet at that point.)
  ipcMain.handle('sgc:setConfig', async (_event, patch: unknown) => {
    writeConfig(whitelistPatch(patch));
    if (app.isPackaged) {
      const handle = await serverManager.restart();
      win?.loadURL(originFor(handle.port));
    }
    // Dev-mode Electron has no embedded server — the write still lands in
    // sgc-config.json for the next packaged run; the dev server keeps reading
    // .env. Nothing to restart.
    return redactConfig(readConfig());
  });

  void boot();
});

app.on('will-quit', () => {
  void serverManager.stop();
});

app.on('window-all-closed', () => {
  app.quit();
});
