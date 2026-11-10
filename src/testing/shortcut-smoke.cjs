const fs = require('node:fs');
const path = require('node:path');

async function smokeShortcutRecording({ panelWindow, petWindow, store, globalShortcut, showPanel, waitFor, getRecording, getCurrentShortcut, dataRoot }) {
  const execute = code => panelWindow.webContents.executeJavaScript(code);
  const original = store.value.shortcuts.togglePet;
  const first = 'Control+Alt+Shift+F23', second = 'Control+Alt+Shift+F24', conflict = 'Control+Alt+Shift+F21';
  const check = (value, message) => { if (!value) throw new Error(message); };
  const save = async value => {
    await execute(`document.querySelector('#shortcut').value=${JSON.stringify(value)};document.querySelector('#shortcut').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#save').click();`);
    await waitFor(() => store.value.shortcuts.togglePet === value);
    await waitFor(() => execute(`!document.querySelector('#save').disabled`));
  };
  const start = async () => {
    showPanel('settings'); panelWindow.focus();
    await waitFor(() => panelWindow.isFocused());
    await waitFor(() => execute(`!document.querySelector('#shortcut').readOnly`));
    await execute(`document.querySelector('#shortcut-record').scrollIntoView({block:'center'});document.querySelector('#shortcut-record').click();`);
    await waitFor(() => getRecording() && getCurrentShortcut() === '');
    await waitFor(() => execute(`document.querySelector('#shortcut-hint').textContent.includes('请按下组合键')`));
  };
  const input = (type, keyCode, modifiers = []) => panelWindow.webContents.sendInputEvent({ type, keyCode, modifiers });
  const record = async key => {
    await start();
    input('keyDown', key, ['control', 'alt', 'shift']);
    await waitFor(() => execute(`document.querySelector('#shortcut').value===${JSON.stringify('Control+Alt+Shift+' + key)}`));
    check(getRecording(), '主键松开前不应提前恢复全局快捷键');
    input('keyUp', key, ['control', 'alt', 'shift']);
    await waitFor(() => !getRecording());
  };
  showPanel('settings');
  await execute(`document.querySelector('.nav[data-page="settings"]').click();`);
  try {
    await save(first); check(globalShortcut.isRegistered(first), '测试快捷键注册失败');
    const visible = petWindow.isVisible();
    await record('F23');
    check(globalShortcut.isRegistered(first) && petWindow.isVisible() === visible && panelWindow.isVisible(), '录制原快捷键时不应触发显示隐藏');
    await record('F24');
    check(store.value.shortcuts.togglePet === first && getCurrentShortcut() === first, '未保存的录制结果不应替换原快捷键');
    await execute(`document.querySelector('#save').click();`);
    await waitFor(() => store.value.shortcuts.togglePet === second);
    check(globalShortcut.isRegistered(second) && !globalShortcut.isRegistered(first), '保存后快捷键没有切换');

    await start(); input('keyDown', 'Control', ['control']); input('keyUp', 'Control');
    await waitFor(() => execute(`document.querySelector('#shortcut-hint').textContent.includes('继续按下')`));
    check(getRecording(), '单独修饰键不能结束录制');
    input('keyDown', 'Escape'); input('keyUp', 'Escape'); await waitFor(() => !getRecording());
    check(globalShortcut.isRegistered(second), 'Esc 取消后未恢复快捷键');

    const draft = 'Control+Alt+Shift+F22';
    await execute(`document.querySelector('#shortcut').value=${JSON.stringify(draft)};document.querySelector('#shortcut').dispatchEvent(new Event('input',{bubbles:true}));`);
    await start(); input('keyDown', 'K', ['control', 'alt']);
    await waitFor(() => execute(`document.querySelector('#shortcut').value==='Control+Alt+K'`));
    await execute(`document.querySelector('#shortcut-cancel').click();`);
    input('keyUp', 'K', ['control', 'alt']); await waitFor(() => !getRecording());
    check(await execute(`document.querySelector('#shortcut').value===${JSON.stringify(draft)}`), '取消录制没有恢复原编辑值');

    await start(); petWindow.show(); petWindow.focus();
    await waitFor(() => !panelWindow.isFocused()); await waitFor(() => !getRecording());
    check(globalShortcut.isRegistered(second), '失焦后未恢复快捷键');
    await start(); panelWindow.hide(); await waitFor(() => !getRecording());
    check(globalShortcut.isRegistered(second), '隐藏窗口后未恢复快捷键');
    showPanel('settings');
    await waitFor(() => execute(`!document.querySelector('#shortcut').readOnly`));

    check(globalShortcut.register(conflict, () => {}), '冲突测试快捷键注册失败');
    await save(conflict);
    check(getCurrentShortcut() === '', '被占用的快捷键不应被当成注册成功');
    await waitFor(() => execute(`document.querySelector('#shortcut-status').textContent.includes('被占用')`));
    globalShortcut.unregister(conflict);
    await execute(`document.querySelector('#shortcut-clear').click();document.querySelector('#save').click();`);
    await waitFor(() => store.value.shortcuts.togglePet === '');
    check(getCurrentShortcut() === '', '清空并保存后应禁用快捷键');
    await waitFor(() => execute(`document.querySelector('#shortcut-status').textContent.includes('未设置')`));
    await save(first);
    await execute(`document.querySelector('#shortcut-record').scrollIntoView({block:'center'});`);
    await new Promise(resolve => setTimeout(resolve, 180));
    fs.writeFileSync(path.join(dataRoot, 'shortcut-settings-smoke.png'), (await panelWindow.webContents.capturePage()).toPNG());
    return { shortcutRecording: true, releaseBeforeRestore: true, savedOnly: true, modifierRejected: true, escapeCancel: true,
      cancelRestoresDraft: true, blurRestoresShortcut: true, hideRestoresShortcut: true, conflictsReported: true, clearDisables: true, pass: true };
  } finally {
    globalShortcut.unregister(conflict);
    showPanel('settings');
    await execute(`document.querySelector('#shortcut-cancel').click();`);
    await waitFor(() => !getRecording());
    await save(original);
  }
}
module.exports = { smokeShortcutRecording };
