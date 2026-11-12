const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, globalShortcut, screen, shell, dialog, powerMonitor } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { ConfigStore, atomicWrite } = require('./config.cjs');
const { History } = require('./history.cjs');
const { streamReply, userError } = require('./backends/api.cjs');
const { resolve: resolveTheme, character: getCharacter, integration: selectedIntegration } = require('../renderer/themes.js');
const { PetState } = require('./pet-state.cjs');
const { OpenaiStatus } = require('./backends/openai-status.cjs');
const { source: providerSource } = require('../renderer/provider-source.js');
const { Sub2apiQuota } = require('./backends/sub2api-quota.cjs');

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
let panelReady = false, panelPending = false, panelCrashed = false;
let quitting = false, currentState = 'idle', panelPage = 'chat', dragOrigin, dragLastCursorX = 0, positionTimer, idleTimer;
let runtime = { shortcut: '', shortcutRecording: false, shortcutRecordingRevision: 0, startup: '', error: '', dsh: { count: 0, degraded: false, message: '未开启' }, openai: { count: 0, degraded: false, message: '未开启' }, codexCli: { count: 0, degraded: false, message: '未开启' } };
let appliedTheme;
let accountSnapshot = null, accountEnabled = false;
let dshAccountSnapshot = null, sub2apiSnapshot = null;
function publishAccount() {
  const provider = store?.value.providers[store.value.chat.provider];
  accountSnapshot = provider && providerSource(provider) === 'sub2api' ? sub2apiSnapshot : dshAccountSnapshot;
  broadcast('dsh:account', accountSnapshot);
}
const dshAccount = new (require('./backends/dsh-account.cjs').DshAccount)(value => { dshAccountSnapshot = value && { ...value, source: 'dsh' }; publishAccount(); });
const sub2apiQuota = new Sub2apiQuota(value => { sub2apiSnapshot = value; publishAccount(); });
let shortcutRecording = false, shortcutRecordingRevision = 0, shortcutRecordingTimer;
let dshObserver, openaiObserver, cliObserver, integrationStopping = Promise.resolve();
const integrationSlots = new Map(), openaiStatus = new OpenaiStatus();
let dshSnapshot = { state: 'idle' };
const petState = new PetState(payload => { currentState = payload.state; broadcast('pet:state', payload); }, () => Boolean(request));

