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
  async exportOriginals(directory) {
    const files = [];
    for (let index = 0; index < this.frames.length; index++) {
      const frame = this.frames[index], name = `原始第${String(index + 1).padStart(3, '0')}屏.png`;
      await fs.promises.copyFile(path.join(this.directory, frame.file), path.join(directory, name));
      files.push({ file: name, width: frame.width, height: frame.height, overlap: frame.overlap });
    }
    await fs.promises.writeFile(path.join(directory, '截图清单.json'), JSON.stringify({ frames: files }, null, 2));
    return files;
  }
  async exportParts(directory, limits) {
    const files = [], parts = S.planParts(this.frames, limits);
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index], name = `长图第${String(index + 1).padStart(3, '0')}段.png`;
      const buffer = S.composePart(part, frame => this.read(frame));
      await fs.promises.writeFile(path.join(directory, name), buffer);
      files.push({ file: name, ...S.pngDimensions(buffer) });
    }
    await fs.promises.writeFile(path.join(directory, '分段清单.json'), JSON.stringify({ originalSize: S.dimensions(this.frames, false), parts: files }, null, 2));
    return files;
  }
  metadata() {
    let size = null, logicalSize = null, partsCount = 0, issue = '';
    try { logicalSize = S.dimensions(this.frames, false); partsCount = S.planParts(this.frames).length; } catch {}
    try { size = S.dimensions(this.frames); } catch (error) { issue = error.message; }
    return { frames: this.frames.map(({ file, ...rest }) => rest), version: this.version, saved: this.saved, size, logicalSize, partsCount, issue };
  }
  destroy() { fs.rmSync(this.directory, { recursive: true, force: true }); this.cache = null; this.frames = []; }
}
module.exports = { ShotSession };
