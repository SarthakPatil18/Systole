// main.js — Electron main process.
//
// Keeps three jobs, nothing more:
//   1. create the window and wire the SmartSpectra IPC bridge
//   2. point the native library at the packaged copy (when packaged)
//   3. grant camera permission to this window only, and to nothing else
//
// Copy of the structure used by Presage's own electron-quickstart, trimmed to
// what Systole needs.

'use strict';

const path = require('path');
const { app, BrowserWindow, session } = require('electron');

// In a packaged build the native runtime closure ships as an extra resource at
// `resources/smartspectra/` — not inside app.asar, because a .dylib cannot be
// loaded from within an asar archive. Set this BEFORE requiring the binding.
if (app.isPackaged && !process.env.SMARTSPECTRA_CAPI_PATH) {
  const LIB = {
    darwin: 'libsmartspectra_capi.dylib',
    win32: 'smartspectra_capi.dll',
    linux: 'libsmartspectra_capi.so',
  }[process.platform];
  if (LIB) {
    process.env.SMARTSPECTRA_CAPI_PATH = path.join(process.resourcesPath, 'smartspectra', LIB);
  }
}

const { bindSmartSpectraIpc } = require('@smartspectra/node-sdk/main');

const DIAGNOSTICS = process.env.SYSTOLE_DIAGNOSTICS === '1';

// Convenience for demos and CI: `SMARTSPECTRA_API_KEY=... npm start` pre-fills
// the key field. It is passed to this one window as a query param that never
// leaves the process, and is never written to disk.
const PREFILLED_KEY = process.env.SMARTSPECTRA_API_KEY || '';

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 660,
    backgroundColor: '#0b0a10',
    title: 'Systole',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: require.resolve('@smartspectra/node-sdk/preload'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // One private IPC channel per window; the SDK instance is created in this
  // process and destroyed automatically when the window closes.
  bindSmartSpectraIpc(win);

  // This app only ever renders its own bundled page.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  const query = PREFILLED_KEY ? { apiKey: PREFILLED_KEY } : {};
  win.loadFile(path.join(__dirname, 'index.html'), { query });

  if (DIAGNOSTICS) win.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(() => {
  app.setName('Systole');

  // Grant the camera — and only the camera, and only to our bundled page. The
  // SDK calls getUserMedia({ video: ... }) with no audio, so a request that
  // also asks for the microphone is denied rather than silently widened.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = (details && details.requestingUrl) || (wc && wc.getURL()) || '';
    const mediaTypes = (details && details.mediaTypes) || [];
    const cameraOnly = mediaTypes.length === 1 && mediaTypes[0] === 'video';
    callback(permission === 'media' && cameraOnly && url.startsWith('file://'));
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
