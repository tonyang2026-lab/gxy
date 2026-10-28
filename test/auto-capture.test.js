const { test }=require('node:test');
const assert=require('node:assert/strict');
const { PNG }=require('pngjs');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const { runAuto,nearSame,abortableWait }=require('../src/auto-capture');
const { ShotSession }=require('../src/session');
function frame(offset) {
  const p=new PNG({width:96,height:200});
  for(let y=0;y<200;y++)for(let x=0;x<96;x++) {let n=Math.imul((y+offset)*719+x*107+8,1597334677)>>>0;const i=(y*96+x)*4;p.data[i]=n&255;p.data[i+1]=n>>>8&255;p.data[i+2]=n>>>16&255;p.data[i+3]=255;}
  return PNG.sync.write(p);
}
function setup(overrides={}) {
  const counts={begin:0,step:0,close:0,shot:0,append:0};const controller=new AbortController();
  const driver={begin:async()=>{counts.begin++;},step:async()=>{counts.step++;},close:async()=>{counts.close++;}};
  const options={driver,bounds:{},ticks:2,settle:1200,signal:controller.signal,wait:async()=>!controller.signal.aborted,shot:async()=>{counts.shot++;return frame(80);},baseline:()=>frame(0),append:()=>{counts.append++;return {note:'ok'};},...overrides};
  return {counts,controller,options};
}
test('automatic scrolling appends stable screens and stops after three unchanged attempts',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'longshot-auto-')),s=new ShotSession(dir);t.after(()=>s.destroy());s.append(frame(0));
  const h=setup();
  h.options.shot=async()=>frame(h.counts.step===1?80:160);
  h.options.baseline=()=>fs.readFileSync(path.join(dir,s.frames.at(-1).file));
  h.options.append=b=>s.append(b);
  const result=await runAuto(h.options);
  assert.match(result,/连续3次/);assert.equal(h.counts.step,5);assert.equal(h.counts.close,1);assert.equal(s.frames.length,3);
  assert.equal(PNG.sync.read(s.output()).height,360);
});
test('stop before beginning does not issue mouse input',async()=>{
  const h=setup();h.controller.abort();const result=await runAuto(h.options);
  assert.match(result,/停止/);assert.equal(h.counts.begin,0);assert.equal(h.counts.step,0);assert.equal(h.counts.close,1);
});
test('stop while waiting after scroll prevents subsequent screenshots and scroll steps',async()=>{
  const h=setup();let waits=0;
  h.options.wait=async()=>{if(++waits===2)h.controller.abort();return !h.controller.signal.aborted;};
  await runAuto(h.options);assert.equal(h.counts.step,1);assert.equal(h.counts.shot,0);assert.equal(h.counts.append,0);assert.equal(h.counts.close,1);
});
test('never captures an unstable animation as a completed new frame',async()=>{
  const h=setup();let offset=40;h.options.shot=async()=>frame(offset++);
  const result=await runAuto(h.options);assert.match(result,/一直在变化/);assert.equal(h.counts.step,1);assert.equal(h.counts.append,0);assert.equal(h.counts.close,1);
});
test('alignment failure and size limits stop instead of scrolling further',async()=>{
  for(const failure of [{unaligned:true},{limit:true}]) {
    const h=setup();h.options.append=()=>failure;
    const result=await runAuto(h.options);assert.match(result,/停止|限制/);assert.equal(h.counts.step,1);assert.equal(h.counts.close,1);
  }
});
test('window/mouse guard failures stop and always release the scroll driver',async()=>{
  const h=setup();h.options.driver.step=async()=>{throw new Error('目标窗口已切换');};
  const result=await runAuto(h.options);assert.match(result,/目标窗口/);assert.equal(h.counts.shot,0);assert.equal(h.counts.close,1);
});
test('tiny blinking pixel changes count as stable but a real scroll does not',()=>{
  const a=frame(0),p=PNG.sync.read(a);p.data[0]^=255;const blink=PNG.sync.write(p);
  assert.equal(nearSame(a,blink),true);assert.equal(nearSame(a,frame(80)),false);
});
test('waiting can be interrupted immediately by stop',async()=>{
  const controller=new AbortController();const waiting=abortableWait(10000,controller.signal);controller.abort();assert.equal(await waiting,false);
});
test('a brief still frame followed by movement is not accepted until two consecutive confirmations',async()=>{
  const h=setup();const sequence=['a','a','b','b','b'];let shots=0,accepted;
  h.options.shot=async()=>sequence[Math.min(shots++,sequence.length-1)];
  h.options.equal=(a,b)=>a===b;h.options.baseline=()=> 'old';h.options.append=value=>{accepted=value;return {limit:true};};
  await runAuto(h.options);assert.equal(accepted,'b');assert.equal(shots,5);
});
test('measured overlap adapts wheel steps gradually and reduces steps after a large jump',async()=>{
  const h=setup();h.options.ticks=3;const ticks=[];let current=0,previous=0,added=0;
  h.options.driver.step=async value=>{ticks.push(value);current++;};h.options.shot=async()=>current;
  h.options.equal=(a,b)=>a===b;h.options.baseline=()=>previous;
  h.options.append=value=>{previous=value;added++;return {advance:added===3?75:10,height:100,limit:added===4};};
  await runAuto(h.options);assert.deepEqual(ticks,[2,2,3,2]);
});
test('small fingerprint probes require PNG encoding only for newly committed screens',async()=>{
  const h=setup();let encoded=0,baseline;
  function probe(offset){
    const buffer=frame(offset),p=PNG.sync.read(buffer),fingerprint=Buffer.alloc(96*60*4);
    for(let y=0;y<60;y++)p.data.copy(fingerprint,y*96*4,Math.floor(y*200/60)*96*4,(Math.floor(y*200/60)+1)*96*4);
    return {width:96,height:200,fingerprint,toPNG:()=>{encoded++;return buffer;}};
  }
  baseline=probe(0);const next=probe(80);h.options.baseline=()=>baseline;h.options.shot=async()=>next;
  h.options.append=sample=>{sample.toPNG();baseline=sample;return {};};
  await runAuto(h.options);assert.equal(encoded,1);assert.equal(h.counts.step,4);
});
test('window changing after stability checks prevents committing that frame',async()=>{
  const h=setup();let checks=0;h.options.driver.check=async()=>{if(++checks===2)throw new Error('目标窗口已切换');};
  const result=await runAuto(h.options);assert.match(result,/目标窗口/);assert.equal(h.counts.append,0);assert.equal(h.counts.close,1);
});

test('small scroll setting remains the maximum even after many short advances',async()=>{
  const h=setup();h.options.ticks=1;const ticks=[];let current=0,previous=0,added=0;
  h.options.driver.step=async value=>{ticks.push(value);current++;};h.options.shot=async()=>current;h.options.equal=(a,b)=>a===b;h.options.baseline=()=>previous;
  h.options.append=value=>{previous=value;return {advance:10,height:100,limit:++added===5};};
  await runAuto(h.options);assert.deepEqual(ticks,[1,1,1,1,1]);
});
