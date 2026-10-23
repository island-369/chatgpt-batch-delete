/**
 * Qwen 适配器（chat.qwen.ai）
 *
 * 列表：GET /api/v2/chats 分页拉全量（含置顶），站点自己的会话列表接口。
 * 删除：DELETE /api/v2/chats/{id}（逐条）。
 */
(function () {
  'use strict';

  const shared = CGptBatchDelete;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const PAGE_SIZE = 60;
  const REQ_GAP = 300;

  function headers() {
    let timezone = '';
    try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (error) { /* ignore */ }
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      source: 'web',
      'X-Request-Id': globalThis.crypto?.randomUUID?.() || String(Date.now()),
      Timezone: timezone,
      'Accept-Language': navigator.language || 'en-US',
    };
  }

  // /api/v2 统一返回 { success, data } 信封；success 不为 true 一律视为失败。
  async function request(path, { method = 'GET', body } = {}) {
    const data = await shared.fetchJson('/api/v2' + path, {
      method,
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!data || data.success !== true) throw new Error('接口返回格式异常');
    return data.data;
  }

  function toItem(value) {
    if (!value || typeof value.id !== 'string' || !UUID_RE.test(value.id)) return null;
    return {
      id: value.id.toLowerCase(),
      title: typeof value.title === 'string' ? value.title : '',
      time: value.updated_at || value.created_at || null,
    };
  }

  async function list(onProgress) {
    const out = [];
    const seen = new Set();
    const add = (items) => {
      if (!Array.isArray(items)) return;
      for (const raw of items) {
        const item = toItem(raw);
        // 项目内的会话不在主列表展示，和网站自身行为一致。
        if (!item || raw.project_id || seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(item);
      }
    };
    add(await request('/chats/pinned'));
    for (let page = 1; page <= Math.ceil(shared.MAX_LOAD / PAGE_SIZE); page++) {
      const items = await request('/chats/?page=' + page + '&exclude_project=true');
      if (!Array.isArray(items)) throw new Error('接口返回格式异常');
      add(items);
      if (onProgress) onProgress(out.length);
      if (items.length < PAGE_SIZE) break;
      await shared.sleep(300);
    }
    return out;
  }

  async function removeOne(id) {
    try {
      const data = await request('/chats/' + id, { method: 'DELETE' });
      return data !== false && data?.success !== false;
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
    return { ok, failed };
  }

  function idFromHref(href) {
    const match = String(href || '').match(/^\/c\/([0-9a-f-]{36})(?:[?#/]|$)/i);
    return match && UUID_RE.test(match[1]) ? match[1].toLowerCase() : null;
  }

  function currentId() {
    const match = location.pathname.match(/^\/c\/([0-9a-f-]{36})/i);
    return match && UUID_RE.test(match[1]) ? match[1].toLowerCase() : null;
  }

  shared.sites.qwen = {
    id: 'qwen',
    name: 'Qwen',
    origins: ['https://chat.qwen.ai'],
    list,
    remove,
    currentId,
    idFromHref,
  };
})();
