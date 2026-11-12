const test=require('node:test'),assert=require('node:assert/strict');
const {project,DshAccount}=require('../src/backends/dsh-account.cjs');
test('account projection includes only validated monetary summaries',()=>{
 assert.deepEqual(project({normal_wallets:[{currency:'CNY',balance:'1.25'}],bonus_wallets:[],total_costs:[{currency:'USD',amount:'0.5'}],token:'secret'}),{depleted:false,insufficient:false,balance:'¥1.25',bonus:'—',cost:'$0.50'});
 assert.throws(()=>project({}));
 assert.throws(()=>project({normal_wallets:[{currency:'CNY',balance:'oops'}]}));
});
test('disabled account monitor clears data and starts no polling',()=>{
 const updates=[];const monitor=new DshAccount(v=>updates.push(v));monitor.configure(false);assert.deepEqual(updates,[null]);assert.equal(monitor.timer,undefined);monitor.stop();
});

test('only an exhausted combined wallet triggers the insufficient balance state',()=>{
 const sample=(normal,bonus)=>project({normal_wallets:[{currency:'CNY',balance:normal}],bonus_wallets:[{currency:'CNY',balance:bonus}],total_costs:[]});
 assert.equal(sample('0','0').insufficient,true);
 assert.equal(sample('-1','0').insufficient,true);
 assert.equal(sample('0','0.001').insufficient,false);
 assert.equal(sample('1','0').insufficient,false);
 assert.equal(project({normal_wallets:[],bonus_wallets:[],total_costs:[]}).insufficient,false);
});

test('configured warning threshold uses unrounded account amounts',()=>{
 const data={normal_wallets:[{currency:'CNY',balance:'1.50'}],bonus_wallets:[],total_costs:[]};
 assert.equal(project(data,2).insufficient,true);
 assert.equal(project(data,1.5).insufficient,true);
 assert.equal(project(data,1.49).insufficient,false);
});

const credentials = () => ({ records: { 'deepseek-account-platform/default': {
  kind: 'grant', payload: { issuer: 'https://platform.deepseek.com', token: 'test-only-token' }
} } });
const response = balance => Response.json({ code: 0, data: { biz_code: 0, biz_data: {
  normal_wallets: [{ currency: 'CNY', balance }], bonus_wallets: [], total_costs: []
} } });
const flush = () => new Promise(resolve => setImmediate(resolve));
test('manual DSH refresh retries errors, keeps prior balance while busy and never overlaps automatic queries', async () => {
  const updates = [], requests = [], timers = new Map(); let next = 0;
  const monitor = new DshAccount(value => updates.push(value), {
    readCredentials: async () => credentials(),
    request: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })),
    setTimer: (fn, delay) => { const id = ++next; timers.set(id, { fn, delay }); return id; },
    clearTimer: id => timers.delete(id)
  });
  monitor.configure(true, 1); await flush();
  assert.equal(requests.length, 1); assert.equal(updates.at(-1).refreshing, true);
  await monitor.refresh(); assert.equal(requests.length, 1);
  requests[0].resolve(new Response('{}', {status:401})); await flush();
  assert.ok(updates.at(-1).error); assert.equal(timers.size, 1);
  const retry = monitor.refresh(); await flush(); assert.equal(requests.length, 2); assert.equal(timers.size, 0);
  requests[1].resolve(response('0')); await retry;
  assert.equal(updates.at(-1).depleted, true);
  const refresh = monitor.refresh(); await flush();
  assert.equal(updates.at(-1).refreshing, true); assert.equal(updates.at(-1).depleted, true);
  assert.equal(updates.at(-1).balance, '¥0.00');
  await monitor.refresh(); assert.equal(requests.length, 3);
  requests[2].resolve(response('10')); await refresh;
  assert.equal(updates.at(-1).depleted, false); assert.equal(updates.at(-1).insufficient, false);
  assert.equal(updates.at(-1).refreshing, undefined);
  assert.equal(timers.size, 1); assert.equal([...timers.values()][0].delay, 300000);
  for (const req of requests) {
    assert.equal(req.url, 'https://platform.deepseek.com/api/v0/users/get_user_summary');
    assert.equal(req.options.headers['x-dsh-auth-token'], 'test-only-token'); assert.equal(req.options.redirect, 'error');
  }
  monitor.stop(); await monitor.refresh(); assert.equal(requests.length, 3); assert.equal(timers.size, 0);
});
test('DSH stop aborts pending refreshes and ignores late responses or credential reads', async () => {
  let resolveCredentials, resolveRequest, signal; const updates = [];
  const monitor = new DshAccount(value => updates.push(value), {
    readCredentials: () => new Promise(resolve => { resolveCredentials = resolve; }),
    request: (_url, options) => { signal = options.signal; return new Promise(resolve => { resolveRequest = resolve; }); }
  });
  monitor.configure(true); monitor.stop(); resolveCredentials(credentials()); await flush();
  assert.equal(resolveRequest, undefined); assert.equal(updates.at(-1), null);
  monitor.configure(true); resolveCredentials(credentials()); await flush();
  monitor.stop(); assert.equal(signal.aborted, true);
  resolveRequest(response('10')); await flush();
  assert.equal(updates.at(-1), null); assert.equal(monitor.timer, undefined);
});
