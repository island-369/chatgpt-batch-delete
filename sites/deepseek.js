/**
 * DeepSeek 适配器（chat.deepseek.com）
 *
 * 列表：GET /api/v0/chat_session/fetch_page 游标分页拉全量；
 *       置顶会话不在分页结果里，从侧边栏已渲染的条目补充。
 * 删除：POST /api/v0/chat_session/delete（每批 20 条），
 *       新接口收 chat_session_ids 数组，失败时回退旧的单条 chat_session_id。
 */
(function () {
  'use strict';

  const shared = CGptBatchDelete;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const BATCH_SIZE = 20;
  const REQ_GAP = 300;

  /* ==================== 登录态 ==================== */
  // 网页把登录令牌放在 localStorage.userToken（JSON），旧版本键名和 cookie 也兼容。
  function token() {
    try {
      const raw = localStorage.getItem('userToken');
      if (raw) {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (error) { /* 可能是纯字符串 */ }
        if (typeof parsed === 'string' && parsed) return parsed;
        if (parsed && typeof parsed === 'object') {
          const value = parsed.value || parsed.token;
          if (typeof value === 'string' && value) return value;
        }
        if (!parsed && raw.trim()) return raw.trim();
      }
    } catch (error) { /* localStorage 不可用时继续尝试 cookie */ }
    const match = document.cookie.match(/(?:^|;\s*)ds_token=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
    throw new Error('登录已失效');
  }

  function headers(auth, withBody) {
    let offset = 0;
    try { offset = -new Date().getTimezoneOffset() * 60; } catch (error) { /* ignore */ }
    return {
      Authorization: 'Bearer ' + auth,
      'x-client-bundle-id': 'com.deepseek.chat',
      'x-client-locale': 'zh_CN',
      'x-client-platform': 'web',
      'x-client-timezone-offset': String(offset),
      'x-client-version': '2.5.0',
      ...(withBody ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  // 统一响应信封 { code, msg, data: { biz_code, biz_msg, biz_data } }
  function payload(data) {
    if (!data || data.code !== 0) throw new Error(data?.msg || '接口返回格式异常');
    const biz = data.data;
    if (!biz || typeof biz !== 'object') throw new Error('接口返回格式异常');
    if (typeof biz.biz_code === 'number' && biz.biz_code !== 0) {
      throw new Error(biz.biz_msg || '接口返回格式异常');
    }
    return biz.biz_data || {};
  }

  function accepted(data) {
    return !!data && data.code === 0
      && !(data.data && typeof data.data.biz_code === 'number' && data.data.biz_code !== 0);
  }

  /* ==================== 列表 ==================== */
  async function list(onProgress) {
    const auth = token();
    const out = [];
    const seen = new Set();
    let cursor = 0;
    for (let page = 0; page < Math.ceil(shared.MAX_LOAD / 100); page++) {
      const params = new URLSearchParams({ 'lte_cursor.pinned': 'false' });
      if (cursor) params.set('lte_cursor.updated_at', String(cursor));
      const biz = payload(await shared.fetchJson(
        '/api/v0/chat_session/fetch_page?' + params,
        { headers: headers(auth, false) }
      ));
      const items = Array.isArray(biz.chat_sessions) ? biz.chat_sessions : null;
      if (!items) throw new Error('接口返回格式异常');
      let added = 0;
      for (const item of items) {
        const id = typeof item?.id === 'string' ? item.id.toLowerCase() : '';
        if (!UUID_RE.test(id) || seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          title: typeof item.title === 'string' ? item.title : '',
          time: typeof item.updated_at === 'number' ? item.updated_at : (item.updated_at || null),
        });
        if (typeof item.updated_at === 'number') cursor = item.updated_at;
        added++;
      }
      if (onProgress) onProgress(out.length);
      if (!added || !biz.has_more || out.length >= shared.MAX_LOAD) break;
      await shared.sleep(300);
    }
    // 置顶会话走单独的展示逻辑，分页接口通常拿不到，用侧边栏里的行补齐。
    for (const row of domList()) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(row);
    }
    return out;
  }

  function idFromHref(href) {
    try {
      const url = new URL(href || '', location.origin);
      if (url.origin !== location.origin) return null;
      const match = url.pathname.match(/^\/a\/chat\/s\/([0-9a-f-]{36})\/?$/i);
      return match && UUID_RE.test(match[1]) ? match[1].toLowerCase() : null;
    } catch (error) {
      return null;
    }
  }

  function domList() {
    return shared.domList({
      roots: '.ds-scroll-area, aside',
      selector: 'a[href*="/a/chat/s/"]',
      idFromHref,
    });
  }

  function currentId() {
    const match = location.pathname.match(/^\/a\/chat\/s\/([0-9a-f-]{36})/i);
    return match && UUID_RE.test(match[1]) ? match[1].toLowerCase() : null;
  }

  /* ==================== 删除 ==================== */
  async function deleteBulk(auth, ids) {
    try {
      const data = await shared.fetchJson('/api/v0/chat_session/delete', {
        method: 'POST',
        headers: headers(auth, true),
        body: JSON.stringify({ chat_session_ids: ids }),
      });
      return accepted(data);
    } catch (error) {
      return false;
    }
  }

  // 旧版接口只接受单个 chat_session_id。
  async function deleteSingle(auth, id) {
    try {
      const data = await shared.fetchJson('/api/v0/chat_session/delete', {
        method: 'POST',
        headers: headers(auth, true),
        body: JSON.stringify({ chat_session_id: id }),
      });
      return accepted(data);
    } catch (error) {
      return false;
    }
  }

  async function remove(ids, { onProgress, aborted }) {
    const auth = token();
    const ok = [];
    const failed = [];
    const report = (id, good) => {
      (good ? ok : failed).push(id);
      if (onProgress) onProgress(id, good);
    };

    for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
      if (aborted && aborted()) break;
      const batch = ids.slice(offset, offset + BATCH_SIZE);
      if (await deleteBulk(auth, batch)) {
        for (const id of batch) report(id, true);
      } else {
        for (const id of batch) {
          if (aborted && aborted()) break;
          report(id, await deleteSingle(auth, id));
          await shared.sleep(REQ_GAP);
        }
      }
      if (offset + BATCH_SIZE < ids.length) await shared.sleep(REQ_GAP);
    }
    return { ok, failed };
  }

  shared.sites.deepseek = {
    id: 'deepseek',
    name: 'DeepSeek',
    origins: ['https://chat.deepseek.com'],
    list,
    domList,
    remove,
    currentId,
    idFromHref,
  };
})();
