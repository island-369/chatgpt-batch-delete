/**
 * ChatGPT 批量删除会话 —— Chrome / Edge 扩展（content script）
 *
 * 功能：
 *   在 chatgpt.com 右下角注入一个可拖动的悬浮按钮，点击后弹出会话选择框，
 *   支持搜索、全选、多选，一键批量删除。深浅色主题自动适配。
 *
 * 原理（全部为 chatgpt.com 同源请求，使用当前登录态，无任何外部上传）：
 *   - GET  /backend-api/conversations?offset&limit&order=updated   分页拉取会话列表
 *   - POST /backend-api/conversations/delete                       优先尝试真·批量删除
 *   - DELETE /backend-api/conversation/{id} 等多个接口             逐条回退
 *   - PATCH /backend-api/conversation/{id} {is_visible:false}      最后兜底（隐藏/归档，
 *     效果同样是会话从列表消失；此链路已在多个 2025 年仍活跃的脚本中验证）
 *
 * 注意：这些是 OpenAI 未公开的内部接口，ChatGPT 改版后可能变化；
 *       届时调整下方「删除方法表 DELETE_METHODS」即可。
 */
(() => {
  'use strict';

  if (window.__CGPT_BATCH_DELETE_LOADED__) return;
  window.__CGPT_BATCH_DELETE_LOADED__ = true;

  /* ==================== 配置 ==================== */
  const MAX_LOAD = 1000;                        // 单次最多加载的会话条数
  const PAGE_SIZE = 100;                        // 列表接口分页大小
  const REQ_GAP = 300;                          // 逐条删除之间的间隔(ms)，避免触发限流
  const POS_KEY = 'cgpt-batch-delete:fab-pos';  // 悬浮按钮位置存储键

  /* ==================== 小工具 ==================== */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  function fmtTime(v) {
    if (v == null || v === '') return '';
    const d = typeof v === 'number' ? new Date(v * 1000) : new Date(v);
    if (isNaN(d.getTime())) return '';
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + ' 天前';
    return d.toLocaleDateString('zh-CN');
  }

  /* ==================== 接口层（同源 + 当前登录态） ==================== */
  let tokenCache = null;
  let tokenAt = 0;

  // 从 /api/auth/session 取 accessToken；取不到时仅凭 Cookie 请求
  async function getToken(force = false) {
    if (!force && tokenCache && Date.now() - tokenAt < 5 * 60 * 1000) return tokenCache;
    try {
      const r = await fetch('/api/auth/session', { credentials: 'include' });
      if (r.ok) {
        const j = await r.json();
        if (j && j.accessToken) { tokenCache = j.accessToken; tokenAt = Date.now(); }
      }
    } catch (e) { /* ignore */ }
    return tokenCache;
  }

  async function apiFetch(url, options = {}, timeoutMs = 20000) {
    const headers = Object.assign({}, options.headers);
    const token = await getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const doFetch = async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        return await fetch(url, Object.assign({}, options, {
          credentials: 'include', headers, signal: ctrl.signal,
        }));
      } finally { clearTimeout(timer); }
    };

    let res = await doFetch();
    if (res.status === 401) {  // token 过期：强制刷新一次再试
      const t2 = await getToken(true);
      if (t2) {
        headers['Authorization'] = 'Bearer ' + t2;
        res = await doFetch();
      }
    }
    return res;
  }

  /* 拉取全部会话（自动翻页），返回 [{id, title, time}] */
  async function fetchConversations(onProgress) {
    const out = [];
    for (let offset = 0; offset < MAX_LOAD; offset += PAGE_SIZE) {
      const res = await apiFetch(
        '/backend-api/conversations?offset=' + offset + '&limit=' + PAGE_SIZE + '&order=updated'
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json().catch(() => null);
      if (!data) break;
      const items = data.items || data.conversations || [];
      for (const it of items) {
        if (!it || !(it.id || it.conversation_id)) continue;
        out.push({
          id: String(it.id || it.conversation_id),
          title: (it.title || '').trim(),
          time: it.update_time || it.updated_at || it.create_time || it.created_at || null,
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

  /* 接口不可用时的兜底：直接读侧边栏 DOM */
  function conversationsFromSidebar() {
    const seen = new Map();
    document.querySelectorAll('a[href*="/c/"]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(/\/c\/([0-9a-fA-F-]{36})/);
      if (!m || seen.has(m[1])) return;
      const t = a.querySelector('[title]');
      const title = ((t && t.getAttribute('title')) || a.textContent || '')
        .trim().replace(/\s+/g, ' ');
      seen.set(m[1], { id: m[1], title: title || '未命名会话', time: null });
    });
    return Array.from(seen.values());
  }

  /* ==================== 删除 ==================== */
  const JSON_HEADERS = { 'Content-Type': 'application/json' };
  const RETRYABLE_STATUS = [429, 500, 502, 503, 504];

  // 删除方法表：按优先级尝试（真删除在前），第一个成功的方法会被记住并复用
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
      // 长期可用的兜底：从列表隐藏（归档），效果同样是侧边栏消失
      name: 'PATCH conversation/{id} (隐藏)',
      fn: (id) => apiFetch('/backend-api/conversation/' + id, {
        method: 'PATCH', headers: JSON_HEADERS,
        body: JSON.stringify({ is_visible: false }),
      }),
    },
  ];

  let preferredMethod = -1; // 探测成功的删除方法下标；-1 表示未知

  async function attemptWithRetry(makeRequest) {
    try {
      let res = await makeRequest();
      if (RETRYABLE_STATUS.indexOf(res.status) >= 0) {
        await sleep(res.status === 429 ? 2500 : 700);
        res = await makeRequest();
      }
      return res.ok;
    } catch (e) {
      return false;
    }
  }

  // 优先一次性批量删除（一条请求删全部）
  async function tryDeleteBulk(ids) {
    const bodies = [
      { conversation_ids: ids },
      { conversation_ids: ids, target: 'conversations' },
    ];
    for (const body of bodies) {
      try {
        const res = await apiFetch('/backend-api/conversations/delete', {
          method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body),
        }, 60000);
        if (res.ok) return true;
      } catch (e) { /* 换下一种参数 */ }
    }
    return false;
  }

  // 单条删除：优先复用已探测成功的方法，否则按方法表逐个探测
  async function deleteOne(id) {
    if (preferredMethod >= 0) {
      const m = DELETE_METHODS[preferredMethod];
      if (await attemptWithRetry(() => m.fn(id))) return true;
      preferredMethod = -1; // 该方法失效，重新探测
    }
    for (let i = 0; i < DELETE_METHODS.length; i++) {
      const m = DELETE_METHODS[i];
      if (await attemptWithRetry(() => m.fn(id))) {
        preferredMethod = i;
        console.debug('[ChatGPT批量删除] 使用删除方法:', m.name);
        return true;
      }
    }
    return false;
  }

  /* ==================== 界面（Shadow DOM 隔离，open 便于调试） ==================== */
  const CSS = `
    :host {
      all: initial;
      /* 深色主题（默认） */
      --bg: #212121;
      --bg-hover: rgba(255, 255, 255, 0.05);
      --fg: #ececec;
      --muted: #9b9b9b;
      --time: #8f8f8f;
      --border: rgba(255, 255, 255, 0.09);
      --border-soft: rgba(255, 255, 255, 0.06);
      --input-bg: rgba(255, 255, 255, 0.06);
      --input-border: rgba(255, 255, 255, 0.1);
      --accent: #10a37f;
      --accent-soft: rgba(16, 163, 127, 0.12);
      --accent-ring: rgba(16, 163, 127, 0.18);
      --danger: #ef4444;
      --danger-hover: #dc2626;
      --danger-deep: #b91c1c;
      --ok: #4ade80;
      --warn: #fbbf24;
      --err: #f87171;
      --overlay: rgba(0, 0, 0, 0.52);
      --track: rgba(255, 255, 255, 0.1);
      --scrollbar: rgba(255, 255, 255, 0.14);
      --shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
    }
    :host(.theme-light) {
      --bg: #ffffff;
      --bg-hover: rgba(0, 0, 0, 0.045);
      --fg: #0d0d0d;
      --muted: #5d5d5d;
      --time: #8a8a8a;
      --border: rgba(0, 0, 0, 0.1);
      --border-soft: rgba(0, 0, 0, 0.07);
      --input-bg: rgba(0, 0, 0, 0.04);
      --input-border: rgba(0, 0, 0, 0.14);
      --accent: #0d8a6c;
      --accent-soft: rgba(16, 163, 127, 0.1);
      --accent-ring: rgba(13, 138, 108, 0.15);
      --danger: #dc2626;
      --danger-hover: #b91c1c;
      --danger-deep: #991b1b;
      --ok: #16a34a;
      --warn: #b45309;
      --err: #dc2626;
      --overlay: rgba(0, 0, 0, 0.4);
      --track: rgba(0, 0, 0, 0.08);
      --scrollbar: rgba(0, 0, 0, 0.2);
      --shadow: 0 24px 64px rgba(0, 0, 0, 0.22);
    }
    * { box-sizing: border-box; margin: 0; padding: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                     "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
    .hidden { display: none !important; }

    .fab { position: fixed; z-index: 2147483646; right: 20px; bottom: 96px;
      width: 46px; height: 46px; border-radius: 50%;
      border: 1px solid rgba(255, 255, 255, 0.15); background: #10a37f; color: #fff;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35); opacity: 0.92;
      transition: opacity 0.15s, transform 0.15s; touch-action: none; user-select: none; }
    .fab:hover { opacity: 1; transform: scale(1.06); }
    .fab:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
    .fab.dragging { opacity: 1; transform: scale(0.94); cursor: grabbing; }
    .fab svg { width: 21px; height: 21px; pointer-events: none; }
    .fab.deleting { cursor: progress; }
    /* 删除中：按钮外圈的环形进度 */
    .fab.deleting::after { content: ""; position: absolute; inset: -4px; border-radius: 50%;
      background: conic-gradient(var(--accent) var(--p, 0%), rgba(255, 255, 255, 0.22) 0);
      -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3.5px), #000 calc(100% - 3px));
              mask: radial-gradient(farthest-side, transparent calc(100% - 3.5px), #000 calc(100% - 3px));
      pointer-events: none; }
    /* 收起弹窗后的后台进度气泡 */
    .flag { position: fixed; z-index: 2147483646; display: none; align-items: center; gap: 7px;
      transform: translate(-100%, -50%); background: rgba(33, 33, 33, 0.96); color: #ececec;
      border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 999px; padding: 6px 12px;
      font-size: 12px; white-space: nowrap; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35); }
    .flag.show { display: flex; }
    .flag::before { content: ""; width: 8px; height: 8px; border-radius: 50%;
      background: var(--accent); flex: none; animation: blink 1.1s infinite; }
    .flag.ok::before { background: var(--ok); animation: none; }
    .flag.warn::before { background: var(--warn); animation: none; }
    @keyframes blink { 50% { opacity: 0.25; } }

    .overlay { position: fixed; inset: 0; z-index: 2147483647;
      background: var(--overlay); display: flex; align-items: center;
      justify-content: center; padding: 24px; animation: fadeIn 0.16s ease-out; }
    .dialog { width: min(560px, 94vw); max-height: min(82vh, 700px);
      display: flex; flex-direction: column; background: var(--bg); color: var(--fg);
      border: 1px solid var(--border); border-radius: 16px;
      box-shadow: var(--shadow); overflow: hidden;
      animation: pop 0.18s cubic-bezier(0.2, 0.9, 0.3, 1.15); }
    @keyframes fadeIn { from { opacity: 0; } }
    @keyframes pop { from { opacity: 0; transform: scale(0.96) translateY(8px); } }

    header { display: flex; align-items: center; justify-content: space-between;
      padding: 16px 18px 12px; }
    .title { font-size: 16px; font-weight: 600; }
    .title small { font-weight: 400; font-size: 12px; color: var(--muted); margin-left: 8px; }
    .close { background: none; border: none; color: var(--muted); font-size: 22px;
      line-height: 1; cursor: pointer; padding: 2px 9px; border-radius: 8px; }
    .close:hover { background: var(--bg-hover); color: var(--fg); }

    .toolbar { display: flex; align-items: center; gap: 10px; padding: 0 18px 10px; }
    .sel-all-label { display: flex; align-items: center; gap: 6px; font-size: 13px;
      color: var(--fg); cursor: pointer; white-space: nowrap; }
    input[type="checkbox"] { accent-color: var(--accent); width: 15px; height: 15px;
      cursor: pointer; flex: none; }
    .search { flex: 1; min-width: 0; background: var(--input-bg);
      border: 1px solid var(--input-border); border-radius: 10px; color: var(--fg);
      font-size: 13px; padding: 7px 10px; outline: none; transition: border-color 0.15s, box-shadow 0.15s; }
    .search:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring); }
    .search::placeholder { color: var(--muted); }
    .count { font-size: 12px; color: var(--muted); white-space: nowrap; }

    .list { flex: 1; overflow-y: auto; padding: 0 10px 10px; }
    .row { display: flex; align-items: center; gap: 10px; padding: 8px 10px;
      border-radius: 10px; cursor: pointer; }
    .row:hover { background: var(--bg-hover); }
    .row.checked { background: var(--accent-soft); }
    .row-title { flex: 1; min-width: 0; font-size: 13.5px; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; }
    .row-time { font-size: 11.5px; color: var(--time); white-space: nowrap; }
    .badge { font-size: 10px; color: var(--accent); border: 1px solid var(--accent);
      padding: 1px 6px; border-radius: 99px; white-space: nowrap; flex: none; }
    .empty { padding: 44px 0; text-align: center; color: var(--muted); font-size: 13px; }

    .statusbar { display: flex; align-items: center; gap: 10px; min-height: 34px;
      padding: 6px 18px; font-size: 12px; color: var(--muted);
      border-top: 1px solid var(--border-soft); }
    .status-text.err { color: var(--err); }
    .status-text.ok { color: var(--ok); }
    .status-text.warn { color: var(--warn); }
    .progress { flex: 1; height: 4px; border-radius: 4px;
      background: var(--track); overflow: hidden; }
    .progress i { display: block; height: 100%; width: 0; background: var(--accent);
      transition: width 0.2s; }

    footer { display: flex; justify-content: flex-end; gap: 10px;
      padding: 12px 18px 16px; border-top: 1px solid var(--border-soft); }
    .btn { font-size: 13px; padding: 8px 16px; border-radius: 10px; cursor: pointer;
      border: 1px solid transparent; }
    .btn-ghost { background: none; border-color: var(--border); color: var(--fg); }
    .btn-ghost:hover { background: var(--bg-hover); }
    .btn-del { background: var(--danger); color: #fff; min-width: 150px; }
    .btn-del:hover { background: var(--danger-hover); }
    .btn-del:disabled { background: var(--danger); opacity: 0.35; cursor: not-allowed; }
    .btn-del.btn-pending { background: none; color: var(--danger); border-color: var(--danger);
      animation: pulse 1.2s infinite; }
    .btn-del.btn-abort { background: none; color: var(--danger); border-color: var(--danger); }
    .btn-del.btn-abort:hover { background: rgba(239, 68, 68, 0.12); }
    .btn-del.btn-abort:disabled { background: none; color: var(--danger); opacity: 0.5; cursor: default; }
    @keyframes pulse { 50% { box-shadow: 0 0 0 6px rgba(239, 68, 68, 0.16); } }

    ::-webkit-scrollbar { width: 8px; }
    ::-webkit-scrollbar-thumb { background: var(--scrollbar); border-radius: 8px; }

    @media (prefers-reduced-motion: reduce) {
      * { animation: none !important; transition: none !important; }
    }
  `;

  const SVG_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>'
    + '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'
    + '<path d="M10 11v6"/><path d="M14 11v6"/></svg>';

  const host = document.createElement('div');
  host.dataset.cgptBatchDelete = 'root';
  // open 模式：closed 并不能真正防篡改，只会让控制台排查和自动化验证变困难
  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <button class="fab" title="批量删除会话（可拖动）">${SVG_TRASH}</button>
    <div class="flag"></div>
    <div class="overlay hidden">
      <div class="dialog" role="dialog" aria-modal="true" aria-label="批量删除会话">
        <header>
          <div class="title">批量删除会话<small class="sub"></small></div>
          <button class="close" title="关闭 (Esc)">×</button>
        </header>
        <div class="toolbar">
          <label class="sel-all-label" title="选中 / 取消当前筛选出的会话"><input type="checkbox" class="sel-all">全选</label>
          <input type="text" class="search" placeholder="搜索标题筛选…">
          <span class="count"></span>
        </div>
        <div class="list"></div>
        <div class="statusbar">
          <span class="status-text"></span>
          <div class="progress hidden"><i></i></div>
        </div>
        <footer>
          <button class="btn btn-ghost btn-reload">重新加载</button>
          <button class="btn btn-ghost btn-close">关闭</button>
          <button class="btn btn-del" disabled>删除所选</button>
        </footer>
      </div>
    </div>`;

  // 优先用 adoptedStyleSheets（不受页面 CSP 影响），失败则退回 <style>
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];
  } catch (e) {
    const st = document.createElement('style');
    st.textContent = CSS;
    shadow.appendChild(st);
  }

  const $s = (sel) => shadow.querySelector(sel);
  const fab = $s('.fab');
  const flagEl = $s('.flag');
  const overlay = $s('.overlay');
  const listEl = $s('.list');
  const searchEl = $s('.search');
  const selAllEl = $s('.sel-all');
  const countEl = $s('.count');
  const delBtn = $s('.btn-del');
  const statusEl = $s('.status-text');
  const subEl = $s('.sub');
  const progressEl = $s('.progress');
  const progressFill = progressEl.querySelector('i');

  /* ==================== 状态 ==================== */
  let conversations = [];        // [{id, title, time}]
  let state = 'idle';            // idle | loading | ready | deleting
  let pendingTimer = null;       // 删除前的撤销窗口定时器
  let pendingActive = false;     // 撤销窗口是否进行中（先置位再刷新 UI）
  let pendingSeconds = 0;
  let abortRequested = false;    // 用户请求中止删除
  const selected = new Set();    // 已勾选的会话 id
  const UNDO_SECONDS = 5;        // 点删除后留给用户反悔的秒数

  /* ==================== 主题（跟随 ChatGPT 深浅色） ==================== */
  function applyTheme() {
    const de = document.documentElement;
    let light;
    if (de.classList.contains('dark')) light = false;
    else if (de.classList.contains('light')) light = true;
    else light = window.matchMedia('(prefers-color-scheme: light)').matches;
    host.classList.toggle('theme-light', light);
  }

  /* ==================== 渲染 ==================== */
  function setStatus(text, kind) {
    statusEl.textContent = text || '';
    statusEl.className = 'status-text'
      + (kind === 'err' ? ' err' : kind === 'ok' ? ' ok' : kind === 'warn' ? ' warn' : '');
  }

  function currentConversationId() {
    const m = location.pathname.match(/\/c\/([0-9a-fA-F-]{36})/);
    return m ? m[1] : null;
  }

  function visibleRows() {
    const kw = searchEl.value.trim().toLowerCase();
    return kw
      ? conversations.filter((c) => (c.title || '').toLowerCase().includes(kw))
      : conversations;
  }

  function updateSelAll() {
    const rows = visibleRows();
    const n = rows.filter((c) => selected.has(c.id)).length;
    selAllEl.checked = rows.length > 0 && n === rows.length;
    selAllEl.indeterminate = n > 0 && n < rows.length;
  }

  function updateCount() {
    countEl.textContent = '已选 ' + selected.size + ' / ' + conversations.length;

    if (state === 'deleting') {   // 删除中：按钮变为「中止删除」
      delBtn.disabled = abortRequested;
      delBtn.classList.add('btn-abort');
      delBtn.textContent = abortRequested ? '正在中止…' : '中止删除';
      updateSelAll();
      return;
    }

    delBtn.classList.remove('btn-abort');

    if (pendingActive) {          // 撤销倒计时中：按钮显示秒数，再点就是撤销
      delBtn.classList.add('btn-pending');
      delBtn.disabled = false;
      delBtn.textContent = '撤销删除 (' + pendingSeconds + ')';
      updateSelAll();
      return;
    }

    delBtn.classList.remove('btn-pending');
    const canDelete = selected.size > 0 && state !== 'loading';
    delBtn.disabled = !canDelete;
    delBtn.textContent = selected.size ? '删除所选 (' + selected.size + ')' : '删除所选';
    updateSelAll();
  }

  function clearPendingTimer() {
    pendingActive = false;
    if (pendingTimer) { clearInterval(pendingTimer); pendingTimer = null; }
    pendingSeconds = 0;
    delBtn.classList.remove('btn-pending');
  }

  // 取消撤销窗口（silent=true 时不提示）
  function cancelPending(silent) {
    if (!pendingActive) return false;
    clearPendingTimer();
    updateCount();
    if (!silent) setStatus('已取消删除');
    return true;
  }

  // 一次点击 → 进入 5 秒撤销窗口，走完才真正执行
  function startPending() {
    pendingSeconds = UNDO_SECONDS;
    pendingActive = true;            // 先置位，updateCount 才能立即渲染倒计时文案
    updateCount();
    const tip = () => '将在 ' + pendingSeconds + ' 秒后删除 ' + selected.size + ' 个会话，点「撤销删除」可取消';
    setStatus(tip());
    pendingTimer = setInterval(() => {
      pendingSeconds -= 1;
      if (pendingSeconds <= 0) {
        clearPendingTimer();
        doDelete();
        return;
      }
      updateCount();
      setStatus(tip());
    }, 1000);
  }

  function renderRows() {
    const rows = visibleRows();
    const cur = currentConversationId();
    if (!rows.length) {
      listEl.innerHTML = '<div class="empty">' + (state === 'loading'
        ? '正在加载会话列表…'
        : (conversations.length ? '没有匹配的会话' : '暂无会话')) + '</div>';
    } else {
      listEl.innerHTML = rows.map((c) => {
        const on = selected.has(c.id);
        return '<label class="row' + (on ? ' checked' : '') + '" data-id="' + escapeHtml(c.id) + '">'
          + '<input type="checkbox"' + (on ? ' checked' : '') + '>'
          + '<span class="row-title">' + escapeHtml(c.title || '未命名会话') + '</span>'
          + (c.id === cur ? '<span class="badge">当前</span>' : '')
          + '<span class="row-time">' + escapeHtml(fmtTime(c.time)) + '</span>'
          + '</label>';
      }).join('');
    }
    updateCount();
  }

  /* ==================== 后台进度提示（环形进度 + 气泡） ==================== */
  let flagHideTimer = null;

  function positionFlag() {
    const r = fab.getBoundingClientRect();
    if (r.left < 240) {                       // 按钮太靠左：气泡改放右侧
      flagEl.style.left = (r.right + 10) + 'px';
      flagEl.style.transform = 'translate(0, -50%)';
    } else {
      flagEl.style.left = (r.left - 10) + 'px';
      flagEl.style.transform = 'translate(-100%, -50%)';
    }
    flagEl.style.top = (r.top + r.height / 2) + 'px';
  }

  function updateFlagVisibility() {
    const show = flagEl.textContent !== '' && overlay.classList.contains('hidden');
    flagEl.classList.toggle('show', show);
    if (show) positionFlag();
  }

  function setFlag(text, kind, keepMs) {
    clearTimeout(flagHideTimer);
    if (!text) { flagEl.textContent = ''; flagEl.classList.remove('show'); return; }
    flagEl.textContent = text;
    flagEl.classList.toggle('ok', kind === 'ok');
    flagEl.classList.toggle('warn', kind === 'warn');
    updateFlagVisibility();
    if (keepMs) flagHideTimer = setTimeout(() => setFlag(null), keepMs);
  }

  function setProgress(done, total, failN) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    progressFill.style.width = pct + '%';
    fab.style.setProperty('--p', pct + '%');
    if (state === 'deleting') {
      setFlag('删除中 ' + done + '/' + total + (failN ? '（失败 ' + failN + '）' : ''));
    }
  }

  /* ==================== 弹窗开关 ==================== */
  function openDialog() {
    overlay.classList.remove('hidden');
    applyTheme();
    updateFlagVisibility();
    // 只在空闲/就绪时重新加载：避免加载中重复打开造成并发双拉
    if (state === 'idle' || state === 'ready') {
      searchEl.value = '';
      selected.clear();
      clearPendingTimer();
      renderRows();
      loadConversations();
    }
    setTimeout(() => {
      if (!overlay.classList.contains('hidden')) searchEl.focus();
    }, 60);
  }

  // 收起弹窗不会中止删除：删除在后台继续，进度显示在悬浮按钮上
  function closeDialog() {
    overlay.classList.add('hidden');
    if (state !== 'deleting') cancelPending(true);   // 收起弹窗即取消尚未执行的删除
    updateFlagVisibility();
  }

  /* ==================== 加载列表 ==================== */
  async function loadConversations() {
    state = 'loading';
    delBtn.disabled = true;
    renderRows();
    setStatus('正在加载会话列表…');
    progressEl.classList.remove('hidden');
    progressFill.style.width = '0%';

    let list = null;
    let apiError = null;
    try {
      list = await fetchConversations((n, total) => {
        setStatus('正在加载会话列表… 已加载 ' + n + ' 条'
          + (total ? ' / 共 ' + total + ' 条' : ''));
      });
    } catch (e) { apiError = e; }

    if (list && list.length) {
      conversations = list;
      subEl.textContent = '共 ' + list.length + ' 条';
      setStatus('已加载 ' + list.length + ' 条会话，勾选后点击「删除所选」');
    } else if (apiError) {
      // 列表接口不可用 → 兜底读侧边栏 DOM
      const domList = conversationsFromSidebar();
      if (domList.length) {
        conversations = domList;
        subEl.textContent = '来自侧边栏可见项';
        setStatus('列表接口暂不可用（' + apiError.message + '），已读取侧边栏可见的会话', 'warn');
      } else {
        conversations = [];
        subEl.textContent = '';
        setStatus('加载失败：请确认已登录 chatgpt.com，然后点「重新加载」', 'err');
      }
    } else {
      conversations = [];
      subEl.textContent = '';
      setStatus('没有找到会话');
    }

    progressEl.classList.add('hidden');
    state = 'ready';
    renderRows();
  }

  /* ==================== 删除 ==================== */
  function removeSidebarNodes(ids) {
    try {
      ids.forEach((id) => {
        document.querySelectorAll('a[href*="/c/' + id + '"]').forEach((a) => {
          const node = a.closest('li') || a;
          node.remove();
        });
      });
    } catch (e) { /* 仅视觉同步，失败不影响结果 */ }
  }

  async function doDelete() {
    const ids = Array.from(selected);
    if (!ids.length || state !== 'ready') return;

    state = 'deleting';
    abortRequested = false;
    clearPendingTimer();
    listEl.style.pointerEvents = 'none';
    searchEl.disabled = true;
    selAllEl.disabled = true;
    progressEl.classList.remove('hidden');
    progressFill.style.width = '0%';
    fab.classList.add('deleting');
    fab.style.setProperty('--p', '0%');
    updateCount();                        // 按钮切成「中止删除」
    setProgress(0, ids.length, 0);
    setStatus('正在删除… 0/' + ids.length);

    let okCount = 0;
    const failed = [];
    let bulkDone = false;
    let abortedEarly = false;

    // 1) 优先一次性批量删除
    if (ids.length > 1) bulkDone = await tryDeleteBulk(ids);

    if (bulkDone) {
      okCount = ids.length;
      setProgress(ids.length, ids.length, 0);
    } else {
      // 2) 逐条删除（自动探测可用接口并复用）
      for (let i = 0; i < ids.length; i++) {
        if (abortRequested) { abortedEarly = true; break; }
        const ok = await deleteOne(ids[i]);
        if (ok) okCount++; else failed.push(ids[i]);
        setProgress(i + 1, ids.length, failed.length);
        setStatus('正在删除… ' + (i + 1) + '/' + ids.length
          + (failed.length ? '（失败 ' + failed.length + '）' : ''));
        // 连续失败且无一成功：接口整体不可用，及时止损
        if (failed.length >= 3 && okCount === 0) {
          abortedEarly = true;
          setStatus('删除接口暂时不可用，已中止。请稍后重试或反馈。', 'err');
          break;
        }
        if (i < ids.length - 1) await sleep(REQ_GAP);
      }
    }

    // 收尾：更新本地列表与侧边栏
    const okSet = new Set(bulkDone ? ids : ids.filter((id) => failed.indexOf(id) < 0));
    selected.clear();
    conversations = conversations.filter((c) => !okSet.has(c.id));
    removeSidebarNodes(okSet);

    state = 'ready';
    listEl.style.pointerEvents = '';
    searchEl.disabled = false;
    selAllEl.disabled = false;
    progressEl.classList.add('hidden');
    fab.classList.remove('deleting');
    fab.style.setProperty('--p', '0%');
    subEl.textContent = '共 ' + conversations.length + ' 条';
    renderRows();

    const failN = ids.length - okCount;
    const usedHide = preferredMethod === DELETE_METHODS.length - 1;
    if (abortedEarly && okCount === 0) {
      setStatus('删除接口暂时不可用，已中止。', 'err');
      setFlag('已中止', 'warn', 4000);
    } else if (abortedEarly) {
      setStatus('已中止：成功 ' + okCount + ' 个，剩余未处理', 'warn');
      setFlag('已中止（成功 ' + okCount + '）', 'warn', 4000);
    } else if (failN === 0) {
      setStatus('已删除 ' + okCount + ' 个会话 ✓ '
        + (usedHide ? '（走的是隐藏/归档接口，会话已从列表消失；彻底清理：设置 → 数据控制）'
                    : '（若侧边栏未同步，刷新页面即可）'), 'ok');
      setFlag('已删除 ' + okCount + ' 个 ✓', 'ok', 4000);
    } else {
      setStatus('完成：成功 ' + okCount + ' 个，失败 ' + failN + ' 个', 'err');
      setFlag('完成：成功 ' + okCount + '，失败 ' + failN, 'warn', 5000);
    }
  }

  /* ==================== 事件 ==================== */
  listEl.addEventListener('change', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    cancelPending(true);            // 改了勾选就退出撤销窗口
    const id = row.dataset.id;
    if (e.target.checked) selected.add(id); else selected.delete(id);
    row.classList.toggle('checked', e.target.checked);
    updateCount();
  });

  searchEl.addEventListener('input', () => {
    cancelPending(true);
    renderRows();
  });

  selAllEl.addEventListener('change', () => {
    cancelPending(true);
    visibleRows().forEach((c) => {
      if (selAllEl.checked) selected.add(c.id); else selected.delete(c.id);
    });
    renderRows();
  });

  delBtn.addEventListener('click', () => {
    if (state === 'deleting') {            // 中止删除
      if (abortRequested) return;
      abortRequested = true;
      delBtn.disabled = true;
      delBtn.textContent = '正在中止…';
      setStatus('正在中止…（等当前这一条处理完）', 'warn');
      return;
    }
    if (pendingActive) { cancelPending(); return; }   // 倒计时中再点 = 撤销
    if (delBtn.disabled || state !== 'ready' || !selected.size) return;
    startPending();
  });

  $s('.close').addEventListener('click', closeDialog);
  $s('.btn-close').addEventListener('click', closeDialog);
  $s('.btn-reload').addEventListener('click', () => {
    if (state !== 'deleting' && state !== 'loading') loadConversations();
  });

  // 点击遮罩空白处关闭
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeDialog();
  });

  /* ==================== 悬浮按钮：可拖动，位置记忆 ==================== */
  function applyFabPos(p) {
    const x = Math.min(Math.max(p.x, 4), window.innerWidth - 50);
    const y = Math.min(Math.max(p.y, 4), window.innerHeight - 50);
    fab.style.left = x + 'px';
    fab.style.top = y + 'px';
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
    if (flagEl.classList.contains('show')) positionFlag();   // 气泡跟随按钮
  }

  let savedPos = null;
  try { savedPos = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch (e) { /* ignore */ }
  if (savedPos && typeof savedPos.x === 'number' && typeof savedPos.y === 'number') {
    applyFabPos(savedPos);
  }

  let dragInfo = null;
  let fabClickSuppress = false; // 拖动结束后的那次 click 不应触发挥开/收起

  fab.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    fabClickSuppress = false;
    dragInfo = { x: e.clientX, y: e.clientY, moved: false };
    try { fab.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  });
  fab.addEventListener('pointermove', (e) => {
    if (!dragInfo) return;
    if (!dragInfo.moved) {
      if (Math.abs(e.clientX - dragInfo.x) < 4 && Math.abs(e.clientY - dragInfo.y) < 4) return;
      dragInfo.moved = true;
      fab.classList.add('dragging');
    }
    applyFabPos({ x: e.clientX - 23, y: e.clientY - 23 });
  });
  fab.addEventListener('pointerup', () => {
    if (!dragInfo) return;
    const moved = dragInfo.moved;
    dragInfo = null;
    fab.classList.remove('dragging');
    if (moved) {
      fabClickSuppress = true; // 吞掉紧随其后的 click
      const r = fab.getBoundingClientRect();
      try { localStorage.setItem(POS_KEY, JSON.stringify({ x: r.left, y: r.top })); }
      catch (err) { /* ignore */ }
    }
  });
  fab.addEventListener('pointercancel', () => {
    dragInfo = null;
    fab.classList.remove('dragging');
  });

  // 统一在 click 里处理开合：鼠标点击、键盘 Enter/Space 都能触发
  fab.addEventListener('click', () => {
    if (fabClickSuppress) { fabClickSuppress = false; return; }
    if (overlay.classList.contains('hidden')) openDialog(); else closeDialog();
  });

  window.addEventListener('resize', () => {
    if (fab.style.left) {
      applyFabPos({
        x: parseFloat(fab.style.left) || 0,
        y: parseFloat(fab.style.top) || 0,
      });
    }
  });

  /* ==================== 挂载 ==================== */
  function mount() {
    if (document.body) {
      if (!document.documentElement.contains(host)) {
        document.body.appendChild(host);
        console.info('[ChatGPT批量删除] 已加载，点击右下角按钮开始');
      }
    } else {
      setTimeout(mount, 200);
    }
  }
  mount();
})();
