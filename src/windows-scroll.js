const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
function createWindowsScroller() {
  let child, serial = 0, pending = new Map(), stopped = false;
  function readable(message) {
    const known = [ ['User input detected', '检测到键盘或鼠标按键操作'], ['Mouse moved', '检测到鼠标移动'], ['Target window changed', '目标窗口已切换或被遮挡'], ['Target window moved', '目标窗口移动或尺寸变化'], ['Cannot focus target', '无法激活目标窗口，请用手动模式'], ['Selection spans multiple', '选区跨越多个窗口，请只选择一个滚动区域'], ['Windows rejected', 'Windows 拒绝模拟滚轮，请使用手动模式'] ];
    return known.find(([text]) => String(message).includes(text))?.[1] || message;
  }
  function fail(error) { for (const value of pending.values()) value.reject(error); pending.clear(); }
  function initialize() {
    if (process.platform !== 'win32') throw new Error('自动滚动仅支持 Windows，请切换手动模式');
    const code = fs.readFileSync(path.join(__dirname, 'windows-scroll.ps1'), 'utf8');
    child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', code], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    child.on('error', () => fail(new Error('无法启动 Windows 滚动助手，请使用手动模式')));
    child.on('exit', () => { stopped = true; fail(new Error('滚动助手已退出，请使用手动模式')); });
    child.stderr.on('data', () => { /* Fail through the timeout or process exit; never evaluate helper output. */ });
    child.stdin.on('error', () => fail(new Error('无法连接滚动助手')));
    readline.createInterface({ input: child.stdout }).on('line', line => {
      try { const result = JSON.parse(line), item = pending.get(result.id); if (!item) return; pending.delete(result.id); result.ok ? item.resolve(result.result) : item.reject(new Error(`自动滚动已停止：${readable(result.error)}`)); } catch { /* Ignore non-protocol PowerShell output. */ }
    });
  }
  async function send(action, data, signal, timeout = 5000) {
    if (signal?.aborted) throw new Error('已停止自动滚动');
    if (!child) initialize();
    if (stopped) throw new Error('滚动助手不可用');
    const id = ++serial; let timer, abort;
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(() => { pending.delete(id); stopped = true; child.kill(); reject(new Error('滚动助手响应超时，请使用手动模式')); }, timeout);
        abort = () => { pending.delete(id); reject(new Error('已停止自动滚动')); };
        signal?.addEventListener('abort', abort, { once: true });
        child.stdin.write(JSON.stringify({ id, action, ...data }) + '\n', error => { if (error) { pending.delete(id); reject(new Error('无法发送滚动指令')); } });
      });
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  return {
    terminate() { stopped = true; if (child) child.kill(); fail(new Error('已停止自动滚动')); },
    begin: (bounds, signal) => send('begin', bounds, signal, 20000),
    step: (ticks, signal) => send('step', { ticks }, signal),
    async close() { if (!child) return; try { if (!stopped) await send('end', {}, null, 1000); } catch {} finally { stopped = true; child.kill(); fail(new Error('滚动助手已关闭')); } }
  };
}
module.exports = { createWindowsScroller };
