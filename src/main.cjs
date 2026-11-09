const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, globalShortcut, screen, shell, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ConfigStore, atomicWrite } = require('./config.cjs');
const { History } = require('./history.cjs');
const { streamReply, userError } = require('./backends/api.cjs');
const { resolve: resolveTheme, character: getCharacter } = require('../renderer/themes.js');

app.setName('DragonDesk');
const appRoot = path.resolve(__dirname, '..');
const customConfig = process.argv.find(a => a.startsWith('--config='))?.slice(9);
const defaultRoot = app.isPackaged ? (process.platform === 'win32' ? path.dirname(process.execPath) : app.getPath('userData')) : appRoot;
const configPath = path.resolve(customConfig || path.join(defaultRoot, 'config.json'));
const dataRoot = path.join(path.dirname(configPath), 'data');
const smoke = process.argv.includes('--smoke-test');
fs.mkdirSync(path.join(dataRoot, 'electron'), { recursive: true });
fs.mkdirSync(path.join(dataRoot, 'logs'), { recursive: true });
app.setPath('userData', path.join(dataRoot, 'electron'));
app.setPath('sessionData', path.join(dataRoot, 'electron'));
app.setAppLogsPath(path.join(dataRoot, 'logs'));
const ownLock = app.requestSingleInstanceLock();
if (!ownLock) app.quit();

let petWindow, panelWindow, tray, store, history, request, unwatch, currentShortcut = '', cursorTimer;
let quitting = false, currentState = 'idle', panelPage = 'chat', dragOrigin, positionTimer, idleTimer;
let runtime = { shortcut: '', startup: '', error: '' };
let appliedTheme;

