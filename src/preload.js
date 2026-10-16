const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pet', {
  hide: () => ipcRenderer.invoke('hide'),
  quit: () => ipcRenderer.invoke('quit')
});
