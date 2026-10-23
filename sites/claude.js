/**
 * Claude 适配器（claude.ai）
 *
 * 列表：GET /api/organizations/{org}/chat_conversations 分页拉全量；
 *       接口不可用时读侧边栏 DOM（当前已渲染的条目）。
 * 删除：普通会话走原生批量接口 delete_many（每批 20 条），失败回退单条 DELETE；
 *       Cowork 任务走 /v1/code/sessions。
 */
(function () {
  'use strict';

  const shared = CGptBatchDelete;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const COWORK_RE = /^cse_[0-9]{2}[1-9A-HJ-NP-Za-km-z]{22}$/;
  const PAGE_SIZE = 100;
  const BATCH_SIZE = 20;
  const REQ_GAP = 500;
  const JSON_HEADERS = { 'Content-Type': 'application/json' };

  const isCowork = (id) => COWORK_RE.test(id);

  /* ==================== 工作区（组织） ==================== */
  let orgCache = null;
  async function organization() {
    if (orgCache) return orgCache;
    const cookie = document.cookie.split(';').map((part) => part.trim())
      .find((part) => part.startsWith('lastActiveOrg='))?.slice('lastActiveOrg='.length);
    if (cookie && UUID_RE.test(cookie)) return (orgCache = cookie);
    const list = await shared.fetchJson('/api/organizations');
    const org = Array.isArray(list) ? list.find((item) => UUID_RE.test(item?.uuid || '')) : null;
    if (!org) throw new Error('未找到工作区');
    return (orgCache = org.uuid);
  }

  /* ==================== 列表 ==================== */
  async function list(onProgress) {
    const org = await organization();
    const out = [];
    const seen = new Set();
    for (let offset = 0; offset < shared.MAX_LOAD; offset += PAGE_SIZE) {
      const data = await shared.fetchJson(
        '/api/organizations/' + org + '/chat_conversations?limit=' + PAGE_SIZE + '&offset=' + offset
      );
      const items = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : null);
      if (!items) throw new Error('接口返回格式异常');
      for (const item of items) {
        const id = typeof item?.uuid === 'string' ? item.uuid.toLowerCase() : null;
        if (!id || !UUID_RE.test(id) || seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          title: typeof item.name === 'string' ? item.name : '',
          time: item.updated_at || item.created_at || null,
        });
      }
      if (onProgress) onProgress(out.length);
      if (items.length < PAGE_SIZE) break;
    }
    // 列表接口通常不含 Cowork 任务，把侧栏里出现的 Cowork 行补进来。
    for (const row of domList()) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(row);
    }
    return out;
  }

  function domList() {
    return shared.domList({
      roots: '[data-testid="sidebar"]',
      selector: 'a[href^="/chat/"], a[href^="/cowork/"]',
      idFromHref,
    });
  }

  function idFromHref(href) {
    const path = String(href || '');
    const chat = path.match(/^\/chat\/([0-9a-f-]{36})(?:[?#/]|$)/i);
    if (chat && UUID_RE.test(chat[1])) return chat[1].toLowerCase();
    const cowork = path.match(/^\/cowork\/(cse_[A-Za-z0-9]+)(?:[?#/]|$)/);
    if (cowork && isCowork(cowork[1])) return cowork[1];
    return null;
  }

  function currentId() {
    const chat = location.pathname.match(/^\/chat\/([0-9a-f-]{36})/i);
    if (chat && UUID_RE.test(chat[1])) return chat[1].toLowerCase();
    const cowork = location.pathname.match(/^\/cowork\/(cse_[A-Za-z0-9]+)/);
    return cowork && isCowork(cowork[1]) ? cowork[1] : null;
  }

  /* ==================== 删除 ==================== */
  async function deleteSingle(org, id) {
    try {
      await shared.fetchJson('/api/organizations/' + org + '/chat_conversations/' + id, {
        method: 'DELETE', headers: JSON_HEADERS, body: JSON.stringify(id),
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  async function deleteCowork(org, id) {
    try {
      await shared.fetchJson('/v1/code/sessions/' + id, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'ccr-byoc-2025-07-29',
          'anthropic-client-feature': 'ccr',
          'x-organization-uuid': org,
        },
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  async function remove(ids, { onProgress, aborted }) {
    const org = await organization();
    const ok = [];
    const failed = [];
    const normal = ids.filter((id) => UUID_RE.test(id));
    const tasks = ids.filter(isCowork);
    const report = (id, good) => {
      (good ? ok : failed).push(id);
      if (onProgress) onProgress(id, good);
    };

    for (let offset = 0; offset < normal.length; offset += BATCH_SIZE) {
      if (aborted && aborted()) break;
      const batch = normal.slice(offset, offset + BATCH_SIZE);
      let acknowledged = null;
      try {
        const data = await shared.fetchJson(
          '/api/organizations/' + org + '/chat_conversations/delete_many',
          { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ conversation_uuids: batch }) }
        );
        if (Array.isArray(data?.deleted)) acknowledged = new Set(data.deleted);
      } catch (error) { /* 批量失败时逐条回退 */ }
      for (const id of batch) {
        if (aborted && aborted()) break;
        report(id, acknowledged ? acknowledged.has(id) : await deleteSingle(org, id));
      }
      if (offset + BATCH_SIZE < normal.length) await shared.sleep(REQ_GAP);
    }

    for (const id of tasks) {
      if (aborted && aborted()) break;
      report(id, await deleteCowork(org, id));
      await shared.sleep(300);
    }
    return { ok, failed };
  }

  shared.sites.claude = {
    id: 'claude',
    name: 'Claude',
    origins: ['https://claude.ai'],
    list,
    domList,
    remove,
    currentId,
    idFromHref,
  };
})();
