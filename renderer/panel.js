const $ = selector => document.querySelector(selector);
let config, activeConfig, selectedProvider, editingCharacter, activePage = 'chat', busy = false, pendingNode, pendingId, partial = '', dirty = false;
let shortcutPlatform = 'win32', shortcutRecorder = null, shortcutRuntime = { active: false, revision: 0 };
function shortcutUI() {
  const recording = Boolean(shortcutRecorder);
  $('#shortcut').readOnly = recording; $('#shortcut').classList.toggle('recording', recording);
  $('#shortcut-record').disabled = busy || recording;
  $('#shortcut-cancel').classList.toggle('hidden', !recording);
  $('#shortcut-clear').disabled = busy;
  $('#save').disabled = busy || recording;
}
function endShortcutRecording(commit = false, fromMain = false, message = '') {
  const recorder = shortcutRecorder;
  if (!recorder) return;
  shortcutRecorder = null;
  $('#shortcut').value = commit ? recorder.candidate.accelerator : recorder.before;
  if (commit) dirty = true;
  $('#shortcut-hint').textContent = message || (commit ? `已记录 ${window.petShortcuts.display(recorder.candidate.accelerator, shortcutPlatform)}，保存后生效。` : '已取消键盘录入，快捷键设置未改变。');
  shortcutUI();
  if (!fromMain) window.dragon.invoke('shortcut:recording', false).catch(error => notice(error.message, true));
}
async function startShortcutRecording() {
  if (busy || shortcutRecorder) return;
  const recorder = { before: $('#shortcut').value, candidate: null, ready: false, revision: 0 };
  shortcutRecorder = recorder; shortcutUI(); $('#shortcut-hint').textContent = '正在准备键盘录入……';
  try {
    const state = await window.dragon.invoke('shortcut:recording', true);
    if (shortcutRecorder !== recorder) return;
    if (!state.active || (shortcutRuntime.revision > state.revision && !shortcutRuntime.active)) {
      endShortcutRecording(false, true, '键盘录入已结束，请重新点击“键盘录入”。'); return;
    }
    recorder.ready = true; recorder.revision = state.revision;
    $('#shortcut-hint').textContent = '请按下组合键，松开主键完成；Esc 或取消按钮退出。';
    $('#shortcut').focus();
  } catch (error) {
    if (shortcutRecorder !== recorder) return;
    endShortcutRecording(false); $('#shortcut-hint').textContent = error.message;
  }
}
function page(name) {
  if (name !== 'settings') endShortcutRecording();
  activePage = name;
  for (const element of document.querySelectorAll('.page')) element.classList.toggle('hidden', element.id !== `${name}-page`);
  for (const button of document.querySelectorAll('.nav')) button.classList.toggle('active', button.dataset.page === name);
  if (name === 'chat') { showIdentity(window.petThemes.resolve(activeConfig), window.petThemes.character(activeConfig)); $('#message').focus(); }
  else previewTheme();
}
function showIdentity(theme, character) {
  document.documentElement.dataset.theme = theme.id;
  $('#rail-name').textContent = character.name;
  $('#message').placeholder = `和${character.name}说点什么……`;
  const welcome = $('#welcome h3');
  if (welcome) welcome.textContent = `${character.name}，在桌边陪着你。`;
}
function notice(message, bad = false) { $('#settings-message').textContent = message; $('#settings-message').classList.remove('hidden'); $('#settings-message').classList.toggle('bad',bad); }
function chatError(message) { $('#chat-error').textContent = message; $('#chat-error').classList.toggle('hidden',!message); }
function renderHistory(messages) {
  $('#messages').replaceChildren();
  pendingNode = null; pendingId = null; partial = '';
  chatError('');
  if (messages.length) {
    for (const item of messages) message(item.role,item.content,false,item.characterName);
  } else {
    $('#messages').append($('#welcome-template').content.cloneNode(true));
    showIdentity(window.petThemes.resolve(activeConfig), window.petThemes.character(activeConfig));
    $('#messages').scrollTop = 0;
  }
}
function message(role, text, pending = false, characterName = '伙伴') {
  $('#welcome')?.remove();
  const wrapper = document.createElement('div'); wrapper.className = `message ${role}${pending ? ' pending' : ''}`;
  const label = document.createElement('div'); label.className = 'message-label'; label.textContent = role === 'user' ? '你' : characterName;
  const content = document.createElement('div'); content.className = 'message-content'; content.textContent = text;
  wrapper.append(label, content); $('#messages').append(wrapper); scrollChat(); return wrapper;
}
function scrollChat() { const area = $('#messages'); area.scrollTop = area.scrollHeight; }
function setBusy(value) { busy = value; if (busy) endShortcutRecording(); $('#send').classList.toggle('hidden',value); $('#stop').classList.toggle('hidden',!value); shortcutUI(); $('#clear-chat').disabled = value; $('#chat-status').textContent = value ? '正在想，慢慢说给你听……' : `${activeConfig.providers[activeConfig.chat.provider].label} · 准备好了`; }
function runtime(value) {
  if (Number.isSafeInteger(value.shortcutRecordingRevision) && value.shortcutRecordingRevision >= shortcutRuntime.revision) {
    shortcutRuntime = { active: value.shortcutRecording === true, revision: value.shortcutRecordingRevision };
    if (shortcutRecorder?.ready && !shortcutRuntime.active && shortcutRuntime.revision >= shortcutRecorder.revision) endShortcutRecording(false, true, '键盘录入已结束，快捷键设置未改变。');
  }
  $('#shortcut-status').textContent = value.shortcut || ''; $('#startup-status').textContent = value.startup || ''; $('#dsh-status').textContent = value.dsh?.message || '未开启'; $('#openai-status').textContent = value.openai?.message || '未开启'; if (value.error) notice(value.error,true);
}
function effortOptions(value = 'default') {
  const deepseek = $('#reasoning-format').value === 'deepseek';
  const all = [['default','模型默认'],['none','关闭推理（none）'],['minimal','极低（minimal）'],['low','低（low）'],['medium','中（medium）'],['high','高（high）'],['xhigh','极高（xhigh）'],['max','最大（max）']];
  const options = deepseek ? all.filter(([key]) => ['default','none','low','high','max'].includes(key)) : all;
  $('#reasoning-effort').replaceChildren(...options.map(([key,label]) => { const option = document.createElement('option'); option.value = key; option.textContent = label; return option; }));
  $('#reasoning-effort').value = options.some(([key]) => key === value) ? value : 'default';
  $('#reasoning-hint').textContent = deepseek ? '关闭会禁用思考；选择低、高、最大时会启用思考。模型默认不额外发送推理参数。' : '档位由模型支持情况决定；不确定时选模型默认。推理会计入输出上限，较高档位可能需要更长超时。';
}
function providerFields(id) {
  selectedProvider = id; const p = config.providers[id];
  $('#protocol').value = p.protocol; $('#base-url').value = p.baseUrl; $('#api-key').value = p.apiKey; $('#model').value = p.model; $('#extra-body').value = JSON.stringify(p.extraBody,null,2);
  $('#reasoning-format').value = p.reasoning?.format || (id === 'deepseek' || new URL(p.baseUrl).hostname === 'api.deepseek.com' ? 'deepseek' : 'openai');
  effortOptions(p.reasoning?.effort || 'default'); badge(); previewTheme();
}
function previewTheme() {
  const id = selectedProvider;
  const preview = { chat: { provider: id }, providers: { [id]: { model: $('#model').value, baseUrl: $('#base-url').value } } };
  const theme = window.petThemes.resolve(preview);
  const integration = window.petThemes.integration(preview);
  $('#dsh-integration-card').classList.toggle('hidden', integration !== 'dsh');
  $('#openai-integration-card').classList.toggle('hidden', integration !== 'openai');
  if (editingCharacter !== theme.id) {
    retainCharacter(); editingCharacter = theme.id;
    const character = config.characters[editingCharacter];
    $('#pet-name').value = character.name; $('#personality').value = character.systemPrompt; $('#greetings').value = character.greetings.join('\n');
  }
  showIdentity(theme, { name: $('#pet-name').value });
  $('#character-label').textContent = `正在编辑：${theme.label}`;
  $('#character-hint').textContent = `${theme.label}的名字、性格和互动台词单独保存，切换回来会保留。`;
  $('#theme-hint').textContent = `随模型切换：${theme.label} · ${theme.color}主题及对应人设，保存后生效。`;
}
function retainCharacter() {
  if (!editingCharacter) return;
  config.characters[editingCharacter] = {
    name: $('#pet-name').value.trim(), systemPrompt: $('#personality').value,
    greetings: $('#greetings').value.split('\n').map(line => line.trim()).filter(Boolean),
  };
}
function badge() { $('#key-badge').textContent = $('#model').value && ($('#api-key').value || $('#base-url').value.startsWith('http://')) ? '已填写' : '待配置'; }
function retainProvider() {
  const provider = config.providers[selectedProvider];
  provider.protocol = $('#protocol').value; provider.baseUrl = $('#base-url').value.trim(); provider.model = $('#model').value.trim(); provider.apiKey = $('#api-key').value.trim();
  provider.reasoning = { format: $('#reasoning-format').value, effort: $('#reasoning-effort').value };
  try { provider.extraBody = JSON.parse($('#extra-body').value || '{}'); } catch { throw new Error('附加请求参数不是有效 JSON。'); }
}
function fill(value) {
  endShortcutRecording();
  activeConfig = structuredClone(value); config = structuredClone(value); dirty = false; editingCharacter = null;
  $('#backend-label').textContent = config.providers[config.chat.provider].label;
  $('#provider').replaceChildren(...Object.entries(config.providers).map(([id,p]) => { const option = document.createElement('option'); option.value = id; option.textContent = p.label; return option; }));
  $('#provider').value = config.chat.provider; providerFields(config.chat.provider);
  $('#max-tokens').value = config.chat.maxOutputTokens; $('#timeout').value = config.chat.timeoutSeconds;
  $('#autostart').checked = config.startup.enabled; $('#always-top').checked = config.pet.alwaysOnTop; $('#follow').checked = config.pet.followMouse;
  $('#show-on-launch').checked = config.pet.showOnLaunch; $('#save-history').checked = config.chat.saveHistory; $('#scale').value = config.pet.scale;
  $('#scale-label').textContent = `${Math.round(config.pet.scale*100)}%`; $('#idle-minutes').value = config.pet.idleTalkMinutes; $('#shortcut').value = config.shortcuts.togglePet;
  $('#shortcut-hint').textContent = '点击“键盘录入”后按组合键，Esc 取消；保存后生效。清空并保存可禁用快捷键。';
  const dsh = config.integrations.dsh;
  $('#dsh-account').checked = dsh.showAccount === true;
  $('#dsh-balance-warning').value = dsh.balanceWarning ?? 0;
  $('#dsh-enabled').checked = dsh.enabled; $('#dsh-bubble').checked = dsh.showBubble;
  $('#dsh-root').value = dsh.sessionsRoot; $('#dsh-workspace').value = dsh.workspace;
  $('#openai-enabled').checked = config.integrations.openai.enabled; $('#openai-bubble').checked = config.integrations.openai.showBubble;
  $('#openai-workspace').value = config.integrations.openai.workspace;
  setBusy(busy);
}
function readForm() {
  retainProvider(); retainCharacter();
  const next = structuredClone(config);
  next.chat.provider = $('#provider').value; next.chat.maxOutputTokens = Number($('#max-tokens').value); next.chat.timeoutSeconds = Number($('#timeout').value);
  next.startup.enabled = $('#autostart').checked; next.pet.alwaysOnTop = $('#always-top').checked; next.pet.followMouse = $('#follow').checked;
  next.pet.showOnLaunch = $('#show-on-launch').checked; next.chat.saveHistory = $('#save-history').checked; next.pet.scale = Number($('#scale').value);
  next.pet.idleTalkMinutes = Number($('#idle-minutes').value); next.shortcuts.togglePet = $('#shortcut').value.trim();
  Object.assign(next.integrations.dsh, { enabled: $('#dsh-enabled').checked, showBubble: $('#dsh-bubble').checked, showAccount: $('#dsh-account').checked, balanceWarning: Number($('#dsh-balance-warning').value),
    sessionsRoot: $('#dsh-root').value.trim(), workspace: $('#dsh-workspace').value.trim() });
  Object.assign(next.integrations.openai, { enabled: $('#openai-enabled').checked, showBubble: $('#openai-bubble').checked,
    workspace: $('#openai-workspace').value.trim() });
  return next;
}
async function save() {
  if (shortcutRecorder) { notice('请先完成或取消键盘录入。'); return; }
  try { $('#save').disabled = true; const result = await window.dragon.invoke('config:save',readForm()); fill(result.config); runtime(result.runtime); notice('已保存，设置已经生效。'); }
  catch (error) { notice(error.message.replace(/^Error invoking remote method '[^']+': Error: /,''),true); }
  finally { shortcutUI(); }
}
async function send() {
  if (busy) return;
  const text = $('#message').value.trim(); if (!text) return;
  chatError(''); $('#message').value = ''; setBusy(true);
  try { await window.dragon.invoke('chat:send',text); }
  catch (error) { chatError(error.message); setBusy(false); }
}
for (const button of document.querySelectorAll('.nav')) button.onclick = () => page(button.dataset.page);
$('#messages').addEventListener('click', event => {
  const button = event.target.closest('.suggestions button');
  if (button) { $('#message').value = button.textContent; $('#message').focus(); }
});
$('#send').onclick = send; $('#stop').onclick = () => window.dragon.invoke('chat:stop');
$('#message').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); } };
$('#save').onclick = save;
$('#shortcut-record').onclick = startShortcutRecording;
$('#shortcut-cancel').onclick = () => endShortcutRecording();
$('#shortcut-clear').onclick = () => { endShortcutRecording(); $('#shortcut').value = ''; dirty = true; $('#shortcut-hint').textContent = '已清空，保存后禁用快捷键。'; };
$('#shortcut').addEventListener('input', () => { if (!shortcutRecorder) $('#shortcut-hint').textContent = '已修改，保存后生效。'; });
document.addEventListener('keydown', event => {
  const recorder = shortcutRecorder;
  if (!recorder) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (event.key === 'Escape') { endShortcutRecording(); return; }
  if (!recorder.ready || recorder.candidate) return;
  const result = window.petShortcuts.fromEvent(event, shortcutPlatform);
  if (result.kind === 'cancel') { endShortcutRecording(); return; }
  if (result.kind === 'shortcut') { recorder.candidate = result; $('#shortcut').value = result.accelerator; $('#shortcut-hint').textContent = '松开主键完成录入。'; }
  else if (result.kind === 'invalid') $('#shortcut-hint').textContent = result.hint;
  else if (result.kind === 'modifier') $('#shortcut-hint').textContent = '继续按下一个字母、数字或功能键。';
}, true);
document.addEventListener('keyup', event => {
  if (!shortcutRecorder) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (shortcutRecorder.candidate?.releaseKey === (event.code || event.key.toLowerCase())) endShortcutRecording(true);
}, true);
window.addEventListener('blur', () => endShortcutRecording());
$('#provider').onchange = () => { const target = $('#provider').value; try { retainProvider(); providerFields(target); dirty = true; } catch (error) { $('#provider').value = selectedProvider; notice(error.message,true); } };
$('#reasoning-format').onchange = () => { effortOptions($('#reasoning-effort').value); dirty = true; };
for (const selector of ['#model', '#base-url']) $(selector).addEventListener('input', previewTheme);
$('#pet-name').addEventListener('input', previewTheme);
$('#settings-page').addEventListener('input', () => { dirty = true; badge(); });
$('#scale').oninput = () => { $('#scale-label').textContent = `${Math.round(Number($('#scale').value)*100)}%`; };
$('#open-config').onclick = async () => { try { await window.dragon.invoke('config:open'); } catch (error) { notice(error.message,true); } };
$('#clear-chat').onclick = () => $('#confirm-clear').classList.remove('hidden');
$('#cancel-clear').onclick = () => $('#confirm-clear').classList.add('hidden');
$('#confirm-clear-button').onclick = async () => { try { await window.dragon.invoke('history:clear'); $('#confirm-clear').classList.add('hidden'); } catch (error) { chatError(error.message); } };
window.dragon.on('config:updated', value => {
  activeConfig = structuredClone(value);
  if (!dirty) fill(value);
  else { config.pet.position = value.pet.position; if (activePage === 'chat') showIdentity(window.petThemes.resolve(value), window.petThemes.character(value)); }
});
window.dragon.on('runtime:updated', runtime);
window.dragon.on('panel:page', page);
window.dragon.on('history:updated', renderHistory);
window.dragon.on('chat:start', payload => { pendingId = payload.id; partial = ''; message('user',payload.text); pendingNode = message('assistant','',true,payload.characterName); setBusy(true); });
window.dragon.on('chat:delta', payload => { if (payload.id !== pendingId) return; partial += payload.delta; pendingNode.querySelector('.message-content').textContent = partial; scrollChat(); });
window.dragon.on('chat:done', payload => { if (payload.id !== pendingId) return; pendingNode.classList.remove('pending'); pendingNode.querySelector('.message-content').textContent = payload.text; scrollChat(); });
window.dragon.on('chat:error', payload => { if (payload.id !== pendingId) return; pendingNode.classList.remove('pending'); pendingNode.classList.add('failed'); pendingNode.querySelector('.message-content').textContent = partial || '这次还没能回复。'; chatError(payload.message); });
window.dragon.on('chat:idle', () => setBusy(false));
window.dragon.invoke('bootstrap').then(data => { shortcutPlatform = data.platform || 'win32'; fill(data.config); runtime(data.runtime); $('#config-path').textContent = data.configPath; renderHistory(data.messages); setBusy(data.busy); page(data.page); }).catch(error => { window.__bootError = error.message; chatError(error.message); });
