const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

async function smokeSub2apiQuota({ store, applyConfig, panelWindow, petWindow, waitFor, dataRoot, showPanel, dshAccount }) {
  const original = structuredClone(store.value), calls = [];
  let failNext = false, holdNext = false, releaseRequest, dshCalls = 0;
  const originalDsh = { request: dshAccount.request, readCredentials: dshAccount.readCredentials };
  const server = http.createServer((req, res) => {
    if (req.url === '/dsh') {
      dshCalls++;
      if (req.headers['x-dsh-auth-token'] !== 'dsh-local-test') { res.writeHead(401); res.end('{}'); return; }
      const finish = () => res.end(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: {
        normal_wallets: [{ currency: 'CNY', balance: dshCalls === 1 ? '0' : '15.5' }], bonus_wallets: [], total_costs: [{ currency: 'CNY', amount: '2.5' }]
      } } }));
      if (holdNext) { holdNext = false; releaseRequest = finish; } else finish();
      return;
    }
    calls.push(req.url);
    if (req.headers.authorization !== 'Bearer quota-smoke-key') { res.writeHead(401); res.end('{}'); return; }
    if (req.url === '/missing/v1/usage') { res.end(JSON.stringify({ balance: 999, quota: { remaining: 999 } })); return; }
    if (req.url === '/error/v1/usage') { res.writeHead(401); res.end('{}'); return; }
    if (failNext) { failNext = false; res.writeHead(401); res.end('{}'); return; }
    const finish = () => res.end(JSON.stringify({ isValid: true, status: 'active', rate_limits: [{ window: '1d',
      remaining: 121.9060417, used: 28.0939583, window_start: new Date(Date.now() - 3600000).toISOString(),
      reset_at: new Date(Date.now() + 3600000).toISOString() }] }));
    if (holdNext) { holdNext = false; releaseRequest = finish; } else finish();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const run = code => panelWindow.webContents.executeJavaScript(code);
  const bubble = () => petWindow.webContents.executeJavaScript(`({hidden:document.querySelector('#account-bubble').hidden,text:document.querySelector('#account-bubble').textContent})`);
  const choose = id => run(`document.querySelector('#provider').value=${JSON.stringify(id)};document.querySelector('#provider').dispatchEvent(new Event('change'));`);
  const edit = (values, check = true) => run(`(() => {
    for(const [id,value] of Object.entries(${JSON.stringify(values)})) { const node=document.querySelector('#'+id); node.value=value; node.dispatchEvent(new Event('input',{bubbles:true})); node.dispatchEvent(new Event('change')); }
    document.querySelector('#sub2api-quota').checked=${check};document.querySelector('#sub2api-quota').dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  const save = async () => {
    await run(`document.querySelector('#save').click()`);
    await waitFor(() => run(`!document.querySelector('#save').disabled && document.querySelector('#settings-message').textContent.includes('已保存')`));
  };
  try {
    showPanel('settings');
    const setup = structuredClone(original);
    for (const integration of Object.values(setup.integrations)) integration.enabled = false;
    setup.providers.openai.baseUrl = 'https://api.openai.com/v1';
    delete setup.providers.openai.serviceSource; delete setup.providers.openai.showDailyQuota;
    setup.chat.provider = 'custom'; setup.providers.custom.model = '';
    setup.providers.custom.baseUrl = baseUrl; setup.providers.custom.apiKey = 'quota-smoke-key';
    setup.providers.custom.serviceSource = 'compatible'; setup.providers.custom.showDailyQuota = false;
    store.save(setup); applyConfig();
    await run(`window.dragon.invoke('bootstrap').then(data=>fill(data.config))`);
    await choose('openai');
    if (!await run(`document.querySelector('#service-source').value==='openai' && document.querySelector('#sub2api-quota-settings').classList.contains('hidden')`)) throw new Error('官方来源默认值或开关隐藏失败');
    await choose('deepseek');
    if (!await run(`document.querySelector('#service-source-field').classList.contains('hidden')`)) throw new Error('DeepSeek 原设置不应重新分类');
    await choose('custom');
    await edit({ 'service-source': 'sub2api' });
    await choose('openai'); await edit({ 'service-source': 'compatible' }, false); await choose('custom');
    if (!await run(`document.querySelector('#service-source').value==='sub2api' && document.querySelector('#sub2api-quota').checked && !document.querySelector('#sub2api-quota-settings').classList.contains('hidden')`)) throw new Error('接口草稿互相覆盖');
    if (calls.length || !(await bubble()).hidden) throw new Error('未保存草稿触发了额度查询');
    await save();
    await waitFor(async () => (await bubble()).text === '今日余额 121.91 · 已用 28.09');
    if (calls.length !== 1 || Object.values(store.value.integrations).some(value => value.enabled) || store.value.providers.custom.model) throw new Error('额度不能依赖模型或执行状态监听');
    const layout = await petWindow.webContents.executeJavaScript(`(() => {
      const node=document.querySelector('#account-bubble'),style=getComputedStyle(node);
      return {font:style.fontSize,wrap:style.whiteSpace,clipped:node.scrollWidth>node.clientWidth};
    })()`);
    if (layout.font !== '14px' || layout.wrap !== 'nowrap' || layout.clipped) throw new Error('额度气泡布局不符合要求');
    const clickRefresh = () => petWindow.webContents.executeJavaScript(`document.querySelector('#account-refresh').click()`);
    failNext = true; await clickRefresh();
    await waitFor(async () => (await bubble()).text === 'Sub2API 额度暂不可用');
    holdNext = true; releaseRequest = null; await clickRefresh();
    await waitFor(() => Boolean(releaseRequest));
    const pendingCalls = calls.length;
    if (!await petWindow.webContents.executeJavaScript(`document.querySelector('#account-refresh').disabled && document.querySelector('#account-refresh').getAttribute('aria-busy')==='true'`)) throw new Error('刷新中按钮没有禁用');
    await clickRefresh();
    await petWindow.webContents.executeJavaScript(`Promise.all([window.dragon.invoke('sub2api:quota-refresh'),window.dragon.invoke('dsh:account-refresh')])`);
    if (calls.length !== pendingCalls || dshCalls) throw new Error('手动刷新重叠或错误请求了 DSH');
    releaseRequest();
    await waitFor(async () => (await bubble()).text === '今日余额 121.91 · 已用 28.09');
    await waitFor(() => petWindow.webContents.executeJavaScript(`!document.querySelector('#account-refresh').disabled`));
    fs.writeFileSync(path.join(dataRoot, 'sub2api-pet-smoke.png'), (await petWindow.webContents.capturePage()).toPNG());
    await run(`document.querySelector('#service-source-field').scrollIntoView({block:'center'})`);
    await run(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    fs.writeFileSync(path.join(dataRoot, 'sub2api-settings-smoke.png'), (await panelWindow.webContents.capturePage()).toPNG());
    const animations = await petWindow.webContents.executeJavaScript(`(() => {
      const previous=state;
      showAccount({source:'dsh',depleted:true,insufficient:true,balance:'0',cost:'0'});
      if(!accountDepleted||!accountInsufficient)throw new Error('DSH 原状态丢失');
      showAccount({source:'sub2api',remaining:0,used:150});
      const rows=['running','review','waiting','waving'].map(name=>{state=name;choose(name);return row;});
      const isolated=!accountDepleted&&!accountInsufficient;
      state=previous;choose(state);
      return {isolated,rows};
    })()`);
    if (!animations.isolated || JSON.stringify(animations.rows) !== '[7,8,6,3]') throw new Error('Sub2API 额度影响了执行或互动动画');
    await edit({ 'base-url': `${baseUrl}/missing` }); await save();
    await waitFor(async () => (await bubble()).text === '当前 Key 未提供日额度');
    await edit({ 'base-url': `${baseUrl}/error` }); await save();
    await waitFor(async () => (await bubble()).text === 'Sub2API 额度暂不可用');
    await edit({ 'base-url': baseUrl }); await save();
    await waitFor(async () => (await bubble()).text === '今日余额 121.91 · 已用 28.09');
    await choose('openai'); await edit({ 'service-source': 'sub2api', 'base-url': `${baseUrl}/b`, 'api-key': 'quota-smoke-key' });
    const beforePreview = calls.length;
    if ((await bubble()).hidden) throw new Error('预览其他接口不应清除实际额度');
    await save(); await waitFor(() => calls.includes('/b/v1/usage'));
    await waitFor(async () => (await bubble()).text === '今日余额 121.91 · 已用 28.09');
    if (calls.length !== beforePreview + 1 || store.value.providers.custom.serviceSource !== 'sub2api' || !store.value.providers.custom.showDailyQuota) throw new Error('来源或开关未按接口保存');
    await edit({ 'base-url': 'https://api.openai.com/v1' }); await save();
    await waitFor(async () => (await bubble()).hidden);
    if (calls.length !== beforePreview + 1) throw new Error('官方地址误选 Sub2API 不应查询');
    await choose('custom'); await save();
    await waitFor(async () => !(await bubble()).hidden);
    await edit({}, false); await save(); await waitFor(async () => (await bubble()).hidden);
    const callsBeforeDisabled = calls.length;
    await petWindow.webContents.executeJavaScript(`window.dragon.invoke('sub2api:quota-refresh')`);
    if (calls.length !== callsBeforeDisabled) throw new Error('关闭后仍可手动查询');
    // Exercise the independent DSH route against local fixtures only; never read real login credentials.
    const dshSetup = structuredClone(store.value); dshSetup.chat.provider = 'deepseek';
    dshSetup.providers.deepseek.model = 'deepseek-smoke'; dshSetup.providers.deepseek.apiKey = 'dsh-chat-local-test';
    store.save(dshSetup); applyConfig();
    dshAccount.readCredentials = async () => ({ records: { 'deepseek-account-platform/default': {
      kind: 'grant', payload: { issuer: 'https://platform.deepseek.com', token: 'dsh-local-test' }
    } } });
    dshAccount.request = (_url, options) => fetch(`${baseUrl}/dsh`, options);
    dshAccount.configure(true);
    await waitFor(async () => (await bubble()).text === '余额 ¥0.00 · 消费 ¥2.50');
    if (!await petWindow.webContents.executeJavaScript(`accountDepleted && document.querySelector('#account-refresh').title==='刷新 DSH 账号余额'`)) throw new Error('DSH 来源或余额动画状态无效');
    holdNext = true; releaseRequest = null; await clickRefresh(); await waitFor(() => Boolean(releaseRequest));
    if (!await petWindow.webContents.executeJavaScript(`accountDepleted && document.querySelector('#account-refresh').disabled`)) throw new Error('DSH 刷新不应清除已确认的耗尽状态');
    await petWindow.webContents.executeJavaScript(`Promise.all([window.dragon.invoke('dsh:account-refresh'),window.dragon.invoke('sub2api:quota-refresh')])`);
    if (dshCalls !== 2 || calls.length !== callsBeforeDisabled) throw new Error('DSH 刷新重叠或串用 Sub2API');
    releaseRequest(); await waitFor(async () => (await bubble()).text === '余额 ¥15.50 · 消费 ¥2.50');
    if (!await petWindow.webContents.executeJavaScript(`!accountDepleted && !document.querySelector('#account-refresh').disabled`)) throw new Error('DSH 刷新后没有恢复状态');
    fs.writeFileSync(path.join(dataRoot, 'dsh-account-refresh-smoke.png'), (await petWindow.webContents.capturePage()).toPNG());
    dshAccount.stop();
    await petWindow.webContents.executeJavaScript(`window.dragon.invoke('dsh:account-refresh')`);
    if (dshCalls !== 2) throw new Error('DSH 关闭后仍可刷新');
    return { sub2apiSavedProviderDrafts: true, sourceGuards: true, independentOfModelAndObservers: true,
      quotaFormattingAndLayout: true, unsupportedAndError: true, providerSwitch: true, animationIsolation: true,
      sub2apiManualRetry: true, dshManualRefresh: true, refreshSourceIsolation: true, refreshSingleFlight: true, pass: true };
  } finally {
    dshAccount.stop(); Object.assign(dshAccount, originalDsh);
    store.save(original); applyConfig();
    await run(`window.dragon.invoke('bootstrap').then(data=>fill(data.config))`);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
module.exports = { smokeSub2apiQuota };