function log(message) {
  fs.appendFileSync(path.join(dataRoot, 'logs', 'app.log'), `${new Date().toISOString()} ${message}\n`);
}
function send(window, channel, value) { if (window && !window.isDestroyed() && !window.webContents.isLoading()) window.webContents.send(channel, value); }
function broadcast(channel, value) { send(petWindow, channel, value); send(panelWindow, channel, value); }
function status(state, bubble) {
  currentState = state; broadcast('pet:state', { state, bubble });
}
function petSize() { return { width: Math.round(290 * store.value.pet.scale), height: Math.round(340 * store.value.pet.scale) }; }
function clampPoint(point, size) {
  const display = point ? screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) }) : screen.getPrimaryDisplay();
  const a = display.workArea;
  return { x: Math.round(Math.min(Math.max(point?.x ?? a.x + a.width - size.width - 28, a.x), a.x + a.width - size.width)), y: Math.round(Math.min(Math.max(point?.y ?? a.y + a.height - size.height - 20, a.y), a.y + a.height - size.height)) };
}
function showPet() { petWindow.showInactive(); }
function hidePet() { petWindow.hide(); panelWindow?.hide(); }
function togglePet() { petWindow.isVisible() ? hidePet() : showPet(); }
function showPanel(page = 'chat') {
  panelPage = page;
  const a = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const bounds = panelWindow.getBounds();
  if (!screen.getAllDisplays().some(d => bounds.x >= d.workArea.x && bounds.x < d.workArea.x + d.workArea.width)) panelWindow.setPosition(a.x + 30, a.y + 30);
  panelWindow.show(); panelWindow.focus(); send(panelWindow, 'panel:page', page);
}
function interaction(kind = 'pet') {
  const lines = getCharacter(store.value).greetings;
  status(kind === 'jump' ? 'jumping' : 'waving', lines.length ? lines[Math.floor(Math.random() * lines.length)] : '我在呢。');
  if (!request) setTimeout(() => { if (!request) status('idle'); }, 1700);
}
function setShortcut(accelerator) {
  if (accelerator === currentShortcut) return;
  if (currentShortcut) globalShortcut.unregister(currentShortcut);
  currentShortcut = '';
  if (!accelerator) { runtime.shortcut = '未设置快捷键，可用托盘显示桌宠'; return; }
  try {
    if (globalShortcut.register(accelerator, togglePet)) { currentShortcut = accelerator; runtime.shortcut = `${accelerator} · 注册成功`; }
    else runtime.shortcut = `${accelerator} 被占用，请换一个组合；托盘仍然可用`;
  } catch { runtime.shortcut = '快捷键格式无效，请检查设置'; }
}
function setStartup(enabled) {
  if (smoke) { runtime.startup = '测试模式，不修改开机启动'; return; }
  if (process.platform === 'darwin' && !app.isPackaged) {
    if (enabled) throw new Error('macOS 请先打包为 .app，再打开开机自启。');
    runtime.startup = '未开启'; return;
  }
  const settings = { openAtLogin: enabled };
  if (process.platform === 'win32') {
    settings.path = process.execPath;
    settings.args = [...(app.isPackaged ? [] : [appRoot]), `--config=${configPath}`, '--autostart'];
    settings.name = 'DragonDesk';
  }
  if (enabled || app.getLoginItemSettings(process.platform === 'win32' ? { path: settings.path, args: settings.args } : {}).openAtLogin) app.setLoginItemSettings(settings);
  const actual = app.getLoginItemSettings(process.platform === 'win32' ? { path: settings.path, args: settings.args } : {}).openAtLogin;
  runtime.startup = actual ? '已开启登录后启动' : '未开启';
  if (enabled && !actual) throw new Error('系统没有接受开机自启设置，请检查登录项设置。');
}
function applyConfig({ startup = false } = {}) {
  runtime.error = '';
  const config = store.value;
  if (startup) { try { setStartup(config.startup.enabled); } catch (error) { runtime.startup = error.message; } }
  if (petWindow) {
    const size = petSize();
    const point = clampPoint(config.pet.position || petWindow.getBounds(), size);
    petWindow.setBounds({ ...size, ...point });
    petWindow.setAlwaysOnTop(config.pet.alwaysOnTop, 'floating');
  }
  panelWindow?.setAlwaysOnTop(false);
  setShortcut(config.shortcuts.togglePet);
  clearInterval(idleTimer);
  if (config.pet.idleTalkMinutes > 0) idleTimer = setInterval(() => { if (!request && petWindow.isVisible()) interaction(); }, config.pet.idleTalkMinutes * 60000);
  updateTray(); broadcast('config:updated', config); broadcast('runtime:updated', runtime);
}
function updateTray() {
  if (!tray) return;
  const theme = resolveTheme(store.value);
  if (appliedTheme !== theme.id) {
    tray.setImage(nativeImage.createFromPath(path.join(appRoot, theme.tray)));
    if (process.platform !== 'darwin') panelWindow?.setIcon(path.join(appRoot, theme.icon));
    panelWindow?.setBackgroundColor(theme.background);
    appliedTheme = theme.id;
  }
  tray.setToolTip(`${getCharacter(store.value).name} · ${theme.label} · DragonDesk`);
  tray.setContextMenu(contextMenu());
}
function contextMenu() {
  return Menu.buildFromTemplate([
    { label: `和${getCharacter(store.value).name}聊天`, click: () => showPanel('chat') },
    { label: '显示 / 隐藏桌宠', click: togglePet },
    { label: '摸摸头', click: () => interaction() },
    { type: 'separator' },
    { label: '设置与性格', click: () => showPanel('settings') },
    { label: '重新放到主屏幕', click: () => { const point = clampPoint(null, petSize()); petWindow.setPosition(point.x, point.y); persistPosition(); showPet(); } },
    { type: 'separator' },
    { label: '退出 DragonDesk', click: () => { quitting = true; app.quit(); } },
  ]);
}
function persistPosition() {
  clearTimeout(positionTimer);
  positionTimer = setTimeout(() => {
    if (!petWindow || petWindow.isDestroyed()) return;
    try { const { x, y } = petWindow.getBounds(); store.save({ ...store.value, pet: { ...store.value.pet, position: { x, y } } }); }
    catch (error) { log(`Position save failed: ${error.message}`); }
  }, 450);
}
function guard(event) {
  const allowed = [petWindow?.webContents.id, panelWindow?.webContents.id];
  if (!allowed.includes(event.sender.id) || event.senderFrame !== event.sender.mainFrame) throw new Error('拒绝未知页面请求');
}
function handle(channel, callback) { ipcMain.handle(channel, async (event, ...args) => { guard(event); return callback(...args); }); }
function on(channel, callback) { ipcMain.on(channel, (event, ...args) => { guard(event); callback(...args); }); }

