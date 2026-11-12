const { officialOpenai, source } = require('../../renderer/provider-source.js');
const REFRESH_MS = 300000, MAX_BYTES = 65536;

function usageUrl(baseUrl) {
  const url = new URL(baseUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) ||
      url.username || url.password || url.search || url.hash || officialOpenai(baseUrl)) throw new Error('address');
  let prefix = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|responses|completions)$/, '');
  if (!prefix.endsWith('/v1')) prefix += '/v1';
  url.pathname = `${prefix}/usage`;
  return url.href;
}
function enabled(provider) {
  if (!provider || source(provider) !== 'sub2api' || provider.showDailyQuota !== true ||
      typeof provider.apiKey !== 'string' || !provider.apiKey.trim()) return false;
  try { usageUrl(provider.baseUrl); return true; } catch { return false; }
}
function amount(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value))) throw new Error('amount');
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error('amount');
  return result;
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw new Error('window');
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error('window');
  return result;
}
function project(data, now = Date.now()) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.isValid === false ||
      (data.status !== undefined && data.status !== 'active')) throw new Error('account');
  if (data.rate_limits === undefined) return { source: 'sub2api', unsupported: true };
  if (!Array.isArray(data.rate_limits)) throw new Error('schema');
  const windows = data.rate_limits.filter(item => item?.window === '1d');
  if (!windows.length) return { source: 'sub2api', unsupported: true };
  if (windows.length !== 1) throw new Error('ambiguous');
  const daily = windows[0], remaining = amount(daily.remaining), used = amount(daily.used);
  const windowStart = timestamp(daily.window_start), resetAt = timestamp(daily.reset_at);
  if (used < 0 || windowStart > now || resetAt <= now || resetAt <= windowStart) throw new Error('window');
  return { source: 'sub2api', remaining, used, windowStart, resetAt, updated: now };
}
async function readJson(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); throw new Error('limit'); }
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('limit');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
class Sub2apiQuota {
  constructor(publish, { fetch: request = globalThis.fetch, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, timeoutMs = 15000 } = {}) {
    Object.assign(this, { publish, request, now, setTimer, clearTimer, timeoutMs, generation: 0, key: '' });
  }
  emit(value) { this.snapshot = value; this.publish(value); }
  configure(provider, id = '') {
    const active = enabled(provider);
    const key = active ? JSON.stringify([id, provider.baseUrl, provider.apiKey]) : '';
    if (key === this.key) return;
    this.stop(); this.key = key;
    if (!active) return;
    const generation = this.generation;
    this.options = { url: usageUrl(provider.baseUrl), apiKey: provider.apiKey.trim(), generation };
    this.emit({ source: 'sub2api', loading: true });
    void this.refresh();
  }
  async refresh() {
    const options = this.options;
    if (!options || this.inFlight) return;
    this.clearTimer(this.timer); this.timer = undefined;
    const controller = new AbortController();
    this.controller = controller; this.inFlight = true;
    this.emit({ ...this.snapshot, refreshing: true });
    // One signal covers headers AND the bounded response stream.
    const timeout = this.setTimer(() => controller.abort(), this.timeoutMs);
    this.timeoutTimer = timeout;
    try {
      const response = await this.request(options.url, { method: 'GET',
        headers: { Authorization: `Bearer ${options.apiKey}`, Accept: 'application/json' },
        redirect: 'error', signal: controller.signal });
      if (!response.ok) { await response.body?.cancel(); throw new Error('request'); }
      const value = project(await readJson(response), this.now());
      if (options.generation !== this.generation) return;
      this.clearTimer(this.resetTimer); this.resetTimer = undefined;
      this.emit(value);
      if (value.resetAt && options.generation === this.generation) this.scheduleReset(value.resetAt, options.generation);
    } catch {
      if (options.generation === this.generation) {
        this.emit({ source: 'sub2api', error: 'Sub2API 额度暂不可用' });
      }
    } finally {
      this.clearTimer(timeout);
      if (options.generation === this.generation) {
        this.inFlight = false;
        if (this.resetPending) { this.resetPending = false; void this.refresh(); }
        else this.timer = this.setTimer(() => void this.refresh(), REFRESH_MS);
      }
    }
  }
  scheduleReset(resetAt, generation) {
    this.resetTimer = this.setTimer(() => {
      if (generation !== this.generation) return;
      if (this.now() < resetAt) { this.scheduleReset(resetAt, generation); return; }
      this.resetTimer = undefined;
      this.emit({ source: 'sub2api', loading: true, refreshing: this.inFlight });
      if (this.inFlight) this.resetPending = true;
      else void this.refresh();
    }, Math.min(Math.max(1, resetAt - this.now()), 2147483647));
  }
  stop() {
    ++this.generation; this.key = ''; this.options = null;
    this.clearTimer(this.timer); this.clearTimer(this.resetTimer);
    this.clearTimer(this.timeoutTimer); this.timeoutTimer = undefined;
    this.timer = this.resetTimer = undefined;
    this.controller?.abort(); this.controller = null; this.inFlight = false; this.resetPending = false;
    this.emit(null);
  }
}
module.exports = { usageUrl, enabled, project, Sub2apiQuota };
