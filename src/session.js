const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const S = require('./stitch');
class ShotSession {
  constructor(directory) { this.directory = directory; fs.mkdirSync(directory, { recursive: true }); this.frames = []; this.version = 0; this.saved = false; this.cache = null; }
  read(frame) { return S.decode(fs.readFileSync(path.join(this.directory, frame.file))); }
  changed() { this.version++; this.saved = false; this.cache = null; }
  append(buffer) {
    const image = S.decode(buffer);
    if (this.frames.length >= 40) throw new Error('最多采集40屏，请结束并分批保存');
    if (this.frames.reduce((n, f) => n + f.width * f.height, 0) + image.width * image.height > 80000000) throw new Error('原始截图总量超过8000万像素，请结束并分批保存');
    let match = { overlap: 0, reason: '第一屏' };
    if (this.frames.length) {
      const last = this.frames.at(-1);
      if (last.width !== image.width || last.height !== image.height) throw new Error('截图尺寸变化，请结束本次采集后重新选择区域');
      match = S.matchOverlap(this.read(last), image);
      if (match.duplicate) return { added: false, note: match.reason };
    }
    const id = randomUUID(), file = `${id}.png`;
    fs.writeFileSync(path.join(this.directory, file), buffer);
    this.frames.push({ id, file, width: image.width, height: image.height, overlap: match.overlap, note: match.reason, manual: false });
    this.changed(); return { added: true, note: match.reason };
  }
  align(id, overlap) {
    const index = this.frames.findIndex(f => f.id === id), frame = this.frames[index];
    if (index < 1 || !Number.isInteger(overlap) || overlap < 0 || overlap >= frame.height) throw new Error('重叠像素必须介于0和当前屏高度减1之间');
    frame.overlap = overlap; frame.manual = true; frame.note = '已手动校准'; this.changed();
  }
  remove(id) {
    const index = this.frames.findIndex(f => f.id === id);
    if (index < 0) throw new Error('截图不存在');
    const [removed] = this.frames.splice(index, 1);
    fs.rmSync(path.join(this.directory, removed.file), { force: true });
    if (this.frames[index]) {
      if (index === 0) Object.assign(this.frames[0], { overlap: 0, manual: false, note: '第一屏' });
      else {
        const match = S.matchOverlap(this.read(this.frames[index - 1]), this.read(this.frames[index]));
        Object.assign(this.frames[index], { overlap: match.duplicate ? null : match.overlap, manual: false, note: match.duplicate ? '与上一屏相同，请删除重复屏' : match.reason });
      }
    }
    this.changed();
  }
  output() { if (!this.cache) this.cache = S.compose(this.frames, f => this.read(f)); return this.cache; }
  metadata() {
    let size = null, issue = '';
    try { size = S.dimensions(this.frames); } catch (error) { issue = error.message; }
    return { frames: this.frames.map(({ file, ...rest }) => rest), version: this.version, saved: this.saved, size, issue };
  }
  destroy() { fs.rmSync(this.directory, { recursive: true, force: true }); this.cache = null; this.frames = []; }
}
module.exports = { ShotSession };
