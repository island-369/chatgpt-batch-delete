/**
 * 腾讯元宝适配器（yuanbao.tencent.com）
 *
 * 列表：POST /api/user/agent/conversation/list（offset 分页拉全量）。
 * 删除：POST /api/user/agent/conversation/v1/clear（逐条，网页侧边栏删除走的也是它），
 *       失败时回退 /api/user/agent/conversation/v1/delete。
 * 会话地址是 /chat/<agentId>/<conversationId>，删除只需要 conversationId。
 */
(function () {
  'use strict';

  const shared = CGptBatchDelete;
  const PAGE_SIZE = 40;
  const REQ_GAP = 300;
  const DEFAULT_AGENT = 'naQivTmsDa';
  const ID_RE = /^[0-9A-Za-z_-]{6,64}$/;

  const agentOf = new Map();   // conversation_id -> agentId（删除时一并回传）

  /* ==================== 请求 ==================== */
  async function post(path, body) {
    const data = await shared.fetchJson(path, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const code = data?.code ?? data?.error?.code;
    if (code !== undefined && String(code) !== '0') {
      throw new Error(data?.message || data?.msg || data?.error?.message || '接口返回格式异常');
    }
    return data || {};
  }

  function agentId() {
    const parts = location.pathname.split('/').filter(Boolean);
    return parts[0] === 'chat' && parts[1] && ID_RE.test(parts[1]) ? parts[1] : DEFAULT_AGENT;
  }

  /* ==================== 列表 ==================== */
  async function list(onProgress) {
    const current = agentId();
    const out = [];
    const seen = new Set();
    let offset = 0;
    let total = Infinity;

    while (out.length < shared.MAX_LOAD && offset < total) {
      const data = await post('/api/user/agent/conversation/list', {
        agentId: current,
        offset,
        limit: PAGE_SIZE,
        filterGoodQuestion: true,
      });
      const items = Array.isArray(data.conversations) ? data.conversations : [];
      const rawTotal = data?.pagination?.totalResults;
      total = rawTotal == null || rawTotal === '' ? Infinity : Number(rawTotal);
      if (!Number.isFinite(total)) total = Infinity;
      let added = 0;

      for (const item of items) {
        const id = item?.id == null ? '' : String(item.id);
        if (!ID_RE.test(id) || seen.has(id)) continue;
        seen.add(id);
        agentOf.set(id, item.agentId || current);
        out.push({
          id,
          title: String(item.title || item.sessionTitle || id).trim(),
          time: item.lastRepliedAt || item.lastRepliedDatetime || null,
        });
        added++;
        if (out.length >= shared.MAX_LOAD) break;
      }

      if (onProgress) onProgress(out.length);
      if (!items.length || !added) break;
      offset += items.length;
      await shared.sleep(REQ_GAP);
    }
    return out;
  }

  function idFromHref(href) {
    try {
      const url = new URL(href || '', location.origin);
      if (url.origin !== location.origin) return null;
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'chat' || parts.length < 3) return null;
      const id = parts[2];
      return ID_RE.test(id) ? id : null;
    } catch (error) {
      return null;
    }
  }

  function domList() {
    return shared.domList({ roots: 'body', selector: 'a[href*="/chat/"]', idFromHref });
  }

  function currentId() {
    const parts = location.pathname.split('/').filter(Boolean);
    return parts[0] === 'chat' && parts.length >= 3 && ID_RE.test(parts[2]) ? parts[2] : null;
  }

  /* ==================== 删除 ==================== */
  function accepted(data) {
    if (!data || typeof data !== 'object') return true;
    const code = data.code ?? data.error?.code;
    return code === undefined || String(code) === '0';
  }

  async function deleteOnce(path, body) {
    try {
      const data = await shared.fetchJson(path, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return accepted(data);
    } catch (error) {
      return false;
    }
  }

  async function remove(ids, { onProgress, aborted }) {
    const ok = [];
    const failed = [];
    const report = (id, good) => {
      (good ? ok : failed).push(id);
      if (onProgress) onProgress(id, good);
    };

    for (const id of ids) {
      if (aborted && aborted()) break;
      let good = await deleteOnce('/api/user/agent/conversation/v1/clear', {
        conversationIds: [id],
        uiOptions: { noToast: true },
      });
      if (!good) {
        good = await deleteOnce('/api/user/agent/conversation/v1/delete', {
          conversationId: id,
          agentId: agentOf.get(id) || agentId(),
        });
      }
      report(id, good);
      await shared.sleep(REQ_GAP);
    }
    return { ok, failed };
  }

  shared.sites.yuanbao = {
    id: 'yuanbao',
    name: '腾讯元宝',
    origins: ['https://yuanbao.tencent.com'],
    list,
    domList,
    remove,
    currentId,
    idFromHref,
  };
})();
