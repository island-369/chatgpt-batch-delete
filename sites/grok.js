/**
 * Grok 适配器（grok.com）
 *
 * 列表：GET /rest/app-chat/conversations 分页拉全量；接口不可用时读侧边栏 DOM。
 * 删除：网站原生的软删除接口（会话从列表消失）。
 */
(function () {
  'use strict';

  const shared = CGptBatchDelete;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const PAGE_SIZE = 100;
  const REQ_GAP = 300;

  async function list(onProgress) {
    const out = [];
    const seen = new Set();
    let token = '';
    for (let page = 0; page < Math.ceil(shared.MAX_LOAD / PAGE_SIZE); page++) {
      const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
      if (token) params.set('pageToken', token);
      const data = await shared.fetchJson('/rest/app-chat/conversations?' + params);
      if (!Array.isArray(data?.conversations)) throw new Error('接口返回格式异常');
      for (const chat of data.conversations) {
        const id = typeof chat?.conversationId === 'string' ? chat.conversationId.toLowerCase() : null;
        if (!id || !UUID_RE.test(id) || seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          title: typeof chat.title === 'string' ? chat.title : '',
          time: chat.modifyTime || chat.createTime || null,
        });
      }
      if (onProgress) onProgress(out.length);
      const next = typeof data.nextPageToken === 'string' ? data.nextPageToken : '';
      if (!next || next === token) break;
      token = next;
      await shared.sleep(300);   // 分页间隔，避免连续打满
    }
    return out;
  }

  function domList() {
    return shared.domList({
      roots: '[data-sidebar="sidebar"]',
      selector: 'a[href^="/c/"]',
      idFromHref,
    });
  }

  function idFromHref(href) {
    const match = String(href || '').match(/^\/c\/([0-9a-f-]{36})(?:[?#/]|$)/i);
    return match && UUID_RE.test(match[1]) ? match[1].toLowerCase() : null;
  }

  function currentId() {
    const match = location.pathname.match(/^\/c\/([0-9a-f-]{36})/i);
    return match && UUID_RE.test(match[1]) ? match[1].toLowerCase() : null;
  }

  async function removeOne(id) {
    try {
      const data = await shared.fetchJson('/rest/app-chat/conversations/soft/' + id, { method: 'DELETE' });
      return !!data && typeof data === 'object' && !Array.isArray(data) && !data.error && data.success !== false;
    } catch (error) {
      return false;
    }
  }

  async function remove(ids, { onProgress, aborted }) {
    const ok = [];
    const failed = [];
    for (let i = 0; i < ids.length; i++) {
      if (aborted && aborted()) break;
      const good = await removeOne(ids[i]);
      (good ? ok : failed).push(ids[i]);
      if (onProgress) onProgress(ids[i], good);
      if (i < ids.length - 1) await shared.sleep(REQ_GAP);
    }
    return { ok, failed, soft: true };
  }

  shared.sites.grok = {
    id: 'grok',
    name: 'Grok',
    origins: ['https://grok.com'],
    list,
    domList,
    remove,
    currentId,
    idFromHref,
  };
})();
