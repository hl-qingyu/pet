const sprite = document.querySelector('#sprite'), scene = document.querySelector('#scene'), bubble = document.querySelector('#bubble');
const names = ['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review'];
const times = [[1680,660,660,840,840,1920],[120,120,120,120,120,120,120,220],[120,120,120,120,120,120,120,220],[140,140,140,280],[140,140,140,140,280],[140,140,140,140,140,140,140,240],[150,150,150,150,150,260],[120,120,120,120,120,220],[150,150,150,150,150,280]];
let config, state = 'idle', row = 0, frame = 0, next = 0, hover = false, drag = false, moved = false, lastX = 0, lastY = 0, direction = null, bubbleTimer, clickTimer;
function cell(r,c) { sprite.style.backgroundPosition = `${-c*192}px ${-r*208}px`; }
function choose(name) { const r = Math.max(0, names.indexOf(name)); if (row !== r) { row = r; frame = 0; next = 0; } }
function say(text) { if (!text) return; clearTimeout(bubbleTimer); bubble.textContent = text; bubble.classList.add('visible'); bubbleTimer = setTimeout(() => bubble.classList.remove('visible'), 6500); }
function configure(value) {
  const theme = window.petThemes.resolve(value);
  if (document.documentElement.dataset.theme !== theme.id) {
    document.documentElement.dataset.theme = theme.id;
    frame = 0; next = 0; cell(row, 0);
    clearTimeout(bubbleTimer); bubble.classList.remove('visible');
  }
  config = value; scene.style.transform = `scale(${value.pet.scale})`;
  sprite.setAttribute('aria-label', `${window.petThemes.character(value).name}（${theme.label}）：单击互动，双击聊天，右键菜单，按住拖动`);
}
function animate(t) {
  if (drag && moved) { /* drag decides the row */ }
  else if (hover && state === 'idle') choose('jumping');
  else choose(state);
  if (!hover && !drag && state === 'idle' && config?.pet.followMouse && direction !== null) cell(9 + Math.floor(direction/8),direction%8);
  else if (t >= next) { cell(row,frame); next = t + times[row][frame]; frame = (frame+1) % times[row].length; }
  requestAnimationFrame(animate);
}
sprite.addEventListener('pointerenter', () => { hover = true; next = 0; });
sprite.addEventListener('pointerleave', () => { hover = false; next = 0; });
sprite.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  drag = true; moved = false; lastX = e.screenX; lastY = e.screenY; sprite.setPointerCapture(e.pointerId); window.dragon.send('pet:drag-start');
});
sprite.addEventListener('pointermove', e => {
  if (!drag) return;
  const dx = e.screenX-lastX;
  if (Math.abs(dx) > 3 || Math.abs(e.screenY-lastY) > 3 || moved) { moved = true; choose(dx < 0 ? 'running-left' : 'running-right'); window.dragon.send('pet:drag'); lastX = e.screenX; lastY = e.screenY; }
});
function release(e) {
  if (!drag) return;
  drag = false; if (sprite.hasPointerCapture(e.pointerId)) sprite.releasePointerCapture(e.pointerId);
  window.dragon.send('pet:drag-end');
  if (!moved) { clearTimeout(clickTimer); clickTimer = setTimeout(() => window.dragon.send('pet:interact','pet'), 250); }
}
sprite.addEventListener('pointerup', release); sprite.addEventListener('pointercancel', release);
sprite.addEventListener('dblclick', () => { clearTimeout(clickTimer); window.dragon.send('panel:open','chat'); });
sprite.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); window.dragon.send('panel:open','chat'); } });
let hit = null;
document.addEventListener('mousemove', event => {
  const over = Boolean(event.target.closest('#sprite,#toolbar'));
  if (over !== hit && !drag) { hit = over; window.dragon.send('pet:hit',over); }
});
document.addEventListener('contextmenu', e => { e.preventDefault(); window.dragon.send('pet:menu'); });
document.querySelector('#chat').onclick = () => window.dragon.send('panel:open','chat');
document.querySelector('#settings').onclick = () => window.dragon.send('panel:open','settings');
document.querySelector('#hide').onclick = () => window.dragon.send('pet:hide');
window.dragon.on('pet:state', payload => { state = payload.state; choose(state); say(payload.bubble); });
window.dragon.on('pet:cursor', point => { const s = config?.pet.scale || 1, dx = point.x/s-145, dy = point.y/s-210; direction = Math.round(((Math.atan2(dx,-dy)*180/Math.PI+360)%360)/22.5)%16; });
window.dragon.on('config:updated', configure);
window.dragon.invoke('bootstrap').then(data => { configure(data.config); state = data.state; sprite.dataset.loaded = 'true'; requestAnimationFrame(animate); }).catch(error => { window.__bootError = error.message; say(error.message); });
