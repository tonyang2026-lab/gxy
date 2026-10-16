const { app, BrowserWindow, ipcMain, globalShortcut } = require('electron');
const path = require('node:path');
let win;
app.whenReady().then(() => {
  win = new BrowserWindow({ width: 390, height: 760, minWidth: 300, minHeight: 470, frame: false, transparent: true, alwaysOnTop: true, resizable: true, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  globalShortcut.register('CommandOrControl+Shift+Space', () => { win.show(); win.focus(); });
  ipcMain.handle('hide', () => win.hide());
  ipcMain.handle('quit', () => app.quit());
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