function log(message) {
  fs.appendFileSync(path.join(dataRoot, 'logs', 'app.log'), `${new Date().toISOString()} ${message}\n`);
}
function send(window, channel, value) { if (window && !window.isDestroyed() && !window.webContents.isLoading()) window.webContents.send(channel, value); }
function broadcast(channel, value) { send(petWindow, channel, value); send(panelWindow, channel, value); }
function status(state, bubble, resetMs = 0) { petState.local(state, bubble, resetMs); }
function refreshExternal() {
  const combined = openaiStatus.snapshot();
  runtime.openaiSummary = { ...combined.info, message: selectedIntegration(store.value) !== 'openai' ? '' :
    store.value.integrations.openai.enabled || store.value.integrations.codexCli.enabled ? combined.info.message : '未开启监听' };
  petState.external(selectedIntegration(store.value) === 'dsh' ? dshSnapshot : combined);
}
function applyIntegration() {
  const selected = selectedIntegration(store.value), integrations = store.value.integrations;
  const provider = store.value.providers[store.value.chat.provider];
  const hasApi = Boolean(provider?.apiKey?.trim() && provider?.baseUrl?.trim() && provider?.model?.trim());
  const isSub2api = providerSource(provider) === 'sub2api';
  const showAccount = !isSub2api && selected === 'dsh' && hasApi && integrations.dsh.showAccount === true && !smoke;
  const accountKey = JSON.stringify([showAccount, integrations.dsh.balanceWarning ?? 0]);
  if (accountKey !== accountEnabled) { accountEnabled = accountKey; dshAccount.configure(showAccount, integrations.dsh.balanceWarning ?? 0); }
  sub2apiQuota.configure(provider, store.value.chat.provider);
  publishAccount();
  const pending = [], stops = [];
  for (const id of ['dsh', 'openai', 'codexCli']) {
    const options = integrations[id], appropriate = (selected === 'dsh') === (id === 'dsh');
    const enabled = appropriate && options.enabled && (id !== 'dsh' || hasApi);
    const key = enabled ? JSON.stringify(options) : '';
    const previous = integrationSlots.get(id);
    if (!enabled) runtime[id] = { count: 0, degraded: false, message: !appropriate && options.enabled ?
      `已启用，切换到${id === 'dsh' ? '鲸鱼娘' : '龙娘'}后监听` : appropriate && options.enabled && id === 'dsh' && !hasApi ?
        '未配置 API，运行状态监听已停止' : '未开启' };
    if (previous?.key === key) continue;
    const slot = { key, observer: null }; integrationSlots.set(id, slot);
    if (previous?.observer) stops.push(previous.observer.stop());
    if (id === 'dsh') { dshObserver = null; dshSnapshot = { state: 'idle' }; }
    else { openaiStatus.clear(id); if (id === 'openai') openaiObserver = null; else cliObserver = null; }
    if (!enabled) continue;
    runtime[id] = { count: 0, degraded: false, message: id === 'dsh' ? '等待 DSH 会话……' : id === 'openai' ?
      '等待 ChatGPT 桌面端连接……' : '等待 CLI 会话日志……' };
    pending.push({ id, slot, options });
  }
  // Keep unchanged sources alive. Role changes wait until all obsolete readers stop.
  integrationStopping = Promise.all([integrationStopping, ...stops]).then(() => {}, () => {});
  petState.enable(selected === 'dsh' ? integrations.dsh.enabled && hasApi : integrations.openai.enabled || integrations.codexCli.enabled);
  refreshExternal(); broadcast('runtime:updated', runtime);
  for (const { id, slot, options } of pending) integrationStopping.then(() => {
    if (quitting || integrationSlots.get(id) !== slot) return;
    const Observer = id === 'dsh' ? require('./backends/dsh-observer.cjs').DshObserver : id === 'openai' ?
      require('./backends/openai-observer.cjs').OpenaiObserver : require('./backends/codex-cli-observer.cjs').CodexCliObserver;
    const observer = new Observer(options, snapshot => {
      if (quitting || integrationSlots.get(id) !== slot) return;
      const before = JSON.stringify([runtime[id], runtime.openaiSummary]);
      runtime[id] = snapshot.info;
      if (id === 'dsh') dshSnapshot = snapshot; else openaiStatus.update(id, snapshot);
      refreshExternal();
      if (before !== JSON.stringify([runtime[id], runtime.openaiSummary])) broadcast('runtime:updated', runtime);
    });
    slot.observer = observer;
    if (id === 'dsh') dshObserver = observer; else if (id === 'openai') openaiObserver = observer; else cliObserver = observer;
    observer.start();
  }).catch(() => {
    if (quitting || integrationSlots.get(id) !== slot) return;
    runtime[id] = { count: 0, degraded: true, message: '状态来源启动失败' };
    refreshExternal(); broadcast('runtime:updated', runtime);
  });
}

