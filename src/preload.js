const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pet', {
  hide: () => ipcRenderer.invoke('hide'),
  quit: () => ipcRenderer.invoke('quit'),
  competitor: Object.fromEntries(['start', 'status', 'list', 'resume', 'cancel', 'export'].map(name => [name, (...args) => ipcRenderer.invoke(`competitor-${name}`, ...args)]))
});
