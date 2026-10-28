const box = document.getElementById('box');
let origin = null, submitting = false, ready = false;
const clamp = (n, max) => Math.max(0, Math.min(max, n));
function rectangle(event) { const x = clamp(event.clientX, innerWidth), y = clamp(event.clientY, innerHeight); return { x: Math.min(origin.x, x), y: Math.min(origin.y, y), width: Math.abs(origin.x - x), height: Math.abs(origin.y - y) }; }
window.longshot.selection().then(data => { const image = document.getElementById('desktop'); image.onload = () => { ready = true; }; image.src = data.image; }).catch(() => window.longshot.cancelSelection());
document.onpointerdown = event => { if (!ready || event.button !== 0 || submitting) return; origin = { x: event.clientX, y: event.clientY }; box.style.display = 'block'; document.body.setPointerCapture(event.pointerId); };
document.onpointermove = event => { if (!origin || submitting) return; const r = rectangle(event); Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` }); };
document.onpointerup = async event => {
  if (!origin || submitting) return;
  const r = rectangle(event); origin = null;
  if (r.width < 80 || r.height < 80) { box.style.display = 'none'; return; }
  submitting = true;
  try { await window.longshot.select(r); } catch { submitting = false; }
};
document.onkeydown = event => { if (event.key === 'Escape') window.longshot.cancelSelection(); };
