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
  constructor(publish) { this.publish = publish; this.generation = 0; }
  configure(enabled, threshold = 0) {
    this.stop();
    if (!enabled) return;
    const generation = this.generation;
    const refresh = async () => {
      this.controller = new AbortController();
      try {
        const root = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
        const stat = await fs.stat(path.join(root, '.credentials.yaml'));
        if (stat.size > 1024 * 1024) throw new Error('storage');
        const doc = yaml.parse(await fs.readFile(path.join(root, '.credentials.yaml'), 'utf8'));
        const record = doc?.records?.['deepseek-account-platform/default'];
        if (record?.kind !== 'grant' || record.payload?.issuer !== ORIGIN || typeof record.payload.token !== 'string') throw new Error('login');
        const response = await fetch(`${ORIGIN}/api/v0/users/get_user_summary`, {
          headers: { 'x-dsh-auth-token': record.payload.token }, redirect: 'error',
          signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)])
        });
        if (!response.ok) throw new Error('request');
        const raw = await response.text();
        if (raw.length > 65536) throw new Error('limit');
        const body = JSON.parse(raw);
        if (body.code !== 0 || body.data?.biz_code !== 0) throw new Error('account');
        const result = { ...project(body.data.biz_data, threshold), updated: Date.now() };
        if (generation === this.generation) this.publish(result);
      } catch {
        if (generation === this.generation) this.publish({ error: '账号数据暂不可用，请确认 DSH 已登录' });
      } finally {
        if (generation === this.generation) this.timer = setTimeout(refresh, 300000);
      }
    };
    this.publish({ loading: true });
    refresh();
  }
  stop() { ++this.generation; clearTimeout(this.timer); this.controller?.abort(); this.publish(null); }
}
module.exports = { DshAccount, project };
