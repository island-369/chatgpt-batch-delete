/**
 * 批量删除 AI 网站会话 —— Chrome / Edge 扩展（content script）
 *
 * 在 ChatGPT / Claude / Grok / Gemini / Kimi / Qwen / DeepSeek / 智谱清言 / 腾讯元宝 / 豆包
 * 页面右下角注入一个可拖动的悬浮按钮，点击后弹出会话选择框，支持搜索、全选、多选，一键批量删除。
 * 深浅色主题自动适配。
 *
 * 原理：站点列表与删除使用当前网站的登录态；AI 标题仅在用户手动触发并确认后，
 *       将所选会话的最近消息发送到用户配置的 AI 服务。
 *   - 各站的会话列表与删除接口在 sites/*.js 适配器中实现；
 *   - 列表接口不可用时，回退读取侧边栏已渲染的会话；
 *   - ChatGPT 保留多级删除回退（批量 → 单条 → 隐藏），其余站点使用原生接口。
 *
 * 注意：这些都是各网站未公开的内部接口，改版后可能变化；
 *       届时修改对应 sites/*.js 即可。
 */
(() => {
  'use strict';

  if (window.__CGPT_BATCH_DELETE_LOADED__) return;
  window.__CGPT_BATCH_DELETE_LOADED__ = true;

  const shared = globalThis.CGptBatchDelete;
  // 本地回归测试用 file:// 打开模拟页，按 ChatGPT 处理。
  const adapter = shared.adapterFor(location.origin)
    || (location.protocol === 'file:' ? shared.sites.chatgpt : null);
  if (!adapter) return;

  /* ==================== 配置 ==================== */
  const POS_KEY = 'cgpt-batch-delete:fab-pos';  // 悬浮按钮位置存储键

  /* ==================== 小工具 ==================== */
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  function timestampOf(v) {
    if (v == null || v === '') return null;
    const numeric = typeof v === 'number' || /^\d+$/.test(String(v));
    const time = numeric
      ? Number(v) < 1e12 ? Number(v) * 1000 : Number(v)
      : Date.parse(v);
    return Number.isFinite(time) && Number.isFinite(new Date(time).getTime()) ? time : null;
  }

  function fmtTime(v) {
    const time = timestampOf(v);
    if (time == null) return '';
    const d = new Date(time);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + ' 天前';
    return d.toLocaleDateString('zh-CN');
  }

  /* 各站的会话列表与删除接口见 sites/*.js 适配器。 */

  /* 删除由各站适配器的 remove() 完成：逐条回报进度，界面负责展示与收尾。 */


  /* ==================== 界面（Shadow DOM 隔离，open 便于调试） ==================== */
  const CSS = `
    :host {
      all: initial;
      /* 深色主题（默认）：中性蓝灰底 + 靛蓝强调色 */
      --bg: #151923;
      --fg: #e9edf9;
      --muted: #99a3bd;
      --time: #7f8aa6;
      --border: rgba(255, 255, 255, 0.10);
      --border-soft: rgba(255, 255, 255, 0.07);
      --row-hover: rgba(255, 255, 255, 0.045);
      --input-bg: rgba(255, 255, 255, 0.05);
      --input-border: rgba(255, 255, 255, 0.11);
      --check-border: rgba(255, 255, 255, 0.28);
      --accent: #6a7bff;
      --accent-ink: #aab4ff;
      --accent-soft: rgba(106, 123, 255, 0.14);
      --accent-ring: rgba(106, 123, 255, 0.24);
      --danger: #e5484d;
      --danger-hover: #d33a40;
      --ok: #4ade80;
      --warn: #fbbf24;
      --err: #f87171;
      --overlay: rgba(6, 9, 18, 0.62);
      --track: rgba(255, 255, 255, 0.10);
      --scrollbar: rgba(255, 255, 255, 0.16);
      --shadow: 0 30px 80px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.35);
      --flag-bg: rgba(24, 29, 42, 0.94);
      --flag-fg: #eef1fb;
      --sheen: rgba(255, 255, 255, 0.08);
      --sk-base: rgba(255, 255, 255, 0.055);
      --sk-shine: rgba(255, 255, 255, 0.13);
      --danger-glow: rgba(229, 72, 77, 0.32);
      --glow-2: rgba(84, 176, 196, 0.10);
      color-scheme: dark;
    }
    :host(.theme-light) {
      --bg: #f7f8fd;
      --fg: #1b2233;
      --muted: #626d87;
      --time: #8a93a8;
      --border: rgba(28, 38, 64, 0.10);
      --border-soft: rgba(28, 38, 64, 0.07);
      --row-hover: rgba(28, 38, 64, 0.045);
      --input-bg: #ffffff;
      --input-border: rgba(28, 38, 64, 0.13);
      --check-border: rgba(28, 38, 64, 0.30);
      --accent: #5b6cf0;
      --accent-ink: #4956cf;
      --accent-soft: rgba(91, 108, 240, 0.10);
      --accent-ring: rgba(91, 108, 240, 0.20);
      --danger: #d93a3f;
      --danger-hover: #c22f34;
      --ok: #128a5a;
      --warn: #a86412;
      --err: #cf2f36;
      --overlay: rgba(16, 21, 34, 0.38);
      --track: rgba(28, 38, 64, 0.09);
      --scrollbar: rgba(28, 38, 64, 0.20);
      --shadow: 0 30px 80px rgba(23, 32, 58, 0.20), 0 2px 8px rgba(23, 32, 58, 0.08);
      --flag-bg: rgba(255, 255, 255, 0.95);
      --flag-fg: #1b2233;
      --sheen: #ffffff;
      --sk-base: rgba(28, 38, 64, 0.07);
      --sk-shine: rgba(255, 255, 255, 0.9);
      --danger-glow: rgba(217, 58, 63, 0.26);
      --glow-2: rgba(84, 176, 196, 0.12);
      color-scheme: light;
    }
    * { box-sizing: border-box; margin: 0; padding: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                     "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
    .hidden { display: none !important; }

    /* ---------- 悬浮按钮：靛蓝渐变 + 分层阴影 ---------- */
    .fab { position: fixed; z-index: 2147483646; right: 22px; bottom: 100px;
      width: 48px; height: 48px; border-radius: 50%;
      border: 1px solid rgba(255, 255, 255, 0.20); color: #fff;
      background: linear-gradient(160deg, #8492ff 0%, var(--accent) 46%, #4a58e0 100%);
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      box-shadow: 0 12px 28px rgba(74, 88, 224, 0.38), 0 2px 6px rgba(0, 0, 0, 0.22),
                  inset 0 1px 0 rgba(255, 255, 255, 0.35);
      transition: transform 0.16s cubic-bezier(0.2, 0.8, 0.3, 1.2), box-shadow 0.16s;
      touch-action: none; user-select: none; }
    .fab:hover { transform: translateY(-1px) scale(1.05);
      box-shadow: 0 16px 34px rgba(74, 88, 224, 0.46), 0 3px 8px rgba(0, 0, 0, 0.24),
                  inset 0 1px 0 rgba(255, 255, 255, 0.35); }
    .fab:active { transform: scale(0.96); }
    .fab:focus-visible { outline: none;
      box-shadow: 0 0 0 3px var(--accent-ring), 0 12px 28px rgba(74, 88, 224, 0.38); }
    .fab.dragging { transform: scale(0.94); cursor: grabbing; }
    .fab svg { width: 21px; height: 21px; pointer-events: none; }
    .fab.deleting { cursor: progress; }
    /* 删除中：按钮外圈的环形进度 */
    .fab.deleting::after { content: ""; position: absolute; inset: -5px; border-radius: 50%;
      background: conic-gradient(#fff var(--p, 0%), rgba(255, 255, 255, 0.22) 0);
      -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2.5px));
              mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2.5px));
      pointer-events: none; }
    /* 收起弹窗后的后台进度气泡（玻璃拟态） */
    .flag { position: fixed; z-index: 2147483646; display: none; align-items: center; gap: 8px;
      transform: translate(-100%, -50%); background: var(--flag-bg); color: var(--flag-fg);
      border: 1px solid var(--border); border-radius: 999px; padding: 7px 13px 7px 11px;
      font-size: 12px; font-weight: 500; letter-spacing: 0.01em; white-space: nowrap;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.24), inset 0 1px 0 var(--sheen);
      -webkit-backdrop-filter: blur(16px) saturate(1.4);
              backdrop-filter: blur(16px) saturate(1.4); }
    .flag.show { display: flex; }
    .flag::before { content: ""; width: 8px; height: 8px; border-radius: 50%;
      background: var(--accent); flex: none; box-shadow: 0 0 0 3px var(--accent-soft);
      animation: blink 1.2s ease-in-out infinite; }
    .flag.ok::before { background: var(--ok); box-shadow: 0 0 0 3px rgba(74, 222, 128, 0.18);
      animation: none; }
    .flag.warn::before { background: var(--warn); box-shadow: 0 0 0 3px rgba(251, 191, 36, 0.18);
      animation: none; }
    @keyframes blink { 50% { opacity: 0.3; } }

    .overlay { position: fixed; inset: 0; z-index: 2147483647;
      background: var(--overlay); display: flex; align-items: center;
      justify-content: center; padding: 24px; animation: fadeIn 0.16s ease-out;
      -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); }
    .confirm-overlay { position: fixed; inset: 0; z-index: 2147483647; display: flex;
      align-items: center; justify-content: center; padding: 24px;
      background: rgba(6, 9, 18, 0.48); }
    .confirm-card { width: min(360px, 90vw); padding: 20px; color: var(--fg);
      background: var(--bg); border: 1px solid var(--border); border-radius: 16px;
      box-shadow: var(--shadow); }
    .confirm-title { font-size: 16px; font-weight: 650; }
    .confirm-message { margin-top: 8px; color: var(--muted); font-size: 13px; line-height: 1.65;
      white-space: pre-line; }
    .confirm-actions { display: flex; justify-content: flex-end; gap: 9px; margin-top: 18px; }
    .ai-review-overlay, .ai-consent-overlay { position: fixed; inset: 0; z-index: 2147483647;
      display: flex; align-items: center; justify-content: center; padding: 24px;
      background: var(--overlay); -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); }
    .ai-review-card { width: min(720px, 94vw); max-height: min(84vh, 760px); display: flex;
      flex-direction: column; overflow: hidden; color: var(--fg); background: var(--bg);
      border: 1px solid var(--border); border-radius: 20px; box-shadow: var(--shadow); }
    .ai-review-head { padding: 20px 22px 14px; border-bottom: 1px solid var(--border-soft); }
    .ai-review-title { font-size: 17px; font-weight: 650; }
    .ai-review-hint { margin-top: 5px; color: var(--muted); font-size: 12px; line-height: 1.55; }
    .ai-review-list { min-height: 0; overflow: auto; padding: 10px 14px; }
    .ai-review-row { display: grid; grid-template-columns: 16px minmax(115px, .8fr) 20px minmax(180px, 1.2fr) 34px;
      align-items: center; gap: 9px; padding: 9px; border-radius: 11px; }
    .ai-review-row:hover { background: var(--row-hover); }
    .ai-review-old { min-width: 0; overflow: hidden; color: var(--muted); font-size: 12px;
      text-overflow: ellipsis; white-space: nowrap; }
    .ai-review-arrow { color: var(--time); text-align: center; }
    .ai-review-input { min-width: 0; width: 100%; height: 36px; padding: 0 10px; border-radius: 9px;
      border: 1px solid var(--input-border); outline: none; color: var(--fg); background: var(--input-bg);
      font: inherit; font-size: 12px; }
    .ai-review-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring); }
    .ai-review-refresh { display: grid; place-items: center; width: 32px; height: 32px; border: 0;
      border-radius: 8px; color: var(--muted); background: transparent; cursor: pointer; }
    .ai-review-refresh:hover { color: var(--accent-ink); background: var(--accent-soft); }
    .ai-review-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 13px 20px 17px; border-top: 1px solid var(--border-soft); background: none; }
    .ai-review-actions { display: flex; flex: none; gap: 9px; }
    .ai-review-apply { min-width: 150px; }
    .ai-review-result { min-width: 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
    .ai-consent-card { width: min(420px, 92vw); padding: 21px; color: var(--fg); background: var(--bg);
      border: 1px solid var(--border); border-radius: 16px; box-shadow: var(--shadow); }
    .ai-consent-card h2 { font-size: 16px; font-weight: 650; }
    .ai-consent-card p { margin-top: 10px; color: var(--muted); font-size: 13px; line-height: 1.65; }
    .ai-consent-actions { display: flex; justify-content: flex-end; gap: 9px; margin-top: 18px; }
    .library-overlay { position: fixed; inset: 0; z-index: 2147483647; display: flex;
      align-items: center; justify-content: center; padding: 24px; background: var(--overlay);
      -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); }
    .library-card { width: min(820px, 96vw); height: min(760px, 88vh); display: flex;
      flex-direction: column; overflow: hidden; color: var(--fg); background: var(--bg);
      border: 1px solid var(--border); border-radius: 20px; box-shadow: var(--shadow); }
    .library-head { display: flex; align-items: center; justify-content: space-between;
      padding: 18px 22px; border-bottom: 1px solid var(--border-soft); }
    .library-head > div { min-width: 0; }
    .library-native { flex: none; text-decoration: none; white-space: nowrap; }
    .library-title { font-size: 17px; font-weight: 650; }
    .library-hint { margin-top: 4px; color: var(--muted); font-size: 12px; }
    .library-toolbar { display: flex; align-items: center; gap: 9px; padding: 12px 18px; }
    .library-filter { flex: none; max-width: 150px; background: var(--input-bg); color: var(--fg);
      border: 1px solid var(--input-border); border-radius: 10px; font: inherit; font-size: 12px; padding: 8px; }
    .library-list { flex: 1; min-height: 0; overflow: auto; padding: 4px 14px 12px; }
    .library-row { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto 90px 100px;
      align-items: center; gap: 12px; min-height: 54px; padding: 8px 10px;
      border: 1px solid transparent; border-radius: 11px; }
    .library-row:hover { background: var(--row-hover); border-color: var(--border-soft); }
    .library-row.selected { background: var(--accent-soft); border-color: var(--accent-ring); }
    .library-file-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
    .library-file-meta { color: var(--time); font-size: 11px; white-space: nowrap; }
    .library-tag { color: var(--accent-ink); background: var(--accent-soft); border: 1px solid var(--accent-ring);
      border-radius: 999px; padding: 2px 7px; font-size: 10px; white-space: nowrap; }
    .library-status { min-height: 38px; padding: 9px 20px; color: var(--muted); font-size: 12px;
      border-top: 1px solid var(--border-soft); }
    .library-foot { display: flex; align-items: center; gap: 9px; padding: 12px 18px 16px;
      border-top: 1px solid var(--border-soft); }
    .library-foot .spacer { flex: 1; }
    .dialog { width: min(600px, 94vw); max-height: min(84vh, 760px);
      display: flex; flex-direction: column; color: var(--fg);
      background:
        radial-gradient(88% 78% at 100% 0%, var(--accent-soft), transparent 58%),
        radial-gradient(78% 68% at 0% 78%, var(--glow-2), transparent 62%),
        var(--bg);
      border: 1px solid var(--border); border-radius: 22px;
      box-shadow: var(--shadow), inset 0 1px 0 var(--sheen); overflow: hidden;
      animation: pop 0.2s cubic-bezier(0.2, 0.9, 0.3, 1.15); }
    @keyframes fadeIn { from { opacity: 0; } }
    @keyframes pop { from { opacity: 0; transform: translateY(10px) scale(0.975); } }

    header { display: flex; align-items: flex-start; justify-content: space-between;
      gap: 12px; padding: 20px 20px 15px; border-bottom: 1px solid var(--border-soft); }
    .brand { display: flex; align-items: center; gap: 11px; min-width: 0; }
    .logo { width: 38px; height: 38px; border-radius: 12px; flex: none;
      display: grid; place-items: center; color: #fff;
      background: linear-gradient(155deg, #8492ff, #5563e8);
      box-shadow: 0 8px 18px rgba(74, 88, 224, 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.42); }
    .logo svg { width: 19px; height: 19px; }
    .heading { min-width: 0; }
    .title { font-size: 17px; font-weight: 680; letter-spacing: -0.02em; line-height: 1.3;
      white-space: nowrap; }
    .meta { display: flex; align-items: center; gap: 6px; margin-top: 2px;
      font-size: 12px; color: var(--muted); min-width: 0; }
    .meta .dot { width: 3px; height: 3px; border-radius: 50%; background: currentColor;
      opacity: 0.5; flex: none; }
    .meta .dot:has(+ .sub:empty) { display: none; }
    .meta .sub:empty { display: none; }
    .sub { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .close { display: grid; place-items: center; width: 30px; height: 30px; flex: none;
      border: 1px solid transparent; border-radius: 9px; background: none;
      color: var(--muted); cursor: pointer; transition: background 0.14s, color 0.14s; }
    .close:hover { background: var(--row-hover); color: var(--fg); }
    .close:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
    .close svg { width: 15px; height: 15px; }

    .toolbar { display: flex; align-items: center; gap: 10px; padding: 12px 20px 13px; }
    .sel-all-label { display: inline-flex; align-items: center; gap: 7px; flex: none;
      font-size: 13px; color: var(--muted); cursor: pointer; white-space: nowrap;
      transition: color 0.14s; }
    .sel-all-label:hover { color: var(--fg); }
    input[type="checkbox"] { appearance: none; -webkit-appearance: none;
      width: 16px; height: 16px; flex: none; margin: 0; border-radius: 5px; cursor: pointer;
      border: 1.5px solid var(--check-border); background: var(--input-bg);
      box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.06);
      transition: background 0.14s, border-color 0.14s, box-shadow 0.14s; }
    input[type="checkbox"]:hover:not(:disabled) { border-color: var(--accent); }
    input[type="checkbox"]:checked, input[type="checkbox"]:indeterminate {
      background-color: var(--accent); border-color: var(--accent);
      box-shadow: 0 2px 6px var(--accent-ring), inset 0 1px 0 rgba(255, 255, 255, 0.28); }
    input[type="checkbox"]:checked {
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='m3.5 8.2 3 3 6-6.4' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
      background-size: 12px 12px; background-position: center; background-repeat: no-repeat; }
    input[type="checkbox"]:indeterminate {
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4.5 8h7' fill='none' stroke='white' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E");
      background-size: 12px 12px; background-position: center; background-repeat: no-repeat; }
    input[type="checkbox"]:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
    input[type="checkbox"]:disabled { opacity: 0.45; cursor: not-allowed; }
    .search-field { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; }
    .search-icon { position: absolute; left: 11px; display: grid; place-items: center;
      color: var(--muted); pointer-events: none; }
    .search-icon svg { width: 14px; height: 14px; }
    .search { width: 100%; min-width: 0; background: var(--input-bg);
      border: 1px solid var(--input-border); border-radius: 10px; color: var(--fg);
      font-size: 13px; padding: 8px 12px 8px 32px; outline: none;
      transition: border-color 0.15s, box-shadow 0.15s; }
    .search::placeholder { color: var(--muted); }
    .search:hover:not(:disabled) { border-color: var(--check-border); }
    .search:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring); }
    .search:disabled { opacity: 0.55; cursor: not-allowed; }
    .age-filter { flex: none; max-width: 138px; background: var(--input-bg);
      border: 1px solid var(--input-border); border-radius: 10px; color: var(--fg);
      font: inherit; font-size: 12px; padding: 8px 9px; outline: none;
      transition: border-color 0.15s, box-shadow 0.15s; }
    .age-filter:hover { border-color: var(--check-border); }
    .age-filter:focus-visible { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring); }
    .count { flex: none; font-size: 12px; font-weight: 600; color: var(--muted);
      font-variant-numeric: tabular-nums; white-space: nowrap; padding: 5px 10px;
      border: 1px solid var(--border-soft); border-radius: 999px; background: var(--row-hover);
      transition: color 0.16s, background 0.16s, border-color 0.16s; }
    .count.active { color: var(--accent-ink); background: var(--accent-soft);
      border-color: var(--accent-ring); }

    .list { flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: 2px 12px 14px; }
    .row { display: flex; align-items: center; gap: 11px; min-height: 40px; padding: 8px 11px;
      border: 1px solid transparent; border-radius: 11px; cursor: pointer;
      transition: background 0.14s, border-color 0.14s, transform 0.12s; }
    .row:hover { background: var(--row-hover); border-color: var(--border-soft); }
    .row:active { transform: scale(0.997); }
    .row.checked { background: var(--accent-soft); border-color: var(--accent-ring);
      box-shadow: inset 3px 0 0 var(--accent); }
    .row-title { flex: 1; min-width: 0; font-size: 13.5px; letter-spacing: -0.005em;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .row-time { font-size: 11.5px; color: var(--time); white-space: nowrap;
      font-variant-numeric: tabular-nums; }
    .badge { flex: none; font-size: 10px; font-weight: 600; letter-spacing: 0.02em;
      color: var(--accent-ink); background: var(--accent-soft);
      border: 1px solid var(--accent-ring); padding: 1px 7px; border-radius: 999px;
      white-space: nowrap; }
    .empty { display: flex; flex-direction: column; align-items: center; gap: 10px;
      padding: 46px 12px 50px; text-align: center; color: var(--muted); font-size: 13px; }
    .empty-icon { width: 42px; height: 42px; border-radius: 14px; display: grid;
      place-items: center; background: var(--row-hover); border: 1px solid var(--border-soft); }
    .empty-icon svg { width: 19px; height: 19px; }
    /* 加载骨架屏（不用 .row，避免干扰行计数断言） */
    .sk-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px;
      border: 1px solid transparent; }
    .sk-box { width: 16px; height: 16px; border-radius: 5px; flex: none; }
    .sk-line { height: 10px; border-radius: 6px; flex: none; }
    .sk-time { width: 42px; height: 9px; border-radius: 6px; flex: none; margin-left: auto; }
    .sk-box, .sk-line, .sk-time { background: linear-gradient(100deg,
      var(--sk-base) 20%, var(--sk-shine) 42%, var(--sk-base) 64%);
      background-size: 220% 100%; animation: shimmer 1.5s ease-in-out infinite; }
    @keyframes shimmer { from { background-position: 140% 0; } to { background-position: -60% 0; } }

    .statusbar { display: flex; align-items: center; gap: 12px; min-height: 40px;
      padding: 8px 20px; font-size: 12px; color: var(--muted);
      border-top: 1px solid var(--border-soft); }
    .status-text { min-width: 0; line-height: 1.5; }
    .status-text.err { color: var(--err); }
    .status-text.ok { color: var(--ok); }
    .status-text.warn { color: var(--warn); }
    .progress { flex: 0 1 140px; min-width: 60px; height: 5px; margin-left: auto;
      border-radius: 999px; background: var(--track); overflow: hidden; }
    .progress i { display: block; height: 100%; width: 0; border-radius: inherit;
      background: linear-gradient(90deg, var(--accent), var(--accent-ink));
      box-shadow: 0 0 8px var(--accent-ring); transition: width 0.25s ease; }

    footer { display: flex; justify-content: flex-end; align-items: center; gap: 9px;
      padding: 13px 20px 18px; border-top: 1px solid var(--border-soft);
      background: linear-gradient(180deg, transparent, var(--row-hover)); }
    .btn { display: inline-flex; align-items: center; justify-content: center;
      height: 38px; padding: 0 16px; font-size: 13px; font-weight: 600;
      border: 1px solid transparent; border-radius: 10px; cursor: pointer;
      transition: background 0.15s, border-color 0.15s, box-shadow 0.15s, transform 0.1s; }
    .btn:active:not(:disabled) { transform: translateY(1px); }
    .btn:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
    .btn-ghost { background: transparent; border-color: var(--border); color: var(--fg); }
    .btn-ghost:hover { background: var(--row-hover); }
    .btn-del { min-width: 150px; color: #fff;
      background: linear-gradient(180deg, #ef5b60, var(--danger));
      box-shadow: 0 6px 16px var(--danger-glow), inset 0 1px 0 rgba(255, 255, 255, 0.22); }
    .btn-del:hover:not(:disabled) { background: linear-gradient(180deg, #f26a6f, var(--danger-hover));
      box-shadow: 0 8px 20px var(--danger-glow), inset 0 1px 0 rgba(255, 255, 255, 0.22); }
    .btn-del:disabled { opacity: 0.48; cursor: not-allowed; box-shadow: none; filter: saturate(0.55); }
    .btn-ai { color: var(--accent-ink); background: var(--accent-soft); border-color: var(--accent-ring); }
    .btn-ai:hover:not(:disabled) { background: var(--accent-ring); }
    .btn-ai:disabled { opacity: 0.45; cursor: not-allowed; }
    .btn-del.btn-abort,
    .btn-del.btn-abort:hover:not(:disabled) { background: transparent; color: var(--danger);
      border-color: var(--danger); box-shadow: none; }
    .btn-del.btn-abort:hover:not(:disabled) { background: rgba(229, 72, 77, 0.10); }
    .btn-del.btn-abort:disabled { background: transparent; color: var(--danger);
      opacity: 0.5; cursor: default; }

    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--scrollbar); border-radius: 8px;
      border: 2px solid transparent; background-clip: padding-box; }
    ::-webkit-scrollbar-thumb:hover { background: var(--muted); background-clip: padding-box; }

    @media (max-width: 520px) {
      header { padding: 16px 14px 12px; }
      .toolbar { flex-wrap: wrap; padding: 10px 14px 10px; }
      .sel-all-label { order: 1; }
      .count { margin-left: auto; }
      .count { order: 2; }
      .age-filter { order: 3; max-width: none; flex: 1; }
      .search-field { order: 4; flex-basis: 100%; }
      .list { padding: 0 6px 10px; }
      .statusbar, footer { padding-left: 14px; padding-right: 14px; }
      .dialog footer { flex-wrap: wrap; }
      .dialog footer .btn { flex: 1; }
      .btn-del { min-width: 0; flex: 1; }
      .ai-review-row { grid-template-columns: 16px minmax(62px, .7fr) 14px minmax(92px, 1.3fr) 28px; gap: 4px; padding: 7px 3px; }
      .ai-review-head { padding: 16px 15px 12px; }
      .ai-review-list { padding: 8px 12px; }
      .ai-review-foot { align-items: flex-start; flex-direction: column; padding: 12px 14px 15px; }
      .ai-review-actions { width: 100%; }
      .ai-review-apply { flex: 1; min-width: 0; }
      .library-toolbar { flex-wrap: wrap; padding: 10px 12px; }
      .library-filter { max-width: none; flex: 1; }
      .library-row { grid-template-columns: 18px minmax(0, 1fr) auto; gap: 7px; }
      .library-file-meta { display: none; }
      .library-foot { flex-wrap: wrap; padding: 10px 12px; }
      .library-foot .spacer { display: none; }
      .library-foot .btn { flex: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      * { animation: none !important; transition: none !important; }
    }
    @media (prefers-reduced-transparency: reduce) {
      .flag, .overlay { -webkit-backdrop-filter: none; backdrop-filter: none; }
    }
    @media (forced-colors: active) {
      input[type="checkbox"] { appearance: auto; -webkit-appearance: auto; background-image: none; }
    }
  `;

  const SVG_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>'
    + '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'
    + '<path d="M10 11v6"/><path d="M14 11v6"/></svg>';
  const SVG_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" '
    + 'stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>';
  const SVG_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" '
    + 'stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/>'
    + '<path d="M16 16l4.5 4.5"/></svg>';
  const SVG_EMPTY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" '
    + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.6 9.6 0 0 1-3.3-.6L4 21l1.8-4.2A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z"/>'
    + '</svg>';

  const host = document.createElement('div');
  host.dataset.cgptBatchDelete = 'root';
  // open 模式：closed 并不能真正防篡改，只会让控制台排查和自动化验证变困难
  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <button class="fab" title="Clear Chats：批量删除会话（可拖动）" aria-label="Clear Chats 批量删除会话">${SVG_TRASH}</button>
    <div class="flag" role="status" aria-live="polite"></div>
    <div class="overlay hidden">
      <div class="dialog" role="dialog" aria-modal="true" aria-label="Clear Chats 批量删除会话">
        <header>
          <div class="brand">
            <span class="logo" aria-hidden="true">${SVG_TRASH}</span>
            <div class="heading">
            <h1 class="title">批量删除会话</h1>
              <p class="meta"><span class="site"></span><span class="dot" aria-hidden="true"></span><span class="sub"></span></p>
            </div>
          </div>
          <button class="close" title="关闭 (Esc)" aria-label="关闭">${SVG_X}</button>
        </header>
        <div class="toolbar">
          <label class="sel-all-label" title="选中 / 取消当前筛选出的会话"><input type="checkbox" class="sel-all"><span>全选</span></label>
          <select class="age-filter" aria-label="按更新时间筛选会话">
            <option value="all">全部时间</option>
            <option value="1">24 小时以前</option>
            <option value="7">7 天以前</option>
            <option value="30">30 天以前</option>
            <option value="90">90 天以前</option>
            <option value="365">1 年以前</option>
            <option value="unknown">时间未知</option>
          </select>
          <label class="search-field">
            <span class="search-icon" aria-hidden="true">${SVG_SEARCH}</span>
            <input type="text" class="search" placeholder="搜索标题筛选…" aria-label="搜索标题筛选">
          </label>
          <span class="count"></span>
        </div>
        <div class="list" aria-label="会话列表"></div>
        <div class="statusbar">
          <span class="status-text" role="status" aria-live="polite"></span>
          <div class="progress hidden"><i></i></div>
        </div>
        <footer>
          <button class="btn btn-ghost btn-reload">重新加载</button>
          <button class="btn btn-ghost btn-close">关闭</button>
          <button class="btn btn-ghost btn-library" type="button">资料库</button>
          <button class="btn btn-ai" type="button">AI 生成标题</button>
          <button class="btn btn-del" disabled>删除所选</button>
        </footer>
      </div>
    </div>
    <div class="confirm-overlay hidden" role="presentation">
      <section class="confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message">
        <h2 class="confirm-title" id="confirm-title">确认删除</h2>
        <p class="confirm-message" id="confirm-message"></p>
        <div class="confirm-actions">
          <button class="btn btn-ghost confirm-cancel" type="button">取消</button>
          <button class="btn btn-del confirm-accept" type="button">确认删除</button>
        </div>
      </section>
    </div>`;

  const extraMarkup = document.createElement('template');
  extraMarkup.innerHTML = `
    <div class="ai-consent-overlay hidden" role="presentation">
      <section class="ai-consent-card" role="alertdialog" aria-modal="true" aria-labelledby="ai-consent-title" aria-describedby="ai-consent-message">
        <h2 id="ai-consent-title">发送近期内容生成标题？</h2>
        <p class="ai-consent-message"></p>
        <div class="ai-consent-actions">
          <button class="btn btn-ghost ai-consent-cancel" type="button">取消</button>
          <button class="btn btn-ai ai-consent-accept" type="button">继续生成</button>
        </div>
      </section>
    </div>
    <div class="ai-review-overlay hidden" role="presentation">
      <section class="ai-review-card" role="dialog" aria-modal="true" aria-labelledby="ai-review-title">
        <header class="ai-review-head">
          <h2 class="ai-review-title" id="ai-review-title">检查 AI 标题建议</h2>
          <p class="ai-review-hint">标题根据最近几轮对话生成。编辑或取消个别建议后，再确认更新原标题。</p>
        </header>
        <div class="ai-review-list"></div>
        <footer class="ai-review-foot">
          <span class="ai-review-result" role="status" aria-live="polite"></span>
          <div class="ai-review-actions">
            <button class="btn btn-ghost ai-review-back" type="button">返回列表</button>
            <button class="btn btn-ai ai-review-apply" type="button">更新原标题</button>
          </div>
        </footer>
      </section>
    </div>
    <div class="library-overlay hidden" role="presentation">
      <section class="library-card" role="dialog" aria-modal="true" aria-labelledby="library-title">
        <header class="library-head">
          <div><h2 class="library-title" id="library-title">ChatGPT 资料库</h2>
            <p class="library-hint">搜索、筛选并批量下载文件；删除请使用 ChatGPT 原生资料库。</p></div>
          <a class="btn btn-ghost library-native" href="/library" target="_blank" rel="noopener">打开原生资料库</a>
          <button class="close library-close" type="button" aria-label="关闭资料库">${SVG_X}</button>
        </header>
        <div class="library-toolbar">
          <label class="sel-all-label"><input type="checkbox" class="library-all"><span>全选</span></label>
          <label class="search-field"><span class="search-icon" aria-hidden="true">${SVG_SEARCH}</span>
            <input type="text" class="search library-search" placeholder="搜索文件名…" aria-label="搜索资料库文件"></label>
          <select class="library-filter library-source" aria-label="按文件来源筛选">
            <option value="all">所有来源</option><option value="uploaded">已上传</option><option value="generated">已生成</option><option value="connected">外部网盘</option>
          </select>
          <select class="library-filter library-type" aria-label="按文件类型筛选">
            <option value="all">所有类型</option><option value="image">图片</option><option value="document">文档</option><option value="spreadsheet">表格</option><option value="presentation">演示文稿</option><option value="pdf">PDF</option>
          </select>
        </div>
        <div class="library-list" role="list" aria-label="资料库文件"></div>
        <div class="library-status" role="status" aria-live="polite"></div>
        <footer class="library-foot">
          <span class="count library-count">已选 0 项</span><span class="spacer"></span>
          <button class="btn btn-ghost library-reload" type="button">重新加载</button>
          <button class="btn btn-ghost library-download" type="button" disabled>下载所选</button>
        </footer>
      </section>
    </div>`;
  shadow.appendChild(extraMarkup.content);
  // Keep the shared confirmation layer after every other overlay. Browsers clamp
  // z-index to 2147483647, so a larger number cannot place it above the library.
  shadow.appendChild(shadow.querySelector('.confirm-overlay'));

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
  const confirmOverlay = $s('.confirm-overlay');
  const listEl = $s('.list');
  const searchEl = $s('.search');
  const ageFilterEl = $s('.age-filter');
  const selAllEl = $s('.sel-all');
  const countEl = $s('.count');
  const delBtn = $s('.btn-del');
  const statusEl = $s('.status-text');
  const subEl = $s('.sub');
  const siteEl = $s('.site');
  siteEl.textContent = adapter.name;
  const progressEl = $s('.progress');
  const progressFill = progressEl.querySelector('i');
  const aiButton = $s('.btn-ai');
  const consentOverlay = $s('.ai-consent-overlay');
  const reviewOverlay = $s('.ai-review-overlay');
  const reviewList = $s('.ai-review-list');
  const reviewResult = $s('.ai-review-result');
  const reviewApply = $s('.ai-review-apply');
  const libraryOverlay = $s('.library-overlay');
  const libraryListEl = $s('.library-list');
  const libraryStatusEl = $s('.library-status');
  const librarySearchEl = $s('.library-search');
  const librarySourceEl = $s('.library-source');
  const libraryTypeEl = $s('.library-type');
  const libraryAllEl = $s('.library-all');
  const libraryCountEl = $s('.library-count');
  const libraryDownloadBtn = $s('.library-download');
  const libraryButton = $s('.btn-library');

  /* ==================== 状态 ==================== */
  let conversations = [];        // [{id, title, time}]
  let listScopeNote = '';
  let state = 'idle';            // idle | loading | ready | deleting | ai-generating | ai-renaming
  let abortRequested = false;    // 用户请求中止删除
  const selected = new Set();    // 已勾选的会话 id
  let aiConfigured = false;
  let aiGenerating = false;
  let aiAbortRequested = false;
  let aiCandidates = [];
  let aiRenameBusy = false;
  let aiRegenerating = 0;
  let libraryFiles = [];
  const librarySelected = new Set();
  let libraryBusy = false;
  let pendingConfirmAction = null;

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
        reject(new Error('扩展通信不可用，请刷新页面后重试'));
        return;
      }
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response || {});
      });
    });
  }

  function aiSupported() {
    return typeof adapter.getRecentMessages === 'function' && typeof adapter.renameTitle === 'function';
  }

  function updateAIButton() {
    if (!aiSupported()) {
      aiButton.disabled = true;
      aiButton.textContent = 'AI 标题（仅支持 ChatGPT）';
      return;
    }
    if (aiGenerating) {
      aiButton.disabled = false;
      aiButton.textContent = aiAbortRequested ? '正在停止…' : '停止生成';
      return;
    }
    aiButton.disabled = state !== 'ready' || selected.size === 0;
    aiButton.textContent = aiConfigured
      ? 'AI 生成标题' + (selected.size ? ' (' + selected.size + ')' : '')
      : '设置 AI 服务';
    if (!aiConfigured) aiButton.disabled = state !== 'ready';
  }

  async function refreshAIConfig() {
    if (!aiSupported()) { updateAIButton(); return; }
    try {
      const result = await runtimeMessage({ type: 'cgpt-batch-delete:ai-config-status' });
      aiConfigured = !!result.configured;
    } catch (error) { aiConfigured = false; }
    updateAIButton();
  }

  if (adapter.id !== 'chatgpt') libraryButton.classList.add('hidden');

  /* ==================== 主题（跟随站点深浅色） ==================== */
  function applyTheme() {
    host.classList.toggle('theme-light', !shared.isDark());
  }

  /* ==================== 渲染 ==================== */
  function setStatus(text, kind) {
    statusEl.textContent = text || '';
    statusEl.className = 'status-text'
      + (kind === 'err' ? ' err' : kind === 'ok' ? ' ok' : kind === 'warn' ? ' warn' : '');
  }

  function currentConversationId() {
    return adapter.currentId ? adapter.currentId() : null;
  }

  function visibleRows() {
    const kw = searchEl.value.trim().toLowerCase();
    const filter = ageFilterEl.value;
    const cutoff = filter === 'all' || filter === 'unknown'
      ? null
      : Date.now() - Number(filter) * 24 * 60 * 60 * 1000;
    return conversations.filter((c) => {
      if (kw && !(c.title || '').toLowerCase().includes(kw)) return false;
      const time = timestampOf(c.time);
      if (filter === 'unknown') return time == null;
      if (cutoff != null && (time == null || time > cutoff)) return false;
      return true;
    });
  }

  function updateSelAll() {
    const rows = visibleRows();
    const n = rows.filter((c) => selected.has(c.id)).length;
    selAllEl.checked = rows.length > 0 && n === rows.length;
    selAllEl.indeterminate = n > 0 && n < rows.length;
  }

  function updateCount() {
    countEl.textContent = '已选 ' + selected.size + ' / ' + conversations.length;
    countEl.classList.toggle('active', selected.size > 0);

    if (state === 'deleting') {   // 删除中：按钮变为「中止删除」
      delBtn.disabled = abortRequested;
      delBtn.classList.add('btn-abort');
      delBtn.textContent = abortRequested ? '正在中止…' : '中止删除';
      updateSelAll();
      updateAIButton();
      return;
    }

    delBtn.classList.remove('btn-abort');

    const canDelete = selected.size > 0 && state === 'ready';
    delBtn.disabled = !canDelete;
    delBtn.textContent = selected.size ? '删除所选 (' + selected.size + ')' : '删除所选';
    updateSelAll();
    updateAIButton();
  }

  // 加载占位：宽度固定，避免每次渲染跳动
  const SK_WIDTHS = [64, 48, 72, 56, 40, 68];

  function skeletonHtml() {
    return SK_WIDTHS.map((w) => '<div class="sk-row" aria-hidden="true">'
      + '<span class="sk-box"></span>'
      + '<span class="sk-line" style="width:' + w + '%"></span>'
      + '<span class="sk-time"></span>'
      + '</div>').join('');
  }

  function renderRows() {
    const rows = visibleRows();
    const cur = currentConversationId();
    if (state === 'loading' && !conversations.length) {
      listEl.innerHTML = skeletonHtml();
    } else if (!rows.length) {
      const text = conversations.length ? '当前条件下没有匹配的会话' : '暂无会话';
      listEl.innerHTML = '<div class="empty"><span class="empty-icon">' + SVG_EMPTY + '</span>'
        + '<p>' + text + '</p></div>';
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
      renderRows();
      loadConversations();
    }
    setTimeout(() => {
      if (!overlay.classList.contains('hidden')) searchEl.focus();
    }, 60);
  }

  // 收起弹窗不会中止删除：删除在后台继续，进度显示在悬浮按钮上
  function closeDialog() {
    if (aiGenerating) aiAbortRequested = true;
    consentOverlay.classList.add('hidden');
    reviewOverlay.classList.add('hidden');
    overlay.classList.add('hidden');
    updateFlagVisibility();
  }

  /* ==================== 加载列表 ==================== */
  async function loadConversations() {
    state = 'loading';
    delBtn.disabled = true;
    subEl.textContent = '加载中…';
    renderRows();
    setStatus('正在加载会话列表…');
    progressEl.classList.remove('hidden');
    progressFill.style.width = '0%';

    let list = null;
    let apiError = null;
    try {
      list = await adapter.list((n, total) => {
        setStatus('正在加载会话列表… 已加载 ' + n + ' 条'
          + (total ? ' / 共 ' + total + ' 条' : ''));
      });
    } catch (e) { apiError = e; }

    if (list && list.length) {
      conversations = list;
      listScopeNote = adapter.listNote || '';
      if (list.length >= shared.MAX_LOAD) {
        listScopeNote = [listScopeNote, '达到单次加载上限，结果可能不完整'].filter(Boolean).join('；');
      }
      subEl.textContent = '共 ' + list.length + ' 条' + (listScopeNote ? ' · ' + listScopeNote : '');
      setStatus('已加载 ' + list.length + ' 条会话' + (listScopeNote ? '；' + listScopeNote : '') + '，勾选后点击「删除所选」');
    } else if (apiError) {
      // 列表接口不可用 → 兜底读侧边栏 DOM
      const domList = adapter.domList ? adapter.domList() : [];
      if (domList.length) {
        conversations = domList;
        listScopeNote = '仅包含侧边栏当前已加载的会话';
        subEl.textContent = '共 ' + domList.length + ' 条 · ' + listScopeNote;
        setStatus('列表接口暂不可用（' + apiError.message + '），已读取侧边栏可见的会话', 'warn');
      } else {
        conversations = [];
        listScopeNote = '';
        subEl.textContent = '';
        setStatus('加载失败：' + (apiError.message || '请确认已登录') + '，然后点「重新加载」', 'err');
      }
    } else {
      conversations = [];
      listScopeNote = adapter.listNote || '';
      subEl.textContent = '';
      setStatus('没有找到会话' + (listScopeNote ? '；' + listScopeNote : '') + '，请确认已登录且侧边栏已展开', 'warn');
    }

    progressEl.classList.add('hidden');
    state = 'ready';
    renderRows();
  }

  /* ==================== 删除 ==================== */
  // ChatGPT 直接移除侧边栏节点；其余站点加 class 隐藏，避免和框架抢 DOM。
  function removeSidebarNodes(ids) {
    if (!ids.length) return;
    if (adapter.hideDeleted) adapter.hideDeleted(ids);
    else if (adapter.idFromHref) shared.hideRows(ids, adapter.idFromHref);
  }

  async function doDelete() {
    const ids = Array.from(selected);
    if (!ids.length || state !== 'ready') return;

    state = 'deleting';
    abortRequested = false;
    listEl.style.pointerEvents = 'none';
    searchEl.disabled = true;
    ageFilterEl.disabled = true;
    selAllEl.disabled = true;
    progressEl.classList.remove('hidden');
    progressFill.style.width = '0%';
    fab.classList.add('deleting');
    fab.style.setProperty('--p', '0%');
    updateCount();                        // 按钮切成「中止删除」
    setProgress(0, ids.length, 0);
    setStatus('正在删除… 0/' + ids.length);

    // 适配器逐条回报结果；界面只负责进度与收尾。
    let result = { ok: [], failed: ids.slice() };
    let done = 0;
    let failCount = 0;
    try {
      result = await adapter.remove(ids, {
        onProgress: (id, good) => {
          done += 1;
          if (!good) failCount += 1;
          setProgress(done, ids.length, failCount);
          setStatus('正在删除… ' + done + '/' + ids.length
            + (failCount ? '（失败 ' + failCount + '）' : ''));
        },
        aborted: () => abortRequested,
      });
    } catch (error) {
      result = { ok: [], failed: ids.slice(), error: error.message };
    }

    // 收尾：更新本地列表与侧边栏
    const okIds = result.ok || [];
    const okSet = new Set(okIds);
    selected.clear();
    ids.forEach((id) => { if (!okSet.has(id)) selected.add(id); });
    conversations = conversations.filter((c) => !okSet.has(c.id));
    removeSidebarNodes(okIds);

    state = 'ready';
    listEl.style.pointerEvents = '';
    searchEl.disabled = false;
    ageFilterEl.disabled = false;
    selAllEl.disabled = false;
    progressEl.classList.add('hidden');
    fab.classList.remove('deleting');
    fab.style.setProperty('--p', '0%');
    subEl.textContent = '共 ' + conversations.length + ' 条' + (listScopeNote ? ' · ' + listScopeNote : '');
    renderRows();

    const failN = ids.length - okIds.length;
    if (abortRequested) {
      setStatus('已停止：成功 ' + okIds.length + ' 个，未完成的 ' + failN + ' 个已保留勾选，可重试', 'warn');
      setFlag('已停止（成功 ' + okIds.length + '）', 'warn', 4000);
    } else if (result.error && !okIds.length) {
      setStatus('删除失败：' + result.error + '；未完成项已保留勾选，可重试', 'err');
      setFlag('删除失败', 'warn', 4000);
    } else if (result.stopped && !okIds.length) {
      setStatus('连续失败，已停止。未完成项已保留勾选，可稍后重试', 'err');
      setFlag('删除已停止', 'warn', 4000);
    } else if (failN === 0) {
      setStatus('已删除 ' + okIds.length + ' 个会话 ✓ '
        + (result.soft ? '（走的是隐藏/归档接口，会话已从列表消失；彻底清理：设置 → 数据控制）'
                       : '（若侧边栏未同步，刷新页面即可）'), 'ok');
      setFlag('已删除 ' + okIds.length + ' 个 ✓', 'ok', 4000);
    } else {
      setStatus('部分完成：成功 ' + okIds.length + ' 个，失败 ' + failN + ' 个；失败项已保留勾选，可重试', 'err');
      setFlag('失败 ' + failN + ' 个，可重试', 'warn', 5000);
    }
  }

  /* ==================== AI 标题整理（ChatGPT） ==================== */
  function setBusyControls(busy) {
    listEl.style.pointerEvents = busy ? 'none' : '';
    searchEl.disabled = busy;
    ageFilterEl.disabled = busy;
    selAllEl.disabled = busy;
    $s('.btn-reload').disabled = busy;
    if (busy) delBtn.disabled = true;
  }

  function renderAICandidates() {
    reviewList.innerHTML = aiCandidates.map((item, index) => (
      '<div class="ai-review-row" data-index="' + index + '">'
      + '<input type="checkbox" class="ai-review-check"' + (item.checked ? ' checked' : '') + '>'
      + '<span class="ai-review-old" title="' + escapeHtml(item.original) + '">' + escapeHtml(item.original || '未命名会话') + '</span>'
      + '<span class="ai-review-arrow" aria-hidden="true">→</span>'
      + '<input class="ai-review-input" type="text" maxlength="80" aria-label="编辑建议标题" value="' + escapeHtml(item.title) + '">'
      + '<button class="ai-review-refresh" type="button" title="重新生成此标题" aria-label="重新生成此标题">↻</button>'
      + '</div>'
    )).join('');
    updateReviewApplyButton();
  }

  function updateReviewApplyButton() {
    const count = aiCandidates.filter((item) => item.checked).length;
    reviewApply.disabled = aiRenameBusy || aiRegenerating > 0 || count === 0;
    reviewApply.textContent = aiRenameBusy ? '正在更新…' : '更新原标题' + (count ? ' (' + count + ')' : '');
  }

  async function generateTitleFor(id) {
    const messages = await adapter.getRecentMessages(id);
    const response = await runtimeMessage({ type: 'cgpt-batch-delete:ai-title', messages });
    if (!response.ok) throw new Error(response.error || '标题生成失败');
    return response.title;
  }

  async function beginAIGeneration(ids) {
    if (!ids.length || state !== 'ready') return;
    aiGenerating = true;
    aiAbortRequested = false;
    aiCandidates = [];
    state = 'ai-generating';
    setBusyControls(true);
    progressEl.classList.remove('hidden');
    progressFill.style.width = '0%';
    fab.classList.add('deleting');
    fab.style.setProperty('--p', '0%');
    updateCount();
    let failed = 0;
    for (let i = 0; i < ids.length; i += 1) {
      if (aiAbortRequested) break;
      const id = ids[i];
      const conversation = conversations.find((item) => item.id === id);
      setStatus('正在生成标题… ' + i + '/' + ids.length + (failed ? '（失败 ' + failed + '）' : ''));
      try {
        const title = await generateTitleFor(id);
        aiCandidates.push({ id, original: conversation?.title || '', title, checked: true });
      } catch (error) {
        failed += 1;
      }
      const done = i + 1;
      progressFill.style.width = Math.round(done / ids.length * 100) + '%';
      fab.style.setProperty('--p', Math.round(done / ids.length * 100) + '%');
    }
    aiGenerating = false;
    state = 'ready';
    setBusyControls(false);
    progressEl.classList.add('hidden');
    fab.classList.remove('deleting');
    fab.style.setProperty('--p', '0%');
    renderRows();
    if (aiCandidates.length) {
      renderAICandidates();
      reviewResult.textContent = '生成 ' + aiCandidates.length + ' 个建议' + (failed ? '，失败 ' + failed + ' 个' : '')
        + (aiAbortRequested ? '，已按要求停止' : '');
      reviewOverlay.classList.remove('hidden');
      $s('.ai-review-back').focus();
      setStatus('标题建议已生成，请检查后确认更新原标题', 'ok');
    } else {
      setStatus(aiAbortRequested ? '已停止生成标题' : '没有生成可用标题' + (failed ? '（失败 ' + failed + ' 个）' : ''), aiAbortRequested ? 'warn' : 'err');
    }
    updateAIButton();
  }

  async function applyAIRenames() {
    const items = aiCandidates.filter((item) => item.checked);
    if (!items.length || aiRenameBusy || state !== 'ready') return;
    aiRenameBusy = true;
    state = 'ai-renaming';
    setBusyControls(true);
    reviewList.style.pointerEvents = 'none';
    updateReviewApplyButton();
    let successes = 0;
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const title = item.title.trim();
      if (!title) { item.error = '标题不能为空'; continue; }
      reviewResult.textContent = '正在更新原标题… ' + i + '/' + items.length;
      try {
        await adapter.renameTitle(item.id, title);
        const conversation = conversations.find((entry) => entry.id === item.id);
        if (conversation) conversation.title = title;
        selected.delete(item.id);
        successes += 1;
        item.checked = false;
        item.error = '';
      } catch (error) {
        item.error = error.message || '更新失败';
      }
    }
    aiRenameBusy = false;
    state = 'ready';
    setBusyControls(false);
    reviewList.style.pointerEvents = '';
    renderRows();
    const failures = items.length - successes;
    if (failures) {
      aiCandidates = aiCandidates.filter((item) => item.checked);
      renderAICandidates();
      reviewResult.textContent = '已更新 ' + successes + ' 个，失败 ' + failures + ' 个；失败项仍可勾选后重试。';
      setStatus('部分标题更新完成：成功 ' + successes + ' 个，失败 ' + failures + ' 个', 'warn');
    } else {
      reviewOverlay.classList.add('hidden');
      setStatus('已更新 ' + successes + ' 个会话原标题', 'ok');
      setFlag('已更新 ' + successes + ' 个标题', 'ok', 4000);
    }
    updateAIButton();
  }

  /* ==================== ChatGPT 资料库 ==================== */
  function fileType(file) {
    const value = (file.mime + ' ' + file.name + ' ' + file.type).toLowerCase();
    if (value.includes('image') || /\.(png|jpe?g|gif|webp|svg|heic)$/.test(value)) return 'image';
    if (value.includes('spreadsheet') || value.includes('csv') || /\.(xls|xlsx|csv|ods)$/.test(value)) return 'spreadsheet';
    if (value.includes('presentation') || /\.(ppt|pptx|key)$/.test(value)) return 'presentation';
    if (value.includes('pdf') || /\.pdf$/.test(value)) return 'pdf';
    return 'document';
  }

  function fileTypeLabel(file) {
    return ({ image: '图片', spreadsheet: '表格', presentation: '演示文稿', pdf: 'PDF', document: '文档' })[fileType(file)];
  }

  function formatBytes(bytes) {
    if (!bytes) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  }

  function visibleLibraryFiles() {
    const keyword = librarySearchEl.value.trim().toLowerCase();
    const source = librarySourceEl.value;
    const type = libraryTypeEl.value;
    return libraryFiles.filter((file) => (!keyword || file.name.toLowerCase().includes(keyword))
      && (source === 'all' || file.source === source)
      && (type === 'all' || fileType(file) === type));
  }

  function updateLibrarySelection() {
    const files = visibleLibraryFiles();
    const selectedVisible = files.filter((file) => librarySelected.has(file.id)).length;
    libraryAllEl.checked = files.length > 0 && selectedVisible === files.length;
    libraryAllEl.indeterminate = selectedVisible > 0 && selectedVisible < files.length;
    const selected = libraryFiles.filter((file) => librarySelected.has(file.id));
    libraryCountEl.textContent = '已选 ' + selected.length + ' 项';
    libraryDownloadBtn.disabled = libraryBusy || selected.length === 0;
    librarySearchEl.disabled = libraryBusy;
    librarySourceEl.disabled = libraryBusy;
    libraryTypeEl.disabled = libraryBusy;
    libraryAllEl.disabled = libraryBusy;
    $s('.library-reload').disabled = libraryBusy;
    libraryListEl.style.pointerEvents = libraryBusy ? 'none' : '';
  }

  function renderLibraryFiles() {
    const files = visibleLibraryFiles();
    if (!files.length) {
      libraryListEl.innerHTML = '<div class="empty"><span class="empty-icon">' + SVG_EMPTY + '</span><p>'
        + (libraryFiles.length ? '没有符合筛选条件的文件' : '资料库中没有文件') + '</p></div>';
    } else {
      libraryListEl.innerHTML = files.map((file) => {
        const checked = librarySelected.has(file.id);
        const source = file.connected ? '外部网盘' : (file.source === 'generated' ? '已生成' : '已上传');
        return '<div class="library-row' + (checked ? ' selected' : '') + '" role="listitem" data-file-id="' + escapeHtml(file.id) + '">'
          + '<input type="checkbox" class="library-check" aria-label="选择 ' + escapeHtml(file.name) + '"' + (checked ? ' checked' : '') + '>'
          + '<span class="library-file-name" title="' + escapeHtml(file.name) + '">' + escapeHtml(file.name) + '</span>'
          + '<span class="library-tag">' + source + '</span>'
          + '<span class="library-file-meta">' + escapeHtml(fileTypeLabel(file)) + ' · ' + escapeHtml(formatBytes(file.size)) + '</span>'
          + '<span class="library-file-meta">' + escapeHtml(fmtTime(file.time)) + '</span></div>';
      }).join('');
    }
    updateLibrarySelection();
  }

  async function loadLibraryFiles() {
    if (libraryBusy || !adapter.libraryList) return;
    libraryBusy = true;
    libraryStatusEl.textContent = '正在读取资料库…';
    $s('.library-reload').disabled = true;
    updateLibrarySelection();
    try {
      libraryFiles = await adapter.libraryList();
      const valid = new Set(libraryFiles.map((file) => file.id));
      Array.from(librarySelected).forEach((id) => { if (!valid.has(id)) librarySelected.delete(id); });
      libraryStatusEl.textContent = '已加载 ' + libraryFiles.length + ' 个文件'
        + (libraryFiles.hasMore ? '，资料库还有未加载内容，请在原生资料库查看' : '，删除请使用 ChatGPT 原生资料库');
    } catch (error) {
      libraryFiles = [];
      librarySelected.clear();
      libraryStatusEl.textContent = '读取失败：' + (error.message || '资料库接口暂不可用') + '。也可以在 ChatGPT 资料库页面查看。';
    } finally {
      libraryBusy = false;
      $s('.library-reload').disabled = false;
      renderLibraryFiles();
    }
  }

  async function downloadLibrarySelection() {
    if (libraryBusy) return;
    const files = libraryFiles.filter((file) => librarySelected.has(file.id));
    if (!files.length) return;
    libraryBusy = true;
    let successes = 0;
    let failures = 0;
    updateLibrarySelection();
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      libraryStatusEl.textContent = '正在准备下载… ' + (index + 1) + '/' + files.length;
      try {
        const result = await adapter.libraryDownload(file);
        const anchor = document.createElement('a');
        anchor.download = file.name;
        if (result.blob) {
          const objectUrl = URL.createObjectURL(result.blob);
          anchor.href = objectUrl;
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
        } else {
          anchor.href = result.url;
          anchor.target = '_blank';
          anchor.rel = 'noopener';
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
        }
        successes += 1;
      } catch (error) { failures += 1; }
    }
    libraryBusy = false;
    libraryStatusEl.textContent = '已开始下载 ' + successes + ' 个文件' + (failures ? '，失败 ' + failures + ' 个' : '');
    updateLibrarySelection();
  }

  /* ==================== 事件 ==================== */
  listEl.addEventListener('change', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const id = row.dataset.id;
    if (e.target.checked) selected.add(id); else selected.delete(id);
    row.classList.toggle('checked', e.target.checked);
    updateCount();
  });

  searchEl.addEventListener('input', () => {
    renderRows();
    setStatus('当前筛选显示 ' + visibleRows().length + ' 条会话');
  });

  ageFilterEl.addEventListener('change', () => {
    renderRows();
    setStatus('当前筛选显示 ' + visibleRows().length + ' 条会话'
      + (ageFilterEl.value === 'unknown' ? '（更新时间未知）' : ''));
  });

  selAllEl.addEventListener('change', () => {
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
    if (delBtn.disabled || state !== 'ready' || !selected.size) return;
    const chosen = conversations.filter((c) => selected.has(c.id));
    const dates = chosen.map((c) => timestampOf(c.time)).filter((t) => t != null).sort((a, b) => a - b);
    const dateRange = dates.length
      ? (new Date(dates[0]).toLocaleDateString('zh-CN') + ' – ' + new Date(dates[dates.length - 1]).toLocaleDateString('zh-CN'))
      : '更新时间未知';
    const currentCount = chosen.filter((c) => c.id === currentConversationId()).length;
    $s('.confirm-title').textContent = '确认删除';
    $s('.confirm-message').textContent = '即将删除 ' + chosen.length + ' 条会话\n'
      + '更新时间：' + dateRange + '\n'
      + '当前正在浏览：' + (currentCount ? '包含 ' + currentCount + ' 条' : '未包含') + '\n'
      + '筛选条件只影响列表显示；此前已勾选的会话也计入本次删除。';
    $s('.confirm-accept').textContent = '确认删除 ' + chosen.length + ' 条';
    pendingConfirmAction = doDelete;
    confirmOverlay.classList.remove('hidden');
    $s('.confirm-cancel').focus();
  });

  libraryButton.addEventListener('click', () => {
    if (!adapter.libraryList) return;
    libraryOverlay.classList.remove('hidden');
    applyTheme();
    librarySearchEl.focus();
    loadLibraryFiles();
  });
  $s('.library-close').addEventListener('click', () => libraryOverlay.classList.add('hidden'));
  libraryOverlay.addEventListener('click', (event) => {
    if (event.target === libraryOverlay) libraryOverlay.classList.add('hidden');
  });
  $s('.library-reload').addEventListener('click', loadLibraryFiles);
  librarySearchEl.addEventListener('input', renderLibraryFiles);
  librarySourceEl.addEventListener('change', renderLibraryFiles);
  libraryTypeEl.addEventListener('change', renderLibraryFiles);
  libraryAllEl.addEventListener('change', () => {
    visibleLibraryFiles().forEach((file) => {
      if (libraryAllEl.checked) librarySelected.add(file.id);
      else librarySelected.delete(file.id);
    });
    renderLibraryFiles();
  });
  libraryListEl.addEventListener('change', (event) => {
    if (!event.target.matches('.library-check')) return;
    const row = event.target.closest('.library-row');
    if (!row) return;
    const id = row.dataset.fileId;
    if (event.target.checked) librarySelected.add(id);
    else librarySelected.delete(id);
    row.classList.toggle('selected', event.target.checked);
    updateLibrarySelection();
  });
  libraryDownloadBtn.addEventListener('click', downloadLibrarySelection);
  aiButton.addEventListener('click', async () => {
    if (!aiSupported()) return;
    if (aiGenerating) {
      aiAbortRequested = true;
      updateAIButton();
      setStatus('正在停止生成…（当前请求结束后停止）', 'warn');
      return;
    }
    if (state !== 'ready') return;
    if (!aiConfigured) {
      if (typeof chrome !== 'undefined' && chrome.runtime?.openOptionsPage) chrome.runtime.openOptionsPage();
      return;
    }
    const ids = conversations.filter((item) => selected.has(item.id)).map((item) => item.id);
    if (!ids.length) return;
    const config = await runtimeMessage({ type: 'cgpt-batch-delete:ai-config-status' }).catch(() => ({}));
    let hostname = '已配置的 AI 服务';
    try { hostname = new URL(config.endpoint).host; } catch (error) { /* keep generic label */ }
    $s('.ai-consent-message').textContent = '将把 ' + ids.length + ' 个所选会话最近最多 8 条消息发送给 ' + hostname
      + ' 生成标题。会话列表、完整历史和密钥不会放进这次请求。生成后会先让你审核；只有再次点击“更新原标题”才会改动会话。';
    consentOverlay.dataset.ids = JSON.stringify(ids);
    consentOverlay.classList.remove('hidden');
    $s('.ai-consent-accept').focus();
  });

  $s('.ai-consent-cancel').addEventListener('click', () => consentOverlay.classList.add('hidden'));
  $s('.ai-consent-accept').addEventListener('click', () => {
    let ids = [];
    try { ids = JSON.parse(consentOverlay.dataset.ids || '[]'); } catch (error) { ids = []; }
    consentOverlay.classList.add('hidden');
    beginAIGeneration(ids);
  });
  consentOverlay.addEventListener('click', (event) => {
    if (event.target === consentOverlay) consentOverlay.classList.add('hidden');
  });
  $s('.ai-review-back').addEventListener('click', () => reviewOverlay.classList.add('hidden'));
  $s('.ai-review-apply').addEventListener('click', applyAIRenames);
  reviewList.addEventListener('change', (event) => {
    const row = event.target.closest('.ai-review-row');
    if (!row) return;
    const item = aiCandidates[Number(row.dataset.index)];
    if (!item) return;
    if (event.target.matches('.ai-review-check')) item.checked = event.target.checked;
    updateReviewApplyButton();
  });
  reviewList.addEventListener('input', (event) => {
    if (!event.target.matches('.ai-review-input')) return;
    const row = event.target.closest('.ai-review-row');
    const item = aiCandidates[Number(row?.dataset.index)];
    if (item) item.title = event.target.value;
  });
  reviewList.addEventListener('click', async (event) => {
    const button = event.target.closest('.ai-review-refresh');
    if (!button || aiRenameBusy) return;
    const row = button.closest('.ai-review-row');
    const item = aiCandidates[Number(row?.dataset.index)];
    if (!item) return;
    aiRegenerating += 1;
    button.disabled = true;
    updateReviewApplyButton();
    reviewResult.textContent = '正在重新生成标题…';
    try {
      item.title = await generateTitleFor(item.id);
      renderAICandidates();
      reviewResult.textContent = '已重新生成此标题，请检查后更新。';
      reviewList.querySelectorAll('.ai-review-row')[aiCandidates.indexOf(item)]?.querySelector('.ai-review-input')?.focus();
    } catch (error) {
      reviewResult.textContent = '重新生成失败：' + (error.message || '请稍后重试');
    } finally {
      aiRegenerating = Math.max(0, aiRegenerating - 1);
      button.disabled = false;
      updateReviewApplyButton();
    }
  });

  $s('.close').addEventListener('click', closeDialog);
  $s('.btn-close').addEventListener('click', closeDialog);
  $s('.confirm-cancel').addEventListener('click', () => {
    pendingConfirmAction = null;
    confirmOverlay.classList.add('hidden');
    if (!libraryOverlay.classList.contains('hidden')) $s('.library-reload').focus(); else delBtn.focus();
  });
  $s('.confirm-accept').addEventListener('click', () => {
    confirmOverlay.classList.add('hidden');
    const action = pendingConfirmAction;
    pendingConfirmAction = null;
    if (action) action();
  });
  confirmOverlay.addEventListener('click', (e) => {
    if (e.target === confirmOverlay) {
      pendingConfirmAction = null;
      confirmOverlay.classList.add('hidden');
      if (!libraryOverlay.classList.contains('hidden')) $s('.library-reload').focus(); else delBtn.focus();
    }
  });
  $s('.btn-reload').addEventListener('click', () => {
    if (state !== 'deleting' && state !== 'loading') loadConversations();
  });

  // 点击遮罩空白处关闭
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !libraryOverlay.classList.contains('hidden')) {
      libraryOverlay.classList.add('hidden');
    } else if (e.key === 'Escape' && !consentOverlay.classList.contains('hidden')) {
      consentOverlay.classList.add('hidden');
    } else if (e.key === 'Escape' && !reviewOverlay.classList.contains('hidden')) {
      reviewOverlay.classList.add('hidden');
    } else if (e.key === 'Escape' && !confirmOverlay.classList.contains('hidden')) {
      pendingConfirmAction = null;
      confirmOverlay.classList.add('hidden');
      if (!libraryOverlay.classList.contains('hidden')) $s('.library-reload').focus(); else delBtn.focus();
    } else if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeDialog();
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
    applyFabPos({ x: e.clientX - 24, y: e.clientY - 24 });
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
  function isLibraryPage() {
    return adapter.id === 'chatgpt' && /^\/library(?:\/|$)/.test(location.pathname);
  }

  function syncFabLabel() {
    const isLibrary = isLibraryPage();
    fab.title = isLibrary ? '打开资料库批量管理' : 'Clear Chats：批量删除会话（可拖动）';
    fab.setAttribute('aria-label', isLibrary ? '打开资料库批量管理' : 'Clear Chats 批量删除会话');
  }

  syncFabLabel();
  fab.addEventListener('click', () => {
    if (fabClickSuppress) { fabClickSuppress = false; return; }
    if (isLibraryPage()) {
      libraryOverlay.classList.remove('hidden');
      applyTheme();
      librarySearchEl.focus();
      loadLibraryFiles();
    } else if (overlay.classList.contains('hidden')) openDialog(); else closeDialog();
  });

  window.addEventListener('resize', () => {
    if (fab.style.left) {
      applyFabPos({
        x: parseFloat(fab.style.left) || 0,
        y: parseFloat(fab.style.top) || 0,
      });
    }
  });

  /* ==================== 工具栏弹窗通信 ==================== */
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'cgpt-batch-delete:ping') {
        reply({ supported: true, site: adapter.name });
        return;
      }
      if (message.type === 'cgpt-batch-delete:open') {
        if (overlay.classList.contains('hidden')) openDialog();
        reply({ ok: true });
        return;
      }
      if (message.type === 'cgpt-batch-delete:open-library' && adapter.libraryList) {
        libraryOverlay.classList.remove('hidden');
        applyTheme();
        loadLibraryFiles();
        reply({ ok: true });
      }
    });
  }

  refreshAIConfig();

  /* ==================== 挂载 ==================== */
  function mount() {
    if (document.body) {
      if (!document.documentElement.contains(host)) {
        document.body.appendChild(host);
        console.info('[' + adapter.name + ' 批量删除] 已加载，点击右下角按钮开始');
      }
    } else {
      setTimeout(mount, 200);
    }
  }
  mount();
})();
