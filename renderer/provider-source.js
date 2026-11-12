(function (root) {
  function officialOpenai(baseUrl) {
    try {
      const host = new URL(baseUrl).hostname.toLowerCase().replace(/\.+$/, '');
      return ['openai.com', 'chatgpt.com'].some(domain => host === domain || host.endsWith(`.${domain}`));
    } catch { return false; }
  }
  function source(provider) { return provider.serviceSource || (officialOpenai(provider.baseUrl) ? 'openai' : 'compatible'); }
  function selectable(provider, id) {
    let host = '';
    try { host = new URL(provider.baseUrl).hostname; } catch {}
    return id !== 'deepseek' && !/(^|\.)deepseek\.com\.?$/i.test(host);
  }
  const api = { officialOpenai, source, selectable };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.petProviderSource = api;
})(globalThis);
