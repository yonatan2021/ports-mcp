const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('portManager', Object.freeze({
  applyUpdate: () => ipcRenderer.invoke('app-update'),
}));
