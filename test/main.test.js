const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PNG } = require('pngjs');
const { ShotSession } = require('../src/session');
function image(offset = 0, width = 160, height = 300) {
  const p = new PNG({ width, height });
  for(let y=0;y<p.height;y++) for(let x=0;x<p.width;x++) {
    const i=(y*p.width+x)*4; let n=Math.imul((y+offset)*719+x*107+8, 1597334677)>>>0;
    p.data[i]=n&255; p.data[i+1]=n>>>8&255; p.data[i+2]=n>>>16&255; p.data[i+3]=255;
  }
  return p;
}
function native(p, counters) {
  return { isEmpty:()=>false, getSize:()=>({width:p.width,height:p.height}), toPNG:()=>{if(counters)counters.encodes++;return PNG.sync.write(p);}, toBitmap:()=>Buffer.from(p.data), toDataURL:()=>`data:image/png;base64,${PNG.sync.write(p).toString('base64')}`, resize:size=>{const out=new PNG(size);for(let y=0;y<size.height;y++)for(let x=0;x<size.width;x++){const i=(Math.floor(y*p.height/size.height)*p.width+Math.floor(x*p.width/size.width))*4;p.data.copy(out.data,(y*size.width+x)*4,i,i+4);}return native(out,counters);}, crop:r=>{const out=new PNG({width:r.width,height:r.height}); PNG.bitblt(p,out,r.x,r.y,r.width,r.height,0,0);return native(out,counters);} };
}
async function harness(t, occupied = false, automatic = false, initialImage = image()) {
  let autoOptions;
  const autoMock = { runAuto: options => { autoOptions = options; return new Promise(resolve => options.signal.addEventListener('abort', () => resolve('已停止'), { once: true })); } };
  const counters={encodes:0};
  const windows=[], ipc=new Map(), shortcuts=new Map(), appEvents=new Map(), sessions=[];
  const output=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'longshot-main-')),'saved.png');
  t.after(()=>{appEvents.get('will-quit')?.();fs.rmSync(path.dirname(output),{recursive:true,force:true});});
  const current = { image:initialImage };
  class Window {
    constructor(options){this.options=options;this.events=new Map();this.webContents={setWindowOpenHandler(){},on(){}};windows.push(this);}
    on(name,fn){this.events.set(name,fn);}
    loadFile(){return Promise.resolve();}
    hide(){this.hidden=true;}
    show(){this.hidden=false;}
    focus(){}
    close(){this.destroyed=true;this.events.get('closed')?.();}
    isDestroyed(){return !!this.destroyed;}
  }
  class Session extends ShotSession {constructor(dir){super(dir);sessions.push(this);}}
  const electron={
    app:{whenReady:()=>Promise.resolve(),on:(name,fn)=>appEvents.set(name,fn),quit(){}},BrowserWindow:Window,
    ipcMain:{handle:(name,fn)=>ipc.set(name,fn)},screen:{dipToScreenPoint:point=>point,getAllDisplays:()=>[{id:1,bounds:{x:0,y:0,width:160,height:300},scaleFactor:1}]},
    desktopCapturer:{getSources:async()=>[{display_id:'1',thumbnail:native(current.image,counters)}]},
    globalShortcut:{register:(name,fn)=>{if(occupied)return false;shortcuts.set(name,fn);return true;},unregister:name=>shortcuts.delete(name),unregisterAll:()=>shortcuts.clear()},
    Tray:class {setToolTip(text){this.text=text;}setContextMenu(){}on(){}destroy(){}},Menu:{buildFromTemplate:items=>items},
    nativeImage:{createFromBitmap(){return {};},createFromBuffer:b=>native(PNG.sync.read(b),counters)},
    dialog:{showMessageBox:async()=>({response:1}),showMessageBoxSync:()=>1,showSaveDialog:async()=>({filePath:output,canceled:false}),showOpenDialog:async()=>({filePaths:[path.dirname(output)],canceled:false})}
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/main.js'),'utf8'),{
    require:name=>name==='electron'?electron:name==='./session'?{ShotSession:Session}:name==='./auto-capture'&&automatic?autoMock:name.startsWith('./')?require('../src/'+name.slice(2)):require(name),
    __dirname:path.join(__dirname,'../src'),Buffer,AbortController,setTimeout:callback=>{queueMicrotask(callback);return 0;},clearTimeout(){}
  });
  await Promise.resolve();
  const call=(name,...args)=>ipc.get(`longshot:${name}`)({sender:windows[0].webContents},...args);
  const overlayCall=(name,...args)=>ipc.get(`longshot:${name}`)({sender:windows.at(-1).webContents},...args);
  return {windows,call,overlayCall,shortcuts,current,output,sessions,ipc,counters,getAutoOptions:()=>autoOptions};
}
test('capture selection, global shortcuts, PNG save and cleanup operate as one workflow', async t=>{
  const h=await harness(t);
  assert.equal((await h.call('displays')).length,1);
  await h.call('start','1'); assert.equal(h.windows[0].hidden,true);
  assert.match((await h.overlayCall('selection')).image,/^data:image\/png/);
  await h.overlayCall('select',{x:0,y:0,width:160,height:300});
  assert.equal((await h.call('state')).phase,'capturing');assert.equal((await h.call('state')).frames.length,1);
  h.current.image=image(140);
  await h.shortcuts.get('CommandOrControl+Shift+1')();
  await h.shortcuts.get('CommandOrControl+Shift+2')();
  const review=await h.call('state'); assert.equal(review.phase,'review');assert.equal(review.frames.length,2);assert.equal(h.shortcuts.size,0);assert.equal(h.windows[0].hidden,false);
  assert.equal(review.size.height,440);
  const saved=await h.call('save');assert.equal(saved,h.output);assert.equal(PNG.sync.read(fs.readFileSync(saved)).height,440);
  assert.equal((await h.call('state')).saved,true);
});
test('selection cancel restores main window and does not discard prior capture', async t=>{
  const h=await harness(t);
  await h.call('start','1');await h.overlayCall('cancelSelection');
  assert.equal((await h.call('state')).phase,'idle');assert.equal(h.windows[0].hidden,false);assert.equal(h.sessions.length,0);
});
test('occupied shortcuts leave usable capture with tray fallback and invalid IPC origins are rejected', async t=>{
  const h=await harness(t,true);
  await h.call('start','1');await h.overlayCall('select',{x:0,y:0,width:160,height:300});
  assert.match((await h.call('state')).message,/托盘/);
  assert.throws(()=>h.ipc.get('longshot:state')({sender:{}}),/无效窗口/);
});

