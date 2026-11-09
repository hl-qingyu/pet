const { character: getCharacter } = require('../../renderer/themes.js');

function endpoint(base, protocol) {
  const suffix = protocol === 'responses' ? '/responses' : '/chat/completions';
  const clean = base.replace(/\/+$/, '');
  return clean.endsWith(suffix) ? clean : clean + suffix;
}

async function* sse(body) {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true });
    // SSE fields are delimited by LF or CRLF. Keep partial UTF-8 and lines across reads.
    let match;
    while ((match = /\r?\n\r?\n/.exec(pending))) {
      const block = pending.slice(0, match.index);
      pending = pending.slice(match.index + match[0].length);
      const lines = block.split(/\r?\n/).filter(line => line.startsWith('data:'));
      if (lines.length) yield lines.map(line => line.slice(5).replace(/^ /, '')).join('\n');
    }
  }
  pending += decoder.decode();
  const lines = pending.split(/\r?\n/).filter(line => line.startsWith('data:'));
  if (lines.length) yield lines.map(line => line.slice(5).replace(/^ /, '')).join('\n');
}

function bodyFor(config, provider, messages) {
  const base = { ...provider.extraBody, model: provider.model, stream: true };
  const { format, effort } = provider.reasoning || { format: 'openai', effort: 'default' };
  // Default leaves older extraBody configurations untouched. Explicit UI choices win.
  if (effort !== 'default') {
    if (provider.protocol === 'responses') {
      base.reasoning = { ...base.reasoning, effort };
      delete base.reasoning_effort; delete base.thinking;
    } else if (format === 'deepseek') {
      base.thinking = { type: effort === 'none' ? 'disabled' : 'enabled' };
      delete base.reasoning;
      if (effort === 'none') delete base.reasoning_effort;
      else base.reasoning_effort = effort;
    } else {
      base.reasoning_effort = effort;
      delete base.reasoning; delete base.thinking;
    }
  }
  const character = getCharacter(config);
  const instructions = `${character.systemPrompt}\n你的名字是「${character.name}」，请使用这个名字与用户交流。`;
  if (provider.protocol === 'responses') return { ...base, store: false, instructions, input: messages, max_output_tokens: config.chat.maxOutputTokens };
  const completionBudget = format === 'openai' && (effort !== 'default' || new URL(provider.baseUrl).hostname === 'api.openai.com');
  if (completionBudget) delete base.max_tokens;
  else delete base.max_completion_tokens;
  return { ...base, messages: [{ role: 'system', content: instructions }, ...messages], [completionBudget ? 'max_completion_tokens' : 'max_tokens']: config.chat.maxOutputTokens };
}

function userError(error, secrets = []) {
  let message = error?.message || String(error);
  for (const secret of secrets) if (secret) message = message.split(secret).join('[已隐藏密钥]');
  message = message.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]');
  return message.slice(0, 1200);
}

async function streamReply({ config, messages, signal, onDelta, fetchImpl = fetch }) {
  const provider = config.providers[config.chat.provider];
  if (!provider.model.trim()) throw new Error('请在「设置 → 接口」中填写模型名称。');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(provider.baseUrl).hostname);
  if (!local && !provider.apiKey.trim()) throw new Error('还没有配置 API Key。打开「设置 → 接口」，填写后保存即可聊天。');
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  let response;
  try {
    response = await fetchImpl(endpoint(provider.baseUrl, provider.protocol), {
      method: 'POST', headers, body: JSON.stringify(bodyFor(config, provider, messages)), signal,
    });
    if (!response.ok) {
      let detail = '';
      try { const payload = await response.json(); detail = payload?.error?.message || payload?.message || ''; } catch {}
      const hints = { 401: '密钥无效或账号未获授权', 403: '接口拒绝访问，请检查模型权限', 404: '接口地址或模型名称不存在', 429: '请求过多或额度不足，请稍后重试' };
      throw new Error(`API ${response.status}：${hints[response.status] || '请求失败'}${detail ? `。${detail}` : ''}`);
    }
    let full = '';
    if ((response.headers.get('content-type') || '').includes('application/json')) {
      const payload = await response.json();
      if (payload.error) throw new Error(payload.error.message || '接口返回错误');
      full = provider.protocol === 'responses'
        ? (payload.output_text || payload.output?.flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('') || '')
        : (payload.choices?.[0]?.message?.content || '');
      if (full) onDelta(full);
    } else {
      let terminal = false;
      for await (const data of sse(response.body)) {
        if (data === '[DONE]') { terminal = true; break; }
        let event; try { event = JSON.parse(data); } catch { throw new Error('接口返回了无法解析的流式数据。请检查协议类型。'); }
        if (event.error || ['error', 'response.failed'].includes(event.type)) throw new Error(event.error?.message || event.response?.error?.message || event.message || '生成失败');
        if (event.type === 'response.incomplete') throw new Error('回复未完成，可能达到输出上限。可在设置中调整。');
        const delta = provider.protocol === 'responses' ? (event.type === 'response.output_text.delta' ? event.delta : '') : event.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) { full += delta; onDelta(delta); }
        if (event.type === 'response.completed' || event.choices?.[0]?.finish_reason) terminal = true;
        if (full.length > 200000) throw new Error('回复过长，已停止接收。');
      }
      if (!terminal) throw new Error('连接提前中断，回复未完成，请重试。');
    }
    if (!full.trim()) throw new Error('接口没有返回文字。请检查模型、接口协议或输出上限。');
    return full;
  } catch (error) {
    if (signal?.aborted) throw signal.reason || new Error('已停止生成');
    throw new Error(userError(error, [provider.apiKey]));
  }
}
module.exports = { endpoint, sse, bodyFor, streamReply, userError };
