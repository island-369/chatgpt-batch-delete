(() => {
  'use strict';
  const KEY = 'aiTitleConfig';
  const $ = (selector) => document.querySelector(selector);
  const endpointEl = $('#endpoint');
  const modelEl = $('#model');
  const keyEl = $('#api-key');
  const statusEl = $('#status');

  function showStatus(text, error = false) {
    statusEl.textContent = text;
    statusEl.style.color = error ? '#c6373d' : '';
  }

  function permissionPattern(endpoint) {
    const url = new URL(endpoint);
    return url.origin + '/*';
  }

  chrome.storage.local.get(KEY).then((values) => {
    const config = values[KEY];
    if (!config) return;
    endpointEl.value = config.endpoint || '';
    modelEl.value = config.model || '';
    keyEl.value = config.apiKey || '';
    showStatus('已加载本地配置');
  });

  $('#save').addEventListener('click', async () => {
    let endpoint;
    try {
      endpoint = new URL(endpointEl.value.trim());
      if (!['https:', 'http:'].includes(endpoint.protocol)) throw new Error();
      if (endpoint.username || endpoint.password || endpoint.hash) throw new Error('服务地址不能包含账号信息或片段');
      if (endpoint.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(endpoint.hostname)) {
        throw new Error('非本机服务必须使用 HTTPS');
      }
      if (!modelEl.value.trim()) throw new Error('请填写模型名称');
    } catch (error) {
      showStatus(error.message || '请检查服务地址格式', true);
      return;
    }
    const permission = permissionPattern(endpoint.href);
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [permission] });
    } catch (error) { /* 由下方提示用户 */ }
    if (!granted) {
      showStatus('未获得该服务地址的访问权限，配置未保存。', true);
      return;
    }
    await chrome.storage.local.set({
      [KEY]: {
        endpoint: endpoint.href,
        model: modelEl.value.trim(),
        apiKey: keyEl.value.trim(),
      },
    });
    showStatus('配置已保存在本机，可以回到会话列表生成标题。');
  });

  $('#clear').addEventListener('click', async () => {
    const values = await chrome.storage.local.get(KEY);
    const config = values[KEY];
    if (config?.endpoint) {
      try { await chrome.permissions.remove({ origins: [permissionPattern(config.endpoint)] }); }
      catch (error) { /* 清除本地密钥优先 */ }
    }
    await chrome.storage.local.remove(KEY);
    endpointEl.value = '';
    modelEl.value = '';
    keyEl.value = '';
    showStatus('本地 AI 配置和访问授权已清除。');
  });
})();
