(function (root) {
  const themes = {
    dragon: { id: 'dragon', label: '龙娘', color: '紫色', icon: 'assets/icon.png', tray: 'assets/tray.png', background: '#f8f7fc' },
    whale: { id: 'whale', label: '鲸鱼娘', color: '海蓝色', icon: 'assets/whale/icon.png', tray: 'assets/whale/tray.png', background: '#f4f8fc' },
  };
  function resolve(config) {
    const id = config.chat.provider;
    const provider = config.providers[id];
    const model = provider.model.trim();
    // Model names take priority, including models accessed through a custom gateway.
    if (/codex|(?:^|[/:\s_-])gpt(?:[-.\d]|$)/i.test(model)) return themes.dragon;
    if (/deepseek/i.test(model)) return themes.whale;
    let host = '';
    try { host = new URL(provider.baseUrl).hostname; } catch { /* A form may contain an unfinished URL. */ }
    return /^deepseek(?:[-_]|$)/i.test(id) || /(^|\.)deepseek\.com$/i.test(host) ? themes.whale : themes.dragon;
  }
  function character(config) { return config.characters[resolve(config).id]; }
  function integration(config) { return resolve(config).id === 'whale' ? 'dsh' : 'openai'; }
  const api = { resolve, character, themes, integration };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.petThemes = api;
})(globalThis);