function setupIPC() {
  handle('bootstrap', () => ({ config: store.value, configPath, runtime, messages: history.messages, state: currentState, page: panelPage, busy: Boolean(request) }));
  handle('config:save', next => {
    if (request) throw new Error('请先停止当前回复，再修改接口或性格。');
    const previous = store.value;
    const { validate } = require('./config.cjs'); validate(next);
    next.pet.position = store.value.pet.position;
    if (next.startup.enabled !== previous.startup.enabled) setStartup(next.startup.enabled);
    try { store.save(next); } catch (error) { if (next.startup.enabled !== previous.startup.enabled) setStartup(previous.startup.enabled); throw error; }
    applyConfig(); return { config: store.value, runtime };
  });
  handle('config:open', async () => { const result = await shell.openPath(configPath); if (result) throw new Error(result); });
  handle('history:clear', () => { if (request) throw new Error('请先停止生成，再清空聊天。'); history.clear(); broadcast('history:updated', []); });
  handle('chat:send', async text => {
    if (request) throw new Error('正在回复，请稍候或点击停止。');
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw new Error('消息长度应为 1–16000 字符。');
    const config = structuredClone(store.value);
    const provider = config.providers[config.chat.provider];
    const character = { id: resolveTheme(config).id, ...getCharacter(config) };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('等待回复超时，请稍后重试或调整超时。')), config.chat.timeoutSeconds * 1000);
    const id = randomUUID(); request = { controller, id };
    broadcast('chat:start', { id, text, provider: provider.label, characterName: character.name }); status('running', '让我想一想……');
    try {
      const messages = [...history.context(config.chat.historyMessages), { role: 'user', content: text.trim() }];
      const reply = await streamReply({ config, messages, signal: controller.signal, onDelta: delta => broadcast('chat:delta', { id, delta }) });
      history.append(text.trim(), reply, config.chat.saveHistory, character);
      broadcast('chat:done', { id, text: reply }); status('review', reply.slice(0, 90));
      setTimeout(() => { if (!request) status('idle'); }, 3200);
    } catch (error) {
      const message = userError(error, Object.values(config.providers).map(p => p.apiKey));
      broadcast('chat:error', { id, message }); status(controller.signal.aborted ? 'idle' : 'failed', message.slice(0, 90));
    } finally { clearTimeout(timeout); request = null; broadcast('chat:idle', { id }); }
    return { id };
  });
  handle('chat:stop', () => request?.controller.abort(new Error('已停止生成。')));
  on('panel:open', page => showPanel(page === 'settings' ? 'settings' : 'chat'));
  on('panel:hide', () => panelWindow.hide());
  on('pet:interact', kind => interaction(kind));
  on('pet:menu', () => contextMenu().popup({ window: petWindow }));
  on('pet:hide', hidePet);
  on('pet:hit', over => { if (typeof over === 'boolean' && !dragOrigin) petWindow.setIgnoreMouseEvents(!over, { forward: true }); });
  on('pet:drag-start', () => { petWindow.setIgnoreMouseEvents(false); dragOrigin = { cursor: screen.getCursorScreenPoint(), bounds: petWindow.getBounds() }; });
  on('pet:drag', () => {
    if (!dragOrigin) return;
    const cursor = screen.getCursorScreenPoint();
    const point = clampPoint({ x: dragOrigin.bounds.x + cursor.x - dragOrigin.cursor.x, y: dragOrigin.bounds.y + cursor.y - dragOrigin.cursor.y }, petSize());
    petWindow.setPosition(point.x, point.y);
  });
  on('pet:drag-end', () => { dragOrigin = null; persistPosition(); });
}

