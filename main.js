'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { loadCatalog, publicCatalog } = require('./engine/catalog');
const { BackupStore } = require('./engine/backups');
const { TweakEngine } = require('./engine/tweaks');
const { isAdmin, runPowerShell } = require('./engine/exec');

app.setName('MuraTweaks');

// Two instances applying registry changes at the same time is asking for
// trouble; the second launch just focuses the first window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.focus();
});

let window = null;
let engine = null;
let store = null;
let catalog = null;

function reply(promise) {
  return Promise.resolve(promise)
    .then((value) => ({ ok: true, ...value }))
    .catch((error) => ({ ok: false, error: error.message, code: error.code || null }));
}

function createWindow() {
  window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: '#0b0f14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.loadFile(path.join(__dirname, 'renderer/index.html'));
  window.once('ready-to-show', () => window.show());

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) || url.startsWith('ms-settings:')) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
}

function relaunchElevated() {
  const exe = process.execPath;
  const args = process.argv.slice(1);
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const argumentList = args.length ? ` -ArgumentList @(${args.map(quote).join(',')})` : '';
  const script = `Start-Process -FilePath ${quote(exe)}${argumentList} -Verb RunAs`;
  spawn('powershell', ['-NoProfile', '-Command', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  setTimeout(() => app.quit(), 400);
}

app.whenReady().then(() => {
  if (!gotLock) return;
  catalog = loadCatalog(path.join(__dirname, 'data/catalog.json'));
  store = new BackupStore(app.getPath('userData'));
  engine = new TweakEngine({
    catalog,
    store,
    adminCheck: isAdmin,
    env: {
      openUrl: (url) => shell.openExternal(url),
      openPath: (target) => shell.openPath(target),
      openApp: (file, args) => {
        spawn(file, args || [], { detached: true, stdio: 'ignore' }).unref();
        return Promise.resolve();
      }
    }
  });

  ipcMain.handle('app:boot', () => reply((async () => ({
    version: app.getVersion(),
    admin: await isAdmin(),
    catalog: publicCatalog(catalog),
    applied: engine.listApplied(),
    backups: store.list()
  }))()));

  ipcMain.handle('tweak:apply', (_event, id) => reply(engine.apply(id)));
  ipcMain.handle('tweak:revert', (_event, id) => reply(engine.revert(id)));
  ipcMain.handle('backups:restore', (_event, id) => reply(engine.restoreBackup(id)));
  ipcMain.handle('backups:applied', () => reply((async () => ({ applied: engine.listApplied() }))()));
  ipcMain.handle('backups:list', () => reply((async () => ({ backups: store.list() }))()));
  ipcMain.handle('backups:undoAll', () => reply((async () => ({ results: await engine.undoAll() }))()));
  ipcMain.handle('backups:restorePoint', () => reply(runPowerShell(
    "Checkpoint-Computer -Description 'MuraTweaks' -RestorePointType 'MODIFY_SETTINGS' -ErrorAction Stop; Write-Output 'OK'",
    { timeoutMs: 10 * 60 * 1000 }
  )));
  ipcMain.handle('backups:openRestore', () => reply((async () => {
    spawn('rstrui.exe', [], { detached: true, stdio: 'ignore' }).unref();
  })()));
  ipcMain.handle('app:relaunchElevated', () => { relaunchElevated(); return { ok: true }; });
  ipcMain.handle('app:isAdmin', () => reply((async () => ({ admin: await isAdmin() }))()));

  ipcMain.handle('window:minimize', () => window && window.minimize());
  ipcMain.handle('window:toggleMaximize', () => {
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  ipcMain.handle('window:close', () => window && window.close());

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
