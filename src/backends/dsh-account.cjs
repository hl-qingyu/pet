const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const yaml = require('yaml');
const ORIGIN = 'https://platform.deepseek.com';
function project(data, threshold = 0) {
  const amounts = key => {
    if (!Array.isArray(data?.[key])) throw new Error('schema');
    return data[key].map(item => {
      const value = Number(item.balance ?? item.amount);
      if (!['CNY', 'USD'].includes(item.currency) || !Number.isFinite(value)) throw new Error('schema');
      return `${item.currency === 'CNY' ? '¥' : '$'}${value.toFixed(2)}`;
    }).join(' / ') || '—';
  };
  const bonus = amounts('bonus_wallets');
  amounts('normal_wallets');
  const wallets = [...data.normal_wallets, ...data.bonus_wallets];
  const totals = new Map();
  for (const wallet of wallets) totals.set(wallet.currency, (totals.get(wallet.currency) || 0) + Number(wallet.balance));
  const balance = [...totals].map(([currency, value]) => (currency === 'CNY' ? '¥' : '$') + value.toFixed(2)).join(' / ') || '—';
  return { depleted: totals.size > 0 && [...totals.values()].every(value => value <= 0), insufficient: totals.size > 0 && [...totals.values()].every(value => value <= threshold), balance, bonus, cost: amounts('total_costs') };
}
class DshAccount {
  constructor(publish, { request = globalThis.fetch, readCredentials = async () => {
    const root = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const file = path.join(root, '.credentials.yaml');
    const stat = await fs.stat(file);
    if (stat.size > 1024 * 1024) throw new Error('storage');
    return yaml.parse(await fs.readFile(file, 'utf8'));
  }, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { publish, request, readCredentials, setTimer, clearTimer, generation: 0 });
  }
  emit(value) { this.snapshot = value; this.publish(value); }
  configure(enabled, threshold = 0) {
    this.stop();
    if (!enabled) return;
    this.active = true; this.threshold = threshold;
    this.emit({ loading: true });
    void this.refresh();
  }
  async refresh() {
    if (!this.active || this.inFlight) return;
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller; this.inFlight = true;
    this.clearTimer(this.timer); this.timer = undefined;
    this.emit({ ...this.snapshot, refreshing: true });
    try {
      const doc = await this.readCredentials();
      if (generation !== this.generation) return;
      const record = doc?.records?.['deepseek-account-platform/default'];
      if (record?.kind !== 'grant' || record.payload?.issuer !== ORIGIN || typeof record.payload.token !== 'string') throw new Error('login');
      const response = await this.request(`${ORIGIN}/api/v0/users/get_user_summary`, {
        headers: { 'x-dsh-auth-token': record.payload.token }, redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])
      });
      if (!response.ok) throw new Error('request');
      const raw = await response.text();
      if (raw.length > 65536) throw new Error('limit');
      const body = JSON.parse(raw);
      if (body.code !== 0 || body.data?.biz_code !== 0) throw new Error('account');
      const result = { ...project(body.data.biz_data, this.threshold), updated: Date.now() };
      if (generation === this.generation) this.emit(result);
    } catch {
      if (generation === this.generation) this.emit({ error: '账号数据暂不可用，请确认 DSH 已登录' });
    } finally {
      if (generation === this.generation) {
        this.inFlight = false;
        this.timer = this.setTimer(() => void this.refresh(), 300000);
      }
    }
  }
  stop() {
    ++this.generation; this.active = false; this.inFlight = false;
    this.clearTimer(this.timer); this.timer = undefined;
    this.controller?.abort(); this.emit(null);
  }
}
module.exports = { DshAccount, project };