function secureWindow(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  window.webContents.on('render-process-gone', (_event, details) => { log(`Renderer stopped: ${details.reason}`); });
  window.webContents.on('console-message', details => { if (details.level === 'error') log(`Renderer: ${String(details.message).slice(0, 600)}`); });
  window.on('unresponsive', () => log('Window unresponsive'));
}
function createWindows() {
  const size = petSize(); const point = clampPoint(store.value.pet.position, size);
  const webPreferences = { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false };
  petWindow = new BrowserWindow({ ...size, ...point, title: 'DragonDesk · 桌宠', frame: false, transparent: true, backgroundColor: '#00000000', resizable: false, maximizable: false, minimizable: false, hasShadow: false, skipTaskbar: true, show: false, webPreferences });
  panelWindow = new BrowserWindow({ width: 940, height: 740, minWidth: 760, minHeight: 580, title: 'DragonDesk · 聊天与设置', backgroundColor: '#f8f7fc', show: false, autoHideMenuBar: true, icon: path.join(appRoot, 'assets/icon.png'), webPreferences });
  for (const window of [petWindow, panelWindow]) secureWindow(window);
  if (process.platform === 'darwin') petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panelWindow.on('close', event => { if (!quitting) { event.preventDefault(); panelWindow.hide(); } });
  petWindow.on('close', event => { if (!quitting) { event.preventDefault(); hidePet(); } });
  petWindow.on('move', persistPosition);
  petWindow.once('ready-to-show', () => { if (store.value.pet.showOnLaunch) showPet(); status('idle', getCharacter(store.value).greetings[0]); });
  panelWindow.once('ready-to-show', () => { if (process.argv.includes('--settings')) showPanel('settings'); });
  petWindow.loadFile(path.join(appRoot, 'renderer/pet.html'));
  panelWindow.loadFile(path.join(appRoot, 'renderer/panel.html'));
  const trayImage = nativeImage.createFromPath(path.join(appRoot, 'assets/tray.png'));
  tray = new Tray(trayImage); tray.on('double-click', () => showPanel('chat')); tray.on('click', () => { showPet(); });
  updateTray();
  cursorTimer = setInterval(() => {
    if (!petWindow.isVisible() || !store.value.pet.followMouse || dragOrigin) return;
    const cursor = screen.getCursorScreenPoint(), b = petWindow.getBounds();
    send(petWindow, 'pet:cursor', { x: cursor.x - b.x, y: cursor.y - b.y });
  }, 100);
}

