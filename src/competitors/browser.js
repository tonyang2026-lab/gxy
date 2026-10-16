const { HOSTS } = require('./parse');
function createBrowserReader({ BrowserWindow, session }) {
  let window = null, marketplace = null;
  function allowed(url, host) {
    try { const u = new URL(url); return u.protocol === 'https:' && u.hostname === host && !u.username && !u.password && (!u.port || u.port === '443'); } catch { return false; }
  }
  async function request(url, market) {
    const host = HOSTS[market];
    if (!host || !allowed(url, host)) throw new Error('采集窗口只允许访问所选 Amazon 站点');
    if (!window || window.isDestroyed() || marketplace !== market) {
      if (window && !window.isDestroyed()) window.close();
      marketplace = market;
      window = new BrowserWindow({ width: 1100, height: 800, title: 'Amazon 采集窗口 · 遇到验证请手动操作后回主窗口继续', autoHideMenuBar: true, webPreferences: { session: session.fromPartition(`competitor-browser-${market}`), nodeIntegration: false, contextIsolation: true, sandbox: true } });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const guard = (event, destination) => { if (!allowed(destination, host)) event.preventDefault(); };
      window.webContents.on('will-navigate', guard);
      window.webContents.on('will-redirect', guard);
      window.webContents.on('will-attach-webview', event => event.preventDefault());
    }
    const current = window;
    current.show();
    let timer;
    try {
      await Promise.race([
        current.loadURL(url),
        new Promise((_, reject) => { timer = setTimeout(() => { if (!current.isDestroyed()) current.webContents.stop(); reject(new Error('浏览器加载超时，请检查采集窗口后再继续')); }, 30000); })
      ]);
      if (!allowed(current.webContents.getURL(), host)) throw new Error('采集页面离开了所选站点，已停止');
      const code = `document.documentElement.outerHTML`;
      const html = await current.webContents.executeJavaScript(code);
      return { ok: true, text: async () => html };
    } catch (error) {
      throw new Error(`采集窗口未能读取页面：${error.message}`);
    } finally { clearTimeout(timer); }
  }
  return { request, close() { if (window && !window.isDestroyed()) window.close(); } };
}
module.exports = { createBrowserReader };
