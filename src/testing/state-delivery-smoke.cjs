// Force the precise race: bootstrap returns idle, then activity arrives while
// webContents is still loading and send() cannot deliver the state event.
async function smokeStateDelivery({ petWindow, petState, waitFor, bootstrap, setBootstrap }) {
  const previous = { enabled: petState.enabled, localView: petState.localView, externalView: petState.externalView };
  const checks = [];
  try {
    for (const source of ['openai', 'codexCli', 'dsh']) {
      petState.enable(true); petState.local('idle'); petState.external({ state: 'idle' });
      let injected = false, duringLoad = false;
      setBootstrap(() => {
        const result = bootstrap();
        if (!injected) {
          injected = true; duringLoad = petWindow.webContents.isLoading();
          petState.external({ state: 'running', bubble: `${source} 正在处理……` });
        }
        return result;
      });
      petWindow.reload();
      await waitFor(() => injected && !petWindow.webContents.isLoading());
      try {
        await waitFor(() => petWindow.webContents.executeJavaScript(`state === 'running' && row === 7 && document.querySelector('#sprite').dataset.loaded === 'true'`));
      } catch (error) {
        const view = await petWindow.webContents.executeJavaScript(`({state,row,drag,loaded:document.querySelector('#sprite').dataset.loaded,error:window.__bootError||null})`);
        throw new Error(`状态同步失败：${JSON.stringify({ source, duringLoad, view, main: bootstrap().state, local: petState.localView.state, external: petState.externalView.state })}`, { cause: error });
      }
      if (!duringLoad) throw new Error('未复现加载期间动画广播丢失的竞态');
      checks.push({ source, activityDuringLoad: true, rendererRunning: true });
    }
  } finally {
    setBootstrap(bootstrap);
    petState.localView = previous.localView; petState.externalView = previous.externalView;
    petState.enable(previous.enabled); petState.refresh(true);
  }
  return { externalStateDeliveryAfterLoad: checks, pass: true };
}
module.exports = { smokeStateDelivery };
