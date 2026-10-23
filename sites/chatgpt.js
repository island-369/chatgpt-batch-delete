/**
 * ChatGPT 适配器（chatgpt.com / chat.openai.com）
 *
 * 列表：GET /backend-api/conversations 分页拉全量；接口不可用时读侧边栏 DOM。
 * 删除：优先一次性批量接口，其次单条 DELETE，最后 PATCH is_visible:false（隐藏）。
 */
(function () {
  'use strict';

  const shared = CGptBatchDelete;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const PAGE_SIZE = 100;
  const REQ_GAP = 300;
  const JSON_HEADERS = { 'Content-Type': 'application/json' };
  const RETRYABLE_STATUS = [429, 500, 502, 503, 504];

  let tokenCache = null;
  let tokenAt = 0;

  async function getToken(force = false) {
    if (!force && tokenCache && Date.now() - tokenAt < 5 * 60 * 1000) return tokenCache;
    try {
      const response = await fetch('/api/auth/session', { credentials: 'include' });
      if (response.ok) {
        const data = await response.json();
        if (data && data.accessToken) {
          tokenCache = data.accessToken;
          tokenAt = Date.now();
        }
      }
    } catch (error) { /* 无 token 时仅凭 Cookie 请求 */ }
    return tokenCache;
  }

  async function apiFetch(url, options = {}, timeoutMs = 20000) {
    const headers = Object.assign({}, options.headers);
    const token = await getToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    const doFetch = async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, Object.assign({}, options, {
          credentials: 'include', headers, signal: controller.signal,
        }));
      } finally {
        clearTimeout(timer);
      }
    };
    let response = await doFetch();
    if (response.status === 401) {   // token 过期：强制刷新一次再试
      const fresh = await getToken(true);
      if (fresh) {
        headers.Authorization = 'Bearer ' + fresh;
        response = await doFetch();
      }
    }
    return response;
  }

  /* ==================== 列表 ==================== */
  async function fetchConversations(onProgress) {
    const out = [];
    for (let offset = 0; offset < shared.MAX_LOAD; offset += PAGE_SIZE) {
      const response = await apiFetch(
        '/backend-api/conversations?offset=' + offset + '&limit=' + PAGE_SIZE + '&order=updated'
      );
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json().catch(() => null);
      if (!data) break;
      const items = data.items || data.conversations || [];
      for (const item of items) {
        if (!item || !(item.id || item.conversation_id)) continue;
        out.push({
          id: String(item.id || item.conversation_id),
          title: (item.title || '').trim(),
          time: item.update_time || item.updated_at || item.create_time || item.created_at || null,
        });
      }
      if (onProgress) onProgress(out.length, data.total);
      const more = typeof data.has_more === 'boolean'
        ? data.has_more
        : (data.total != null ? out.length < data.total : items.length === PAGE_SIZE);
      if (!items.length || !more) break;
    }
    return out;
  }

  /* AI 命名：只读取最近 8 条用户/助手消息，不把工具消息或整段历史交给模型。 */
  async function getRecentMessages(id) {
    if (!UUID_RE.test(String(id))) throw new Error('会话 ID 无效');
    const response = await apiFetch('/backend-api/conversation/' + encodeURIComponent(id), {}, 45000);
    if (!response.ok) throw new Error('读取会话内容失败（HTTP ' + response.status + '）');
    const data = await response.json();
    const mapping = data?.mapping || data?.conversation?.mapping;
    if (!mapping || typeof mapping !== 'object') throw new Error('站点没有返回可读取的对话内容');

    let nodes = [];
    if (data.current_node && mapping[data.current_node]) {
      const visited = new Set();
      let node = mapping[data.current_node];
      while (node && !visited.has(node.id)) {
        visited.add(node.id);
        nodes.push(node);
        node = node.parent ? mapping[node.parent] : null;
      }
      nodes.reverse();
    } else {
      nodes = Object.values(mapping).slice().sort((a, b) => {
        const at = Number(a?.message?.create_time) || 0;
        const bt = Number(b?.message?.create_time) || 0;
        return at - bt;
      });
    }

    const messages = nodes.map((node) => {
      const message = node?.message;
      const role = message?.author?.role;
      if (!message || !['user', 'assistant'].includes(role)) return null;
      const content = message.content || {};
      const parts = Array.isArray(content.parts) ? content.parts : [];
      const text = parts.map((part) => typeof part === 'string'
        ? part
        : (part && typeof part.text === 'string' ? part.text : '')).join('\n').trim();
      return text ? { role, text: text.slice(0, 2400) } : null;
    }).filter(Boolean);
    const recent = messages.slice(-8);
    if (!recent.length) throw new Error('这个会话没有可用于生成标题的文字消息');
    return recent;
  }

  async function renameTitle(id, title) {
    if (!UUID_RE.test(String(id))) throw new Error('会话 ID 无效');
    const value = String(title || '').trim();
    if (!value || value.length > 80) throw new Error('标题长度需要在 1 到 80 个字符之间');
    const response = await apiFetch('/backend-api/conversation/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: value }),
    });
    if (!response.ok) throw new Error('更新原标题失败（HTTP ' + response.status + '）');
    return true;
  }

  /* ChatGPT Library：网页内部接口尚无公开契约，优先使用 Library 专属路径。 */
  async function libraryRequest(paths, options = {}) {
    let lastError = null;
    for (const path of paths) {
      let response;
      try {
        response = await apiFetch(path, options, 45000);
      } catch (error) { lastError = error; continue; }
      if (response.status === 404 || response.status === 405) {
        lastError = new Error('资料库接口不可用（HTTP ' + response.status + '）');
        continue;
      }
      if (!response.ok) throw new Error('资料库请求失败（HTTP ' + response.status + '）');
      return response;
    }
    throw lastError || new Error('暂时无法访问 ChatGPT 资料库');
  }

  function normalizeLibraryFile(item) {
    if (!item || typeof item !== 'object') return null;
    const id = item.library_file_id || item.id || item.file_id || item.file?.id;
    if (!id) return null;
    const name = item.name || item.filename || item.file_name || item.original_filename
      || item.file?.name || item.title || '未命名文件';
    const provider = String(item.provider || item.source || item.origin || item.connector || item.provider_name || '').toLowerCase();
    const accessKind = String(item.access_kind || '').toLowerCase();
    const connected = !!(item.connected || item.is_connected || item.external || item.connector
      || (accessKind && accessKind !== 'owned')
      || /drive|dropbox|box|sharepoint|google/.test(provider));
    const kind = String(item.kind || item.type || item.category || item.file_type || item.library_file_category || '').toLowerCase();
    const purpose = String(item.purpose || item.created_by || item.source_type || '').toLowerCase();
    const created = item.created_at || item.createdAt || item.uploaded_at || item.created_time
      || item.file_upload_time || item.updated_at || item.record_creation_time || null;
    return {
      id: String(id),
      name: String(name), size: Number(item.bytes ?? item.size_bytes ?? item.file_size_bytes ?? item.size) || 0,
      time: created, mime: String(item.mime_type || item.mimeType || item.content_type || ''),
      type: kind, source: connected ? 'connected' : (/generated|output|image_gen|dalle/.test(purpose) ? 'generated' : 'uploaded'),
      provider: provider || '', connected,
      url: item.url || item.web_url || item.download_url || item.thumbnail_url || '',
    };
  }

  async function libraryList() {
    const files = [];
    let hasMore = false;
    let cursor = null;
    for (let page = 0; page < 40; page += 1) {
      const response = await libraryRequest(['/backend-api/files/library'], {
        method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify({
          cursor, limit: 50, categories: [], source: null,
          include_hidden_files: false, include_saved_entities: true, include_sites: false,
          providers: ['google_drive', 'box', 'dropbox'], ranking: 'suggested', trashed_only: false,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!data) throw new Error('资料库没有返回可识别的数据');
      const raw = Array.isArray(data) ? data
        : (data?.files || data?.library_files || data?.items || data?.nodes || data?.results
          || data?.data?.files || data?.data?.library_files || data?.data?.items || data?.data?.nodes
          || data?.data?.results || data?.data || []);
      if (!Array.isArray(raw)) throw new Error('资料库返回格式暂不支持，请稍后重试');
      const pageFiles = raw.map(normalizeLibraryFile).filter(Boolean);
      if (!pageFiles.length && raw.length) throw new Error('无法识别资料库文件信息');
      files.push(...pageFiles);
      cursor = data?.next_cursor || data?.nextCursor || data?.cursor
        || data?.pagination?.next_cursor || data?.data?.next_cursor || data?.data?.nextCursor || null;
      hasMore = !!(data?.has_more || data?.hasMore || data?.pagination?.has_more
        || data?.data?.has_more || data?.data?.hasMore);
      if (!hasMore || !cursor || !raw.length || pageFiles.length === 0) break;
      if (page === 39) { hasMore = true; break; }
    }
    const unique = Array.from(new Map(files.map((file) => [file.id, file])).values());
    unique.hasMore = hasMore;
    return unique;
  }

  async function libraryDownload(file) {
    if (!file?.id) throw new Error('文件 ID 无效');
    if (file.connected && file.url) {
      const externalUrl = new URL(file.url, location.origin);
      if (!['https:', 'http:'].includes(externalUrl.protocol)) throw new Error('下载地址无效');
      return { url: externalUrl.href, name: file.name };
    }
    const encoded = encodeURIComponent(file.id);
    const response = await libraryRequest([
      '/api/library/files/' + encoded + '/content',
    ]);
    const type = response.headers.get('content-type') || '';
    if (type.includes('application/json')) {
      const data = await response.json();
      const url = data?.download_url || data?.url || data?.downloadUrl;
      if (!url) throw new Error('资料库没有返回下载地址');
      const downloadUrl = new URL(url, location.origin);
      if (!['https:', 'http:'].includes(downloadUrl.protocol)) throw new Error('下载地址无效');
      return { url: downloadUrl.href, name: file.name };
    }
    return { blob: await response.blob(), name: file.name };
  }

  // 接口不可用时的兜底：直接读侧边栏 DOM（只有当前已渲染的条目）。
  function domList() {
    const seen = new Map();
    document.querySelectorAll('a[href*="/c/"]').forEach((link) => {
      const match = (link.getAttribute('href') || '').match(/\/c\/([0-9a-fA-F-]{36})/);
      if (!match || !UUID_RE.test(match[1]) || seen.has(match[1].toLowerCase())) return;
      const titleNode = link.querySelector('[title]');
      const title = ((titleNode && titleNode.getAttribute('title')) || link.textContent || '')
        .trim().replace(/\s+/g, ' ');
      seen.set(match[1].toLowerCase(), {
        id: match[1].toLowerCase(), title: title || '未命名会话', time: null,
      });
    });
    return Array.from(seen.values());
  }

  /* ==================== 删除 ==================== */
  // 删除方法表：按优先级尝试（真删除在前），探测成功的方法会被记住复用。
  const DELETE_METHODS = [
    {
      name: 'POST conversations/delete',
      fn: (id) => apiFetch('/backend-api/conversations/delete', {
        method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify({ conversation_ids: [id] }),
      }),
    },
    {
      name: 'POST conversations/delete (target)',
      fn: (id) => apiFetch('/backend-api/conversations/delete', {
        method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify({ conversation_ids: [id], target: 'conversations' }),
      }),
    },
    {
      name: 'DELETE conversation/{id}',
      fn: (id) => apiFetch('/backend-api/conversation/' + id, { method: 'DELETE' }),
    },
    {
      name: 'POST conversation/delete',
      fn: (id) => apiFetch('/backend-api/conversation/delete', {
        method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify({ conversation_id: id }),
      }),
    },
    {
      // 长期可用的兜底：从列表隐藏（归档），效果同样是侧边栏消失。
      name: 'PATCH conversation/{id} (隐藏)',
      fn: (id) => apiFetch('/backend-api/conversation/' + id, {
        method: 'PATCH', headers: JSON_HEADERS,
        body: JSON.stringify({ is_visible: false }),
      }),
    },
  ];

  let preferredMethod = -1;

  async function attemptWithRetry(makeRequest) {
    try {
      let response = await makeRequest();
      if (RETRYABLE_STATUS.indexOf(response.status) >= 0) {
        await shared.sleep(response.status === 429 ? 2500 : 700);
        response = await makeRequest();
      }
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  async function tryDeleteBulk(ids) {
    const bodies = [
      { conversation_ids: ids },
      { conversation_ids: ids, target: 'conversations' },
    ];
    for (const body of bodies) {
      try {
        const response = await apiFetch('/backend-api/conversations/delete', {
          method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body),
        }, 60000);
        if (response.ok) return true;
      } catch (error) { /* 换下一种参数 */ }
    }
    return false;
  }

  async function deleteOne(id) {
    if (preferredMethod >= 0) {
      const method = DELETE_METHODS[preferredMethod];
      if (await attemptWithRetry(() => method.fn(id))) return true;
      preferredMethod = -1;
    }
    for (let i = 0; i < DELETE_METHODS.length; i++) {
      const method = DELETE_METHODS[i];
      if (await attemptWithRetry(() => method.fn(id))) {
        preferredMethod = i;
        console.debug('[ChatGPT批量删除] 使用删除方法:', method.name);
        return true;
      }
    }
    return false;
  }

  async function remove(ids, { onProgress, aborted }) {
    const ok = [];
    const failed = [];
    let stopped = false;
    let bulkDone = ids.length > 1 && await tryDeleteBulk(ids);
    if (bulkDone) {
      ids.forEach((id) => { ok.push(id); if (onProgress) onProgress(id, true); });
    } else {
      for (let i = 0; i < ids.length; i++) {
        if (aborted && aborted()) break;
        const good = await deleteOne(ids[i]);
        (good ? ok : failed).push(ids[i]);
        if (onProgress) onProgress(ids[i], good);
        // 连续失败且无一成功：接口整体不可用，及时止损。
        if (failed.length >= 3 && ok.length === 0) {
          stopped = true;
          break;
        }
        if (i < ids.length - 1) await shared.sleep(REQ_GAP);
      }
    }
    // 走方法表最后一项说明是隐藏而非真删除，界面上会补充说明。
    return { ok, failed, stopped, soft: !bulkDone && preferredMethod === DELETE_METHODS.length - 1 };
  }

  function idFromHref(href) {
    const match = String(href || '').match(/\/c\/([0-9a-f-]{36})(?:[?#/]|$)/i);
    return match && UUID_RE.test(match[1]) ? match[1].toLowerCase() : null;
  }

  function currentId() {
    const match = location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
    return match && UUID_RE.test(match[1]) ? match[1].toLowerCase() : null;
  }

  // ChatGPT 的侧边栏行可以安全移除（原项目行为），其余站点用 CSS 隐藏。
  function hideDeleted(ids) {
    try {
      ids.forEach((id) => {
        document.querySelectorAll('a[href*="/c/' + id + '"]').forEach((link) => {
          (link.closest('li') || link).remove();
        });
      });
    } catch (error) { /* 仅视觉同步，失败不影响结果 */ }
  }

  shared.sites.chatgpt = {
    id: 'chatgpt',
    name: 'ChatGPT',
    origins: ['https://chatgpt.com', 'https://chat.openai.com'],
    list: fetchConversations,
    domList,
    remove,
    currentId,
    hideDeleted,
    idFromHref,
    getRecentMessages,
    renameTitle,
    libraryList,
    libraryDownload,
  };
})();
