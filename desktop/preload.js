const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('portManager', Object.freeze({
  isElectron: true,
  platform: process.platform,
  applyUpdate: () => ipcRenderer.invoke('app-update'),
}));
