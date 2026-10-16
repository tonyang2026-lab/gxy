const { app, BrowserWindow, ipcMain, session, dialog } = require('electron');
const path = require('node:path');
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1080, height: 800, minWidth: 680, minHeight: 560, title: 'ASIN 竞品采集与规则评分', backgroundColor: '#f6f8fc', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  require('./competitors/service').register({ app, ipcMain, session, dialog, win, BrowserWindow });
});
app.on('window-all-closed', () => app.quit());