test('automatic mode starts with physical bounds and stop returns review without deadlock', async t=>{
  const h=await harness(t,false,true);
  await h.call('start','1',{automatic:true,ticks:1,settle:2000});
  assert.equal((await h.overlayCall('selection')).automatic,true);
  await h.overlayCall('select',{x:0,y:0,width:160,height:300});
  const options=h.getAutoOptions();assert.equal(options.ticks,1);assert.equal(options.settle,2000);
  assert.equal(options.bounds.x,80);assert.equal(options.bounds.y,150);
  await h.shortcuts.get('CommandOrControl+Shift+2')();
  assert.equal(options.signal.aborted,true);assert.equal((await h.call('state')).phase,'review');assert.equal(h.windows[0].hidden,false);
});

test('PNG export uses original pixels even when preview is actually resized',async t=>{
  const original=image(0,1500,300),h=await harness(t,false,false,original);
  await h.call('start','1');await h.overlayCall('select',{x:0,y:0,width:160,height:300});
  await h.shortcuts.get('CommandOrControl+Shift+2')();
  const preview=await h.call('preview');
  assert.equal(preview.previewSize.width,1000);assert.equal(preview.size.width,1500);
  const thumbnail=PNG.sync.read(Buffer.from(preview.image.split(',')[1],'base64'));assert.equal(thumbnail.width,1000);
  await h.call('save');const saved=PNG.sync.read(fs.readFileSync(h.output));
  assert.equal(saved.width,1500);assert.equal(saved.height,300);assert.deepEqual(saved.data,original.data);
});
test('folder exports preserve raw frames and create full-sized segmented PNG',async t=>{
  const h=await harness(t);await h.call('start','1');await h.overlayCall('select',{x:0,y:0,width:160,height:300});
  await h.shortcuts.get('CommandOrControl+Shift+2')();
  const raw=await h.call('saveOriginals');assert.equal(raw.count,1);assert.ok(fs.existsSync(path.join(raw.folder,'原始第001屏.png')));
  const parts=await h.call('saveParts');assert.equal(parts.count,1);assert.equal(PNG.sync.read(fs.readFileSync(path.join(parts.folder,'长图第001段.png'))).height,300);
});
test('automatic capture retains a frame when single-image output exceeds its limit',async t=>{
  const h=await harness(t,false,true);await h.call('start','1',{automatic:true,ticks:1,settle:1200});
  await h.overlayCall('select',{x:0,y:0,width:160,height:300});
  const current=h.sessions[0],metadata=current.metadata.bind(current);
  current.metadata=()=>{const value=metadata();return current.frames.length>=2?{...value,size:null,issue:'单张图片超限'}:value;};
  const result=h.getAutoOptions().append(PNG.sync.write(image(140)));
  assert.equal(current.frames.length,2);assert.notEqual(result.limit,true);assert.match(result.note,/分段导出/);
  await h.shortcuts.get('CommandOrControl+Shift+2')();
});

test('native stability probes do not encode PNG until a full-resolution frame is committed',async t=>{
  const h=await harness(t,false,true);await h.call('start','1',{automatic:true,ticks:2,settle:350});
  await h.overlayCall('select',{x:0,y:0,width:160,height:300});h.current.image=image(140);
  const before=h.counters.encodes,options=h.getAutoOptions(),probe=await options.shot();
  assert.equal(h.counters.encodes,before);assert.equal(probe.fingerprint.length,96*60*4);assert.equal(probe.width,160);assert.equal(probe.height,300);
  options.append(probe);assert.equal(h.counters.encodes,before+1);assert.equal(h.sessions[0].frames[1].width,160);assert.equal(h.sessions[0].frames[1].height,300);
  await h.shortcuts.get('CommandOrControl+Shift+2')();
});
