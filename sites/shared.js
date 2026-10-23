/**
 * 多站点共享工具：站点注册、DOM 扫描、行隐藏、主题检测、同源请求封装。
 *
 * 每个网站一个适配器（sites/*.js），只负责两件事：
 *   1. list()  —— 拿到 { id, title, time } 列表（接口优先，DOM 兜底）
 *   2. remove() —— 用该网站自己的接口删除，逐条回报进度
 * 界面（悬浮按钮、弹窗、删除进度、中止）仍集中在 content.js。
 */
(function () {
  'use strict';

  const MAX_LOAD = 1000;   // 单次最多加载的会话条数
  const sites = {};        // id -> 适配器

  function adapterFor(origin) {
    return Object.values(sites).find((site) => site.origins.indexOf(origin) >= 0) || null;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /* ==================== 同源请求 ==================== */
  // 统一带上当前登录态；错误文案直接展示在状态栏。
  async function fetchJson(url, { method = 'GET', headers, body, timeout = 20000 } = {}) {
    let response;
    try {
      response = await fetch(url, {
        method,
        credentials: 'same-origin',
        mode: 'same-origin',
        redirect: 'error',
        headers,
        body: body === undefined ? undefined : body,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw new Error('网络请求失败');
    }
    if (!response.ok) {
      throw new Error(
        response.status === 401 ? '登录已失效' :
        response.status === 403 ? '没有权限' :
        response.status === 429 ? '请求过于频繁' :
        'HTTP ' + response.status
      );
    }
    const text = await response.text();
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error('接口返回格式异常');
    }
  }

  /* ==================== DOM 列表（没有稳定列表接口的站点） ==================== */
  function titleOf(link) {
    // 复制节点再取文本，避免把行内的“更多”按钮等控件文字算进标题。
    const clone = link.cloneNode(true);
    clone.querySelectorAll('button,svg,[aria-hidden="true"]').forEach((node) => node.remove());
    return (link.getAttribute('aria-label') || clone.textContent || link.getAttribute('title') || '')
      .trim().replace(/\s+/g, ' ');
  }

  // roots/selector 由适配器给出；同一会话在多个容器里出现时只保留一条。
  function domList({ roots, selector, idFromHref }) {
    const out = [];
    const seen = new Set();
    for (const root of document.querySelectorAll(roots)) {
      for (const link of root.querySelectorAll(selector)) {
        const id = idFromHref(link.getAttribute('href') || '');
        if (!id || seen.has(id) || !link.getClientRects().length) continue;
        const title = titleOf(link);
        if (!title) continue;
        seen.add(id);
        out.push({ id, title, time: null });
      }
    }
    return out;
  }

  // 会话链接所在的行容器：优先用语义化列表项，没有时向上找到仍只含这一条会话的最大祖先，
  // 避免把整片会话列表一起隐藏。
  function rowNode(link, idFromHref) {
    const known = link.closest('li,[role="listitem"],.next-sidebar-history-item,.chat-item-drag');
    if (known) return known;
    let node = link;
    while (node.parentElement && node.parentElement !== document.body) {
      const parent = node.parentElement;
      let count = 0;
      for (const anchor of parent.querySelectorAll('a[href]')) {
        if (idFromHref(anchor.getAttribute('href') || '')) count++;
        if (count > 1) break;
      }
      if (count > 1) break;
      node = parent;
    }
    return node;
  }

  // 删除成功后把对应行藏起来；React 重渲染覆盖也无妨，数据已经删掉。
  function hideRows(ids, idFromHref) {
    const wanted = new Set(ids);
    if (!wanted.size) return;
    for (const link of document.querySelectorAll('a[href]')) {
      const id = idFromHref(link.getAttribute('href') || '');
      if (!id || !wanted.has(id)) continue;
      rowNode(link, idFromHref).classList.add('cgpt-bd-deleted');
    }
  }

  /* ==================== 主题 ==================== */
  // 返回 true/false 表示背景是深色/浅色，null 表示透明或无法判断。
  function darkColor(value) {
    const match = /^(rgba?|oklch|oklab|lab|lch|color)\((.*)\)$/.exec(String(value).trim());
    if (!match) return null;
    let [channels, alpha = '1'] = match[2].split('/');
    let parts = channels.trim().split(/[\s,]+/);
    if (match[1] === 'color') {
      if (parts.shift() !== 'srgb') return null;
      parts = parts.map((v) => parseFloat(v) * 255);
    }
    if (match[1].startsWith('rgb') && parts.length > 3) alpha = parts[3];
    const num = (v) => (String(v).endsWith('%') ? parseFloat(v) / 100 : parseFloat(v));
    if (num(alpha) < 0.5) return null;
    if (match[1].startsWith('rgb') || match[1] === 'color') {
      const [r, g, b] = parts.map((v) => (String(v).endsWith('%') ? parseFloat(v) * 2.55 : parseFloat(v)));
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
    }
    const lightness = num(parts[0]);
    return match[1].startsWith('ok') ? lightness < 0.6 : (String(parts[0]).endsWith('%') ? lightness : lightness / 100) < 0.5;
  }

  function isDark() {
    const html = document.documentElement;
    if (html.classList.contains('dark')) return true;
    if (html.classList.contains('light')) return false;
    for (const node of [html, document.body]) {
      if (!node) continue;
      for (const value of [node.dataset.theme, node.dataset.mode, node.dataset.colorMode]) {
        if (value === 'dark') return true;
        if (value === 'light') return false;
      }
    }
    // 网站没有显式主题标记时，按实际渲染出来的背景色判断。
    for (let node = document.body; node; node = node.parentElement) {
      const dark = darkColor(getComputedStyle(node).backgroundColor);
      if (dark !== null) return dark;
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  globalThis.CGptBatchDelete = {
    MAX_LOAD, sites, adapterFor, sleep, fetchJson, domList, hideRows, isDark, titleOf,
  };
})();
