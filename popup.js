/**
 * 工具栏弹窗：检测当前页面是否注入了批量删除面板，
 * 并可以直接从弹窗打开面板。没有额外权限，全部走 content script 消息。
 */
(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const card = $('#page-card');
  const titleEl = $('#page-title');
  const actionBtn = $('#open-panel');
  const actionLabel = $('#action-label');
  const hintEl = $('#hint');

  const hasChrome = typeof chrome !== 'undefined' && chrome.tabs && chrome.runtime;
  let tabId = null;
  let ready = false;
  let actionMode = 'panel';
  let activeTab = null;

  function isChatGptTab(tab) {
    try {
      const url = new URL(tab && tab.url);
      return (url.hostname === 'chatgpt.com' || url.hostname === 'chat.openai.com');
    } catch (error) { return false; }
  }

  function isLibraryTab(tab) {
    try {
      const path = new URL(tab.url).pathname;
      return isChatGptTab(tab) && (path === '/library' || path.startsWith('/library/'));
    }
    catch (error) { return false; }
  }

  function setState(state, title, actionText, enabled, hint) {
    card.dataset.state = state;
    titleEl.textContent = title;
    actionLabel.textContent = actionText;
    actionBtn.disabled = !enabled;
    ready = state === 'ready';
    hintEl.textContent = hint || '';
    hintEl.hidden = !hint;
  }

  function queryActiveTab() {
    return new Promise((resolve) => {
      if (!hasChrome) { resolve(null); return; }
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          resolve(tabs && tabs[0] ? tabs[0] : null);
        });
      } catch (error) {
        resolve(null);
      }
    });
  }

  function send(tab, message) {
    return new Promise((resolve) => {
      if (!hasChrome || !tab || tab.id == null) { resolve(null); return; }
      try {
        chrome.tabs.sendMessage(tab.id, message, (response) => {
          // 读取 lastError 以阻止控制台出现未检查错误；拿不到接收方时视为未注入。
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(response || null);
        });
      } catch (error) {
        resolve(null);
      }
    });
  }

  async function detect() {
    setState('checking', '正在检测当前页面…', '打开删除面板', false);
    const tab = await queryActiveTab();
    activeTab = tab;
    tabId = tab && tab.id != null ? tab.id : null;
    const info = await send(tab, { type: 'cgpt-batch-delete:ping' });
    if (info && info.supported) {
      actionMode = isLibraryTab(tab) ? 'library' : 'panel';
      setState(
        'ready',
        actionMode === 'library' ? '已连接到 ChatGPT 资料库' : '已连接到' + (info.site ? ' ' + info.site : '当前站点'),
        actionMode === 'library' ? '打开资料库批量管理' : '打开删除面板',
        true
      );
      return;
    }
    if (isChatGptTab(tab)) {
      actionMode = 'connect';
      setState(
        'unsupported',
        'ChatGPT 页面尚未连接',
        isLibraryTab(tab) ? '连接并打开资料库管理' : '连接 ChatGPT 页面',
        true,
        '扩展脚本没有自动运行。点击按钮后，扩展会在当前 ChatGPT 标签页中启动。'
      );
      return;
    }
    actionMode = 'panel';
    setState(
      'unsupported',
      '当前页面暂不支持',
      '重新检测',
      true,
      '请打开受支持的 AI 站点，或刷新页面后重试'
    );
  }

  async function connectAndOpen() {
    if (!hasChrome || tabId == null || !isChatGptTab(activeTab)) return;
    setState('checking', '正在连接 ChatGPT…', '正在连接…', false);
    try {
      await new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
          target: { tabId },
          files: ['sites/shared.js', 'sites/chatgpt.js', 'content.js'],
        }, () => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message)); else resolve();
        });
      });
      const info = await send({ id: tabId }, { type: 'cgpt-batch-delete:ping' });
      if (!info || !info.supported) throw new Error('脚本已启动，但页面仍未响应。请在扩展管理页检查站点访问权限。');
      const library = isLibraryTab(activeTab) && info.site === 'ChatGPT';
      const result = await send({ id: tabId }, {
        type: library ? 'cgpt-batch-delete:open-library' : 'cgpt-batch-delete:open',
      });
      if (!result || !result.ok) throw new Error('页面已连接，但无法打开管理面板。请再点一次扩展图标。');
      window.close();
    } catch (error) {
      actionMode = 'connect';
      setState('unsupported', '连接失败', '重试连接', true,
        error.message || '请检查扩展的 ChatGPT 站点访问权限后重试。');
    }
  }

  actionBtn.addEventListener('click', async () => {
    if (actionMode === 'connect') {
      await connectAndOpen();
      return;
    }
    if (!ready) { detect(); return; }
    const messageType = actionMode === 'library'
      ? 'cgpt-batch-delete:open-library'
      : 'cgpt-batch-delete:open';
    const result = await send({ id: tabId }, { type: messageType });
    if (result && result.ok) {
      window.close();
      return;
    }
    setState('unsupported', '页面连接已断开', '重新检测', true,
      '刷新页面后，再打开这个弹窗试试');
  });

  try {
    $('#version').textContent = hasChrome ? 'v' + chrome.runtime.getManifest().version : '';
  } catch (error) {
    $('#version').textContent = '';
  }

  detect();
})();
