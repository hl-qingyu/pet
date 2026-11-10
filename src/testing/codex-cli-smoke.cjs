const fs = require('node:fs');
const path = require('node:path');

async function smokeCodexCli({ panelWindow, store, applyConfig, waitFor, getObservers, getState, getRuntime, openaiFixture, dataRoot, appRoot, saveTheme }) {
  const root = path.join(dataRoot, 'cli-fixture'), file = path.join(root, 'rollout-smoke.jsonl');
  fs.mkdirSync(root, { recursive: true });
  let cliTurn = 'smoke-turn';
  const event = (type, turn = cliTurn) => ({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type, turn_id: turn } });
  fs.writeFileSync(file, [
    { type: 'session_meta', payload: { id: 'smoke-chat', source: 'vscode', originator: 'codex-tui', thread_source: 'user',
      cwd: appRoot, base_instructions: { text: 'PRIVATE_CLI_TEXT' } } },
    event('task_started'),
  ].map(value => JSON.stringify(value) + '\n').join(''));
  const append = type => fs.appendFileSync(file, JSON.stringify(event(type)) + '\n');
  const saveSources = async (desktop, cli, bubble = true, workspace = appRoot) => {
    await panelWindow.webContents.executeJavaScript(`(() => {
      document.querySelector('.nav[data-page="settings"]').click();
      document.querySelector('#openai-enabled').checked=${desktop};
      document.querySelector('#cli-enabled').checked=${cli};
      document.querySelector('#cli-bubble').checked=${bubble};
      document.querySelector('#cli-workspace').value=${JSON.stringify(workspace)};
      document.querySelector('#cli-root').value=${JSON.stringify(root)};
      document.querySelector('#save').click();
    })()`);
    await waitFor(() => store.value.integrations.openai.enabled === desktop && store.value.integrations.codexCli.enabled === cli &&
      store.value.integrations.codexCli.showBubble === bubble && store.value.integrations.codexCli.workspace === workspace);
    await waitFor(() => panelWindow.webContents.executeJavaScript(`!document.querySelector('#save').disabled`));
  };
  if (getObservers().cli) throw new Error('CLI 应默认关闭');
  const originalKey = store.value.providers[store.value.chat.provider].apiKey;
  store.save({ ...store.value, providers: { ...store.value.providers, [store.value.chat.provider]: {
    ...store.value.providers[store.value.chat.provider], apiKey: '' } } }); applyConfig();
  await saveSources(true, true);
  await waitFor(() => getObservers().desktop && getObservers().cli && getRuntime().codexCli.count === 1);
  await waitFor(() => getState() === 'waiting' && getRuntime().openaiSummary.count === 1);
  const desktop = getObservers().desktop, cli = getObservers().cli;
  await saveSources(true, false);
  await waitFor(() => !getObservers().cli && getState() === 'waiting');
  if (getObservers().desktop !== desktop) throw new Error('关闭 CLI 不应重启桌面端监听');
  await saveSources(true, true);
  await waitFor(() => getObservers().cli && getRuntime().codexCli.count === 1);
  const cliOnly = getObservers().cli;
  await saveSources(false, true);
  await waitFor(() => !getObservers().desktop && getState() === 'running');
  if (getObservers().cli !== cliOnly) throw new Error('关闭桌面端不应重启 CLI 监听');
  await saveSources(false, true, false);
  await waitFor(() => getObservers().cli?.options.showBubble === false && getRuntime().codexCli.count === 1 && getState() === 'running');
  append('task_complete'); await waitFor(() => getState() === 'review');
  cliTurn = 'cli-turn-b'; append('task_started'); await waitFor(() => getState() === 'running');
  openaiFixture.state.turns[0].turnId = cliTurn;
  openaiFixture.update('running', ['ignored']);
  await saveSources(false, true, true, appRoot + '-neighbor');
  await waitFor(() => getRuntime().codexCli.count === 0 && getState() === 'idle');
  await saveSources(true, true);
  await waitFor(() => getState() === 'waiting' && getRuntime().openaiSummary.count === 1);
  await saveTheme('custom', 'deepseek-mock-model', 'whale');
  await waitFor(() => !getObservers().desktop && !getObservers().cli);
  await saveTheme('custom', 'gpt-mock-model', 'dragon');
  await waitFor(() => getObservers().desktop && getObservers().cli && getState() === 'waiting');
  if (cli.active || JSON.stringify(getRuntime()).includes('PRIVATE_CLI_TEXT')) throw new Error('旧 CLI 或正文未正确清理');
  await panelWindow.webContents.executeJavaScript(`document.querySelector('#cli-status').scrollIntoView({block:'center'});`);
  fs.writeFileSync(path.join(dataRoot, 'dual-source-details-smoke.png'), (await panelWindow.webContents.capturePage()).toPNG());
  await panelWindow.webContents.executeJavaScript(`document.querySelector('#openai-integration-card').scrollIntoView({block:'start'});`);
  fs.writeFileSync(path.join(dataRoot, 'dual-source-settings-smoke.png'), (await panelWindow.webContents.capturePage()).toPNG());
  openaiFixture.update('completed'); await waitFor(() => getState() === 'review');
  openaiFixture.update('running', ['again']); await waitFor(() => getState() === 'waiting');
  await saveSources(false, false);
  await waitFor(() => !getObservers().desktop && !getObservers().cli);
  openaiFixture.update('completed');
  Object.assign(openaiFixture.state.turns[0], { turnId: 'older-desktop-turn', turnStartedAtMs: Date.now() - 20000, durationMs: 1000 });
  cliTurn = 'recovered-turn';
  fs.writeFileSync(file, [
    { type: 'session_meta', payload: { id: 'smoke-chat', source: 'cli', cwd: appRoot } },
    { timestamp: new Date(Date.now() - 1000).toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: cliTurn } },
    { type: 'response_item', payload: { content: 'PRIVATE_LARGE_LOG'.repeat(24000) } },
    event('item_completed'),
  ].map(value => JSON.stringify(value) + '\n').join(''));
  await saveSources(true, true);
  await waitFor(() => getRuntime().codexCli.count === 1 && getRuntime().openai.count === 1 && getState() === 'running');
  if ([...getObservers().cli.sessions.values()][0]?.startedAt !== 0 || getRuntime().openaiSummary.count !== 1) {
    throw new Error('大日志恢复及会话去重验证失败');
  }
  append('task_complete'); await waitFor(() => getState() === 'review');
  await saveSources(false, false);
  await waitFor(() => !getObservers().desktop && !getObservers().cli && getState() === 'idle');
  store.save({ ...store.value, providers: { ...store.value.providers, [store.value.chat.provider]: {
    ...store.value.providers[store.value.chat.provider], apiKey: originalKey } } }); applyConfig();
  return { cliDefaultOff: true, allSourceSelections: true, noApiRequired: true, unchangedSourceRetained: true,
    deduplicatedSessions: true, cliCompletion: true, cliWorkspace: true, dualRoleSwitch: true, largeLogRecovery: true, pass: true };
}
module.exports = { smokeCodexCli };
