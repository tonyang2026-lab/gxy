const $ = id => document.getElementById(id);
let messages = [], screenshot = null, busy = false;
const petElement = document.querySelector('.pet');
let replyTimer;
function petState(state) {
  clearTimeout(replyTimer);
  petElement.classList.remove('thinking', 'replying');
  if (state) petElement.classList.add(state);
  $('pet-caption').textContent = state === 'thinking' ? '正在分析，特工出动…' : state === 'replying' ? '情报已送达！' : '小星特工，随时待命。';
  if (state === 'replying') replyTimer = setTimeout(() => petState(''), 2400);
}
const status = text => { $('status').textContent = text; };
function append(role, text) { const el = document.createElement('div'); el.className = `message ${role}`; el.textContent = text; $('messages').append(el); el.scrollIntoView({ block: 'end' }); }
function removeScreenshot() { screenshot = null; $('preview').removeAttribute('src'); $('attachment').hidden = true; }
$('hide').onclick = () => window.pet.hide();
$('quit').onclick = () => window.pet.quit();
$('settingsButton').onclick = async () => {
  $('settings').hidden = !$('settings').hidden;
  if (!$('settings').hidden) { try { const s = await window.pet.settings(); $('endpoint').value = s.endpoint; $('model').value = s.model; $('key').placeholder = s.hasKey ? '已保存，留空保留' : '请输入 API 密钥'; } catch { status('读取设置失败'); } }
};
$('settings').onsubmit = async e => { e.preventDefault(); try { await window.pet.save({ endpoint: $('endpoint').value, model: $('model').value, key: $('key').value }); $('key').value = ''; $('settings').hidden = true; status('设置已保存'); } catch (e) { status(e.message); } };
$('capture').onclick = async () => { if (busy) return; $('capture').disabled = true; try { screenshot = await window.pet.capture(); $('preview').src = screenshot; $('attachment').hidden = false; status('截图仅在点击发送后上传'); } catch(e) { status(e.message); } finally { $('capture').disabled = false; } };
$('remove').onclick = removeScreenshot;
$('clear').onclick = () => { if (busy) return; messages = []; $('messages').replaceChildren(); removeScreenshot(); status('对话已清空'); };
$('chat').onsubmit = async e => {
  e.preventDefault(); const question = $('question').value.trim(); if (!question || busy) return;
  if (messages.length >= 40) { status('对话已达上限，请先清空'); return; }
  busy = true; petState('thinking'); ['send','capture','clear','remove'].forEach(id => $(id).disabled = true); status('小星正在思考…');
  const pending = [...messages, { role: 'user', content: question }];
  try { const answer = await window.pet.ask({ messages: pending, screenshot }); messages = [...pending, { role: 'assistant', content: answer }]; append('user', question); append('assistant', answer); $('question').value = ''; removeScreenshot(); status(''); petState('replying'); }
  catch(e) { status(e.message); petState(''); }
  finally { busy = false; ['send','capture','clear','remove'].forEach(id => $(id).disabled = false); }
};
$('question').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('chat').requestSubmit(); } };
