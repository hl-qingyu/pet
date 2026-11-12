const sprite = document.querySelector('#sprite'), scene = document.querySelector('#scene'), bubble = document.querySelector('#bubble');
const art = document.querySelector('#sprite-art');
const names = ['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review'];
let accountInsufficient = false, accountDepleted = false, depletionFinished = false;
let config, state = 'idle', row = 0, frame = 0, next = 0, hover = false, hoverJumpDone = false, hoverJumpEnd = 0, drag = false, moved = false, dragStartX = 0, dragStartY = 0, direction = null, bubbleTimer, clickTimer;
function cell(r,c) {
  sprite.style.backgroundPosition = `${-c*192}px ${-r*208}px`;
  art.style.transform = `translateX(${window.petMotion.offset(document.documentElement.dataset.theme,r,c)}px)`;
}
function choose(name) { if (accountDepleted && document.documentElement.dataset.theme === 'whale') name = 'failed'; const r = Math.max(0, names.indexOf(name)); if (row !== r) { row = r; frame = 0; next = 0; } }
function say(text) { if (!text) return; clearTimeout(bubbleTimer); (document.querySelector('#bubble-text') || bubble).textContent = text.replace(/\s+/g, ' ').trim(); bubble.classList.add('visible'); bubbleTimer = setTimeout(() => bubble.classList.remove('visible'), 6500); }
function configure(value) {
  const theme = window.petThemes.resolve(value);
  if (document.documentElement.dataset.theme !== theme.id) {
    document.documentElement.dataset.theme = theme.id;
    hoverJumpDone = false; hoverJumpEnd = 0;
    frame = 0; next = 0; cell(row, 0);
    clearTimeout(bubbleTimer); bubble.classList.remove('visible');
  }
  config = value; scene.style.transform = `scale(${value.pet.scale})`;
  sprite.setAttribute('aria-label', `${window.petThemes.character(value).name}（${theme.label}）：单击互动，双击聊天，右键菜单，按住拖动`);
}
function animate(t) {
  if (accountDepleted && document.documentElement.dataset.theme === 'whale') {
    choose('failed');
    if (depletionFinished) cell(5, window.petMotion.durations('whale', 5).length - 1);
    if (!depletionFinished && t >= next) {
      const durations = window.petMotion.durations('whale', 5);
      cell(5, frame); next = t + durations[frame];
      if (frame === durations.length - 1) depletionFinished = true;
      else frame++;
    }
    requestAnimationFrame(animate); return;
  }
  if (hoverJumpEnd && t >= hoverJumpEnd) hoverJumpDone = true;
  const exhausted = accountInsufficient && document.documentElement.dataset.theme === 'whale' && state === 'idle' && (!hover || hoverJumpDone);
  if (drag && moved) { /* drag decides the row */ }
  else if (exhausted) choose('waiting');
  else if (hover && !hoverJumpDone && state === 'idle') choose('jumping');
  else choose(state);
  if (!exhausted && !hover && !drag && state === 'idle' && config?.pet.followMouse && direction !== null) cell(9 + Math.floor(direction/8),direction%8);
  else if (t >= next) {
    const durations = window.petMotion.durations(document.documentElement.dataset.theme,row);
    cell(row,frame); next = t + durations[frame];
    if (row === 4 && frame === durations.length-1 && hover && state === 'idle' && document.documentElement.dataset.theme === 'whale') hoverJumpEnd = next;
    frame = (frame+1) % durations.length;
  }
  requestAnimationFrame(animate);
}
sprite.addEventListener('pointerenter', () => { hover = true; hoverJumpDone = false; hoverJumpEnd = 0; next = 0; });
sprite.addEventListener('pointerleave', () => { hover = false; hoverJumpDone = false; hoverJumpEnd = 0; next = 0; });
sprite.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  drag = true; moved = false; dragStartX = e.screenX; dragStartY = e.screenY; sprite.setPointerCapture(e.pointerId); window.dragon.send('pet:drag-start');
});
sprite.addEventListener('pointermove', e => {
  if (!drag) return;
  if (!moved && Math.abs(e.screenX-dragStartX) <= 3 && Math.abs(e.screenY-dragStartY) <= 3) return;
  moved = true;
  // 方向由主进程按系统光标位移判断，这里只负责驱动窗口跟随。
  window.dragon.send('pet:drag');
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
  const over = Boolean(event.target.closest('#sprite,#toolbar,#account-refresh'));
  if (over !== hit && !drag) { hit = over; window.dragon.send('pet:hit',over); }
});
document.addEventListener('contextmenu', e => { e.preventDefault(); window.dragon.send('pet:menu'); });
document.querySelector('#chat').onclick = () => window.dragon.send('panel:open','chat');
document.querySelector('#settings').onclick = () => window.dragon.send('panel:open','settings');
document.querySelector('#hide').onclick = () => window.dragon.send('pet:hide');
window.dragon.on('pet:state', payload => {
  state = payload.state; choose(state);
  if (payload.clearBubble) { clearTimeout(bubbleTimer); bubble.classList.remove('visible'); }
  say(payload.bubble);
});
window.dragon.on('pet:drag-direction', name => { if (drag) choose(name); });
window.dragon.on('pet:cursor', point => { const s = config?.pet.scale || 1, dx = point.x/s-145, dy = point.y/s-210; direction = Math.round(((Math.atan2(dx,-dy)*180/Math.PI+360)%360)/22.5)%16; });
window.dragon.on('config:updated', configure);
window.dragon.invoke('bootstrap').then(data => { configure(data.config); showAccount(data.account); state = data.state; sprite.dataset.loaded = 'true'; requestAnimationFrame(animate); }).catch(error => { window.__bootError = error.message; say(error.message); });

