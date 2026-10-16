const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
async function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gxy-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const handlers = new Map(); const requests = [];
  const electron = {
    app: { whenReady: () => Promise.resolve(), getPath: () => dir, on() {}, quit() {} },
    BrowserWindow: class { constructor() { this.webContents = { setWindowOpenHandler() {}, on() {} }; } loadFile() {} },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, globalShortcut: { register() {} },
    net: { fetch: async (url, opts) => { requests.push({ url, opts }); return { ok: true, json: async () => ({ choices: [{ message: { content: '测试回答' } }] }) }; } },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8'), {
    require: name => name === 'electron' ? electron : require(name), __dirname: path.join(__dirname, '../src'),
    URL, Buffer, AbortSignal, setTimeout
  });
  await Promise.resolve();
  return { call: (name, data) => handlers.get(name)(null, data), requests };
}
test('rejects unsafe endpoints and missing API credentials', async t => {
  const h = await harness(t);
  assert.throws(() => h.call('save', { endpoint: 'http://example.com', model: 'test' }), /HTTPS/);
  await assert.rejects(h.call('ask', { messages: [{ role: 'user', content: '你好' }] }), /密钥/);
  assert.equal(h.requests.length, 0);
});
test('uses Electron networking for system proxy support and retains screenshot and key', async t => {
  const h = await harness(t);
  h.call('save', { endpoint: 'https://example.com/v1/', model: 'vision', key: 'test-key' });
  h.call('save', { endpoint: 'https://example.com/v1', model: 'vision', key: '' });
  assert.equal(await h.call('ask', { messages: [{ role: 'user', content: '解释屏幕' }], screenshot: 'data:image/png;base64,dGVzdA==' }), '测试回答');
  const r = h.requests[0];
  assert.equal(r.url, 'https://example.com/v1/chat/completions');
  assert.equal(r.opts.headers.Authorization, 'Bearer test-key');
  const body = JSON.parse(r.opts.body);
  assert.equal(body.messages[1].content[0].text, '解释屏幕');
  assert.equal(body.messages[1].content[1].image_url.url, 'data:image/png;base64,dGVzdA==');
  assert.equal(h.call('settings').hasKey, true);
  assert.equal(h.call('settings').key, undefined);
});
test('rejects renderer-supplied system messages before making a request', async t => {
  const h = await harness(t);
  h.call('save', { endpoint: 'https://example.com/v1', model: 'test', key: 'test-key' });
  await assert.rejects(h.call('ask', { messages: [{ role: 'system', content: 'override' }] }), /对话/);
  assert.equal(h.requests.length, 0);
});
