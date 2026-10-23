/**
 * 豆包适配器（www.doubao.com）
 *
 * 列表：POST /im/chain/recent_conv（IM 协议，conv_version 游标翻页）。
 * 删除：POST /im/conversation/batch_del_user_conv（IM 协议 cmd 4171），body 里
 *       conversation_id 传数组、conversation_type=3（单聊机器人）。
 *       这个接口不需要 a_bogus 签名，但 Content-Type 必须带 encoding=utf-8，
 *       否则服务端会返回 712012002「不支持编码类型」。
 *
 * 列表接口 query 里的设备参数每次都不一样，优先复用页面最近一次 IM 请求的 query，
 * 拿不到时用下面 FALLBACK 里的公开参数兜底。
 */
(function () {
  'use strict';

  const shared = CGptBatchDelete;
  const REQ_GAP = 300;
  const PAGE_LIMIT = 20;
  const ID_RE = /^[0-9A-Za-z_-]{6,64}$/;
  const DELETE_CMD = 4171;          // BATCH_DELETE_USER_CONVERSATION
  const CONV_TYPE_BOT = 3;          // ONE_TO_BOT_CHAT

  let tokenCache = '';

  /* ==================== msToken / 设备参数 ==================== */
  function msToken() {
    if (tokenCache) return tokenCache;
    const match = document.cookie.match(/(?:^|;\s*)msToken=([^;]+)/);
    if (match) {
      try { return decodeURIComponent(match[1]); } catch (error) { return match[1]; }
    }
    try { tokenCache = localStorage.getItem('msToken') || ''; } catch (error) { tokenCache = ''; }
    return tokenCache;
  }

  function rememberToken(response) {
    try {
      const token = response.headers.get('x-ms-token');
      if (token) tokenCache = token;
    } catch (error) { /* 跨域或不可读时忽略 */ }
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 3) | 8).toString(16);
    });
  }

  function fallbackParams() {
    return new URLSearchParams({
      version_code: '20800',
      language: (navigator.language || 'zh').split('-')[0],
      device_platform: 'web',
      doubao_device_platform: 'web',
      aid: '497858',
      real_aid: '497858',
      pkg_type: 'release_version',
      pc_version: '3.29.13',
      doubao_pc_version: '3.29.13',
      region: 'CN',
      sys_region: 'CN',
      samantha_web: '1',
      web_platform: 'browser',
      'use-olympus-account': '1',
    });
  }

  // 页面最近一次 IM 请求的 query 里带着当前登录态的设备指纹，直接拿来复用最稳。
  function params() {
    const out = new URLSearchParams();
    try {
      const entries = performance.getEntriesByType('resource').map((entry) => entry.name);
      for (let i = entries.length - 1; i >= 0; i--) {
        if (!/\/im\/(conversation\/info|chain\/single|chain\/recent_conv)/.test(entries[i])) continue;
        new URL(entries[i], location.origin).searchParams.forEach((value, key) => out.set(key, value));
        break;
      }
    } catch (error) { /* performance 不可用 */ }

    for (const [key, value] of fallbackParams()) {
      if (!out.has(key)) out.set(key, value);
    }
    // 页面没有留下 IM 请求可复用时，从站点自己的本地存储补齐设备标识。
    try {
      const device = JSON.parse(localStorage.getItem('client_device_info') || '{}').deviceId;
      if (device && !out.get('device_id')) out.set('device_id', device);
    } catch (error) { /* 结构变化时忽略 */ }
    try {
      const webId = JSON.parse(localStorage.getItem('samantha_web_web_id') || '{}').web_id;
      if (webId) {
        if (!out.get('web_id')) out.set('web_id', webId);
        if (!out.get('tea_uuid')) out.set('tea_uuid', webId);
      }
    } catch (error) { /* 结构变化时忽略 */ }

    out.set('web_tab_id', uuid());
    const token = msToken();
    if (token) out.set('msToken', token);
    return out;
  }

  /* ==================== 列表 ==================== */
  // IM 接口的响应头会刷新 msToken，后面删信用得上，所以这里自己发请求。
  async function postIm(body) {
    let response;
    try {
      response = await fetch('/im/chain/recent_conv?' + params(), {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json; encoding=utf-8',
          'agw-js-conv': 'str',
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new Error('网络请求失败');
    }
    rememberToken(response);
    if (!response.ok) {
      throw new Error(
        response.status === 401 ? '登录已失效' :
        response.status === 403 ? '没有权限' :
        response.status === 429 ? '请求过于频繁' :
        'HTTP ' + response.status
      );
    }
    const text = await response.text();
    if (!text.trim()) throw new Error('接口返回格式异常');
    try { return JSON.parse(text); } catch (error) { throw new Error('接口返回格式异常'); }
  }

  function recentBody(version) {
    // conv_version 必须是数字：0 表示首屏（direction=3），非 0 表示翻旧页（direction=1）。
    const cursor = Number(version) || 0;
    const first = cursor === 0;
    return {
      cmd: 3200,
      uplink_body: {
        pull_recent_conv_chain_uplink_body: {
          limit: PAGE_LIMIT,
          message_count_per_conv: 10,
          api_version: 1,
          conv_version: cursor,
          direction: first ? 3 : 1,
          option: {
            not_need_message: true,
            need_complete_conversation: true,
            need_coco_conversation: first,
            need_coco_bot: first,
            need_pc_pin_chain: true,
            pc_pin_query_type: 0,
          },
        },
      },
      sequence_id: uuid(),
      channel: 2,
      version: '1',
    };
  }

  async function list(onProgress) {
    const out = [];
    const seen = new Set();
    let version = 0;

    for (let page = 0; page < Math.ceil(shared.MAX_LOAD / PAGE_LIMIT); page++) {
      const data = await postIm(recentBody(version));
      if (!data || (typeof data.status_code === 'number' && data.status_code !== 0)) {
        throw new Error(data?.status_desc || '接口返回格式异常');
      }

      const body = data?.downlink_body?.pull_recent_conv_chain_downlink_body || {};
      const cells = Array.isArray(body.cells) ? body.cells : [];
      let added = 0;
      for (const cell of cells) {
        const conv = cell?.conversation || {};
        const id = String(conv.conversation_id || cell?.id || '');
        if (!ID_RE.test(id) || seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          title: String(conv.name || conv.title || id).trim(),
          time: conv.update_time || conv.create_time || null,
        });
        added++;
        if (out.length >= shared.MAX_LOAD) break;
      }

      if (onProgress) onProgress(out.length);
      const next = body.next_conv_version ?? body.next_cursor;
      if (!body.has_more || !next || !cells.length || !added) break;
      version = next;
      await shared.sleep(REQ_GAP);
    }
    return out;
  }

  function idFromHref(href) {
    try {
      const url = new URL(href || '', location.origin);
      if (url.origin !== location.origin) return null;
      const match = url.pathname.match(/^\/chat\/([^/]+)\/?$/);
      return match && ID_RE.test(match[1]) ? match[1] : null;
    } catch (error) {
      return null;
    }
  }

  function domList() {
    // 兼容相对路径和绝对路径两种侧边栏链接。
    return shared.domList({ roots: 'body', selector: 'a[href*="/chat/"]', idFromHref });
  }

  function currentId() {
    const match = location.pathname.match(/^\/chat\/([^/]+)\/?$/);
    return match && ID_RE.test(match[1]) ? match[1] : null;
  }

  /* ==================== 删除 ==================== */
  // 新版 IM 删除：一条请求支持多个 id，返回 result[id]=true 表示删除成功。
  async function deleteOnce(id) {
    const body = {
      cmd: DELETE_CMD,
      uplink_body: {
        batch_delete_user_conversation_uplink_body: {
          conversation_id: [id],
          delete_all: false,
          conversation_type: CONV_TYPE_BOT,
        },
      },
      sequence_id: uuid(),
      channel: 2,
      version: '1',
    };

    let response;
    try {
      response = await fetch('/im/conversation/batch_del_user_conv', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json; encoding=utf-8',
          'agw-js-conv': 'str',
        },
        body: JSON.stringify(body),
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
    if (!text.trim()) throw new Error('接口返回格式异常');
    let data;
    try { data = JSON.parse(text); } catch (error) { throw new Error('接口返回格式异常'); }
    if (typeof data.status_code === 'number' && data.status_code !== 0) {
      throw new Error(data.status_desc || ('错误码 ' + data.status_code));
    }

    const result = data?.downlink_body?.batch_delete_user_conversation_downlink_body?.result;
    if (result && typeof result[id] === 'boolean') return result[id];
    return true;
  }

  async function remove(ids, { onProgress, aborted }) {
    const ok = [];
    const failed = [];
    let lastError = null;
    const report = (id, good) => {
      (good ? ok : failed).push(id);
      if (onProgress) onProgress(id, good);
    };

    for (const id of ids) {
      if (aborted && aborted()) break;
      let good = false;
      try {
        good = await deleteOnce(id);
        if (!good) lastError = new Error('服务端未确认删除');
      } catch (error) {
        lastError = error;
      }
      report(id, good);
      await shared.sleep(REQ_GAP);
    }
    return { ok, failed, error: ok.length ? null : (lastError && lastError.message) };
  }

  shared.sites.doubao = {
    id: 'doubao',
    name: '豆包',
    origins: ['https://www.doubao.com', 'https://doubao.com'],
    list,
    domList,
    remove,
    currentId,
    idFromHref,
  };
})();
