const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('competitor', Object.fromEntries(
  ['start', 'status', 'list', 'resume', 'cancel', 'export'].map(name => [name, (...args) => ipcRenderer.invoke(`competitor-${name}`, ...args)])
));
