const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, Tray, Menu, nativeImage, dialog } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ShotSession } = require('./session');
const { cropBounds } = require('./geometry');
const { createWindowsScroller } = require('./windows-scroll');
const { runAuto } = require('./auto-capture');
let main, overlay, tray, session, display, region, frozen, phase = 'idle', message = '', selecting = false, capturePromise = null;
let autoSettings = { automatic: false, ticks: 2, settle: 1200 }, autoAbort = null, autoPromise = null, autoDriver = null, finishing = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const CAPTURE_KEY = 'CommandOrControl+Shift+1', FINISH_KEY = 'CommandOrControl+Shift+2';
function state() { return { phase, message, ...(session ? session.metadata() : { frames: [], version: 0, saved: false, size: null, issue: '尚未采集' }) }; }
function trustedMain(event) { if (event.sender !== main.webContents) throw new Error('无效窗口'); }
function updateTray() {
  if (!tray) return;
  tray.setToolTip(`长截图 · ${session?.frames.length || 0}屏 · ${message}`.slice(0, 120));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `已采集 ${session?.frames.length || 0} 屏`, enabled: false },
    { label: '采集下一屏（Ctrl+Shift+1）', enabled: phase === 'capturing' && !autoSettings.automatic, click: () => capture() },
    { label: '结束采集并预览（Ctrl+Shift+2）', enabled: phase === 'capturing', click: () => finish() },
    { label: '显示工具', enabled: phase !== 'selecting', click: () => phase === 'capturing' ? finish() : main.show() },
    { type: 'separator' }, { label: '退出', click: () => main.close() }
  ]));
}
function note(text) { message = text; updateTray(); }
function releaseKeys() { globalShortcut.unregister(CAPTURE_KEY); globalShortcut.unregister(FINISH_KEY); }
async function snapshot(selected) {
  const actual = screen.getAllDisplays().find(d => d.id === selected.id);
  if (!actual || JSON.stringify(actual.bounds) !== JSON.stringify(selected.bounds) || actual.scaleFactor !== selected.scaleFactor) throw new Error('显示器设置已变化，请结束采集后重新选择');
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(selected.bounds.width * selected.scaleFactor), height: Math.round(selected.bounds.height * selected.scaleFactor) } });
  const source = sources.find(s => s.display_id === String(selected.id));
  if (!source || source.thumbnail.isEmpty()) throw new Error('无法读取屏幕，请检查系统录屏权限');
  return source.thumbnail;
}
function crop(image) {
  return image.crop(cropBounds(region, display.bounds, image.getSize())).toPNG();
}
function cancelSelection() {
  if (overlay && !overlay.isDestroyed()) overlay.close();
  overlay = null; frozen = null; phase = 'idle'; selecting = false; main.show(); note('已取消区域选择');
}
async function start(id, settings = {}) {
  if (phase === 'capturing' || phase === 'selecting' || selecting) throw new Error('已有采集正在进行');
  if (session?.frames.length && !session.saved) {
    const answer = await dialog.showMessageBox(main, { type: 'question', message: '当前长截图尚未保存。开始新采集会丢弃这些截图。', buttons: ['返回保存', '丢弃并继续'], defaultId: 0, cancelId: 0 });
    if (answer.response !== 1) return state();
  }
  autoSettings = { automatic: settings.automatic === true, ticks: Number(settings.ticks ?? 2), settle: Number(settings.settle ?? 1200) };
  if (![1,2,3].includes(autoSettings.ticks) || ![800,1200,2000].includes(autoSettings.settle)) throw new Error('滚动幅度或等待时间无效');
  selecting = true;
  try {
    display = screen.getAllDisplays().find(d => String(d.id) === String(id));
    if (!display) throw new Error('请选择有效显示器');
    phase = 'selecting'; main.hide(); await pause(350);
    frozen = await snapshot(display);
    overlay = new BrowserWindow({ ...display.bounds, fullscreen: true, frame: false, resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true, backgroundColor: '#111827', webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    overlay.on('closed', () => { if (phase === 'selecting') { phase = 'idle'; frozen = null; selecting = false; main.show(); note('区域选择已关闭'); } });
    await overlay.loadFile(path.join(__dirname, 'selection.html'));
    note('请拖动选择正文区域'); return state();
  } catch (error) { cancelSelection(); throw error; }
}
async function select(value) {
  if (phase !== 'selecting' || !frozen || !value || ['x','y','width','height'].some(key => !Number.isFinite(value[key])) || value.x < 0 || value.y < 0 || value.width < 80 || value.height < 80 || value.x + value.width > display.bounds.width + 1 || value.y + value.height > display.bounds.height + 1) throw new Error('选择区域无效，请重新框选');
  let next;
  try {
    region = value;
    next = new ShotSession(fs.mkdtempSync(path.join(os.tmpdir(), 'longshot-')));
    next.append(crop(frozen));
    if (session) session.destroy(); session = next;
    phase = 'capturing'; selecting = false; overlay.close(); overlay = null; frozen = null;
    const captureKey = globalShortcut.register(CAPTURE_KEY, () => capture());
    const finishKey = globalShortcut.register(FINISH_KEY, () => finish());
    if (autoSettings.automatic) {
      note('即将自动滚动，请不要移动鼠标；Ctrl+Shift+2 或移动鼠标停止');
      beginAuto();
    } else note(captureKey && finishKey ? '第1屏已采集，向下滚动后按 Ctrl+Shift+1；Ctrl+Shift+2 结束' : '快捷键被占用，请用系统托盘菜单采集和结束');
    return state();
  } catch (error) { if (next && next !== session) next.destroy(); releaseKeys(); cancelSelection(); throw error; }
}
function capture() {
  if (phase !== 'capturing' || autoSettings.automatic || finishing || capturePromise) return capturePromise;
  capturePromise = (async () => {
    try {
      await pause(250);
      const result = session.append(crop(await snapshot(display)));
      note(`${session.frames.length}屏 · ${result.note}`);
    } catch (error) { note(error.message); }
  })().finally(() => { capturePromise = null; });
  return capturePromise;
}
function review(reason) {
  if (phase === 'closing') return;
  phase = 'review'; finishing = false; releaseKeys(); note(reason || '采集结束，请检查拼接结果'); main.show(); main.focus();
}
function beginAuto() {
  autoAbort = new AbortController(); autoDriver = createWindowsScroller();
  const controller = autoAbort, driver = autoDriver;
  const physical = point => screen.dipToScreenPoint(point);
  const leftTop = physical({ x: Math.round(display.bounds.x + region.x + 2), y: Math.round(display.bounds.y + region.y + 2) });
  const rightBottom = physical({ x: Math.round(display.bounds.x + region.x + region.width - 2), y: Math.round(display.bounds.y + region.y + region.height - 2) });
  const center = physical({ x: Math.round(display.bounds.x + region.x + region.width / 2), y: Math.round(display.bounds.y + region.y + region.height / 2) });
  const work = runAuto({
    driver, bounds: { x: center.x, y: center.y, left: leftTop.x, top: leftTop.y, right: rightBottom.x, bottom: rightBottom.y },
    ticks: autoSettings.ticks, settle: autoSettings.settle, signal: controller.signal,
    shot: async () => crop(await snapshot(display)),
    baseline: () => fs.readFileSync(path.join(session.directory, session.frames.at(-1).file)),
    append: buffer => {
      const result = session.append(buffer), last = session.frames.at(-1);
      if (last.overlap === null) return { ...result, unaligned: true };
      if (!session.metadata().size) { session.remove(last.id); return { ...result, limit: true }; }
      return { ...result, limit: session.frames.length >= 40 };
    },
    progress: text => note(`自动采集 ${session.frames.length} 屏 · ${text}`)
  });
  autoPromise = work;
  work.then(reason => {
    if (autoPromise === work) autoPromise = null;
    if (autoDriver === driver) autoDriver = null;
    if (!finishing && phase === 'capturing') review(reason);
  }).catch(error => { if (!finishing && phase === 'capturing') review(error.message); });
}
async function finish() {
  if (phase !== 'capturing' || finishing) return;
  finishing = true; releaseKeys(); autoAbort?.abort();
  if (autoPromise) await autoPromise;
  if (capturePromise) await capturePromise;
  review('采集已停止，请检查拼接结果');
}
function resized(buffer, width = 1000, height = 6000) {
  const image = nativeImage.createFromBuffer(buffer), size = image.getSize(), factor = Math.min(1, width / size.width, height / size.height);
  return image.resize({ width: Math.max(1, Math.round(size.width * factor)), height: Math.max(1, Math.round(size.height * factor)) }).toDataURL();
}
function editable() { if (!session || ['capturing','selecting'].includes(phase)) throw new Error('请先结束采集'); }
app.whenReady().then(() => {
  main = new BrowserWindow({ width: 1060, height: 820, minWidth: 740, minHeight: 560, title: '长截图工具', autoHideMenuBar: true, backgroundColor: '#f3f6fc', webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  main.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  main.webContents.on('will-navigate', event => event.preventDefault());
  main.loadFile(path.join(__dirname, 'index.html'));
  const pixels = Buffer.alloc(16 * 16 * 4);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const i = (y * 16 + x) * 4, white = (x === 4 || x === 11) && y >= 3 && y <= 12 || (y === 3 || y === 12) && x >= 4 && x <= 11; pixels[i] = white ? 255 : 222; pixels[i + 1] = white ? 255 : 100; pixels[i + 2] = white ? 255 : 52; pixels[i + 3] = 255; }
  tray = new Tray(nativeImage.createFromBitmap(pixels, { width: 16, height: 16 }));
  tray.on('double-click', () => phase === 'capturing' ? finish() : main.show()); updateTray();
  main.on('close', event => {
    if (session?.frames.length && !session.saved && dialog.showMessageBoxSync(main, { type: 'question', message: '截图尚未保存，退出会丢弃本次截图。', buttons: ['返回', '退出'], defaultId: 0, cancelId: 0 }) === 0) event.preventDefault();
    else { phase = 'closing'; autoAbort?.abort(); autoDriver?.terminate(); releaseKeys(); if (overlay && !overlay.isDestroyed()) overlay.close(); }
  });
  ipcMain.handle('longshot:displays', event => { trustedMain(event); return screen.getAllDisplays().map(d => ({ id: String(d.id), label: `${d.label || '显示器 ' + d.id} · ${d.bounds.width}×${d.bounds.height} · ${Math.round(d.scaleFactor * 100)}%` })); });
  ipcMain.handle('longshot:start', (event, id, settings) => { trustedMain(event); return start(id, settings); });
  ipcMain.handle('longshot:state', event => { trustedMain(event); return state(); });
  ipcMain.handle('longshot:selection', event => { if (!overlay || event.sender !== overlay.webContents || !frozen) throw new Error('选择窗口已失效'); return { image: frozen.toDataURL(), automatic: autoSettings.automatic }; });
  ipcMain.handle('longshot:select', (event, value) => { if (!overlay || event.sender !== overlay.webContents) throw new Error('无效窗口'); return select(value); });
  ipcMain.handle('longshot:cancelSelection', event => { if (overlay && event.sender === overlay.webContents) cancelSelection(); });
  ipcMain.handle('longshot:align', (event, id, overlap) => { trustedMain(event); editable(); session.align(id, overlap); return state(); });
  ipcMain.handle('longshot:remove', (event, id) => { trustedMain(event); editable(); session.remove(id); return state(); });
  ipcMain.handle('longshot:preview', event => { trustedMain(event); editable(); return { image: resized(session.output()), ...session.metadata() }; });
  ipcMain.handle('longshot:framePair', (event, id) => { trustedMain(event); editable(); const index = session.frames.findIndex(f => f.id === id); if (index < 1) throw new Error('第一屏无需校准'); const frame = session.frames[index], previous = session.frames[index - 1]; return { previous: resized(fs.readFileSync(path.join(session.directory, previous.file)), 500, 1300), current: resized(fs.readFileSync(path.join(session.directory, frame.file)), 500, 1300), height: frame.height, overlap: frame.overlap }; });
  ipcMain.handle('longshot:save', async event => {
    trustedMain(event); editable(); const current = session, version = current.version, buffer = current.output();
    const result = await dialog.showSaveDialog(main, { defaultPath: `长截图-${Date.now()}.png`, filters: [{ name: 'PNG 图片', extensions: ['png'] }] });
    if (result.canceled || !result.filePath) return null;
    await fs.promises.writeFile(result.filePath, buffer);
    if (session === current && current.version === version) current.saved = true;
    note(`已保存：${result.filePath}`);
    return result.filePath;
  });
});
app.on('will-quit', () => { autoAbort?.abort(); autoDriver?.terminate(); globalShortcut.unregisterAll(); if (session) session.destroy(); if (tray) tray.destroy(); });
app.on('window-all-closed', () => app.quit());