function petSize() { return { width: Math.round(290 * store.value.pet.scale), height: Math.round(420 * store.value.pet.scale) }; }
function clampPoint(point, size) {
  const display = point ? screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) }) : screen.getPrimaryDisplay();
  const a = display.workArea;
  return { x: Math.round(Math.min(Math.max(point?.x ?? a.x + a.width - size.width - 28, a.x), a.x + a.width - size.width)), y: Math.round(Math.min(Math.max(point?.y ?? a.y + a.height - size.height - 20, a.y), a.y + a.height - size.height)) };
}
function restorePetLevel() {
  if (!petWindow || petWindow.isDestroyed() || !store) return;
  const enabled = store.value.pet.alwaysOnTop;
  petWindow.setAlwaysOnTop(enabled, 'floating');
  if (enabled && petWindow.isVisible()) petWindow.moveTop();
}
function showPet() { petWindow.showInactive(); restorePetLevel(); }
function hidePet() { petWindow.hide(); panelWindow?.hide(); }
function togglePet() { petWindow.isVisible() ? hidePet() : showPet(); }
function showPanel(page = 'chat') {
  panelPage = page;
  if (!panelReady) {
    panelPending = true;
    if (panelCrashed) { panelCrashed = false; panelWindow.reload(); }
    return;
  }
  const a = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const bounds = panelWindow.getBounds();
  if (!screen.getAllDisplays().some(d => bounds.x >= d.workArea.x && bounds.x < d.workArea.x + d.workArea.width)) panelWindow.setPosition(a.x + 30, a.y + 30);
  send(panelWindow, 'panel:page', page);
  if (panelWindow.isMinimized()) panelWindow.restore();
  panelWindow.show(); panelWindow.focus();
  send(panelWindow, 'panel:repaint');
}
function interaction(kind = 'pet') {
  const lines = getCharacter(store.value).greetings;
  petState.interact(kind === 'jump' ? 'jumping' : 'waving', lines.length ? lines[Math.floor(Math.random() * lines.length)] : '我在呢。');
}
function setShortcut(accelerator) {
  if (shortcutRecording) return;
  if (accelerator && accelerator === currentShortcut) return;
  if (currentShortcut) globalShortcut.unregister(currentShortcut);
  currentShortcut = '';
  if (!accelerator) { runtime.shortcut = '未设置快捷键，可用托盘显示桌宠'; return; }
  try {
    if (globalShortcut.register(accelerator, togglePet)) { currentShortcut = accelerator; runtime.shortcut = `${accelerator} · 注册成功`; }
    else runtime.shortcut = `${accelerator} 被占用，请换一个组合；托盘仍然可用`;
  } catch { runtime.shortcut = '快捷键格式无效，请检查设置'; }
}
function setShortcutRecording(active) {
  if (typeof active !== 'boolean') throw new Error('录入状态必须是布尔值');
  if (active && (request || !panelWindow?.isVisible())) throw new Error('请先停止回复，并在设置窗口使用键盘录入。');
  if (active === shortcutRecording) return { active, revision: shortcutRecordingRevision };
  shortcutRecording = active; shortcutRecordingRevision++;
  runtime.shortcutRecording = active; runtime.shortcutRecordingRevision = shortcutRecordingRevision;
  clearTimeout(shortcutRecordingTimer); shortcutRecordingTimer = null;
  if (active) {
    if (currentShortcut) globalShortcut.unregister(currentShortcut);
    currentShortcut = '';
    panelWindow.webContents.setIgnoreMenuShortcuts(true);
    runtime.shortcut = '键盘录入中，原快捷键暂时停用';
    shortcutRecordingTimer = setTimeout(() => setShortcutRecording(false), 30000); shortcutRecordingTimer.unref();
  } else {
    if (panelWindow && !panelWindow.isDestroyed() && !panelWindow.webContents.isDestroyed()) panelWindow.webContents.setIgnoreMenuShortcuts(false);
    setShortcut(store.value.shortcuts.togglePet);
  }
  broadcast('runtime:updated', runtime);
  return { active, revision: shortcutRecordingRevision };
}
const LOGIN_ITEM_NAME = 'DragonDesk';
function windowsLoginItemExists(name) {
  try {
    execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', name], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
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
    settings.name = LOGIN_ITEM_NAME;
  }
  // 开启和关闭都必须调用 setLoginItemSettings。关闭时如果先查询再决定是否删除，
  // 旧路径、旧格式或手动写入的登录项会因为查询匹配不上而被漏掉，
  // 出现“设置已关闭但登录时仍自动启动”。
  app.setLoginItemSettings(settings);
  // Windows 直接查注册表，不依赖 getLoginItemSettings 的参数格式匹配。
  const actual = process.platform === 'win32'
    ? windowsLoginItemExists(LOGIN_ITEM_NAME)
    : app.getLoginItemSettings().openAtLogin;
  runtime.startup = actual ? '已开启登录后启动' : '未开启';
  if (enabled !== actual) {
    throw new Error(enabled
      ? '系统没有接受开机自启设置，请检查登录项设置。'
      : '未能移除开机自启项，请手动检查系统登录项。');
  }
}
function applyConfig({ startup = false } = {}) {
  runtime.error = '';
  const config = store.value;
  if (startup) { try { setStartup(config.startup.enabled); } catch (error) { runtime.startup = error.message; } }
  if (petWindow) {
    const size = petSize();
    const point = clampPoint(config.pet.position || petWindow.getBounds(), size);
    petWindow.setBounds({ ...size, ...point });
    restorePetLevel();
  }
  panelWindow?.setAlwaysOnTop(false);
  setShortcut(config.shortcuts.togglePet);
  applyIntegration();
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
function modelMenu() {
  const items = Object.entries(store.value.providers).filter(([, provider]) => provider.model.trim() && provider.baseUrl.trim()).map(([id, provider]) => ({
    label: provider.label + ' · ' + provider.model,
    type: 'radio', checked: store.value.chat.provider === id, enabled: !request,
    click: () => {
      if (request || store.value.chat.provider === id) return;
      try {
        const next = structuredClone(store.value);
        next.chat.provider = id;
        store.save(next); applyConfig();
      } catch { dialog.showErrorBox('切换模型失败', '无法保存模型设置，请检查配置文件后重试。'); }
    },
  }));
  return [...items, ...(items.length ? [{ type: 'separator' }] : []), { label: '配置模型…', click: () => showPanel('settings') }];
}
function contextMenu() {
  return Menu.buildFromTemplate([
    { label: `和${getCharacter(store.value).name}聊天`, click: () => showPanel('chat') },
    { label: '显示 / 隐藏桌宠', click: togglePet },
    { label: '摸摸头', click: () => interaction() },
    { label: '切换模型', submenu: modelMenu() },
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
  handle('bootstrap', () => ({ config: store.value, configPath, runtime, account: accountSnapshot, messages: history.messages, state: currentState, page: panelPage, busy: Boolean(request), platform: process.platform }));
  handle('shortcut:recording', active => setShortcutRecording(active));
  handle('config:save', next => {
    if (request) throw new Error('请先停止当前回复，再修改接口或性格。');
    setShortcutRecording(false);
    const previous = store.value;
    const { validate, migrate } = require('./config.cjs'); next = migrate(next); validate(next);
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
      broadcast('chat:done', { id, text: reply }); status('review', reply.length > 90 ? reply.slice(0, 90) + '…' : reply, 3200);
    } catch (error) {
      const message = userError(error, Object.values(config.providers).map(p => p.apiKey));
      broadcast('chat:error', { id, message }); status(controller.signal.aborted ? 'idle' : 'failed', message.length > 90 ? message.slice(0, 90) + '…' : message, petState.enabled ? 3200 : 0);
    } finally { clearTimeout(timeout); request = null; petState.refresh(); broadcast('chat:idle', { id }); }
    return { id };
  });
  handle('chat:stop', () => request?.controller.abort(new Error('已停止生成。')));
  on('panel:open', page => showPanel(page === 'settings' ? 'settings' : 'chat'));
  on('panel:ready', () => {
    panelReady = true;
    send(panelWindow, 'panel:page', panelPage);
    if (panelPending) { panelPending = false; showPanel(panelPage); }
  });
  on('panel:hide', () => panelWindow.hide());
  on('pet:interact', kind => interaction(kind));
  on('pet:menu', () => contextMenu().popup({ window: petWindow }));
  on('pet:hide', hidePet);
  on('pet:hit', over => { if (typeof over === 'boolean' && !dragOrigin) petWindow.setIgnoreMouseEvents(!over, { forward: true }); });
  on('pet:drag-start', () => { petWindow.setIgnoreMouseEvents(false); dragOrigin = { cursor: screen.getCursorScreenPoint(), bounds: petWindow.getBounds() }; dragLastCursorX = dragOrigin.cursor.x; });
  on('pet:drag', () => {
    if (!dragOrigin) return;
    const cursor = screen.getCursorScreenPoint();
    // 用系统光标坐标判断方向：窗口跟随拖动时会改变指针在窗口内的坐标，
    // 渲染进程的 screenX 增量在窗口追上光标的过程中会抖动，导致停下后误判为向右。
    const step = cursor.x - dragLastCursorX;
    if (Math.abs(step) >= 3) {
      send(petWindow, 'pet:drag-direction', step < 0 ? 'running-left' : 'running-right');
      dragLastCursorX = cursor.x;
    }
    const point = clampPoint({ x: dragOrigin.bounds.x + cursor.x - dragOrigin.cursor.x, y: dragOrigin.bounds.y + cursor.y - dragOrigin.cursor.y }, petSize());
    petWindow.setPosition(point.x, point.y);
  });
  on('pet:drag-end', () => { dragOrigin = null; persistPosition(); restorePetLevel(); });
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
  panelWindow = new BrowserWindow({ width: 940, height: 740, minWidth: 760, minHeight: 580, title: 'DragonDesk · 聊天与设置', backgroundColor: '#f8f7fc', show: false, autoHideMenuBar: true, icon: path.join(appRoot, 'assets/icon.png'), webPreferences: { ...webPreferences, backgroundThrottling: false } });
  for (const window of [petWindow, panelWindow]) secureWindow(window);
  if (process.platform === 'darwin') petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panelWindow.webContents.on('did-start-loading', () => { panelReady = false; });
  panelWindow.webContents.on('render-process-gone', () => {
    panelReady = false; panelCrashed = true;
    panelPending = panelWindow.isVisible(); panelWindow.hide();
    if (panelPending && !quitting) { panelCrashed = false; panelWindow.reload(); }
  });
  panelWindow.on('close', event => { if (!quitting) { event.preventDefault(); panelWindow.hide(); } });
  for (const event of ['blur', 'hide']) panelWindow.on(event, () => setShortcutRecording(false));
  for (const event of ['render-process-gone', 'did-start-loading']) panelWindow.webContents.on(event, () => setShortcutRecording(false));
  petWindow.on('close', event => { if (!quitting) { event.preventDefault(); hidePet(); } });
  petWindow.on('move', persistPosition);
  for (const event of ['show', 'restore', 'blur']) petWindow.on(event, restorePetLevel);
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
    themeChecks.push(await require('./testing/sub2api-quota-smoke.cjs').smokeSub2apiQuota({ store, applyConfig, panelWindow, petWindow, waitFor, dataRoot, showPanel }));
    // Switching the selected model changes only the visible integration form;
    // both forms keep their independent, unsaved values until Save is pressed.
    const integrationForms = await panelWindow.webContents.executeJavaScript(`(() => {
      document.querySelector('.nav[data-page="settings"]').click();
      const selectModel = value => { const input=document.querySelector('#model');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true})); };
      const visible = id => getComputedStyle(document.querySelector(id)).display !== 'none';
      const originalModel=document.querySelector('#model').value;
      const original={enabled:document.querySelector('#dsh-enabled').checked,bubble:document.querySelector('#dsh-bubble').checked,
        root:document.querySelector('#dsh-root').value,workspace:document.querySelector('#dsh-workspace').value,
        openai:document.querySelector('#openai-enabled').checked,openaiBubble:document.querySelector('#openai-bubble').checked,
        openaiWorkspace:document.querySelector('#openai-workspace').value,
        cli:document.querySelector('#cli-enabled').checked,cliBubble:document.querySelector('#cli-bubble').checked,
        cliRoot:document.querySelector('#cli-root').value,cliWorkspace:document.querySelector('#cli-workspace').value};
      selectModel('deepseek-mock-model');
      const deepseekOnly=visible('#dsh-integration-card')&&!visible('#openai-integration-card');
      document.querySelector('#dsh-enabled').checked=true;document.querySelector('#dsh-bubble').checked=false;
      document.querySelector('#dsh-root').value='dsh-draft-root';document.querySelector('#dsh-workspace').value='dsh-draft-workspace';
      selectModel('gpt-mock-model');
      const openaiOnly=visible('#openai-integration-card')&&!visible('#dsh-integration-card');
      document.querySelector('#openai-enabled').checked=false;document.querySelector('#openai-bubble').checked=true;
      document.querySelector('#openai-workspace').value='openai-draft-workspace';
      document.querySelector('#cli-enabled').checked=true;document.querySelector('#cli-bubble').checked=false;
      document.querySelector('#cli-root').value='cli-draft-root';document.querySelector('#cli-workspace').value='cli-draft-workspace';
      selectModel('deepseek-mock-model');
      const dshDraft=document.querySelector('#dsh-enabled').checked&&!document.querySelector('#dsh-bubble').checked&&
        document.querySelector('#dsh-root').value==='dsh-draft-root'&&document.querySelector('#dsh-workspace').value==='dsh-draft-workspace';
      selectModel('gateway/codex-latest');
      const openaiDraft=!document.querySelector('#openai-enabled').checked&&document.querySelector('#openai-bubble').checked&&
        document.querySelector('#openai-workspace').value==='openai-draft-workspace'&&visible('#openai-integration-card')&&!visible('#dsh-integration-card');
      const cliDraft=document.querySelector('#cli-enabled').checked&&!document.querySelector('#cli-bubble').checked&&
        document.querySelector('#cli-root').value==='cli-draft-root'&&document.querySelector('#cli-workspace').value==='cli-draft-workspace';
      document.querySelector('#dsh-enabled').checked=original.enabled;document.querySelector('#dsh-bubble').checked=original.bubble;
      document.querySelector('#dsh-root').value=original.root;document.querySelector('#dsh-workspace').value=original.workspace;
      document.querySelector('#openai-enabled').checked=original.openai;document.querySelector('#openai-bubble').checked=original.openaiBubble;
      document.querySelector('#openai-workspace').value=original.openaiWorkspace;
      document.querySelector('#cli-enabled').checked=original.cli;document.querySelector('#cli-bubble').checked=original.cliBubble;
      document.querySelector('#cli-root').value=original.cliRoot;document.querySelector('#cli-workspace').value=original.cliWorkspace;
      selectModel(originalModel);document.querySelector('#save').click();
      return {deepseekOnly,openaiOnly,dshDraft,openaiDraft,cliDraft};
    })()`);
    await waitFor(() => panelWindow.webContents.executeJavaScript(`!document.querySelector('#save').disabled && document.querySelector('#settings-message').textContent.includes('已保存')`));
    if (!Object.values(integrationForms).every(Boolean)) throw new Error('按模型显示监听配置或独立草稿验证失败');
    themeChecks.push({integrationFormsByModel:true,independentIntegrationDrafts:true,pass:true});
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
      const pet = await readTheme(petWindow, '#sprite-art'), panel = await readTheme(panelWindow, '.portrait-sprite');
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
    const unchanged = await readTheme(petWindow, '#sprite-art');
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
      // Gaze frames apply while the visible pet is not hovered. Reset native
      // window/pointer state before supplying each synthetic cursor direction.
      showPet();
      await petWindow.webContents.executeJavaScript(`document.querySelector('#sprite').dispatchEvent(new PointerEvent('pointerleave'));`);
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
    // Exercise the actual settings -> observer -> arbitration -> renderer chain.
    const dshRoot = path.join(dataRoot, 'dsh-sessions');
    const dshDirectory = path.join(dshRoot, 'workspace', 'session-smoke');
    fs.mkdirSync(dshDirectory, { recursive: true });
    const dshFile = path.join(dshDirectory, 'session.v4.jsonl.zstd');
    fs.writeFileSync(dshFile, Buffer.alloc(0));
    let dshSeq = 0;
    const appendDsh = (type, data = {}) => fs.appendFileSync(dshFile, require('node:zlib').zstdCompressSync(Buffer.from(JSON.stringify({ type, seq: ++dshSeq, time: Date.now(), data }) + '\n')));
    const saveDsh = async (enabled, bubbles = true) => {
      showPanel('settings');
      await panelWindow.webContents.executeJavaScript(`(() => {
        if(getComputedStyle(document.querySelector('#dsh-integration-card')).display==='none')throw new Error('DSH 配置不应在当前模型下隐藏');
        document.querySelector('#dsh-enabled').checked=${enabled};
        document.querySelector('#dsh-bubble').checked=${bubbles};
        document.querySelector('#dsh-root').value=${JSON.stringify(dshRoot)};
        document.querySelector('#save').click();
      })()`);
      await waitFor(() => store.value.integrations.dsh.enabled === enabled && store.value.integrations.dsh.showBubble === bubbles);
    };
    if (dshObserver || runtime.dsh.message !== '未开启') throw new Error('DSH 默认关闭验证失败');
    await saveTheme('custom', 'deepseek-mock-model', 'whale');
    status('idle'); appendDsh('turn/start', { turn: 1 });
    await saveDsh(true);
    await waitFor(() => currentState === 'running' && runtime.dsh.count === 1);
    appendDsh('approval/asked', { approvalId: 'one' }); appendDsh('approval/asked', { approvalId: 'two' });
    await waitFor(() => currentState === 'waiting');
    appendDsh('approval/decided', { approvalId: 'one' });
    await waitFor(() => [...dshObserver.sessions.values()][0]?.seq >= 4);
    if (currentState !== 'waiting') throw new Error('并发审批提前解除');
    showPanel('chat');
    await panelWindow.webContents.executeJavaScript(`document.querySelector('#message').value='DSH 仲裁测试';document.querySelector('#send').click();`);
    await waitFor(() => Boolean(request) && currentState === 'running');
    await waitFor(() => !request && currentState === 'waiting');
    interaction(); await waitFor(() => currentState === 'waving');
    await waitFor(() => currentState === 'waiting');
    await saveDsh(true, false);
    await waitFor(() => currentState === 'waiting' && dshObserver?.options.showBubble === false);
    await waitFor(() => petWindow.webContents.executeJavaScript(`!document.querySelector('#bubble').classList.contains('visible')`));
    appendDsh('approval/decided', { approvalId: 'two' }); await waitFor(() => currentState === 'running');
    appendDsh('turn/end', { turn: 1, reason: { kind: 'completed' } });
    await waitFor(() => currentState === 'review'); await waitFor(() => currentState === 'idle');
    appendDsh('turn/start', { turn: 2 }); appendDsh('turn/end', { turn: 2, reason: { kind: 'error' } });
    await waitFor(() => currentState === 'failed');
    showPanel('settings');
    await panelWindow.webContents.executeJavaScript(`document.querySelector('#dsh-status').scrollIntoView({block:'center'});`);
    fs.writeFileSync(path.join(dataRoot, 'dsh-settings-smoke.png'), (await panelWindow.webContents.capturePage()).toPNG());
    await saveDsh(false);
    await waitFor(() => !dshObserver && runtime.dsh.message === '未开启' && currentState === 'idle');
    appendDsh('turn/start', { turn: 3 });
    await new Promise(resolve => setTimeout(resolve, 700));
    if (currentState !== 'idle' || dshObserver) throw new Error('关闭后仍在跟随 DSH');
    themeChecks.push({ dshDefaultOff: true, dshSettings: true, concurrentApprovals: true, chatPriority: true,
      interactionRestored: true, bubbleOff: true, completion: true, failure: true, dshStopped: true, pass: true });
    await saveTheme('custom', 'gpt-mock-model', 'dragon');
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\dragon-openai-smoke-${process.pid}` : path.join(require('node:os').tmpdir(), `dragon-openai-smoke-${process.pid}.sock`);
    const openaiFixture = await require('./testing/openai-fixture.cjs').createOpenaiFixture(endpoint, { hostId: 'local', cwd: appRoot });
    try {
      store.save({ ...store.value, integrations: { ...store.value.integrations, openai: { ...store.value.integrations.openai, socketPath: endpoint } } }); applyConfig();
      const saveOpenai = async (enabled, bubble = true, workspace = store.value.integrations.openai.workspace) => {
        showPanel('settings');
        await panelWindow.webContents.executeJavaScript(`if(getComputedStyle(document.querySelector('#openai-integration-card')).display==='none')throw new Error('ChatGPT 配置不应在当前模型下隐藏');document.querySelector('#openai-enabled').checked=${enabled};document.querySelector('#openai-bubble').checked=${bubble};document.querySelector('#openai-workspace').value=${JSON.stringify(workspace)};document.querySelector('#save').click();`);
        await waitFor(() => store.value.integrations.openai.enabled === enabled && store.value.integrations.openai.showBubble === bubble && store.value.integrations.openai.workspace === workspace);
      };
      if (openaiObserver || runtime.openai.message !== '未开启') throw new Error('OpenAI 默认关闭验证失败');
      await saveOpenai(true); await waitFor(() => currentState === 'running' && runtime.openai.count === 1);
      const dshWorkspace = store.value.integrations.dsh.workspace;
      await saveOpenai(true, true, appRoot + '-other');
      await waitFor(() => [...(openaiObserver?.sessions.values() || [])].some(session => session.summary));
      if (currentState !== 'idle' || runtime.openai.count !== 0 || !runtime.openai.message.includes('匹配工作区')) throw new Error('不匹配工作区的会话不应参与显示');
      await saveOpenai(true, true, path.dirname(appRoot));
      await waitFor(() => currentState === 'running' && runtime.openai.count === 1);
      if (store.value.integrations.dsh.workspace !== dshWorkspace) throw new Error('OpenAI 工作区不应覆盖 DSH 工作区');
      openaiFixture.update('running', ['one', 'two']); await waitFor(() => currentState === 'waiting');
      openaiFixture.update('running', ['two']); await waitFor(() => [...openaiObserver.sessions.values()][0]?.revision === 2);
      if (currentState !== 'waiting') throw new Error('OpenAI 并发输入提前解除');
      interaction(); await waitFor(() => currentState === 'waving'); await waitFor(() => currentState === 'waiting');
      await saveOpenai(true, false);
      await waitFor(() => currentState === 'waiting' && openaiObserver?.options.showBubble === false);
      await waitFor(() => petWindow.webContents.executeJavaScript(`!document.querySelector('#bubble').classList.contains('visible')`));
      openaiFixture.update('completed'); await waitFor(() => currentState === 'review'); await waitFor(() => currentState === 'idle');
      openaiFixture.update('failed'); await waitFor(() => currentState === 'failed');
      if (dshObserver) throw new Error('龙娘不应监听 DSH');
      await saveTheme('custom', 'deepseek-mock-model', 'whale');
      await saveDsh(true, false);
      await waitFor(() => !openaiObserver && dshObserver && currentState === 'running' && openaiFixture.clients.size === 0);
      if (!runtime.openai.message.includes('龙娘')) throw new Error('鲸鱼娘不应监听 OpenAI');
      openaiFixture.update('running', ['ignored']);
      await saveTheme('custom', 'gpt-mock-model', 'dragon');
      await waitFor(() => !dshObserver && openaiObserver && currentState === 'waiting');
      if (JSON.stringify([...openaiObserver.sessions.values()]).includes('PRIVATE_SMOKE_TEXT')) throw new Error('OpenAI 正文不应被保留');
      showPanel('settings'); await panelWindow.webContents.executeJavaScript(`document.querySelector('#openai-status').scrollIntoView({block:'center'});`);
      fs.writeFileSync(path.join(dataRoot, 'openai-settings-smoke.png'), (await panelWindow.webContents.capturePage()).toPNG());
      themeChecks.push(await require('./testing/openai-question-smoke.cjs').smokeOpenaiQuestions({ openaiFixture, petWindow, waitFor,
        getState: () => currentState, getObserver: () => openaiObserver, dataRoot }));
      themeChecks.push(await require('./testing/codex-cli-smoke.cjs').smokeCodexCli({ panelWindow, store, applyConfig, waitFor,
        getObservers: () => ({ desktop: openaiObserver, cli: cliObserver }), getState: () => currentState,
        getRuntime: () => runtime, openaiFixture, dataRoot, appRoot, saveTheme }));
      await saveOpenai(false);
      await saveTheme('custom', 'deepseek-mock-model', 'whale');
      await saveDsh(false);
      await waitFor(() => !dshObserver && !openaiObserver && currentState === 'idle');
      themeChecks.push({ openaiDefaultOff: true, openaiSettings: true, openaiSyntheticLocalProtocol: true,
        openaiWorkspaceFilter: true, independentWorkspaces: true, openaiInput: true, openaiCompletion: true,
        openaiFailure: true, roleBoundSources: true, noTranscriptRetained: true, pass: true });
    } finally { await openaiFixture.close(); }
    await saveTheme('custom', initialModel, initialModel.startsWith('deepseek') ? 'whale' : 'dragon');
    // Focus-changing keyboard tests run after cursor animation checks so their
    // native focus/hover events cannot interfere with the synthetic look input.
    themeChecks.push(await require('./testing/shortcut-smoke.cjs').smokeShortcutRecording({ panelWindow, petWindow, store, globalShortcut,
      showPanel, waitFor, getRecording: () => shortcutRecording, getCurrentShortcut: () => currentShortcut, dataRoot }));
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
    powerMonitor.on('resume', restorePetLevel);
    powerMonitor.on('unlock-screen', restorePetLevel);
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
app.on('before-quit', () => { quitting = true; dshAccount.stop(); sub2apiQuota.stop(); dshObserver?.stop(); openaiObserver?.stop(); cliObserver?.stop(); petState.dispose(); request?.controller.abort(new Error('程序已退出')); });
app.on('will-quit', () => { clearInterval(cursorTimer); clearInterval(idleTimer); clearTimeout(positionTimer); clearTimeout(shortcutRecordingTimer); unwatch?.(); globalShortcut.unregisterAll(); tray?.destroy(); });
