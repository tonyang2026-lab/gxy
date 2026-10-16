const $ = id => document.getElementById(id);
let state = { hunger: 70, energy: 80, sleeping: false };
let animationTimer, reminderTimer, deadline = 0;
try {
  const saved = JSON.parse(localStorage.getItem('xiaoxing-pet'));
  if (saved && Number.isFinite(saved.hunger) && Number.isFinite(saved.energy)) state = { hunger: Math.max(0, Math.min(100, saved.hunger)), energy: Math.max(0, Math.min(100, saved.energy)), sleeping: false };
} catch { /* Use defaults if local storage is unavailable or corrupt. */ }
function render() {
  ['hunger', 'energy'].forEach(name => { $(name).value = state[name]; $(name + 'Value').textContent = state[name]; });
  $('sleep').textContent = state.sleeping ? '叫醒 ☀' : '休息 ☾';
  $('feed').disabled = $('play').disabled = state.sleeping;
  document.querySelector('.pet').classList.toggle('sleeping', state.sleeping);
  try { localStorage.setItem('xiaoxing-pet', JSON.stringify(state)); } catch { /* Interaction still works without persistence. */ }
}
function say(text, animate = false) {
  $('caption').textContent = text;
  if (animate) { clearTimeout(animationTimer); $('touch').classList.remove('happy'); void $('touch').offsetWidth; $('touch').classList.add('happy'); animationTimer = setTimeout(() => $('touch').classList.remove('happy'), 900); }
}
$('hide').onclick = () => window.pet.hide();
$('quit').onclick = () => window.pet.quit();
$('touch').onclick = () => say(state.sleeping ? '嘘…特工正在充电。' : ['收到摸摸！精神加倍～', '墨镜戴好，陪伴任务继续！', '今天也要对自己好一点。'][Math.floor(Math.random() * 3)], !state.sleeping);
$('feed').onclick = () => { state = updatePet(state, 'feed'); render(); say('饼干收到！补给完成。', true); };
$('play').onclick = () => {
  if (state.energy < 10) { say('有点累啦，让我休息一下吧。'); return; }
  state = updatePet(state, 'play'); render(); say('特工摇摆！一起活动一下～', true);
};
$('sleep').onclick = () => { state = updatePet(state, 'sleep'); render(); say(state.sleeping ? 'Zzz…休息也是重要任务。' : '充电结束，小星归队！'); };
setInterval(() => { state = updatePet(state, 'tick'); render(); if (!state.sleeping && state.hunger === 0) say('肚子咕咕叫，给我一块饼干吧。'); }, 60000);
function cancelReminder() { clearInterval(reminderTimer); reminderTimer = null; deadline = 0; $('startReminder').disabled = false; $('cancelReminder').disabled = true; $('minutes').disabled = false; }
function updateReminder() {
  const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  if (!remaining) { cancelReminder(); $('timer').textContent = '时间到！起来走走，看看远处吧。'; say('休息任务：伸个懒腰，喝口水！', true); return; }
  $('timer').textContent = `距离休息 ${Math.floor(remaining / 60)} 分 ${String(remaining % 60).padStart(2, '0')} 秒`;
}
$('reminder').onsubmit = e => {
  e.preventDefault(); const minutes = Number($('minutes').value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) return;
  cancelReminder(); deadline = Date.now() + minutes * 60000; $('startReminder').disabled = true; $('cancelReminder').disabled = false; $('minutes').disabled = true; updateReminder(); reminderTimer = setInterval(updateReminder, 1000);
};
$('cancelReminder').onclick = () => { cancelReminder(); $('timer').textContent = '提醒已取消'; };
render();