function showAccount(value) {
  const sub2api = value?.source === 'sub2api';
  if (sub2api) { accountDepleted = false; depletionFinished = false; }
  else if (value && !value.error && !value.loading) {
    const depleted = value.depleted === true;
    if (depleted !== accountDepleted) { depletionFinished = false; frame = 0; next = 0; }
    accountDepleted = depleted;
  } else if (!value) { accountDepleted = false; depletionFinished = false; }
  accountInsufficient = !sub2api && value?.insufficient === true;
  const element = document.querySelector('#account-bubble');
  if (!element) return;
  document.querySelector('#account-controls').hidden = !value;
  const refresh = document.querySelector('#account-refresh');
  refresh.disabled = !value || value.loading === true || value.refreshing === true;
  refresh.classList.toggle('refreshing', value?.refreshing === true);
  const label = value?.source === 'sub2api' ? '刷新今日额度' : '刷新 DSH 账号余额';
  refresh.title = value?.refreshing ? '正在刷新…' : label;
  refresh.setAttribute('aria-label', label);
  refresh.setAttribute('aria-busy', String(value?.refreshing === true));
  element.dataset.source = value?.source || 'dsh';
  element.hidden = !value;
  if (!value) return;
  element.textContent = sub2api ? (value.loading ? 'Sub2API 额度读取中' : value.error || (value.unsupported ? '当前 Key 未提供日额度' : `今日余额 ${value.remaining.toFixed(2)} · 已用 ${value.used.toFixed(2)}`)) :
    value.loading ? 'DSH 账号 · 正在读取…' : value.error || `余额 ${value.balance} · 消费 ${value.cost}`;
  element.title = value.updated ? `更新于 ${new Date(value.updated).toLocaleTimeString()}` : '';
}
window.dragon.on('dsh:account', showAccount);
document.querySelector('#account-refresh').onclick = async () => {
  const button = document.querySelector('#account-refresh');
  if (button.disabled) return;
  const source = document.querySelector('#account-bubble').dataset.source;
  button.disabled = true;
  try { await window.dragon.invoke(source === 'sub2api' ? 'sub2api:quota-refresh' : 'dsh:account-refresh'); }
  catch {
    if (document.querySelector('#account-bubble').dataset.source === source) {
      button.disabled = false; button.title = '刷新未成功，请点击重试';
    }
  }
};


