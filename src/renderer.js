const $ = id => document.getElementById(id), api = window.longshot;
let latest = null, updating = false, previewToken = 0, editingId = null, alignmentHeight = 0;
function status(text) { $('status').textContent = text; }
async function preview() {
  const token = ++previewToken;
  $('preview').hidden = true;
  if (!latest?.size || latest.phase === 'capturing' || latest.phase === 'selecting') { $('preview-message').textContent = latest?.issue || '结束采集后，这里会显示长图。'; if (latest?.logicalSize && !latest.size) $('preview-message').textContent = '完整长图超过单张限制，全部已采屏次已保留，请点击“分段导出”。'; return; }
  $('preview-message').textContent = '正在生成预览…';
  try {
    const result = await api.preview();
    if (token !== previewToken) return;
    $('preview').src = result.image; $('preview').hidden = false;
    $('preview-message').textContent = `完整导出：${result.size.width}×${result.size.height} 像素；预览缩略图：${result.previewSize.width}×${result.previewSize.height} 像素。保存的是完整图，请检查接缝。`;
  } catch (error) { if (token === previewToken) $('preview-message').textContent = error.message; }
}
function update(value) {
  const changed = !latest || latest.version !== value.version || latest.phase !== value.phase;
  latest = value;
  const busy = ['capturing','selecting'].includes(value.phase) || value.exporting;
  $('start').disabled = busy; $('display').disabled = busy; $('save').disabled = busy || !value.size;
  $('save-parts').disabled = busy || !value.logicalSize;
  $('save-originals').disabled = busy || !value.frames.length;
  $('count').textContent = value.frames.length;
  const fullSize = value.logicalSize || value.size;
  $('size').textContent = fullSize ? `完整尺寸 ${fullSize.width} × ${fullSize.height} 像素${value.partsCount > 1 ? '（需分段）' : ''}` : '';
  status(value.message || '准备好了，先选择区域。');
  if (!changed) return;
  $('frames').replaceChildren();
  value.frames.forEach((frame, index) => {
    const li = document.createElement('li'); li.className = frame.overlap === null ? 'warning' : '';
    const title = document.createElement('strong'); title.textContent = `第 ${index + 1} 屏 · ${frame.width}×${frame.height}`;
    const info = document.createElement('p'); info.textContent = `${frame.note}${index ? ` · 重叠 ${frame.overlap === null ? '待确认' : frame.overlap + ' 像素，新增 ' + (frame.height - frame.overlap) + ' 像素'}` : ''}`;
    li.append(title, info);
    if (index) {
      const adjust = document.createElement('button'); adjust.textContent = '校准重叠'; adjust.disabled = busy; adjust.onclick = () => align(frame.id); li.append(adjust);
    }
    const remove = document.createElement('button'); remove.textContent = '删除'; remove.disabled = busy;
    remove.onclick = async () => { try { update(await api.remove(frame.id)); } catch (error) { status(error.message); } };
    li.append(remove); $('frames').append(li);
  });
  preview();
}
async function align(id) {
  try {
    const pair = await api.framePair(id); editingId = id; alignmentHeight = pair.height;
    $('previous-image').src = pair.previous; $('current-image').src = pair.current;
    $('overlap-range').max = $('overlap-number').max = pair.height - 1;
    syncOverlap(pair.overlap ?? Math.floor(pair.height / 2));
    $('align-dialog').showModal();
  } catch (error) { status(error.message); }
}
function syncOverlap(value) {
  const n = Math.max(0, Math.min(alignmentHeight - 1, Math.round(Number(value) || 0)));
  $('overlap-range').value = $('overlap-number').value = n;
  $('overlap-shade').style.height = `${n / alignmentHeight * 100}%`;
}
$('overlap-range').oninput = event => syncOverlap(event.target.value);
$('overlap-number').oninput = event => syncOverlap(event.target.value);
$('close-align').onclick = () => $('align-dialog').close();
$('confirm-align').onclick = async () => { try { const value = await api.align(editingId, Number($('overlap-number').value)); $('align-dialog').close(); update(value); } catch (error) { status(error.message); } };
$('start').onclick = async () => {
  $('start').disabled = true;
  try { update(await api.start($('display').value, { automatic: $('automatic').checked, ticks: Number($('scroll-ticks').value), settle: Number($('scroll-wait').value) })); } catch (error) { status(error.message); $('start').disabled = false; }
};
$('save').onclick = async () => {
  $('save').disabled = true;
  try { const file = await api.save(); if (file) status(`已保存：${file}`); } catch (error) { status(error.message); }
  finally { $('save').disabled = !latest?.size; }
};
for (const [id, method] of [['save-parts', 'saveParts'], ['save-originals', 'saveOriginals']]) {
  $(id).onclick = async () => {
    $(id).disabled = true;
    try { const result = await api[method](); if (result) status(`已保存 ${result.count} 张PNG：${result.folder}`); }
    catch (error) { status(error.message); }
    finally { await poll(); }
  };
}
async function poll() {
  if (updating || $('align-dialog').open) return;
  updating = true;
  try { update(await api.state()); } catch (error) { status(error.message); }
  finally { updating = false; }
}
(async () => {
  try {
    const displays = await api.displays();
    displays.forEach(d => { const option = document.createElement('option'); option.value = d.id; option.textContent = d.label; $('display').append(option); });
    if (!displays.length) throw new Error('未检测到显示器');
    await poll();
  } catch (error) { status(error.message); $('start').disabled = true; }
})();
setInterval(poll, 1000);
