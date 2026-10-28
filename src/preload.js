const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('longshot', Object.fromEntries(
  ['displays', 'start', 'state', 'preview', 'framePair', 'align', 'remove', 'save', 'saveParts', 'saveOriginals', 'selection', 'select', 'cancelSelection'].map(name => [name, (...args) => ipcRenderer.invoke(`longshot:${name}`, ...args)])
));
