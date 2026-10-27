'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mura', Object.freeze({
  boot: () => ipcRenderer.invoke('app:boot'),
  applyTweak: (id) => ipcRenderer.invoke('tweak:apply', id),
  revertTweak: (id) => ipcRenderer.invoke('tweak:revert', id),
  restoreBackup: (id) => ipcRenderer.invoke('backups:restore', id),
  listApplied: () => ipcRenderer.invoke('backups:applied'),
  listBackups: () => ipcRenderer.invoke('backups:list'),
  undoAll: () => ipcRenderer.invoke('backups:undoAll'),
  createRestorePoint: () => ipcRenderer.invoke('backups:restorePoint'),
  openSystemRestore: () => ipcRenderer.invoke('backups:openRestore'),
  relaunchElevated: () => ipcRenderer.invoke('app:relaunchElevated'),
  isAdmin: () => ipcRenderer.invoke('app:isAdmin'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
  close: () => ipcRenderer.invoke('window:close')
}));
