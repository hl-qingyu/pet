const fs = require('node:fs');
const path = require('node:path');

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function check(test, message) { if (!test) throw new Error(`配置错误：${message}`); }
function text(value, label, max = 16000) { check(typeof value === 'string' && value.length <= max, `${label} 必须是文本，长度不超过 ${max}`); }
function range(value, min, max, label) { check(Number.isFinite(value) && value >= min && value <= max, `${label} 应在 ${min}–${max} 之间`); }
function validateCharacter(character, label) {
  check(object(character), `缺少 ${label} 角色配置`);
  text(character.name, `${label}名字`, 50); check(character.name.trim(), `${label}名字不能为空`);
  text(character.systemPrompt, `${label}性格提示词`);
  check(Array.isArray(character.greetings) && character.greetings.length <= 100, `${label}互动台词必须是最多 100 条文本的数组`);
  character.greetings.forEach(value => text(value, `${label}互动台词`, 500));
}
function migrate(config) {
  if (!object(config)) return config;
  if (config.version === 1) {
    check(object(config.pet) && object(config.personality), '旧版角色配置不完整');
    const legacy = { name: config.pet.name, systemPrompt: config.personality.systemPrompt, greetings: config.pet.greetings };
    validateCharacter(legacy, '旧版');
    const next = structuredClone(config);
    next.version = 2;
    next.characters = structuredClone(require('../config.example.json').characters);
    // The original app had one dragon character; keep all its custom text intact.
    next.characters.dragon = structuredClone(legacy);
    delete next.pet.name; delete next.pet.greetings; delete next.personality;
    config = next;
  }
  if (config.version !== 2) return config;
  const defaults = require('../config.example.json').integrations;
  if (object(config.integrations) && Object.entries(defaults).every(([id, values]) => object(config.integrations[id]) &&
    Object.keys(values).every(key => config.integrations[id][key] !== undefined))) return config;
  const next = structuredClone(config);
  if (next.integrations === undefined) next.integrations = {};
  if (object(next.integrations)) {
    for (const [id, values] of Object.entries(defaults)) {
      if (next.integrations[id] === undefined) next.integrations[id] = {};
      if (object(next.integrations[id])) for (const [key, value] of Object.entries(values)) if (next.integrations[id][key] === undefined) next.integrations[id][key] = value;
    }
  }
  return next;
}
function validate(config) {
  check(object(config) && config.version === 2, 'version 必须为 2');
  for (const section of ['pet', 'characters', 'chat', 'providers', 'startup', 'shortcuts']) check(object(config[section]), `缺少 ${section}`);
  for (const id of ['dragon', 'whale']) validateCharacter(config.characters[id], id === 'dragon' ? '龙娘' : '鲸鱼娘');
  range(config.pet.scale, 0.65, 2, '宠物大小');
  range(config.pet.idleTalkMinutes, 0, 1440, '主动气泡间隔');
  for (const key of ['alwaysOnTop', 'followMouse', 'showOnLaunch']) check(typeof config.pet[key] === 'boolean', `pet.${key} 必须是布尔值`);
  check(config.pet.position === null || (object(config.pet.position) && Number.isFinite(config.pet.position.x) && Number.isFinite(config.pet.position.y)), 'pet.position 应为 null 或 {x,y}');
  check(typeof config.chat.saveHistory === 'boolean', 'saveHistory 必须是布尔值');
  range(config.chat.historyMessages, 2, 200, '上下文消息数');
  check(Number.isInteger(config.chat.historyMessages), '上下文消息数必须是整数');
  range(config.chat.timeoutSeconds, 10, 600, '请求超时');
  range(config.chat.maxOutputTokens, 128, 32768, '输出上限');
  check(Object.keys(config.providers).length > 0 && Object.keys(config.providers).length <= 20, '需要 1–20 个 API 配置');
  for (const [id, provider] of Object.entries(config.providers)) {
    check(/^[a-zA-Z0-9_-]+$/.test(id), '接口 ID 只能包含字母、数字、下划线和连字符');
    check(object(provider), `${id} 接口配置无效`);
    for (const key of ['label', 'baseUrl', 'apiKey', 'model']) text(provider[key], `${id}.${key}`);
    check(['responses', 'chat-completions'].includes(provider.protocol), `${id} 的 protocol 无效`);
    if (provider.reasoning !== undefined) {
      check(object(provider.reasoning), `${id}.reasoning 必须是对象`);
      check(['openai', 'deepseek'].includes(provider.reasoning.format), `${id} 的推理参数格式无效`);
      const efforts = provider.reasoning.format === 'deepseek' ? ['default', 'none', 'low', 'high', 'max'] : ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
      check(efforts.includes(provider.reasoning.effort), `${id} 的推理强度不受所选格式支持`);
    }
    let url; try { url = new URL(provider.baseUrl); } catch { throw new Error(`配置错误：${id} 的接口地址无效`); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    check(url.protocol === 'https:' || (url.protocol === 'http:' && local), '远程 API 必须使用 HTTPS；本机接口可用 HTTP');
    check(!url.username && !url.password && !url.search && !url.hash, 'baseUrl 不能包含账号、查询参数或片段');
    check(object(provider.extraBody), `${id}.extraBody 必须是对象`);
    for (const key of ['model', 'messages', 'input', 'instructions', 'stream', 'tools', 'tool_choice', 'store']) check(!(key in provider.extraBody), `extraBody 不能覆盖 ${key}`);
  }
  check(Object.hasOwn(config.providers, config.chat.provider), 'chat.provider 必须对应一个接口 ID');
  check(typeof config.startup.enabled === 'boolean', 'startup.enabled 必须是布尔值');
  text(config.shortcuts.togglePet, '显示隐藏快捷键', 100);
  if (config.integrations !== undefined) {
    check(object(config.integrations) && object(config.integrations.dsh), 'integrations.dsh 必须是对象');
    const dsh = config.integrations.dsh;
    if (dsh.balanceWarning !== undefined) range(dsh.balanceWarning, 0, 1000000, 'dsh.balanceWarning');
    if (dsh.showAccount !== undefined) check(typeof dsh.showAccount === 'boolean', 'dsh.showAccount 必须是布尔值');
    for (const key of ['enabled', 'showBubble']) check(typeof dsh[key] === 'boolean', `dsh.${key} 必须是布尔值`);
    for (const key of ['sessionsRoot', 'workspace']) text(dsh[key], `dsh.${key}`, 1000);
    for (const [key, min, max] of [['pollMs', 200, 5000], ['activeSeconds', 10, 3600]]) {
      range(dsh[key], min, max, `dsh.${key}`); check(Number.isInteger(dsh[key]), `dsh.${key} 必须是整数`);
    }
    if (config.integrations.openai !== undefined) {
      const openai = config.integrations.openai;
      check(object(openai), 'integrations.openai 必须是对象');
      for (const key of ['enabled', 'showBubble']) check(typeof openai[key] === 'boolean', `openai.${key} 必须是布尔值`);
      text(openai.socketPath, 'openai.socketPath', 1000);
      text(openai.workspace, 'openai.workspace', 1000);
      range(openai.activeSeconds, 10, 3600, 'openai.activeSeconds');
      check(Number.isInteger(openai.activeSeconds), 'openai.activeSeconds 必须是整数');
    }
    if (config.integrations.codexCli !== undefined) {
      const cli = config.integrations.codexCli;
      check(object(cli), 'integrations.codexCli 必须是对象');
      for (const key of ['enabled', 'showBubble']) check(typeof cli[key] === 'boolean', `codexCli.${key} 必须是布尔值`);
      for (const key of ['sessionsRoot', 'workspace']) text(cli[key], `codexCli.${key}`, 1000);
      for (const [key, min, max] of [['pollMs', 200, 5000], ['activeSeconds', 10, 3600]]) {
        range(cli[key], min, max, `codexCli.${key}`); check(Number.isInteger(cli[key]), `codexCli.${key} 必须是整数`);
      }
    }
  }
  return config;
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

class ConfigStore {
  constructor(file, example) {
    this.file = file;
    if (!fs.existsSync(file)) atomicWrite(file, JSON.parse(fs.readFileSync(example, 'utf8')));
    const original = JSON.parse(fs.readFileSync(file, 'utf8'));
    this.value = validate(migrate(original));
    if (this.value.version !== original.version) atomicWrite(file, this.value);
    this.signature = JSON.stringify(this.value);
  }
  save(config) {
    const checked = validate(migrate(structuredClone(config)));
    atomicWrite(this.file, checked);
    this.value = checked; this.signature = JSON.stringify(checked);
    return checked;
  }
  watch(onChange, onError) {
    fs.watchFile(this.file, { interval: 700, persistent: false }, () => {
      try {
        const original = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        const next = validate(migrate(original));
        if (JSON.stringify(next) !== this.signature) {
          this.value = next; this.signature = JSON.stringify(next);
          if (next.version !== original.version) atomicWrite(this.file, next);
          onChange(next);
        }
      } catch (error) { onError(error); }
    });
    return () => fs.unwatchFile(this.file);
  }
}
module.exports = { ConfigStore, validate, migrate, atomicWrite };
