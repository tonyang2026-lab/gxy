const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pet', Object.fromEntries(['hide', 'quit', 'settings', 'save', 'capture', 'ask'].map(name => [name, (...args) => ipcRenderer.invoke(name, ...args)])));
