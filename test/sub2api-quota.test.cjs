const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http');
const { usageUrl, enabled, project, Sub2apiQuota } = require('../src/backends/sub2api-quota.cjs');
const { source } = require('../renderer/provider-source.js');
const { validate, migrate, ConfigStore } = require('../src/config.cjs');
const now = Date.parse('2026-11-11T12:00:00+08:00');
const sample = (at = now) => ({ mode: 'quota_limited', isValid: true, status: 'active',
  rate_limits: [{ window: '1d', limit: 150, remaining: 121.9060417, used: 28.0939583,
    window_start: new Date(at - 3600000).toISOString(), reset_at: new Date(at + 3600000).toISOString() }],
  daily_usage: 'PRIVATE', model_stats: 'PRIVATE', balance: 999 });
const provider = { serviceSource: 'sub2api', showDailyQuota: true, baseUrl: 'https://gateway.test/v1', apiKey: 'local-test' };
const flush = () => new Promise(resolve => setImmediate(resolve));
function clock() {
  let time = now, next = 0; const timers = new Map();
  return { now: () => time, timers,
    setTimer(fn, delay) { const id = ++next; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    async advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers]) if (timers.has(id) && timer.at <= time) { timers.delete(id); timer.fn(); }
      await flush();
    } };
}
test('usage paths preserve proxy prefixes and normalize root, v1 and known inference endpoints', () => {
  for (const suffix of ['', '/', '/v1', '/v1/', '/v1/responses', '/v1/chat/completions/', '/v1/completions'])
    assert.equal(usageUrl(`https://gateway.test/proxy${suffix}`), 'https://gateway.test/proxy/v1/usage');
  assert.equal(usageUrl('http://127.0.0.1:8000'), 'http://127.0.0.1:8000/v1/usage');
  for (const url of ['https://api.openai.com/v1', 'https://API.OPENAI.COM./v1', 'https://openai.com', 'https://api.chatgpt.com',
    'http://remote.test', 'https://user:pass@gateway.test', 'https://gateway.test/?a=b', 'https://gateway.test/#x']) assert.throws(() => usageUrl(url));
});
test('explicit saved source, switch, key and safe address are all required, independently of model', () => {
  assert.equal(enabled(provider), true);
  for (const patch of [{ serviceSource: undefined }, { serviceSource: 'openai' }, { serviceSource: 'compatible' },
    { showDailyQuota: false }, { apiKey: '' }, { apiKey: ' ' }, { baseUrl: 'https://api.openai.com/v1' }, { baseUrl: 'bad' }])
    assert.equal(enabled({ ...provider, ...patch }), false);
  assert.equal(source({ baseUrl: 'https://api.openai.com/v1' }), 'openai');
  assert.equal(source({ baseUrl: 'https://sub2api.test/v1' }), 'compatible');
});
test('projection uses only validated raw daily amounts and server window, with no wallet fallback', () => {
  const result = project(sample(), now);
  assert.equal(result.remaining.toFixed(2), '121.91'); assert.equal(result.used.toFixed(2), '28.09');
  assert.equal(result.remaining, 121.9060417);
  assert.deepEqual(Object.keys(result).sort(), ['source', 'remaining', 'used', 'windowStart', 'resetAt', 'updated'].sort());
  for (const rate_limits of [undefined, [], [{ window: '1h', remaining: 999 }]])
    assert.deepEqual(project({ balance: 999, quota: { remaining: 999 }, rate_limits }, now), { source: 'sub2api', unsupported: true });
  const zero = sample(); zero.rate_limits[0].remaining = 0; zero.rate_limits[0].used = 150;
  assert.equal(project(zero, now).remaining, 0);
});
test('nulls, blank or nonfinite amounts, ambiguous windows, invalid accounts and expired windows fail closed', () => {
  for (const field of ['remaining', 'used']) for (const value of [null, undefined, '', ' ', true, [], 'oops', Infinity, NaN, 'Infinity']) {
    const data = sample(); data.rate_limits[0][field] = value; assert.throws(() => project(data, now));
  }
  for (const field of ['window_start', 'reset_at']) for (const value of [null, '', 'yesterday', 123, '2026-11-12']) {
    const data = sample(); data.rate_limits[0][field] = value; assert.throws(() => project(data, now));
  }
  const duplicate = sample(); duplicate.rate_limits.push({ ...duplicate.rate_limits[0] }); assert.throws(() => project(duplicate, now));
  assert.throws(() => project(sample(), now + 3600000));
  assert.throws(() => project(sample(), now - 3600001));
  assert.throws(() => project({ ...sample(), isValid: false }, now));
  assert.throws(() => project({ ...sample(), status: 'disabled' }, now));
  assert.throws(() => project({ rate_limits: {} }, now));
});
test('legacy providers default off and per-provider source and switch validate and roundtrip', t => {
  const config = structuredClone(require('../config.example.json'));
  assert.equal(enabled(migrate(config).providers.openai), false);
  config.providers.openai.serviceSource = 'sub2api'; config.providers.openai.showDailyQuota = true;
  config.providers.custom.serviceSource = 'compatible'; config.providers.custom.showDailyQuota = false;
  const fs = require('node:fs'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pet-quota-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json'); fs.writeFileSync(file, JSON.stringify(config));
  const store = new ConfigStore(file, 'unused'); store.save(config);
  assert.deepEqual(new ConfigStore(file, 'unused').value.providers, config.providers);
  config.providers.openai.serviceSource = 'guessed'; assert.throws(() => validate(config), /来源/);
  config.providers.openai.serviceSource = 'sub2api'; config.providers.openai.showDailyQuota = 'true'; assert.throws(() => validate(config), /showDailyQuota/);
});
test('refresh starts immediately, reconfiguration is idempotent, polling is 5 minutes, stopping releases all timers', async () => {
  const time = clock(), updates = []; let calls = 0;
  const monitor = new Sub2apiQuota(v => updates.push(v), { ...time, fetch: async (url, options) => {
    calls++; assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer local-test');
    return Response.json(sample(time.now()));
  } });
  monitor.configure(provider, 'a'); await flush();
  assert.equal(calls, 1); assert.equal(updates.at(-1).remaining, 121.9060417);
  monitor.configure({ ...provider, model: 'different' }, 'a'); assert.equal(calls, 1);
  await time.advance(299999); assert.equal(calls, 1);
  await time.advance(1); assert.equal(calls, 2);
  monitor.configure({ ...provider, apiKey: 'changed' }, 'a'); await flush();
  assert.equal(updates.at(-1).error, 'Sub2API 额度暂不可用'); // mock checks the original auth only
  monitor.stop(); assert.equal(time.timers.size, 0); assert.equal(updates.at(-1), null);
});
test('switching key/provider or disabling aborts requests and ignores late results', async () => {
  const pending = [], updates = [], time = clock();
  const monitor = new Sub2apiQuota(v => updates.push(v), { ...time, fetch: (url, options) => new Promise(resolve => pending.push({ resolve, options })) });
  monitor.configure(provider, 'a'); monitor.configure({ ...provider, apiKey: 'new-key' }, 'a');
  assert.equal(pending[0].options.signal.aborted, true);
  pending[1].resolve(Response.json(sample())); await flush(); const latest = updates.at(-1);
  pending[0].resolve(Response.json({})); await flush(); assert.equal(updates.at(-1), latest);
  monitor.configure(provider, 'b'); assert.equal(pending.length, 3);
  monitor.configure({ ...provider, showDailyQuota: false }, 'b');
  assert.equal(pending[2].options.signal.aborted, true); assert.equal(time.timers.size, 0);
  pending[2].resolve(Response.json(sample())); await flush(); assert.equal(updates.at(-1), null);
  assert.equal(time.timers.size, 0);
});
test('reset removes expired numbers and serializes reset refresh with an in-flight poll', async () => {
  const time = clock(), updates = [], pending = []; let calls = 0;
  const monitor = new Sub2apiQuota(v => updates.push(v), { ...time, fetch: () => {
    calls++;
    if (calls === 1) { const data = sample(); data.rate_limits[0].reset_at = new Date(now + 300001).toISOString(); return Promise.resolve(Response.json(data)); }
    return new Promise(resolve => pending.push(resolve));
  } });
  monitor.configure(provider); await flush(); await time.advance(300000); assert.equal(calls, 2);
  await time.advance(1); assert.equal(calls, 2); assert.equal(updates.at(-1).loading, true);
  const expired = sample(); expired.rate_limits[0].reset_at = new Date(now + 300001).toISOString();
  pending[0](Response.json(expired)); await flush(); assert.equal(calls, 3);
  assert.equal(updates.at(-1).error, 'Sub2API 额度暂不可用');
  pending[1](Response.json(sample(time.now()))); await flush(); assert.equal(updates.at(-1).updated, time.now());
  monitor.stop(); assert.equal(time.timers.size, 0);
});
test('reset before the regular polling interval refreshes immediately', async () => {
  const time = clock(), updates = []; let calls = 0;
  const monitor = new Sub2apiQuota(v => updates.push(v), { ...time, fetch: async () => {
    calls++; const data = sample(time.now()); data.rate_limits[0].reset_at = new Date(time.now() + 1000).toISOString(); return Response.json(data);
  } });
  monitor.configure(provider); await flush(); await time.advance(1000);
  assert.equal(calls, 2); assert.equal(updates.at(-1).updated, now + 1000); monitor.stop();
});
test('stopping from a successful notification cannot re-create the reset timer', async () => {
  const time = clock();
  const monitor = new Sub2apiQuota(value => { if (value?.updated) monitor.stop(); }, { ...time, fetch: async () => Response.json(sample()) });
  monitor.configure(provider); await flush(); assert.equal(time.timers.size, 0);
});
test('real loopback HTTP validates auth, handles errors, caps chunked bodies, forbids redirects and times out during body read', async t => {
  let redirectRequests = 0, auth;
  const server = http.createServer((req, res) => {
    auth = req.headers.authorization;
    const route = req.url.split('/')[1];
    if (route === 'redirect') { res.writeHead(302, { Location: '/target/v1/usage' }); res.end(); }
    else if (route === 'target') { redirectRequests++; res.end('{}'); }
    else if (route === 'auth') { res.writeHead(401); res.end('{}'); }
    else if (route === 'large') { res.writeHead(200); res.write(' '.repeat(40000)); res.end(' '.repeat(40000)); }
    else if (route === 'slow') { res.writeHead(200); res.write('{'); }
    else if (route === 'invalid') res.end('not json');
    else res.end(JSON.stringify(sample(Date.now())));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  for (const route of ['valid', 'auth', 'large', 'redirect', 'slow', 'invalid']) {
    const updates = [];
    const monitor = new Sub2apiQuota(value => updates.push(value), { timeoutMs: 100 });
    t.after(() => monitor.stop());
    monitor.configure({ ...provider, baseUrl: `http://127.0.0.1:${server.address().port}/${route}` });
    const end = Date.now() + 3000;
    while ((updates.at(-1)?.loading || !updates.at(-1)) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
    if (route === 'valid') assert.equal(updates.at(-1).remaining, 121.9060417);
    else assert.deepEqual(updates.at(-1), { source: 'sub2api', error: 'Sub2API 额度暂不可用' });
    assert.equal(auth, 'Bearer local-test'); monitor.stop();
  }
  assert.equal(redirectRequests, 0);
});
