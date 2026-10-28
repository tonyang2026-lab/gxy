const { decode } = require('./stitch');
function nearSame(first, second) {
  let a, b;
  if (first?.fingerprint && second?.fingerprint) {
    if (first.width !== second.width || first.height !== second.height) return false;
    a = { width: 96, height: 60, data: first.fingerprint };
    b = { width: 96, height: 60, data: second.fingerprint };
    if (a.data.length !== 96 * 60 * 4 || b.data.length !== a.data.length) throw new Error('稳定检测小图尺寸不符');
  } else { a = decode(first); b = decode(second); }
  if (a.width !== b.width || a.height !== b.height) return false;
  let changed = 0, count = 0, sum = 0;
  const dy = Math.max(1, Math.floor(a.height / 60)), dx = Math.max(1, Math.floor(a.width / 96));
  for (let y = 0; y < a.height; y += dy) for (let x = 0; x < a.width; x += dx) {
    const i = (y*a.width+x)*4;
    const difference = (Math.abs(a.data[i]-b.data[i])+Math.abs(a.data[i+1]-b.data[i+1])+Math.abs(a.data[i+2]-b.data[i+2]))/3;
    sum += difference; count++; if (difference > 12) changed++;
  }
  return changed/count <= .003 && sum/count <= .35;
}
function abortableWait(ms, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const stop=()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);resolve(false);};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve(true);},ms);
    signal?.addEventListener('abort',stop,{once:true});
  });
}
async function runAuto({ driver, bounds, ticks, settle, signal, shot, baseline, append, wait=abortableWait, equal=nearSame, progress=()=>{} }) {
  let unchanged = 0, currentTicks = Math.min(ticks, 2), shortSteps = 0;
  try {
    if (!await wait(650,signal)) return '已停止自动滚动';
    await driver.begin(bounds,signal);
    for (let step=0;step<120;step++) {
      if (signal.aborted) return '已停止自动滚动';
      await driver.step(currentTicks,signal);
      if (!await wait(settle,signal)) return '已停止自动滚动';
      await driver.check?.(signal);
      let previous=await shot(), stable=null, confirmations=0;
      for (let attempt=0;attempt<12;attempt++) {
        if (!await wait(100,signal)) return '已停止自动滚动';
        const current=await shot();
        if (equal(previous,current)) { if (++confirmations >= 2) {stable=current;break;} }
        else confirmations=0;
        previous=current;
      }
      if (!stable) return '页面一直在变化，已停止。请等待加载结束，或排除动画后重新采集';
      if (signal.aborted) return '已停止自动滚动';
      if (equal(baseline(),stable)) {
        if (++unchanged>=3) return '连续3次滚动后画面未变化，已停止（可能到底部或目标不支持滚动）';
        progress('画面未变化，正在确认是否到底部');continue;
      }
      await driver.check?.(signal);
      if (signal.aborted) return '已停止自动滚动';
      unchanged=0;
      const result=append(stable);
      progress(result.note);
      if (result.unaligned) return '未找到可靠重叠，自动滚动已停止。请在预览中校准，或减小滚动幅度后重试';
      if (result.limit) return '已达到截图数量或长图尺寸限制，请分批保存';
      if (result.advance > 0 && result.height > 0) {
        const ratio = result.advance / result.height;
        if (ratio > .5) { currentTicks = Math.max(1, currentTicks - 1); shortSteps = 0; }
        else if (ratio < .2) { if (++shortSteps >= 2) { currentTicks = Math.min(ticks, currentTicks + 1); shortSteps = 0; } }
        else shortSteps = 0;
      }
    }
    return '已达到自动滚动次数限制，请检查并保存';
  } catch(error) { return signal.aborted?'已停止自动滚动':error.message; }
  finally { try { await driver.close(); } catch {} }
}
module.exports = { runAuto, nearSame, abortableWait };
