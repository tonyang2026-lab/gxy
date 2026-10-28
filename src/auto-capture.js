const { decode } = require('./stitch');
function nearSame(first, second) {
  const a = decode(first), b = decode(second);
  if (a.width !== b.width || a.height !== b.height) return false;
  let changed = 0, count = 0, sum = 0;
  const dy = Math.max(1, Math.floor(a.height / 60)), dx = Math.max(1, Math.floor(a.width / 64));
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
  let unchanged = 0;
  try {
    if (!await wait(650,signal)) return '已停止自动滚动';
    await driver.begin(bounds,signal);
    for (let step=0;step<120;step++) {
      if (signal.aborted) return '已停止自动滚动';
      await driver.step(ticks,signal);
      if (!await wait(settle,signal)) return '已停止自动滚动';
      let previous=await shot(), stable=null;
      for (let attempt=0;attempt<8;attempt++) {
        if (!await wait(220,signal)) return '已停止自动滚动';
        const current=await shot();
        if (equal(previous,current)) {stable=current;break;}
        previous=current;
      }
      if (!stable) return '页面一直在变化，已停止。请等待加载结束，或排除动画后重新采集';
      if (signal.aborted) return '已停止自动滚动';
      if (equal(baseline(),stable)) {
        if (++unchanged>=3) return '连续3次滚动后画面未变化，已停止（可能到底部或目标不支持滚动）';
        progress('画面未变化，正在确认是否到底部');continue;
      }
      unchanged=0;
      const result=append(stable);
      progress(result.note);
      if (result.unaligned) return '未找到可靠重叠，自动滚动已停止。请在预览中校准，或减小滚动幅度后重试';
      if (result.limit) return '已达到截图数量或长图尺寸限制，请分批保存';
    }
    return '已达到自动滚动次数限制，请检查并保存';
  } catch(error) { return signal.aborted?'已停止自动滚动':error.message; }
  finally { try { await driver.close(); } catch {} }
}
module.exports = { runAuto, nearSame, abortableWait };
