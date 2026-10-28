const { PNG } = require('pngjs');
const MAX_PIXELS = 40000000;
const MAX_HEIGHT = 30000;
function check(image) {
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 || image.width * image.height > 12000000 || image.data.length !== image.width * image.height * 4) throw new Error('截图尺寸无效或单张超过1200万像素');
}
function decode(buffer) { const image = PNG.sync.read(buffer); check(image); return image; }
function signature(image) {
  const columns = 24, rows = new Float32Array(image.height * columns);
  for (let y = 0; y < image.height; y++) for (let col = 0; col < columns; col++) {
    const x = Math.min(image.width - 1, Math.floor(image.width * (.06 + .88 * col / (columns - 1))));
    let sum = 0;
    for (let dx = -1; dx <= 1; dx++) {
      const i = (y * image.width + Math.max(0, Math.min(image.width - 1, x + dx))) * 4;
      sum += image.data[i] * .299 + image.data[i + 1] * .587 + image.data[i + 2] * .114;
    }
    rows[y * columns + col] = sum / 3;
  }
  return rows;
}
function matchOverlap(previous, current) {
  check(previous); check(current);
  if (previous.width !== current.width || previous.height !== current.height) return { overlap: null, reason: '截图尺寸发生变化，请重新选择区域' };
  if (previous.data.equals(current.data)) return { duplicate: true, overlap: previous.height, reason: '画面未变化，本屏已忽略' };
  const height = previous.height, minOverlap = Math.max(32, Math.ceil(height * .12));
  if (height < 64) return { overlap: null, reason: '区域太矮，无法可靠自动匹配，请手动校准' };
  const a = signature(previous), b = signature(current), candidates = [];
  for (let shift = 8; shift <= height - minOverlap; shift++) {
    const overlap = height - shift, step = Math.max(1, Math.floor(overlap / 40));
    let error = 0, count = 0, activeRows = 0;
    for (let y = 0; y < overlap; y += step) {
      let min = 255, max = 0;
      for (let col = 0; col < 24; col++) {
        const left = a[(y + shift) * 24 + col], right = b[y * 24 + col];
        error += Math.abs(left - right); count++;
        min = Math.min(min, right); max = Math.max(max, right);
      }
      if (max - min > 18) activeRows++;
    }
    if (activeRows >= 6) candidates.push({ overlap, shift, error: error / count });
  }
  candidates.sort((x, y) => x.error - y.error || y.overlap - x.overlap);
  const best = candidates[0];
  if (!best || best.error > 6) return { overlap: null, reason: '未找到可靠重叠；可能滚动过多、向上滚动或包含固定栏' };
  if (candidates.some(other => Math.abs(other.shift - best.shift) > 4 && other.error <= best.error + .2)) return { overlap: null, reason: '内容重复或过于相似，存在多个对齐位置，请手动校准' };
  return { overlap: best.overlap, error: Math.round(best.error * 100) / 100, reason: '已自动对齐，请检查预览' };
}
function dimensions(frames) {
  if (!frames.length) throw new Error('没有截图');
  const width = frames[0].width;
  let height = 0;
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index], overlap = index === 0 ? 0 : frame.overlap;
    if (frame.width !== width || !Number.isInteger(overlap) || overlap < 0 || overlap >= frame.height) throw new Error(`第${index + 1}屏需要校准重叠区域`);
    height += frame.height - overlap;
  }
  if (height > MAX_HEIGHT || width * height > MAX_PIXELS) throw new Error('长图超过限制（3万像素高或4000万像素），请删除部分屏次后分批保存');
  return { width, height };
}
function compose(frames, readImage) {
  const size = dimensions(frames), output = new PNG(size);
  let y = 0;
  frames.forEach((frame, index) => {
    const image = readImage(frame), overlap = index ? frame.overlap : 0;
    check(image);
    if (image.width !== frame.width || image.height !== frame.height) throw new Error('原始截图尺寸与记录不符');
    const bytes = image.width * 4;
    image.data.copy(output.data, y * bytes, overlap * bytes);
    y += image.height - overlap;
  });
  return PNG.sync.write(output);
}
module.exports = { decode, matchOverlap, compose, dimensions, MAX_PIXELS, MAX_HEIGHT };
