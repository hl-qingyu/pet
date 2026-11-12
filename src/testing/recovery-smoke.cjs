async function smokePetRecovery({ petWindow, panelWindow, store, showPet, waitFor, getState }) {
  const expected = JSON.stringify(store.value), position = petWindow.getBounds();
  showPet();
  const crash = async () => {
    const before = petWindow.webContents.getOSProcessId();
    petWindow.webContents.forcefullyCrashRenderer();
    await waitFor(() => !petWindow.webContents.isDestroyed() && !petWindow.webContents.isLoading() &&
      petWindow.webContents.getOSProcessId() !== 0 && petWindow.webContents.getOSProcessId() !== before &&
      petWindow.webContents.executeJavaScript(`document.querySelector('#sprite').dataset.loaded === 'true'`).catch(() => false));
  };
  await crash();
  if (!petWindow.isVisible() || petWindow.isAlwaysOnTop() !== store.value.pet.alwaysOnTop) throw new Error('桌宠崩溃恢复后应保持显示与置顶状态');
  const current = petWindow.getBounds();
  if (current.x !== position.x || current.y !== position.y) throw new Error('崩溃恢复不得移动桌宠');
  const state = await petWindow.webContents.executeJavaScript(`window.dragon.invoke('bootstrap').then(x => x.state)`);
  if (state !== getState()) throw new Error('崩溃恢复应继续使用主进程的当前动画状态');
  petWindow.hide(); await crash();
  if (petWindow.isVisible()) throw new Error('隐藏的桌宠崩溃恢复后应保持隐藏');
  showPet();
  if (JSON.stringify(store.value) !== expected) throw new Error('崩溃恢复不得修改配置');
  if (!await panelWindow.webContents.executeJavaScript('Boolean(window.dragon)')) throw new Error('桌宠崩溃不得影响设置窗口');
  return { petRendererCrashRecovered: true, hiddenPetStaysHidden: true, configAndPositionRetained: true,
    animationStateRetained: true, panelUnaffected: true, pass: true };
}
module.exports = { smokePetRecovery };
