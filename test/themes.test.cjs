const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolve } = require('../renderer/themes.js');
const defaults = require('../config.example.json');

test('theme follows the selected model even through a different API provider', () => {
  const config = structuredClone(defaults);
  config.chat.provider = 'custom';
  for (const model of ['deepseek-flash', 'DeepSeek-V4-Pro', 'deepseek-ai/DeepSeek-R1']) {
    config.providers.custom.model = model;
    assert.equal(resolve(config).id, 'whale', model);
  }
  config.chat.provider = 'deepseek';
  for (const model of ['gpt-6.1-sol', 'gpt-5.3-codex', 'gateway/codex-latest']) {
    config.providers.deepseek.model = model;
    assert.equal(resolve(config).id, 'dragon', model);
  }
});

test('unknown model aliases fall back to the active provider or its endpoint', () => {
  const config = structuredClone(defaults);
  config.providers.deepseek.model = 'my-model';
  assert.equal(resolve(config).id, 'whale');
  config.chat.provider = 'openai';
  assert.equal(resolve(config).id, 'dragon');
  config.chat.provider = 'custom';
  config.providers.custom.baseUrl = 'https://api.deepseek.com/v1';
  assert.equal(resolve(config).id, 'whale');
  config.providers.custom.baseUrl = 'https://deepseek.com.example.org/v1';
  assert.equal(resolve(config).id, 'dragon');
  config.providers.custom.baseUrl = 'https://';
  assert.doesNotThrow(() => resolve(config));
});