async function smokeTest() {
  const bootCharacterName = getCharacter(store.value).name;
  await Promise.all([petWindow.webContents.executeJavaScript('document.readyState'), panelWindow.webContents.executeJavaScript('document.readyState')]);
  const checks = await Promise.all([
    petWindow.webContents.executeJavaScript('({loaded:document.querySelector("#sprite").dataset.loaded, frame:document.querySelector("#sprite").style.backgroundPosition, error:window.__bootError || null})'),
    panelWindow.webContents.executeJavaScript('({title:document.title, provider:document.querySelector("#provider").value, name:document.querySelector("#pet-name").value, reasoning:document.querySelector("#reasoning-effort").value, error:window.__bootError || null})'),
  ]);
  const themeChecks = [];
  // Actual IPC + HTTP integration against scripts/smoke.cjs's loopback server.
  if (store.value.chat.provider === 'custom' && ['mock-model', 'deepseek-mock-model'].includes(store.value.providers.custom.model)) {
    const initialModel = store.value.providers.custom.model;
    const waitFor = async predicate => {
      const end = Date.now() + 8000;
      while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
      throw new Error('UI smoke condition timed out');
    };
    const effortSwitch = await panelWindow.webContents.executeJavaScript(`(() => {
      const provider=document.querySelector('#provider');provider.value='deepseek';provider.dispatchEvent(new Event('change'));
      const options=[...document.querySelector('#reasoning-effort').options].map(o=>o.value);
      document.querySelector('#reasoning-effort').value='max';
      provider.value='custom';provider.dispatchEvent(new Event('change'));
      const restored=document.querySelector('#reasoning-effort').value;
      document.querySelector('#save').click();
      return {options,restored};
    })()`);
    await waitFor(() => store.value.providers.deepseek.reasoning.effort === 'max');
    if (effortSwitch.restored !== 'high' || effortSwitch.options.includes('medium') || !effortSwitch.options.includes('max')) throw new Error('推理强度切换验证失败');
    showPanel('chat');
    await panelWindow.webContents.executeJavaScript('document.querySelector("#message").value="你好，小龙";document.querySelector("#send").click();');
    await waitFor(() => panelWindow.webContents.executeJavaScript('document.querySelectorAll(".message.assistant:not(.pending)").length === 1 && document.querySelector("#stop").classList.contains("hidden")'));
    checks.push({ reply: await panelWindow.webContents.executeJavaScript('document.querySelector(".message.assistant .message-content").textContent'), history: history.messages.length });
    fs.writeFileSync(path.join(dataRoot, 'chat-smoke.png'), (await panelWindow.webContents.capturePage()).toPNG());
    await panelWindow.webContents.executeJavaScript('document.querySelector("#message").value="触发错误";document.querySelector("#send").click();');
    await waitFor(() => panelWindow.webContents.executeJavaScript('document.querySelector("#chat-error").textContent.includes("429")'));
    checks.push({ errorShown: true, historyAfterFailure: history.messages.length });

    const clearAndCheckWelcome = async () => {
      showPanel('chat');
      await panelWindow.webContents.executeJavaScript(`document.querySelector('#clear-chat').click();document.querySelector('#confirm-clear-button').click();`);
      await waitFor(() => history.messages.length === 0 && panelWindow.webContents.executeJavaScript(`document.querySelectorAll('#welcome').length === 1 && document.querySelectorAll('.message').length === 0 && document.querySelector('#chat-error').classList.contains('hidden') && document.querySelector('#confirm-clear').classList.contains('hidden')`));
      const welcome = await panelWindow.webContents.executeJavaScript(`({title:document.querySelector('#welcome h3').textContent,buttons:document.querySelectorAll('#welcome .suggestions button').length})`);
      if (welcome.title !== `${getCharacter(store.value).name}，在桌边陪着你。` || welcome.buttons !== 2) throw new Error('清空聊天后的欢迎页验证失败');
      await panelWindow.webContents.executeJavaScript(`document.querySelector('#welcome .suggestions button').click();`);
      const topicWorks = await panelWindow.webContents.executeJavaScript(`document.querySelector('#message').value === document.querySelector('#welcome .suggestions button').textContent`);
      if (!topicWorks) throw new Error('恢复后的快捷话题没有生效');
      await panelWindow.webContents.executeJavaScript(`document.querySelector('#message').value='';`);
    };
    await clearAndCheckWelcome();
    await panelWindow.webContents.executeJavaScript(`document.querySelector('#message').value='清空后继续聊';document.querySelector('#send').click();`);
    await waitFor(() => history.messages.length === 2 && !request);
    if (await panelWindow.webContents.executeJavaScript(`Boolean(document.querySelector('#welcome'))`)) throw new Error('发送消息后欢迎页应收起');
    await clearAndCheckWelcome();
    themeChecks.push({welcomeAfterClear:true,quickTopicsAfterClear:true,welcomeHidesOnSend:true,errorCleared:true,pass:true});

    // Exercise the saved model choice, both windows, packaged image loading, and pointer frames.
    clearInterval(cursorTimer);
    const readTheme = (window, selector) => window.webContents.executeJavaScript(`(async () => {
      const element = document.querySelector(${JSON.stringify(selector)});
      const image = new Image(); image.src = getComputedStyle(element).backgroundImage.slice(5, -2);
      await image.decode();
      return {theme: document.documentElement.dataset.theme, image: image.src, width: image.naturalWidth, height: image.naturalHeight, accent: getComputedStyle(element).getPropertyValue('--accent').trim()};
    })()`);
    const saveTheme = async (provider, model, expected) => {
      await panelWindow.webContents.executeJavaScript(`(() => {
        const provider = document.querySelector('#provider'); provider.value = ${JSON.stringify(provider)}; provider.dispatchEvent(new Event('change'));
        const model = document.querySelector('#model'); model.value = ${JSON.stringify(model)}; model.dispatchEvent(new Event('input', {bubbles:true}));
        document.querySelector('#save').click();
      })()`);
      await waitFor(async () => store.value.chat.provider === provider && store.value.providers[provider].model === model &&
        await petWindow.webContents.executeJavaScript(`document.documentElement.dataset.theme === ${JSON.stringify(expected)}`) &&
        await panelWindow.webContents.executeJavaScript(`document.documentElement.dataset.theme === ${JSON.stringify(expected)}`));
      const pet = await readTheme(petWindow, '#sprite'), panel = await readTheme(panelWindow, '.portrait-sprite');
      const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const imagesMatch = [pet,panel].every(item => item.width === 1536 && item.height === 2288 && item.image.includes('/whale/') === (expected === 'whale'));
      const identity = await panelWindow.webContents.executeJavaScript(`({name:document.querySelector('#pet-name').value,personality:document.querySelector('#personality').value,greetings:document.querySelector('#greetings').value,rail:document.querySelector('#rail-name').textContent})`);
      const character = getCharacter(store.value);
      const pass = imagesMatch && pet.accent === panel.accent && resolveTheme(persisted).id === expected && identity.name === character.name && identity.personality === character.systemPrompt && identity.greetings === character.greetings.join('\n') && identity.rail === character.name;
      themeChecks.push({provider, model, expected, pet, panel, name:identity.name, pass});
      if (!pass) throw new Error('主题切换或图集加载验证失败');
    };
    const savedTheme = resolveTheme(store.value).id;
    const previewTheme = savedTheme === 'whale' ? 'dragon' : 'whale';
    const previewProvider = previewTheme === 'whale' ? 'deepseek' : 'openai';
    await panelWindow.webContents.executeJavaScript(`(() => {
      const provider = document.querySelector('#provider'); provider.value = ${JSON.stringify(previewProvider)}; provider.dispatchEvent(new Event('change'));
    })()`);
    const preview = await readTheme(panelWindow, '.portrait-sprite');
    const unchanged = await readTheme(petWindow, '#sprite');
    if (preview.theme !== previewTheme || unchanged.theme !== savedTheme || store.value.chat.provider !== 'custom') throw new Error('主题预览不应改变已保存的模型');
    themeChecks.push({preview: preview.theme, saved: unchanged.theme, pass: true});
    await saveTheme('deepseek', 'deepseek-flash', 'whale');
    status('idle');
    await panelWindow.webContents.executeJavaScript(`document.querySelector('#follow').checked=false;document.querySelector('#save').click();`);
    await waitFor(() => !store.value.pet.followMouse);
    await new Promise(resolve => setTimeout(resolve, 250));
    showPanel('settings');
    await panelWindow.webContents.executeJavaScript(`document.querySelector('.settings-body').scrollTop=0;`);
    await waitFor(() => panelWindow.webContents.executeJavaScript(`!document.querySelector('#settings-page').classList.contains('hidden')`));
    await new Promise(resolve => setTimeout(resolve, 150));
    fs.writeFileSync(path.join(dataRoot, 'whale-settings.png'), (await panelWindow.webContents.capturePage()).toPNG());
    showPanel('chat');
    fs.writeFileSync(path.join(dataRoot, 'whale-chat.png'), (await panelWindow.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(dataRoot, 'whale-pet.png'), (await petWindow.webContents.capturePage()).toPNG());
    status('waving');
    await waitFor(() => petWindow.webContents.executeJavaScript('parseInt(document.querySelector("#sprite").style.backgroundPosition.split(" ")[1]) === -624'));
    status('idle');
    await panelWindow.webContents.executeJavaScript(`document.querySelector('#follow').checked=true;document.querySelector('#save').click();`);
    await waitFor(() => store.value.pet.followMouse);
    for (let direction = 0; direction < 16; direction++) {
      const angle = direction * Math.PI / 8;
      const scale = store.value.pet.scale;
      send(petWindow, 'pet:cursor', { x: (145 + Math.sin(angle) * 120) * scale, y: (210 - Math.cos(angle) * 120) * scale });
      const expected = `${-(direction % 8) * 192}px ${-(9 + Math.floor(direction / 8)) * 208}px`;
      await waitFor(() => petWindow.webContents.executeJavaScript(`document.querySelector('#sprite').style.backgroundPosition === ${JSON.stringify(expected)}`));
    }
    themeChecks.push({lookDirections: 16, waving: true, pass: true});
    await saveTheme('openai', 'gpt-6.1-sol', 'dragon');
    fs.writeFileSync(path.join(dataRoot, 'dragon-pet.png'), (await petWindow.webContents.capturePage()).toPNG());
    await saveTheme('custom', 'gateway/DeepSeek-V4-Pro', 'whale');
    await saveTheme('custom', 'gateway/codex-latest', 'dragon');

    const profiles = {
      whale: {name:'鲸鲸测试',systemPrompt:'鲸鱼性格：活泼、爱吃白米饭。',greetings:['鲸鱼独立互动台词']},
      dragon: {name:'龙龙测试',systemPrompt:'龙娘性格：沉稳、耐心。',greetings:['龙娘独立互动台词']},
    };
    const drafts = await panelWindow.webContents.executeJavaScript(String.raw`(() => {
      const profiles = ${JSON.stringify(profiles)};
      const choose = id => { const provider=document.querySelector('#provider');provider.value=id;provider.dispatchEvent(new Event('change')); };
      const edit = profile => { document.querySelector('#pet-name').value=profile.name;document.querySelector('#personality').value=profile.systemPrompt;document.querySelector('#greetings').value=profile.greetings.join('\n'); };
      const read = () => ({name:document.querySelector('#pet-name').value,systemPrompt:document.querySelector('#personality').value,greetings:document.querySelector('#greetings').value.split('\n')});
      choose('deepseek');edit(profiles.whale);choose('openai');edit(profiles.dragon);choose('deepseek');
      const whale=read();choose('openai');const dragon=read();document.querySelector('#save').click();return {whale,dragon};
    })()`);
    await waitFor(() => store.value.characters.whale.name === profiles.whale.name && store.value.characters.dragon.name === profiles.dragon.name && store.value.chat.provider === 'openai');
    const reloaded = new ConfigStore(configPath, path.join(appRoot, 'config.example.json')).value;
    for (const id of ['dragon','whale']) {
      if (JSON.stringify(drafts[id]) !== JSON.stringify(profiles[id]) || JSON.stringify(reloaded.characters[id]) !== JSON.stringify(profiles[id])) throw new Error('角色草稿或独立保存验证失败');
    }
    for (const [model, expected] of [['gateway/DeepSeek-V4-Pro','whale'],['gateway/codex-latest','dragon']]) {
      await saveTheme('custom', model, expected);
      interaction();
      await waitFor(() => petWindow.webContents.executeJavaScript(`document.querySelector('#bubble').textContent === ${JSON.stringify(profiles[expected].greetings[0])}`));
      const before = history.messages.length;
      await panelWindow.webContents.executeJavaScript(`document.querySelector('#message').value='你现在是谁？';document.querySelector('#send').click();`);
      await waitFor(() => history.messages.length === before + 2 && !request);
      const latestName = await panelWindow.webContents.executeJavaScript(`[...document.querySelectorAll('.message.assistant .message-label')].at(-1).textContent`);
      if (latestName !== profiles[expected].name || history.messages.at(-1).characterName !== profiles[expected].name) throw new Error('回复角色名字验证失败');
      await clearAndCheckWelcome();
    }
    themeChecks.push({independentProfiles:true,unsavedDrafts:true,profileReload:true,interactionBubbles:true,apiPersonalities:true,replyNames:true,pass:true});
    await saveTheme('custom', initialModel, initialModel.startsWith('deepseek') ? 'whale' : 'dragon');
  }
  showPanel('settings');
  await panelWindow.webContents.executeJavaScript('document.querySelector(".settings-body").scrollTop=document.querySelectorAll(".card")[1].offsetTop-120;');
  await new Promise(resolve => setTimeout(resolve, 1200));
  const image = await panelWindow.webContents.capturePage();
  fs.writeFileSync(path.join(dataRoot, 'panel-smoke.png'), image.toPNG());
  const petImage = await petWindow.webContents.capturePage();
  fs.writeFileSync(path.join(dataRoot, 'pet-smoke.png'), petImage.toPNG());
  const pass = checks[0].loaded === 'true' && !checks.some(c => c.error) && checks[1].provider === store.value.chat.provider && checks[1].name === bootCharacterName && checks[1].reasoning === (store.value.providers[store.value.chat.provider].reasoning?.effort || 'default') && (!checks[2] || (checks[2].reply === '我在呢，今天也一起慢慢来。' && checks[3].historyAfterFailure === checks[2].history));
  const windowLevels = { pet: petWindow.isAlwaysOnTop(), panel: panelWindow.isAlwaysOnTop() };
  const report = { pass: pass && themeChecks.every(check => check.pass) && windowLevels.pet === store.value.pet.alwaysOnTop && !windowLevels.panel, checks, themeChecks, windowLevels, petBounds: petWindow.getBounds(), petVisible: petWindow.isVisible(), runtime };
  atomicWrite(path.join(dataRoot, 'smoke-report.json'), report);
  log(`UI smoke completed: ${report.pass ? 'PASS' : 'FAIL'}`);
  process.exitCode = report.pass ? 0 : 1;
  quitting = true; app.quit();
}

if (ownLock) app.whenReady().then(async () => {
  app.setAppUserModelId('com.dragondesk.pet');
  try {
    store = new ConfigStore(configPath, path.join(appRoot, 'config.example.json'));
    history = new History(path.join(dataRoot, 'history.json'));
    if (!store.value.chat.saveHistory) history.messages = [];
    setupIPC(); createWindows(); applyConfig({ startup: true });
    unwatch = store.watch(() => applyConfig({ startup: true }), error => { runtime.error = error.message; broadcast('runtime:updated', runtime); });
    app.on('second-instance', () => { showPet(); showPanel('chat'); });
    app.on('activate', () => showPet());
    screen.on('display-removed', () => { const p = clampPoint(petWindow.getBounds(), petSize()); petWindow.setPosition(p.x, p.y); });
    log('DragonDesk started. API-only runtime.');
    if (smoke) {
      await Promise.all([new Promise(resolve => petWindow.webContents.once('did-finish-load', resolve)), new Promise(resolve => panelWindow.webContents.once('did-finish-load', resolve))]);
      await new Promise(resolve => setTimeout(resolve, 1000)); await smokeTest();
    }
  } catch (error) {
    quitting = true;
    if (smoke) { console.error(error); process.exit(1); }
    else { dialog.showErrorBox('DragonDesk 无法启动', `${error.message}\n\n配置：${configPath}`); app.quit(); }
  }
});
app.on('window-all-closed', () => {});
app.on('before-quit', () => { quitting = true; request?.controller.abort(new Error('程序已退出')); });
app.on('will-quit', () => { clearInterval(cursorTimer); clearInterval(idleTimer); clearTimeout(positionTimer); unwatch?.(); globalShortcut.unregisterAll(); tray?.destroy(); });
