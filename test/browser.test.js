const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserReader } = require('../src/competitors/browser');
const P = require('../src/competitors/parse');
function setup() {
  const windows = [];
  class Window {
    constructor(options) {
      this.options = options; this.handlers = {}; this.destroyed = false; this.html = '<html><span id="productTitle">Product</span></html>';
      this.webContents = {
        setWindowOpenHandler: h => { this.popup = h; },
        on: (name, h) => { this.handlers[name] = h; },
        getURL: () => this.url,
        stop() {},
        executeJavaScript: async code => { assert.equal(code, 'document.documentElement.outerHTML'); return this.html; }
      }; windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    close() { this.destroyed = true; }
    show() {}
    async loadURL(url) { this.url = url; }
  }
  return { windows, reader: createBrowserReader({ BrowserWindow: Window, session: { fromPartition: name => ({ name }) } }) };
}
test('visible collection reuses isolated session and restricts navigation', async () => {
  const { windows, reader } = setup();
  const response = await reader.request('https://www.amazon.ae/dp/B000000001', 'AE');
  assert.match(await response.text(), /productTitle/);
  assert.equal(windows[0].options.webPreferences.nodeIntegration, false);
  assert.equal(windows[0].options.webPreferences.sandbox, true);
  assert.equal(windows[0].options.webPreferences.preload, undefined);
  assert.equal(windows[0].popup().action, 'deny');
  let prevented = false;
  windows[0].handlers['will-navigate']({ preventDefault() { prevented = true; } }, 'https://evil.example/');
  assert.equal(prevented, true);
  await reader.request('https://www.amazon.ae/s?k=test', 'AE'); assert.equal(windows.length, 1);
  await assert.rejects(reader.request('https://www.amazon.com/', 'AE'), /所选/);
  reader.close(); assert.equal(windows[0].destroyed, true);
});
test('validation HTML remains a stop condition, no automatic verification click', async () => {
  const { windows, reader } = setup();
  await reader.request('https://www.amazon.ae/dp/B000000001', 'AE');
  windows[0].html = '<form action="/errors_page/validateCaptcha"><button>متابعة التسوق.</button></form>';
  const response = await reader.request('https://www.amazon.ae/dp/B000000001', 'AE');
  const html = await response.text();
  assert.throws(() => P.detail(html), /手动完成验证/);
});
