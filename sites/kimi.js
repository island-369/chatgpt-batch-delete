/**
 * Kimi 适配器（www.kimi.com）
 *
 * 列表：读取侧边栏 DOM（当前已渲染的置顶与历史分组）。
 * 删除：网站原生的 Connect-RPC 聊天服务，使用页面已有的登录令牌（逐条）。
 */
(function () {
  'use strict';

  const shared = CGptBatchDelete;
  const SERVICE = '/apiv2/kimi.chat.v1.ChatService/';
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const REQ_GAP = 300;

  function session() {
    let token = null;
    let userId = '';
    let info = null;
    try {
      token = localStorage.getItem('access_token');
      userId = (localStorage.getItem('msh_user_id') || '').trim();
      info = JSON.parse(localStorage.getItem('volcano-token-info') || 'null');
    } catch (error) { /* 存储不可用时按未登录处理 */ }
    if (typeof token !== 'string' || !token) throw new Error('登录已失效');
    return {
      token,
      userId,
      webId: typeof info?.webId === 'string' ? info.webId : '',
      ssid: typeof info?.ssid === 'string' ? info.ssid : '',
    };
  }

  function headers(current) {
    let timezone = '';
    try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (error) { /* ignore */ }
    return {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      Authorization: 'Bearer ' + current.token,
      'x-msh-platform': 'web',
      'x-msh-version': '2.2.0',
      'X-Traffic-Id': current.userId,
      'x-msh-device-id': current.webId,
      'x-msh-session-id': current.ssid,
      'X-Language': navigator.language || 'en',
      'R-Timezone': timezone,
    };
  }

  async function removeOne(id, current) {
    try {
      const data = await shared.fetchJson(SERVICE + 'DeleteChat', {
        method: 'POST',
        headers: headers(current),
        body: JSON.stringify({ chat_id: id }),
      });
      // DeleteChat 成功时返回空消息体；带 code/error 的 JSON 视为失败。
      return !!data && typeof data === 'object' && !Array.isArray(data)
        && typeof data.code !== 'string' && !data.error;
    } catch (error) {
      return false;
    }
  }

  async function remove(ids, { onProgress, aborted }) {
    const ok = [];
    const failed = [];
    const current = session();
    for (let i = 0; i < ids.length; i++) {
      if (aborted && aborted()) break;
      const good = await removeOne(ids[i], current);
      (good ? ok : failed).push(ids[i]);
      if (onProgress) onProgress(ids[i], good);
      if (i < ids.length - 1) await shared.sleep(REQ_GAP);
    }
    return { ok, failed };
  }

  function idFromHref(href) {
    const match = String(href || '').match(/^\/chat\/([0-9a-f-]{36})(?:[?#/]|$)/i);
    return match && UUID_RE.test(match[1]) ? match[1].toLowerCase() : null;
  }

  function domList() {
    return shared.domList({
      roots: '[class*="next-sidebar"]',
      selector: 'a[href^="/chat/"]',
      idFromHref,
    });
  }

  function currentId() {
    const match = location.pathname.match(/^\/chat\/([0-9a-f-]{36})/i);
    return match && UUID_RE.test(match[1]) ? match[1].toLowerCase() : null;
  }

  shared.sites.kimi = {
    id: 'kimi',
    name: 'Kimi',
    listNote: '仅包含侧边栏当前已加载的会话',
    origins: ['https://www.kimi.com'],
    list: async () => domList(),
    domList,
    remove,
    currentId,
    idFromHref,
  };
})();
