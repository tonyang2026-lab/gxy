const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PNG } = require('pngjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const S = require('../src/stitch');
const { ShotSession } = require('../src/session');
const { cropBounds } = require('../src/geometry');
function documentImage(width = 160, height = 1000) {
  const img = new PNG({ width, height }); let seed = 582173;
  for (let i = 0; i < img.data.length; i += 4) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; img.data[i] = seed & 255; img.data[i + 1] = seed >>> 8 & 255; img.data[i + 2] = seed >>> 16 & 255; img.data[i + 3] = 255; }
  return img;
}
function slice(img, y, height) { const out = new PNG({ width: img.width, height }); img.data.copy(out.data, 0, y * img.width * 4, (y + height) * img.width * 4); return out; }
const encode = image => PNG.sync.write(image);
function session(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(),'longshot-test-')); const s = new ShotSession(dir); t.after(() => s.destroy()); return s; }
test('finds exact overlap and composes a lossless continuous PNG', () => {
  const doc = documentImage(), a = slice(doc,0,300), b = slice(doc,140,300);
  const match = S.matchOverlap(a,b); assert.equal(match.overlap,160);
  const frames = [{ width:160,height:300,overlap:0,image:a },{width:160,height:300,overlap:match.overlap,image:b}];
  const output = S.decode(S.compose(frames,f=>f.image));
  assert.equal(output.height,440); assert.deepEqual(output.data,slice(doc,0,440).data);
});
test('identical frames are ignored and unrelated or repeating frames require review', () => {
  const doc = documentImage(); const a = slice(doc,0,300);
  assert.equal(S.matchOverlap(a,slice(doc,0,300)).duplicate,true);
  assert.equal(S.matchOverlap(a,slice(doc,600,300)).overlap,null);
  const repeat = documentImage(160,50), long = new PNG({width:160,height:700});
  for(let y=0;y<700;y++) repeat.data.copy(long.data,y*160*4,(y%50)*160*4,(y%50+1)*160*4);
  const result = S.matchOverlap(slice(long,0,300),slice(long,25,300));
  assert.equal(result.overlap,null); assert.match(result.reason,/多个/);
});
test('session saves frames, ignores duplicates and deletes with new adjacent alignment', t => {
  const s=session(t), doc=documentImage();
  s.append(encode(slice(doc,0,300))); s.append(encode(slice(doc,100,300))); s.append(encode(slice(doc,200,300)));
  assert.equal(s.append(encode(slice(doc,200,300))).added,false);
  assert.equal(s.frames.length,3); s.remove(s.frames[1].id);
  assert.equal(s.frames[1].overlap,100);
  const output=S.decode(s.output()); assert.deepEqual(output.data,slice(doc,0,500).data);
  assert.equal(s.metadata().size.height,500); s.remove(s.frames[0].id); assert.equal(s.frames[0].overlap,0);
});
test('unmatched frames cannot export until manually aligned, including zero-overlap append', t => {
  const s=session(t), doc=documentImage();
  s.append(encode(slice(doc,0,300))); s.append(encode(slice(doc,600,300)));
  assert.equal(s.metadata().size,null); assert.throws(()=>s.output(),/校准/);
  s.align(s.frames[1].id,0); assert.equal(S.decode(s.output()).height,600);
  assert.equal(s.frames[1].manual,true);
  assert.throws(()=>s.align(s.frames[1].id,300),/重叠/);
  assert.throws(()=>s.align(s.frames[1].id,-1),/重叠/);
  assert.throws(()=>s.align(s.frames[0].id,1),/重叠/);
});
test('validates size and output budget before allocating a long image', () => {
  assert.throws(()=>S.dimensions([]),/没有/);
  assert.throws(()=>S.dimensions([{width:4000,height:10000,overlap:0},{width:4000,height:10000,overlap:100}]),/超过/);
  assert.throws(()=>S.dimensions([{width:1,height:20000,overlap:0},{width:1,height:20000,overlap:0}]),/超过/);
  assert.throws(()=>S.decode(Buffer.from('not png')));
});
test('screen selection maps to physical image pixels at multiple DPI scales', () => {
  assert.deepEqual(cropBounds({x:100,y:200,width:400,height:300},{width:1280,height:720},{width:1920,height:1080}),{x:150,y:300,width:600,height:450});
  assert.deepEqual(cropBounds({x:0,y:0,width:1280,height:720},{width:1280,height:720},{width:2560,height:1440}),{x:0,y:0,width:2560,height:1440});
  assert.throws(()=>cropBounds({x:-2,y:0,width:200,height:200},{width:1280,height:720},{width:1920,height:1080}),/范围/);
});
