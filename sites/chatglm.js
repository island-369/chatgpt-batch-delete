/**
 * 智谱清言适配器（chatglm.cn）
 *
 * 列表：POST /chatglm/mainchat-api/conversation/recent_list 分页拉全量。
 * 删除：POST /chatglm/backend-api/assistant/conversation/delete（逐条），
 *       需要 assistant_id，从列表响应里记录。
 * 请求头需要 x-sign（与网页前端一致），算法见 sign()。
 */
(function () {
  'use strict';

  const shared = CGptBatchDelete;
  const PAGE_SIZE = 20;
  const REQ_GAP = 300;
  const SALT = '8a1317a7468aa3ad86e997d08f3f31cb';
  const ID_RE = /^[0-9A-Za-z_-]{6,64}$/;

  const meta = new Map();   // conversation_id -> { assistant_id, title, time }

  /* ==================== 登录态与签名 ==================== */
  function token() {
    const match = document.cookie.match(/(?:^|;\s*)chatglm_token=([^;]+)/);
    if (!match) throw new Error('登录已失效');
    try { return decodeURIComponent(match[1]); } catch (error) { return match[1]; }
  }

  function deviceId() {
    try {
      let id = localStorage.getItem('cgpt-bd:chatglm-device');
      if (!id || !/^[0-9a-f]{32}$/i.test(id)) {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        id = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem('cgpt-bd:chatglm-device', id);
      }
      return id;
    } catch (error) {
      return Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32);
    }
  }

  // 去横线 UUID，作为这次请求的 nonce。
  function nonce() {
    if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // 与网页前端一致：ts 的倒数第二位替换为 (各位数字和 - 该位) % 10。
  function sign() {
    const raw = String(Date.now());
    const digits = raw.split('').map(Number);
    const total = digits.reduce((sum, d) => sum + d, 0) - digits[raw.length - 2];
    const ts = raw.slice(0, -2) + (total % 10) + raw.slice(-1);
    const id = nonce();
    return { ts, nonce: id, sign: md5(ts + '-' + id + '-' + SALT) };
  }

  function expGroups() {
    try { return localStorage.getItem('trialGroup') || ''; } catch (error) { return ''; }
  }

  function headers(withBody) {
    const s = sign();
    return {
      accept: 'application/json, text/plain, */*',
      authorization: 'Bearer ' + token(),
      'app-name': 'chatglm',
      'x-app-platform': 'pc',
      'x-app-version': '0.0.1',
      'x-app-fr': 'default',
      'x-lang': 'zh',
      'x-device-id': deviceId(),
      'x-request-id': s.nonce,
      'x-timestamp': s.ts,
      'x-nonce': s.nonce,
      'x-sign': s.sign,
      'x-exp-groups': expGroups(),
      ...(withBody ? { 'Content-Type': 'application/json;charset=utf-8' } : {}),
    };
  }

  /* ==================== 列表 ==================== */
  async function fetchPage(page) {
    const data = await shared.fetchJson('/chatglm/mainchat-api/conversation/recent_list', {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify({ page, page_size: PAGE_SIZE }),
    });
    if (!data || data.status !== 0) throw new Error(data?.message || '接口返回格式异常');
    const result = data.result || {};
    const items = Array.isArray(result.conversation_list) ? result.conversation_list : [];
    return {
      items,
      // 接口没给 has_more 时按“还有下一页”处理，翻到空页自然会停。
      hasMore: result.has_more,
    };
  }

  async function list(onProgress) {
    const out = [];
    const seen = new Set();
    const push = (items) => {
      let added = 0;
      for (const item of items) {
        const id = item?.conversation_id == null ? '' : String(item.conversation_id);
        if (!ID_RE.test(id) || seen.has(id)) continue;
        seen.add(id);
        meta.set(id, item);
        out.push({
          id,
          title: typeof item.title === 'string' ? item.title.trim() : '',
          time: item.update_time || item.create_time || null,
        });
        added++;
      }
      return added;
    };

    try {
      for (let page = 1; page <= Math.ceil(shared.MAX_LOAD / PAGE_SIZE); page++) {
        const { items, hasMore } = await fetchPage(page);
        const added = push(items);
        if (onProgress) onProgress(out.length);
        if (hasMore === false || !added || out.length >= shared.MAX_LOAD) break;
        await shared.sleep(REQ_GAP);
      }
      return out;
    } catch (error) {
      // 新版列表接口失效时，退回旧版 assistant/recently_conversation（最多 100 条）。
      const items = await fetchLegacy();
      push(items);
      if (onProgress) onProgress(out.length);
      return out;
    }
  }

  async function fetchLegacy() {
    const data = await shared.fetchJson('/chatglm/backend-api/assistant/recently_conversation', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        authorization: 'Bearer ' + token(),
        'app-name': 'chatglm',
        'Content-Type': 'application/json;charset=utf-8',
      },
      body: JSON.stringify({ num: 100 }),
    });
    if (!data || data.status !== 0) throw new Error(data?.message || '接口返回格式异常');
    const result = data.result;
    return Array.isArray(result) ? result : (Array.isArray(result?.conversation_list) ? result.conversation_list : []);
  }

  // 旧接口只用于补齐信息：部分版本的 recent_list 不带 assistant_id。
  async function findLegacy(id) {
    try {
      const items = await fetchLegacy();
      return items.find((item) => String(item?.conversation_id || '') === id) || null;
    } catch (error) {
      return null;
    }
  }

  // 删除接口需要 assistant_id；meta 里没有时翻一遍列表，再退回旧接口。
  async function findMeta(id) {
    let found = null;
    try {
      for (let page = 1; page <= Math.ceil(shared.MAX_LOAD / PAGE_SIZE); page++) {
        const { items, hasMore } = await fetchPage(page);
        const hit = items.find((item) => String(item?.conversation_id || '') === id);
        if (hit) {
          found = hit;
          if (hit.assistant_id) {
            meta.set(id, hit);
            return hit;
          }
          break;
        }
        if (hasMore === false || !items.length) break;
        await shared.sleep(REQ_GAP);
      }
    } catch (error) {
      // 列表接口不可用时继续尝试旧接口。
    }

    const legacy = await findLegacy(id);
    if (legacy) {
      meta.set(id, legacy);
      return legacy;
    }
    if (found) {
      meta.set(id, found);
      return found;
    }
    return null;
  }

  function idFromHref(href) {
    try {
      const url = new URL(href || '', location.origin);
      if (url.origin !== location.origin) return null;
      const id = url.searchParams.get('cid') || url.searchParams.get('conversation_id');
      return id && ID_RE.test(id) ? id : null;
    } catch (error) {
      return null;
    }
  }

  function domList() {
    return shared.domList({ roots: 'body', selector: 'a[href]', idFromHref });
  }

  function currentId() {
    const id = new URL(location.href).searchParams.get('cid')
      || new URL(location.href).searchParams.get('conversation_id');
    return id && ID_RE.test(id) ? id : null;
  }

  /* ==================== 删除 ==================== */
  function accepted(data) {
    if (!data || typeof data !== 'object') return true;   // 空响应按成功
    if (typeof data.status === 'number') return data.status === 0;
    if (typeof data.code === 'number') return data.code === 0;
    return true;
  }

  async function deleteOnce(id, assistantId, signed) {
    try {
      const h = signed
        ? headers(true)
        : { accept: 'application/json, text/plain, */*', authorization: 'Bearer ' + token(), 'app-name': 'chatglm', 'Content-Type': 'application/json;charset=utf-8' };
      const data = await shared.fetchJson('/chatglm/backend-api/assistant/conversation/delete', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ assistant_id: assistantId, conversation_id: id }),
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
      const info = meta.get(id) || await findMeta(id);
      if (!info || !info.assistant_id) {
        report(id, false);
        continue;
      }
      let good = await deleteOnce(id, info.assistant_id, true);
      if (!good) good = await deleteOnce(id, info.assistant_id, false);
      report(id, good);
      await shared.sleep(REQ_GAP);
    }
    return { ok, failed };
  }

  /* ==================== MD5（x-sign 需要，输入为 ASCII） ==================== */
  function md5(text) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0xd800 || c >= 0xe000) {
        bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      } else {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (text.charCodeAt(++i) - 0xdc00);
        bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      }
    }
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (let i = 0; i < 4; i++) bytes.push((bitLen >>> (8 * i)) & 0xff);
    for (let i = 4; i < 8; i++) bytes.push(Math.floor(bitLen / Math.pow(2, 8 * i)) & 0xff);

    const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    const K = [];
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;

    let a0 = 0x67452301;
    let b0 = 0xefcdab89 | 0;
    let c0 = 0x98badcfe | 0;
    let d0 = 0x10325476;
    for (let off = 0; off < bytes.length; off += 64) {
      const M = [];
      for (let i = 0; i < 16; i++) {
        M[i] = bytes[off + i * 4] | (bytes[off + i * 4 + 1] << 8)
          | (bytes[off + i * 4 + 2] << 16) | (bytes[off + i * 4 + 3] << 24);
      }
      let A = a0;
      let B = b0;
      let C = c0;
      let D = d0;
      for (let i = 0; i < 64; i++) {
        let F;
        let g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) | 0;
        A = D;
        D = C;
        C = B;
        const r = S[((i >> 4) << 2) + (i & 3)];
        B = (B + ((F << r) | (F >>> (32 - r)))) | 0;
      }
      a0 = (a0 + A) | 0;
      b0 = (b0 + B) | 0;
      c0 = (c0 + C) | 0;
      d0 = (d0 + D) | 0;
    }
    const hex = (n) => {
      let out = '';
      for (let i = 0; i < 4; i++) out += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
      return out;
    };
    return hex(a0) + hex(b0) + hex(c0) + hex(d0);
  }

  shared.sites.chatglm = {
    id: 'chatglm',
    name: '智谱清言',
    origins: ['https://chatglm.cn', 'https://www.chatglm.cn'],
    list,
    domList,
    remove,
    currentId,
    idFromHref,
  };
})();
